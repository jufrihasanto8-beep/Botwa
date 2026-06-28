/**
 * AI Suggest Reply — dipanggil dari dashboard untuk generate saran balasan
 */
const ANTHROPIC_KEY     = process.env.ANTHROPIC_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ── FETCH WITH TIMEOUT ───────────────────────────────────── */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

const SB_HEADERS = { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` };

async function sbGet(path) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS }, 5000);
  return res.json();
}

async function getUserAnthropicKey(userId) {
  if (!userId) return null;
  try {
    const data = await sbGet(`users?id=eq.${userId}&select=anthropic_key&limit=1`);
    return data[0]?.anthropic_key || null;
  } catch { return null; }
}

// Hitung ongkir dari wilayah string via Mengantar v1 API
async function hitungOngkirByWilayah(wilayah, product, userId, qty = 1) {
  try {
    const fmt = n => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

    const [userRows, whitelist] = await Promise.all([
      sbGet(`users?id=eq.${userId}&select=mengantar_key&limit=1`),
      sbGet(`courier_whitelist?user_id=eq.${userId}&aktif=eq.true`),
    ]);
    const apiKey = userRows[0]?.mengantar_key || process.env.MENGANTAR_KEY;
    console.log(`[ai-suggest] hitungOngkir: wilayah="${wilayah}" apiKey=${apiKey ? 'set' : 'null'}`);
    if (!apiKey) return null;

    const MNG_AUTH = { 'Authorization': `Bearer ${apiKey}` };

    // Cari area via v1 API
    const areasRes = await fetchWithTimeout(
      `https://api.mengantar.com/v1/areas?search=${encodeURIComponent(wilayah)}&limit=3`,
      { headers: MNG_AUTH }, 8000
    ).then(r => r.json()).catch(() => null);
    const areaId = areasRes?.data?.[0]?.id;
    console.log(`[ai-suggest] v1/areas "${wilayah}" → areaId=${areaId}`);
    if (!areaId) return null;

    // Ambil rates
    const beratKg = ((product?.berat_gram || 1000) / 1000) * qty;
    const ratesRes = await fetchWithTimeout(
      `https://api.mengantar.com/v1/rates?destination_id=${areaId}&weight=${beratKg}`,
      { headers: MNG_AUTH }, 8000
    ).then(r => r.json()).catch(() => null);
    let rates = (ratesRes?.data || []).filter(r => (r.price || 0) > 0);
    if (!rates.length) return null;

    // Filter whitelist
    const namaSet = new Set((whitelist || []).map(w => (w.nama || '').toLowerCase()));
    if (namaSet.size > 0) {
      const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const filtered = rates.filter(r => namaSet.has(norm(r.courier_name)));
      if (filtered.length) rates = filtered;
    }
    rates.sort((a, b) => a.price - b.price);
    const best = rates[0];
    if (!best) return null;

    // Promo ongkir
    let promo = product?.promo_ongkir || {};
    if (typeof promo === 'string') try { promo = JSON.parse(promo); } catch { promo = {}; }
    let ongkirPromo = best.price;
    if (promo.tipe === 'gratis_penuh') ongkirPromo = 0;
    else if (promo.tipe === 'potong' || promo.tipe === 'gratis_sd') ongkirPromo = Math.max(0, best.price - (promo.nilai || 0));

    // Harga bundling
    let bundling = product?.harga_bundling || [];
    if (typeof bundling === 'string') try { bundling = JSON.parse(bundling); } catch { bundling = []; }
    let harga = (product?.harga || 0) * qty;
    const exact = Array.isArray(bundling) && bundling.find(b => b.qty == qty);
    if (exact) harga = exact.harga;

    const feeCOD = Math.ceil((harga + ongkirPromo) * 0.05);
    const ongkirDisplay = best.price !== ongkirPromo
      ? `~${fmt(best.price)}~ ${fmt(ongkirPromo)}`
      : fmt(ongkirPromo);

    return {
      kurir: best.courier_name,
      ongkirAsli: best.price,
      ongkirPromo,
      ongkirDisplay,
      feeCOD,
      harga,
      totalTF: harga + ongkirPromo,
      totalCOD: harga + ongkirPromo + feeCOD,
    };
  } catch(e) {
    console.error('[ai-suggest] hitungOngkirByWilayah error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Fallback parse kalau body belum di-parse Vercel
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  const { action, messages, product, userId, hari, tipe } = body || {};
  console.log('[ai-suggest] action:', action, 'hari:', hari, 'body_type:', typeof req.body);

  // ── ACTION: generate teks follow-up ──
  if (action === 'followup-text') {
    const userKey = await getUserAnthropicKey(userId);
    const apiKey  = userKey || ANTHROPIC_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY belum diset' });

    const hariKe   = hari || 2;
    const image_url = body.image_url || null;
    const tipeLabel = { ai: 'AI natural', testimoni: 'testimoni customer', promo: 'promo/diskon', custom: 'pesan custom' }[tipe] || 'custom';

    const toneGuide = hariKe === 2
      ? 'Hari 2 — masih hangat, sambung dari konteks terakhir, jangan kaku'
      : hariKe <= 3
        ? `Hari ${hariKe} — agak soft, kasih value atau social proof ringan`
        : `Hari ${hariKe} — tone penutup, beri ruang tapi pintu tetap terbuka`;

    const imageNote = image_url
      ? `\n- Ada gambar yang akan dikirim bersamaan. Buat caption yang RELEVAN dengan isi gambar tersebut. Caption harus natural, bukan deskripsi gambar.`
      : '';

    const prompt = `Kamu CS WhatsApp toko produk herbal. Buat 1 pesan follow-up untuk customer yang belum balas.

Konteks:
- Follow-up Hari ke-${hariKe} (H+${hariKe - 1} setelah lead masuk)
- Tipe: ${tipeLabel}${imageNote}
- Customer sudah dapat info produk sebelumnya tapi belum balas

Aturan WAJIB:
- Maksimal 2 kalimat
- Natural, hangat, tidak memaksa
- Pakai {nama} untuk nama customer (sistem ganti otomatis)
- 1 emoji saja
- DILARANG markdown (*bold*, dll) — ini WhatsApp
- DILARANG kata: "sistem", "admin", "CS", "tim", "diproses"
- ${toneGuide}

Tulis pesannya langsung, tanpa penjelasan.`;

    // Build message content — tambah gambar kalau ada
    const userContent = image_url
      ? [
          { type: 'image', source: { type: 'url', url: image_url } },
          { type: 'text', text: prompt },
        ]
      : prompt;

    try {
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: image_url ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: userContent }],
        }),
      }, 20000);
      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      return res.status(200).json({ text: data.content?.[0]?.text?.trim() || '' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ACTION: analytics insights ──
  if (action === 'analytics-insights') {
    const userKey = await getUserAnthropicKey(userId);
    const apiKey  = userKey || ANTHROPIC_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY belum diset' });
    const { prompt: insightPrompt } = body;
    if (!insightPrompt) return res.status(400).json({ error: 'prompt wajib' });
    try {
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: insightPrompt }] }),
      }, 20000);
      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      return res.status(200).json({ text: data.content?.[0]?.text?.trim() || '' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!messages?.length) return res.status(400).json({ error: 'messages wajib' });

  const { convState = {}, customerAlamat = {} } = body || {};

  const userKey = await getUserAnthropicKey(userId);
  const apiKey  = userKey || ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY belum diset' });

  // ── Detect skenario stuck ongkir ──────────────────────────────
  const fmt = n => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

  const ongkirState     = convState.ongkir || null;
  const wilayahState    = convState.wilayah || null;
  const proposedWilayah = convState.proposed_wilayah || null;
  const orderPlaced     = convState.order_placed || false;

  console.log(`[ai-suggest] userId=${userId} wilayah=${wilayahState} ongkir=${!!ongkirState} proposed=${proposedWilayah} product=${product?.nama}`);

  let ongkirContext = '';

  if (orderPlaced) {
    // Order sudah selesai — tidak perlu inject apapun, biarkan AI baca konteks normal
  } else if (ongkirState) {
    // Skenario A: ongkir sudah ada di state → inject data total ke system prompt
    const harga = product?.harga || ongkirState.harga || 0;
    const ongkirAsli  = ongkirState.ongkirAsli  || 0;
    const ongkirPromo = ongkirState.ongkirPromo ?? ongkirAsli;
    const feeCOD      = ongkirState.feeCOD      || 0;
    const totalTF     = ongkirState.totalTransfer || (harga + ongkirPromo);
    const totalCOD    = ongkirState.totalCOD     || (harga + ongkirPromo + feeCOD);
    const kurir       = ongkirState.ekspedisi    || 'KURIR';
    const wilayah     = ongkirState.area?.kecamatan
      ? [ongkirState.area.kelurahan, ongkirState.area.kecamatan, ongkirState.area.kota || ongkirState.area.kabupaten].filter(Boolean).join(', ')
      : wilayahState || 'wilayah customer';
    const ongkirDisplay = ongkirAsli !== ongkirPromo
      ? `~${fmt(ongkirAsli)}~ ${fmt(ongkirPromo)}`
      : fmt(ongkirPromo);
    const prodNama = product?.nama || 'Produk';

    ongkirContext = `\n\nDATA ONGKIR (sudah dihitung sistem, WAJIB tampilkan di saran):
- Wilayah tujuan: ${wilayah}
- Ekspedisi: ${kurir}
- Ongkir: ${ongkirDisplay}
- Transfer: ${prodNama} ${fmt(harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(totalTF)}
- COD: ${prodNama} ${fmt(harga)} + ongkir ${ongkirDisplay} + admin ${fmt(feeCOD)} = TOTAL ${fmt(totalCOD)}

Kalau customer belum pilih metode bayar → tampilkan total keduanya + tanya "Mau COD atau Transfer kak? 😊"
Kalau customer sudah pilih COD → tampilkan total COD + minta data lengkap yang belum ada.
Kalau customer sudah pilih Transfer → tampilkan total Transfer.
Format angka: tanpa desimal, pakai titik ribuan.`;

  } else if (wilayahState && !ongkirState) {
    // Skenario B: wilayah confirmed tapi ongkir belum dihitung → hitung sekarang
    const qty = convState.qty || 1;
    const hasilOngkir = await hitungOngkirByWilayah(wilayahState, product, userId, qty);
    if (hasilOngkir) {
      const fmt = n => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
      const prodNama = product?.nama || 'Produk';
      ongkirContext = `\n\nDATA ONGKIR (baru dihitung, WAJIB tampilkan di saran):
- Wilayah tujuan: ${wilayahState}
- Ekspedisi: ${hasilOngkir.kurir}
- Ongkir: ${hasilOngkir.ongkirDisplay}
- Transfer: ${prodNama} ${fmt(hasilOngkir.harga)} + ongkir ${hasilOngkir.ongkirDisplay} = TOTAL ${fmt(hasilOngkir.totalTF)}
- COD: ${prodNama} ${fmt(hasilOngkir.harga)} + ongkir ${hasilOngkir.ongkirDisplay} + admin ${fmt(hasilOngkir.feeCOD)} = TOTAL ${fmt(hasilOngkir.totalCOD)}

Kalau customer belum pilih metode bayar → tampilkan total keduanya + tanya "Mau COD atau Transfer kak? 😊"
Format angka: tanpa desimal, pakai titik ribuan.`;
    } else {
      ongkirContext = `\n\nSITUASI: Wilayah customer (${wilayahState}) diketahui tapi ongkir gagal dihitung.
JANGAN tebak atau estimasi ongkir. Sarankan balasan: "Sebentar ya kak, aku cek ongkirnya dulu 😊"`;
    }

  } else if (proposedWilayah && !wilayahState) {
    // Skenario C: wilayah belum dikonfirmasi (proposed) dan ongkir belum dihitung
    ongkirContext = `\n\nSITUASI: Wilayah customer (${proposedWilayah}) belum terkonfirmasi dan ongkir belum dihitung.
Saran balasan: minta customer balas ulang dengan kecamatan saja supaya sistem bisa hitung otomatis. Contoh: "Kak boleh ketik ulang kecamatannya saja ya, biar aku bisa cek ongkirnya 😊"`;

  }

  // Bersihkan messages sebelum dikirim ke Claude
  const cleaned = messages
    .map(m => ({
      role: m.role,
      // Hapus semua marker internal dan pesan sistem
      content: (m.content || '')
        .replace(/\[SISTEM[^\]]*\]/g, '')
        .replace(/\[WILAYAH_OK:[^\]]+\]/g, '')
        .replace(/\[CEK_ONGKIR:[^\]]+\]/g, '')
        .replace(/\[KELUHAN:[^\]]+\]/g, '')
        .replace(/\[ALAMAT_OK:[^\]]+\]/g, '')
        .replace(/\[ORDER_CONFIRMED\]/g, '')
        .replace(/\[ORDER_DATA:[^\]]+\]/g, '')
        .replace(/\[ESCALATE\]/g, '')
        .replace(/\[GANTI_KURIR:[^\]]+\]/g, '')
        .trim(),
    }))
    .filter(m => m.content.length > 0)                 // buang pesan kosong setelah dibersihkan
    .filter(m => !m.content.startsWith('[SISTEM'))      // buang sisa injeksi sistem
    .filter(m => !m.content.startsWith('[KTP '))        // buang notif KTP
    .filter(m => !m.content.startsWith('[Gambar '));    // buang notif gambar

  // Pastikan role alternating (Claude API wajib user→assistant→user)
  const alternating = [];
  for (const msg of cleaned) {
    const last = alternating[alternating.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n' + msg.content; // gabung consecutive same role
    } else {
      alternating.push({ ...msg });
    }
  }
  // Harus mulai dari 'user'
  if (alternating.length && alternating[0].role === 'assistant') alternating.shift();
  // Harus berakhir dengan 'user' (Claude API tidak bisa generate kalau last message assistant)
  while (alternating.length && alternating[alternating.length - 1].role === 'assistant') {
    alternating.pop();
  }
  if (!alternating.length) return res.status(400).json({ error: 'Tidak ada pesan customer yang valid' });

  // Build info harga produk (bundling jika ada, satuan jika tidak)
  let produkInfo = '';
  if (product) {
    let bundling = product.harga_bundling || [];
    if (typeof bundling === 'string') try { bundling = JSON.parse(bundling); } catch { bundling = []; }
    if (Array.isArray(bundling) && bundling.length) {
      const bundlingTxt = bundling.map(b => `${b.qty} box = Rp ${Number(b.harga).toLocaleString('id-ID')}${b.prioritas ? ' (PRIORITAS)' : ''}`).join(', ');
      produkInfo = `Produk: ${product.nama} | Paket: ${bundlingTxt} | JANGAN sebut harga satuan`;
    } else {
      produkInfo = `Produk: ${product.nama}, Harga: Rp ${Number(product.harga || 0).toLocaleString('id-ID')}`;
    }
  }

  const sysPrompt = `Kamu CS toko yang membalas pesan WhatsApp customer. Nama kamu "Sari".
Tugas: buat SATU balasan terbaik untuk melanjutkan percakapan ini.
${produkInfo}
Rules:
- Pendek (1-3 kalimat), hangat, natural, tidak formal
- DILARANG markdown (*bold*, _italic_, dll) — ini WhatsApp
- Panggil "Kak", emoji secukupnya
- Jangan ulangi apa yang sudah dibahas
- Baca seluruh konteks percakapan dan buat balasan yang RELEVAN dengan pesan terakhir${ongkirContext}`;

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: sysPrompt,
        messages: alternating,
      }),
    }, 20000); // 20 detik timeout
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    return res.status(200).json({ reply: data.content?.[0]?.text || '' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
