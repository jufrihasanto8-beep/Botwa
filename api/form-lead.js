/**
 * POST /api/form-lead
 * Terima order dari orderonline.id via n8n → kirim WA otomatis ke customer
 * Auth: form_token (per user, tersimpan di users table)
 */

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL         = process.env.BAILEYS_URL;
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET;

const sbH = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Prefer': 'return=representation',
};

async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: sbH, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH', headers: sbH, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Normalisasi nomor WA → format 628xxx
function normalizeWA(hp) {
  let n = (hp || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('8')) n = '62' + n;
  if (!n.startsWith('62')) n = '62' + n;
  return n;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { form_token, nama, hp, alamat, produk } = req.body || {};

    if (!form_token) return res.status(400).json({ error: 'form_token wajib diisi' });
    if (!hp)         return res.status(400).json({ error: 'hp wajib diisi' });

    // ── 1. Cari user berdasarkan form_token ──────────────────
    const users = await sbGet('users', `?form_token=eq.${form_token}&select=id,rekening&limit=1`);
    if (!users.length) return res.status(401).json({ error: 'form_token tidak valid' });

    const userId    = users[0].id;   // ini juga session_id Baileys
    const sessionId = userId;
    const waNumber  = normalizeWA(hp);

    // ── 2. Upsert customer ───────────────────────────────────
    const existingCustomer = await sbGet('customers', `?user_id=eq.${userId}&wa_number=eq.${waNumber}&limit=1`);
    let customerId;

    if (existingCustomer.length) {
      customerId = existingCustomer[0].id;
      // Update nama kalau ada & belum terisi
      if (nama && !existingCustomer[0].nama) {
        await sbPatch('customers', `?id=eq.${customerId}`, { nama });
      }
    } else {
      const newCustomer = await sbPost('customers', {
        user_id: userId,
        wa_number: waNumber,
        nama: nama || null,
        alamat: alamat ? { jalan: alamat } : null,
      });
      customerId = newCustomer[0]?.id;
    }

    // ── 3. Cek apakah conversation aktif sudah ada ───────────
    const existingConv = await sbGet('conversations',
      `?user_id=eq.${userId}&wa_number=eq.${waNumber}&order=created_at.desc&limit=1`
    );

    let convId;
    const now = new Date().toISOString();

    if (existingConv.length) {
      convId = existingConv[0].id;
      // Reset state supaya bot mulai dari awal
      await sbPatch('conversations', `?id=eq.${convId}`, {
        state: {
          tahap: 'awal',
          is_form_lead: true,
          form_produk: produk || null,
          form_alamat: alamat || null,
          followed_up: false,
          order_placed: false,
        },
        updated_at: now,
        eskalasi: false,
      });
    } else {
      const newConv = await sbPost('conversations', {
        user_id: userId,
        customer_id: customerId || null,
        wa_number: waNumber,
        state: {
          tahap: 'awal',
          is_form_lead: true,
          form_produk: produk || null,
          form_alamat: alamat || null,
          followed_up: false,
          order_placed: false,
        },
        eskalasi: false,
        created_at: now,
        updated_at: now,
      });
      convId = newConv[0]?.id;
    }

    // ── 4. Kirim WA sapaan ke customer via Baileys ───────────
    const namaSapa = nama ? nama.split(' ')[0] : 'kak';
    const produkText = produk ? ` untuk *${produk}*` : '';
    const pesanWA = `Halo *${namaSapa}* 👋\n\nTerima kasih sudah melakukan pemesanan${produkText}! 🙏\n\nKami sedang memproses pesanan kakak. Boleh kami konfirmasi dulu ya beberapa detailnya?`;

    const baileyRes = await fetch(`${BAILEYS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: WEBHOOK_SECRET,
        session_id: sessionId,
        wa_number: waNumber,
        message: pesanWA,
        is_outbound: true,
      }),
    });

    if (!baileyRes.ok) {
      const errText = await baileyRes.text();
      console.error('Baileys error:', errText);
      // Tetap return success — data sudah tersimpan, WA bisa diretry manual
      return res.status(200).json({
        ok: true,
        warning: 'Data tersimpan tapi WA gagal terkirim',
        baileys_error: errText,
        conv_id: convId,
      });
    }

    // ── 5. Simpan pesan outbound ke conv_messages ────────────
    await sbPost('conv_messages', {
      conversation_id: convId,
      role: 'assistant',
      content: pesanWA,
      created_at: now,
    }).catch(() => {}); // non-critical

    return res.status(200).json({
      ok: true,
      message: 'WA berhasil dikirim',
      wa_number: waNumber,
      conv_id: convId,
    });

  } catch (err) {
    console.error('form-lead error:', err);
    return res.status(500).json({ error: err.message });
  }
};
