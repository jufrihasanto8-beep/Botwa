// Vercel Serverless Function — Terima pesan masuk dari Fonnte → AI balas otomatis

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ── SUPABASE HELPERS ── */
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

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
  return res.json();
}

/* ── FIND / CREATE CONTACT ── */
async function findOrCreateContact(userId, phone, name) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const existing = await sbGet('contacts', `?user_id=eq.${userId}&phone=eq.${cleanPhone}`);
  if (existing.length) return existing[0];
  const rows = await sbPost('contacts', { user_id: userId, name: name || cleanPhone, phone: cleanPhone });
  return rows[0];
}

/* ── MESSAGES ── */
async function getHistory(contactId, userId) {
  return sbGet('messages', `?contact_id=eq.${contactId}&user_id=eq.${userId}&order=created_at.asc&limit=20`);
}

async function saveMessage(contactId, userId, role, content) {
  return sbPost('messages', { contact_id: contactId, user_id: userId, role, content, sent_to_wa: role === 'assistant' });
}

/* ── BUILD SYSTEM PROMPT ── */
async function buildSystemPrompt(config, userId) {
  const storeName = config.store_name || 'Toko';

  let sys = `Kamu adalah CS ${storeName} yang melayani pelanggan lewat WhatsApp. Kamu harus terdengar seperti manusia sungguhan, bukan bot.

KEPRIBADIAN:
Kamu hangat, peduli, dan nyambung ngobrolnya. Seperti teman yang kerja di toko — bukan sales yang lagi pitch produk.

CARA BALAS PESAN:
- Kalau pelanggan cerita keluhan → empati dulu, JANGAN langsung sebut produk
- Jangan tulis meta-komentar seperti "nanya dulu biar bisa bantu..."
- Produk disebut setelah konteks cukup, disampaikan natural
- Kalau pelanggan tolak → gali kenapa dulu, jangan langsung menyerah
- Kalau tanya produk/harga langsung → jawab langsung

CONTOH SALAH: "Nanya dulu biar bisa kasih saran yang lebih pas 🙏"
CONTOH BENAR: "Ih sinusitis emang ngeselin ya... Lagi sering kambuh atau baru parah?"

FORMAT:
- DILARANG markdown: jangan **bold**, jangan ---, jangan > quote
- 2-4 baris, casual, seperti chat WA beneran
- Emoji seperlunya, jangan tiap kalimat

KONTEN:
- Hanya rekomendasikan produk yang ada di katalog
- Jangan sebut nama AI atau Claude
- Keluhan medis serius → sarankan konsul dokter juga`;

  const info = [];
  if (config.store_hours) info.push(`Jam: ${config.store_hours}`);
  if (config.store_wa) info.push(`WA: ${config.store_wa}`);
  if (config.store_address) info.push(`Lokasi: ${config.store_address}`);
  if (info.length) sys += `\n\n== INFO TOKO ==\n${info.join('\n')}`;
  if (config.store_policy) sys += `\n\n== KEBIJAKAN ==\n${config.store_policy}`;
  if (config.store_order) sys += `\n\n== CARA ORDER ==\n${config.store_order}`;
  if (config.ai_extra) sys += `\n\nInstruksi Tambahan:\n${config.ai_extra}`;
  if (config.ai_insights) sys += `\n\n== PELAJARAN DARI CHAT SEBELUMNYA ==\n${config.ai_insights}`;

  try {
    const products = await sbGet('products', `?user_id=eq.${userId}&order=created_at.asc`);
    if (products.length) {
      sys += '\n\n== KATALOG PRODUK ==';
      products.forEach(p => {
        sys += `\n\nPRODUK: ${p.name}`;
        if (p.code) sys += ` (${p.code})`;
        if (p.price) sys += `\nHarga: Rp ${p.price}${p.unit ? ' / ' + p.unit : ''}`;
        if (p.stock) sys += `\nStok: ${p.stock}`;
        if (p.benefits) sys += `\nManfaat: ${p.benefits}`;
        if (p.ingredients) sys += `\nKandungan: ${p.ingredients}`;
        if (p.usage) sys += `\nCara Pakai: ${p.usage}`;
        if (p.suitable_for) sys += `\nCocok Untuk: ${p.suitable_for}`;
        if (p.contraindications) sys += `\nPerhatian: ${p.contraindications}`;
      });
      sys += '\n\n== AKHIR KATALOG ==';
    }
  } catch (e) { console.error('Gagal load produk:', e.message); }

  try {
    const faqs = await sbGet('faqs', `?user_id=eq.${userId}&order=created_at.asc`);
    if (faqs.length) {
      sys += '\n\n== FAQ ==';
      faqs.forEach(f => { sys += `\n\nQ: ${f.question}\nA: ${f.answer}`; });
    }
  } catch (e) { console.error('Gagal load FAQ:', e.message); }

  return sys;
}

