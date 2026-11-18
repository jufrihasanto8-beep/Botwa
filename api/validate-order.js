/**
 * Validate Order Agent — cron tiap 10 menit
 * Validasi data closing vs percakapan, auto-fix kalau salah, notif ke grup WA
 *
 * Routing:
 *   POST + x-cron-secret → cron: validasi semua order baru yang belum divalidasi
 *   POST + body { order_id } + x-cron-secret → validasi 1 order spesifik
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL          = process.env.BAILEYS_URL;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;
const CRON_SECRET          = process.env.CRON_SECRET;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_KEY;

const sbH = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbPatch(table, query, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH', headers: { ...sbH, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function callClaude(systemPrompt, messages, model = 'claude-haiku-4-5-20251001', apiKey = null) {
  const key = apiKey || ANTHROPIC_KEY;
  if (!key) throw new Error('ANTHROPIC_KEY belum diset');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1200, system: systemPrompt, messages }),
  });
  const data = await r.json();
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  return data.content?.[0]?.text || '';
}

async function sendWA(sessionId, to, text) {
  try {
    const r = await fetch(`${BAILEYS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, to, text, secret: WEBHOOK_SECRET }),
    });
    return r.ok;
  } catch { return false; }
}

async function getWaSession(userId, productId) {
  if (productId) {
    const rows = await sbGet(`products?id=eq.${productId}&select=wa_session_id&limit=1`).catch(() => []);
    if (rows[0]?.wa_session_id) return rows[0].wa_session_id;
  }
  const rows = await sbGet(`products?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=wa_session_id&limit=1`).catch(() => []);
  return rows[0]?.wa_session_id || userId;
}

/* ── VALIDASI 1 ORDER ──────────────────────────────────────── */
async function validateOrder(order) {
  const orderId = order.id;
  const log = msg => console.log(`[validate ${orderId.slice(0,8)}] ${msg}`);

  // 1. Ambil conversation + customer + product
  const [convRows, custRows, prodRows] = await Promise.all([
    order.conversation_id ? sbGet(`conversations?id=eq.${order.conversation_id}&select=id,state,status&limit=1`) : Promise.resolve([]),
    order.customer_id     ? sbGet(`customers?id=eq.${order.customer_id}&select=id,nama,wa_number,alamat&limit=1`) : Promise.resolve([]),
    order.product_id      ? sbGet(`products?id=eq.${order.product_id}&select=id,nama,harga,wa_session_id,persona_cs_nama&limit=1`) : Promise.resolve([]),
  ]);
  const conv     = convRows[0];
  const customer = custRows[0];
  const product  = prodRows[0];

  if (!conv) { log('Skip — no conversation'); return { status: 'skip', reason: 'no_conversation' }; }

  // 2. Ambil pesan percakapan (max 40 pesan terakhir)
  const msgs = await sbGet(
    `conv_messages?conversation_id=eq.${conv.id}&order=created_at.asc&limit=40&select=role,isi,created_at`
  ).catch(() => []);

  if (!msgs.length) { log('Skip — no messages'); return { status: 'skip', reason: 'no_messages' }; }

  const chatLog = msgs.map(m => {
    const role = m.role === 'customer' ? 'CUSTOMER' : (m.role === 'cs' ? 'CS' : 'BOT');
    return `${role}: ${(m.isi || '').slice(0, 400)}`;
  }).join('\n');

  // 3. Data order saat ini
  const alamat = order.alamat || {};
  const state  = conv.state || {};
  const formAlamat = state.form_alamat || '';
  const formProduk = state.form_produk || '';
  const isFormLead = state.is_form_lead || false;

  // 4. Panggil Haiku untuk validasi + extract data benar
  const prompt = `Kamu adalah VALIDATOR ORDER yang sangat teliti. Tugasmu mengecek apakah data order yang tersimpan di database BENAR sesuai percakapan.

═══ DATA ORDER DI DATABASE ═══
Nama: ${customer?.nama || order.customer_nama || '-'}
Alamat jalan: ${alamat.jalan || '-'}
Kelurahan: ${alamat.kelurahan || '-'}
Kecamatan: ${alamat.kecamatan || '-'}
Kabupaten: ${alamat.kabupaten || '-'}
Provinsi: ${alamat.provinsi || '-'}
Kode Pos: ${alamat.kodepos || '-'}
Qty: ${order.qty || '-'}
Metode: ${order.metode || '-'}
Ekspedisi: ${order.ekspedisi || '-'}
Produk: ${product?.nama || order.product_nama || '-'}
Total: ${order.total || '-'}

${isFormLead ? `═══ DATA FORM LEAD (dari orderonline.id) ═══
Alamat form: ${formAlamat}
Produk form: ${formProduk}
(Data form lead ini LEBIH TERPERCAYA dari data order jika ada konflik)
` : ''}
═══ PERCAKAPAN ═══
${chatLog}

═══ INSTRUKSI VALIDASI ═══
Cek SEMUA hal berikut:

1. **ALAMAT** — Ini yang PALING PENTING:
   - Apakah kelurahan/kecamatan/kabupaten/provinsi MASUK AKAL dengan alamat jalan?
   - Contoh SALAH: alamat jalan "Kab. Tangerang" tapi wilayah "Bojonegoro, Jawa Timur" → BEDA PULAU!
   - Apakah kelurahan berisi kata umum yang BUKAN nama wilayah? ("Sudah", "Iya", "Oke", "Betul", "Benar", "Ok", "Ya", "Siap" → ini jawaban customer, bukan wilayah)
   - Kalau form lead ada → alamat form lead adalah sumber kebenaran
   - Kalau alamat jalan menyebut kecamatan/kabupaten tertentu tapi data wilayah beda → SALAH

2. **QTY** — Apakah jumlah pesanan sesuai yang customer bilang di chat?

3. **METODE BAYAR** — COD atau Transfer, sesuai yang customer pilih di chat?

4. **ALAMAT LENGKAP** — Apakah ada field alamat yang kosong padahal informasinya ada di percakapan atau form lead?

═══ FORMAT JAWABAN (WAJIB JSON) ═══
Jawab HANYA dengan JSON, tanpa teks lain:

Kalau SEMUA VALID:
{"status":"VALID"}

Kalau ada yang PERLU DIKOREKSI:
{"status":"FIX","fixes":[{"field":"nama field","old":"nilai lama","new":"nilai benar","reason":"alasan"}],"summary":"ringkasan 1 kalimat"}

Contoh fix alamat:
{"status":"FIX","fixes":[{"field":"kelurahan","old":"Sudah","new":"Mekarbakti","reason":"'Sudah' bukan nama kelurahan, itu jawaban konfirmasi customer"},{"field":"kecamatan","old":"Malo","new":"Panongan","reason":"Alamat jalan menunjukkan Kec. Panongan, Tangerang"},{"field":"kabupaten","old":"Kabupaten Bojonegoro","new":"Kabupaten Tangerang","reason":"Sesuai alamat form lead"},{"field":"provinsi","old":"Jawa Timur","new":"Banten","reason":"Tangerang ada di Banten"},{"field":"kodepos","old":"62153","new":"15710","reason":"Kode pos Panongan Tangerang"}],"summary":"Wilayah salah total — 'Sudah' terdeteksi sebagai kelurahan padahal jawaban konfirmasi"}

Field yang bisa di-fix: kelurahan, kecamatan, kabupaten, provinsi, kodepos, jalan, qty, metode
Untuk qty/metode, "new" harus berupa string angka/kata (misal "2", "transfer")`;

  log('Calling Haiku for validation...');
  const result = await callClaude(
    'Kamu validator order yang teliti. Jawab HANYA JSON tanpa markdown atau teks lain.',
    [{ role: 'user', content: prompt }],
    'claude-haiku-4-5-20251001',
    null // pakai ANTHROPIC_KEY global
  );

  log(`Haiku result: ${result.slice(0, 200)}`);

  // 5. Parse result
  let parsed;
  try {
    // Bersihkan markdown wrapper kalau ada
    const clean = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(clean);
  } catch(e) {
    log(`Parse error: ${e.message} — raw: ${result.slice(0, 200)}`);
    return { status: 'error', reason: 'parse_failed', raw: result };
  }

  // 6. Kalau VALID → tandai validated_at saja
  if (parsed.status === 'VALID') {
    await sbPatch('orders_new', `?id=eq.${orderId}`, {
      validated_at: new Date().toISOString(),
    });
    log('✅ VALID');
    return { status: 'valid', orderId };
  }

  // 7. Kalau FIX → auto-fix data
  if (parsed.status === 'FIX' && Array.isArray(parsed.fixes) && parsed.fixes.length > 0) {
    log(`🔧 FIX needed: ${parsed.summary}`);

    const alamatFields = ['kelurahan', 'kecamatan', 'kabupaten', 'provinsi', 'kodepos', 'jalan'];
    const alamatFixes = {};
    let qtyFix = null;
    let metodeFix = null;

    for (const fix of parsed.fixes) {
      if (alamatFields.includes(fix.field)) {
        alamatFixes[fix.field] = fix.new;
      } else if (fix.field === 'qty') {
        qtyFix = parseInt(fix.new) || null;
      } else if (fix.field === 'metode') {
        metodeFix = (fix.new || '').toLowerCase();
      }
    }

    // A. Fix orders_new.alamat
    const hasAlamatFix = Object.keys(alamatFixes).length > 0;
    if (hasAlamatFix || qtyFix || metodeFix) {
      const orderPatch = {};

      if (hasAlamatFix) {
        orderPatch.alamat = { ...alamat, ...alamatFixes };
      }
      if (qtyFix) orderPatch.qty = qtyFix;
      if (metodeFix) orderPatch.metode = metodeFix;

      orderPatch.validated_at = new Date().toISOString();
      orderPatch.validation_note = `[Auto-fix] ${parsed.summary}`;
      orderPatch.flag_risiko = true;
      orderPatch.alasan_flag = `[Auto-fix] ${parsed.summary}`;

      await sbPatch('orders_new', `?id=eq.${orderId}`, orderPatch);
      log('Fixed orders_new');
    }

    // B. Fix customers.alamat
    if (hasAlamatFix && customer?.id) {
      const custAlamat = { ...(customer.alamat || {}), ...alamatFixes };
      await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: custAlamat })
        .catch(e => log(`Gagal fix customers: ${e.message}`));
      log('Fixed customers.alamat');
    }

    // C. Fix conversations.state (wilayah + ongkir.area)
    if (hasAlamatFix && conv?.id) {
      const newState = { ...state };
      const kel = alamatFixes.kelurahan || alamat.kelurahan || '';
      const kec = alamatFixes.kecamatan || alamat.kecamatan || '';
      const kab = alamatFixes.kabupaten || alamat.kabupaten || '';
      const prov = alamatFixes.provinsi || alamat.provinsi || '';

      newState.wilayah = [kel, kec, kab, prov].filter(Boolean).join(', ');

      if (newState.ongkir?.area) {
        newState.ongkir = {
          ...newState.ongkir,
          area: {
            ...newState.ongkir.area,
            ...(alamatFixes.kelurahan ? { kelurahan: alamatFixes.kelurahan } : {}),
            ...(alamatFixes.kecamatan ? { kecamatan: alamatFixes.kecamatan } : {}),
            ...(alamatFixes.kabupaten ? { kota: alamatFixes.kabupaten } : {}),
            ...(alamatFixes.provinsi  ? { provinsi: alamatFixes.provinsi } : {}),
            ...(alamatFixes.kodepos   ? { kodePos: alamatFixes.kodepos } : {}),
          },
        };
      }
      if (newState.order_snapshot?.area) {
        newState.order_snapshot.area = newState.ongkir?.area || newState.order_snapshot.area;
      }

      await sbPatch('conversations', `?id=eq.${conv.id}`, { state: newState })
        .catch(e => log(`Gagal fix conversations: ${e.message}`));
      log('Fixed conversations.state');
    }

    // D. Kirim notif ke grup WA
    try {
      const user = await sbGet(`users?id=eq.${order.user_id}&select=id,group_jid&limit=1`).catch(() => []);
      const groupJid = user[0]?.group_jid || process.env.WA_GROUP_JID;
      if (groupJid) {
        const waSession = await getWaSession(order.user_id, order.product_id);
        const fixDetails = parsed.fixes
          .map(f => `• ${f.field}: "${f.old}" → "${f.new}" (${f.reason})`)
          .join('\n');
        const notifMsg = `⚠️ *AUTO-VALIDASI ORDER*\n\n`
          + `Customer: ${customer?.nama || order.customer_nama || '-'}\n`
          + `HP: ${customer?.wa_number?.replace(/^62/, '0') || order.customer_phone || '-'}\n`
          + `Produk: ${product?.nama || order.product_nama || '-'}\n\n`
          + `🔧 *Data dikoreksi otomatis:*\n${fixDetails}\n\n`
          + `📝 ${parsed.summary}`;
        await sendWA(waSession, groupJid, notifMsg);
        log('Notif sent to group');
      }
    } catch(e) {
      log(`Notif error: ${e.message}`);
    }

    return { status: 'fixed', orderId, fixes: parsed.fixes, summary: parsed.summary };
  }

  // Fallback
  await sbPatch('orders_new', `?id=eq.${orderId}`, { validated_at: new Date().toISOString() });
  return { status: 'unknown', orderId, raw: parsed };
}

