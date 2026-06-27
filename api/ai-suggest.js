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

async function getUserAnthropicKey(userId) {
  if (!userId) return null;
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=anthropic_key&limit=1`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
    }, 5000);
    const data = await res.json();
    return data[0]?.anthropic_key || null;
  } catch { return null; }
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

  } else if (proposedWilayah && !wilayahState) {
    // Skenario B: wilayah belum dikonfirmasi (proposed) dan ongkir belum dihitung
    // Hanya trigger kalau wilayah BELUM confirmed — jangan ganggu kalau wilayah sudah confirmed
    ongkirContext = `\n\nSITUASI: Wilayah customer sudah diketahui (${proposedWilayah}) tapi ongkir belum berhasil dihitung sistem.
Saran balasan: minta customer balas ulang dengan kecamatan saja (lebih pendek) supaya sistem bisa hitung otomatis. Contoh: "Kak boleh ketik ulang kecamatannya saja ya, biar aku bisa cek ongkirnya 😊"`;

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

  const sysPrompt = `Kamu CS toko yang membalas pesan WhatsApp customer. Nama kamu "Sari".
Tugas: buat SATU balasan terbaik untuk melanjutkan percakapan ini.
${product ? `Produk: ${product.nama}, Harga: Rp ${product.harga?.toLocaleString('id-ID')}` : ''}
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