/* ── CALL CLAUDE ── */
async function callClaude(apiKey, systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  return data.content?.[0]?.text || '';
}

/* ── SEND WA ── */
async function sendWA(token, phone, message) {
  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: { 'Authorization': token },
    body: new URLSearchParams({ target: phone, message, countryCode: '62' }),
  });
  return res.json();
}

/* ── MAIN HANDLER ── */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Webhook aktif ✅');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // Fonnte bisa kirim JSON atau form-data — handle keduanya
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(body)); }
    }

    console.log('Webhook received:', JSON.stringify(body));

    // Parse field dari Fonnte
    const sender  = String(body.sender  || body.from   || '').replace(/\D/g, '');
    const message = String(body.message || body.text   || '').trim();
    const name    = String(body.name    || body.pushname || sender);
    const device  = String(body.device  || body.phone  || '').replace(/\D/g, '');

    // Abaikan kalau tidak ada pesan atau pengirim
    if (!sender || !message) {
      console.log('Skip: sender atau message kosong');
      return res.status(200).json({ ok: true });
    }

    // Abaikan pesan dari bot sendiri
    if (sender === device) {
      console.log('Skip: pesan dari device sendiri');
      return res.status(200).json({ ok: true });
    }

    // Abaikan pesan grup
    if (sender.includes('-') || sender.endsWith('@g.us')) {
      console.log('Skip: pesan grup');
      return res.status(200).json({ ok: true });
    }

    console.log(`Pesan dari ${name} (${sender}): ${message}`);

    // Cari config user berdasarkan cs_number = device
    let config = null;
    let userId = null;

    if (device) {
      const byDevice = await sbGet('configs', `?cs_number=eq.${device}`);
      if (byDevice.length) { config = byDevice[0]; userId = config.user_id; }
    }

    // Fallback: pakai config pertama
    if (!config) {
      const all = await sbGet('configs', `?limit=1`);
      if (all.length) { config = all[0]; userId = config.user_id; }
    }

    if (!userId) {
      console.error('Tidak ada user/config ditemukan di Supabase');
      return res.status(200).json({ ok: true });
    }

    if (!config.anthropic_key) {
      console.error('Anthropic API key belum diset di Settings');
      return res.status(200).json({ ok: true });
    }

    if (!config.fonnte_token) {
      console.error('Fonnte token belum diset di Settings');
      return res.status(200).json({ ok: true });
    }

    // Cari / buat kontak
    const contact = await findOrCreateContact(userId, sender, name);

    // Simpan pesan masuk
    await saveMessage(contact.id, userId, 'user', message);

    // Ambil history + build prompt
    const history = await getHistory(contact.id, userId);
    const messages = history.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    const systemPrompt = await buildSystemPrompt(config, userId);

    // Panggil Claude
    const reply = await callClaude(config.anthropic_key, systemPrompt, messages);
    if (!reply) return res.status(200).json({ ok: true });

    console.log(`Reply untuk ${sender}: ${reply}`);

    // Simpan & kirim balasan
    await saveMessage(contact.id, userId, 'assistant', reply);
    await sendWA(config.fonnte_token, sender, reply);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(200).json({ ok: true }); // Selalu 200 ke Fonnte
  }
};