/* ── HANDLER ───────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Auth
  const cronSecret = req.headers['x-cron-secret'];
  if (CRON_SECRET && cronSecret !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const specificOrderId = req.body?.order_id;

    let orders;
    if (specificOrderId) {
      // Validasi 1 order spesifik
      orders = await sbGet(
        `orders_new?id=eq.${specificOrderId}&select=id,user_id,customer_id,conversation_id,product_id,metode,qty,harga,ongkir,fee_cod,total,ekspedisi,alamat,status,customer_nama,customer_phone,product_nama,created_at,validated_at`
      );
    } else {
      // Ambil order 3 hari terakhir yang belum divalidasi
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
      orders = await sbGet(
        `orders_new?validated_at=is.null&created_at=gte.${threeDaysAgo}&status=neq.batal&select=id,user_id,customer_id,conversation_id,product_id,metode,qty,harga,ongkir,fee_cod,total,ekspedisi,alamat,status,customer_nama,customer_phone,product_nama,created_at,validated_at&order=created_at.asc&limit=10`
      );
    }

    console.log(`[validate-order] Found ${orders.length} orders to validate`);

    if (!orders.length) {
      return res.status(200).json({ ok: true, validated: 0, fixed: 0, results: [] });
    }

    const results = [];
    let fixCount = 0;

    for (const order of orders) {
      try {
        const result = await validateOrder(order);
        results.push(result);
        if (result.status === 'fixed') fixCount++;
      } catch(e) {
        console.error(`[validate-order] Error on ${order.id}:`, e.message);
        // Tandai validated_at supaya tidak retry terus
        await sbPatch('orders_new', `?id=eq.${order.id}`, {
          validated_at: new Date().toISOString(),
          validation_note: `[Error] ${e.message}`,
        }).catch(() => {});
        results.push({ status: 'error', orderId: order.id, error: e.message });
      }
    }

    return res.status(200).json({
      ok: true,
      validated: results.length,
      fixed: fixCount,
      results,
    });
  } catch(e) {
    console.error('[validate-order] Fatal:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
