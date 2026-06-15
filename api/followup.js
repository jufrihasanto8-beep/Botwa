// ══════════════════════════════════════════════════════════
//  Follow-up Otomatis — Vercel Cron Job
//  Jalan setiap 30 menit via Vercel Cron
//  Kirim WA ke leads HARI INI yang diam ≥ 1 jam setelah pesan AI
// ══════════════════════════════════════════════════════════

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY= process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL         = process.env.BAILEYS_URL;
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET;
const CRON_SECRET         = process.env.CRON_SECRET;
const ANTHROPIC_KEY       = process.env.ANTHROPIC_KEY;

function sbH() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
}

async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH() });
  if (!res.ok) throw new Error(`sbGet ${table}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch ${table}: ${await res.text()}`);
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
}

// Generate follow-up message pakai Claude berdasarkan konteks percakapan terakhir
async function generateFollowup(messages, namaKak, namaProduk, csNama) {
  if (!ANTHROPIC_KEY) return null;

  // Ambil 6 pesan terakhir saja sebagai konteks
  const recent = messages.slice(-6);
  const transcript = recent.map(m =>
    `${m.role === 'customer' ? 'Customer' : 'CS'}: ${(m.isi || '').replace(/\[SISTEM[^\]]*\]/g, '').replace(/\[.*?\]/g, '').trim()}`
  ).filter(l => l.split(': ')[1]).join('\n');

  const prompt = `Kamu ${csNama || 'Sari'}, CS WhatsApp toko yang jual ${namaProduk || 'produk herbal'}.

Customer bernama ${namaKak || 'Kak'} tadi ngobrol tapi sekarang tiba-tiba diam selama 1 jam tanpa balas.

Berikut akhir percakapan tadi:
---
${transcript}
---

Buatkan SATU pesan follow-up WhatsApp yang:
- Hangat dan natural, seperti teman yang peduli (bukan sales yang maksa)
- Sangat pendek: 1-2 kalimat SAJA
- Sambung dari konteks terakhir — jangan mulai dari awal, jangan sapa ulang
- Jika customer tadi sedang tanya/cerita sesuatu, tindak-lanjuti hal itu secara spesifik
- Jika customer tadi sudah hampir order (nanya ongkir/alamat), ingatkan pelan-pelan
- Jika konsultasi masih di awal, tanya lanjutan ringan tentang keluhannya
- Panggil "Kak" atau nama depannya
- Emoji 1 saja, tidak lebay
- DILARANG markdown, DILARANG "Halo kak" dari awal, DILARANG jual keras

Tulis pesan follow-up saja, tanpa penjelasan.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) {
    console.error('generateFollowup error:', e.message);
    return null;
  }
}

async function sendWA(sessionId, jid, message) {
  if (!BAILEYS_URL) throw new Error('BAILEYS_URL belum diset');
  const res = await fetch(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      session_id: sessionId,
      wa_number: jid,
      message,
      is_outbound: true,
    }),
  });
  if (!res.ok) throw new Error(`Baileys send error: ${await res.text()}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  // Verifikasi CRON_SECRET (Vercel otomatis sisipkan di header)
  const authHeader = req.headers['authorization'] || '';
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    // Izinkan juga manual GET/POST untuk testing
    if (req.method === 'GET' && req.query?.secret === CRON_SECRET) {
      // ok
    } else {
      console.warn('Follow-up: auth gagal');
      return res.status(401).json({ ok: false, reason: 'unauthorized' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  console.log('Follow-up job started:', new Date().toISOString());

  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const todayStart = `${todayStr}T00:00:00.000Z`;
  // Conversations yang sudah diam ≥ 1 jam (last_msg_at ≤ 1 jam lalu)
  const cutoff1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  // Jangan follow-up lebih dari 4 jam setelah masuk (sudah terlalu malam/lama)
  const cutoff4h = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();

  let totalSent = 0;
  let totalSkipped = 0;
  const results = [];

  try {
    // Ambil semua conversation aktif yang masuk HARI INI
    // - status baru/aktif (belum selesai/eskalasi)
    // - created_at hari ini (lead baru)
    // - last_msg_at sudah > 1 jam lalu (diam)
    // - last_msg_at tidak > 4 jam (masih relevan)
    const conversations = await sbGet('conversations',
      `?status=in.(baru,aktif)` +
      `&created_at=gte.${todayStart}` +
      `&last_msg_at=lte.${cutoff1h}` +
      `&last_msg_at=gte.${cutoff4h}` +
      `&select=id,user_id,customer_id,product_id,state,last_msg_at`
    );

    console.log(`Candidate conversations: ${conversations.length}`);

    for (const conv of conversations) {
      try {
        const state = conv.state || {};

        // Skip jika sudah pernah di-follow-up
        if (state.followed_up) {
          totalSkipped++;
          continue;
        }

        // Skip jika eskalasi
        if (state.tahap === 'eskalasi') {
          totalSkipped++;
          continue;
        }

        // Cek pesan terakhir harus dari AI (bukan customer yang belum dibalas)
        const lastMsgs = await sbGet('conv_messages',
          `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
        );
        if (!lastMsgs.length) { totalSkipped++; continue; }
        const lastMsg = lastMsgs[0];

        // Hanya follow-up kalau pesan terakhir dari AI dan customer belum reply
        if (lastMsg.role !== 'ai') {
          totalSkipped++;
          continue;
        }

        // Ambil data customer
        const customers = await sbGet('customers', `?id=eq.${conv.customer_id}&limit=1`);
        if (!customers.length) { totalSkipped++; continue; }
        const customer = customers[0];
        const jid = customer.reply_jid || customer.wa_number;
        if (!jid) { totalSkipped++; continue; }

        // Ambil nama produk + persona CS kalau ada
        let namaProduk = '';
        let csNama = 'Sari';
        if (conv.product_id) {
          const prods = await sbGet('products', `?id=eq.${conv.product_id}&select=nama,persona_cs_nama&limit=1`);
          namaProduk = prods[0]?.nama || '';
          csNama = prods[0]?.persona_cs_nama || 'Sari';
        }

        // Ambil 6 pesan terakhir sebagai konteks untuk AI
        const recentMsgs = await sbGet('conv_messages',
          `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=6`
        );
        recentMsgs.reverse(); // urutkan dari lama ke baru

        const namaKak = customer.nama && customer.nama !== customer.wa_number
          ? customer.nama.split(' ')[0]
          : '';

        // Generate follow-up pakai Claude berdasarkan konteks percakapan
        let followupMsg = await generateFollowup(recentMsgs, namaKak, namaProduk, csNama);

        // Fallback kalau Claude gagal / tidak ada API key
        if (!followupMsg) {
          followupMsg = namaKak
            ? `Kak ${namaKak}, masih ada yang bisa aku bantu? 😊 Jangan ragu kalau mau tanya-tanya lagi ya`
            : `Masih ada yang bisa aku bantu kak? 😊 Jangan ragu kalau mau tanya-tanya lagi ya`;
        }

        // Kirim via Baileys
        await sendWA(conv.user_id, jid, followupMsg);

        // Simpan ke conv_messages
        await sbPost('conv_messages', {
          conversation_id: conv.id,
          role: 'ai',
          isi: followupMsg,
        });

        // Tandai sudah follow-up + update last_msg_at
        await sbPatch('conversations', `?id=eq.${conv.id}`, {
          last_msg_at: now.toISOString(),
          state: { ...state, followed_up: true, followed_up_at: now.toISOString() },
        });

        totalSent++;
        results.push({
          conv_id: conv.id,
          customer: customer.nama || jid,
          wa: jid,
          produk: namaProduk || '-',
          pesan: followupMsg,
          status: 'sent',
        });

        console.log(`Follow-up terkirim → ${customer.nama || jid}: "${followupMsg.slice(0, 60)}..."`);

        // Jeda antar kirim agar tidak spam server
        await new Promise(r => setTimeout(r, 1500));

      } catch(e) {
        console.error(`Error follow-up conv ${conv.id}:`, e.message);
        results.push({ conv_id: conv.id, status: 'error', error: e.message });
      }
    }

    const summary = `Follow-up selesai: ${totalSent} terkirim, ${totalSkipped} dilewati dari ${conversations.length} kandidat`;
    console.log(summary);
    return res.status(200).json({ ok: true, sent: totalSent, skipped: totalSkipped, total: conversations.length, results });

  } catch(err) {
    console.error('Follow-up job error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
