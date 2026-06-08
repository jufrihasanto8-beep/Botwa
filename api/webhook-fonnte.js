// Vercel Serverless Function — Terima pesan masuk dari Fonnte → AI balas otomatis

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;

/* ── SUPABASE HELPERS ── */
const sbH = () => ({
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
});

async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ── FIND / CREATE CONTACT ── */
async function findOrCreateContact(userId, phone, name) {
  const cleanPhone = phone.replace(/\D/g, '');
  const existing = await sbGet('contacts', `?user_id=eq.${userId}&phone=eq.${cleanPhone}`);
  if (existing.length) return existing[0];

  const rows = await sbPost('contacts', {
    user_id: userId,
    name: name || cleanPhone,
    phone: cleanPhone,
  });
  return rows[0];
}

/* ── CHAT HISTORY ── */
async function getHistory(contactId, userId, limit = 20) {
  return sbGet('messages', `?contact_id=eq.${contactId}&user_id=eq.${userId}&order=created_at.asc&limit=${limit}`);
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

Kalau pelanggan cerita keluhan/masalah:
→ Empati dulu dengan tulus, TANPA langsung sebut produk
→ Boleh tanya satu pertanyaan lanjutan yang terasa natural
→ JANGAN tulis kenapa kamu nanya (jangan "nanya dulu biar...", dsb)
→ Produk baru disebut setelah ada konteks yang cukup, dan disampaikan dengan natural

Kalau pelanggan tanya produk atau harga:
→ Langsung jawab dengan ramah dan informatif

Kalau pelanggan menolak atau bilang tidak mau:
→ JANGAN langsung menyerah
→ Gali dulu kenapa — kemahalan? masih ragu? sudah coba produk lain?
→ Kalau kemahalan → tawarkan solusi (produk lain, beli 1 dulu, dsb)
→ Kalau ragu → jawab keraguan mereka
→ Maksimal 2x follow up sebelum benar-benar lepas

CONTOH YANG SALAH: "Nanya dulu biar bisa kasih saran yang lebih pas 🙏"
CONTOH YANG BENAR: "Ih sinusitis tuh emang ngeselin banget ya... Lagi sering kambuh atau baru parah belakangan ini?"

FORMAT PESAN:
- DILARANG pakai markdown: jangan **bold**, jangan ---, jangan > quote
- Singkat dan natural, 2-4 baris sudah cukup
- Bahasa casual seperti orang asli chat WA
- Emoji boleh tapi seperlunya

KONTEN:
- Rekomendasikan HANYA produk yang ada di katalog
- Kalau tidak ada yang cocok, jujur bilang tidak ada
- Jangan sebut nama AI atau Claude
- Untuk keluhan medis serius tetap sarankan konsul dokter`;

  // Info toko
  const infoLines = [];
  if (config.store_hours) infoLines.push(`Jam Operasional: ${config.store_hours}`);
  if (config.store_wa) infoLines.push(`No. WhatsApp: ${config.store_wa}`);
  if (config.store_address) infoLines.push(`Alamat: ${config.store_address}`);
  if (infoLines.length) sys += `\n\n== INFO TOKO ==\n${infoLines.join('\n')}`;
  if (config.store_policy) sys += `\n\n== KEBIJAKAN TOKO ==\n${config.store_policy}`;
  if (config.store_order) sys += `\n\n== CARA ORDER ==\n${config.store_order}`;
  if (config.ai_extra) sys += `\n\nInstruksi Tambahan:\n${config.ai_extra}`;
  if (config.ai_insights) sys += `\n\n== PELAJARAN DARI PERCAKAPAN SEBELUMNYA ==\n${config.ai_insights}\n== AKHIR PELAJARAN ==`;

  // Produk dari Supabase
  try {
    const products = await sbGet('products', `?user_id=eq.${userId}&order=created_at.asc`);
    if (products.length) {
      sys += '\n\n== KATALOG PRODUK ==';
      products.forEach(p => {
        sys += `\n\nPRODUK: ${p.name}`;
        if (p.code) sys += ` (Kode: ${p.code})`;
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
  } catch {}

  // FAQ dari Supabase
  try {
    const faqs = await sbGet('faqs', `?user_id=eq.${userId}&order=created_at.asc`);
    if (faqs.length) {
      sys += '\n\n== FAQ ==';
      faqs.forEach(f => { sys += `\n\nQ: ${f.question}\nA: ${f.answer}`; });
      sys += '\n\n== AKHIR FAQ ==';
    }
  } catch {}

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
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

/* ── SEND WA via FONNTE ── */
async function sendWA(token, phone, message) {
  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: { 'Authorization': token },
    body: new URLSearchParams({ target: phone, message, countryCode: '62' }),
  });
  return res.json();
}

/* ── MAIN HANDLER ── */
export default async function handler(req, res) {
  // Fonnte kadang kirim GET untuk verifikasi
  if (req.method === 'GET') return res.status(200).send('Webhook aktif');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body || {};

    // Parse data dari Fonnte
    const sender = (body.sender || body.from || '').replace(/\D/g, '');
    const message = body.message || body.text || '';
    const senderName = body.name || body.pushname || sender;
    const device = (body.device || body.phone || '').replace(/\D/g, '');

    // Abaikan kalau bukan pesan teks atau dari bot sendiri
    if (!sender || !message || sender === device) {
      return res.status(200).json({ ok: true });
    }

    // Abaikan pesan dari grup WA
    if (sender.includes('@g.us') || sender.endsWith('g.us')) {
      return res.status(200).json({ ok: true });
    }

    // Cari config user berdasarkan nomor device (cs_number)
    let config = null;
    let userId = null;

    if (device) {
      const configs = await sbGet('configs', `?cs_number=eq.${device}`);
      if (configs.length) {
        config = configs[0];
        userId = config.user_id;
      }
    }

    // Fallback: pakai config pertama yang ada
    if (!config) {
      const configs = await sbGet('configs', `?limit=1`);
      if (configs.length) {
        config = configs[0];
        userId = config.user_id;
      }
    }

    if (!userId) {
      console.error('Tidak ada user/config ditemukan');
      return res.status(200).json({ ok: true });
    }

    // Cari / buat kontak
    const contact = await findOrCreateContact(userId, sender, senderName);

    // Simpan pesan masuk
    await saveMessage(contact.id, userId, 'user', message);

    // Ambil history chat (tidak termasuk pesan yang baru disimpan)
    const history = await getHistory(contact.id, userId, 20);
    const messages = history.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(config, userId);

    // Panggil Claude
    const claudeKey = config.anthropic_key || CLAUDE_API_KEY;
    const reply = await callClaude(claudeKey, systemPrompt, messages);

    if (!reply) return res.status(200).json({ ok: true });

    // Simpan balasan AI
    await saveMessage(contact.id, userId, 'assistant', reply);

    // Kirim ke WA pelanggan
    const fonnteToken = config.fonnte_token || FONNTE_TOKEN;
    await sendWA(fonnteToken, sender, reply);

    return res.status(200).json({ ok: true, reply });

  } catch (err) {
    console.error('Webhook error:', err.message);
    // Selalu return 200 ke Fonnte supaya tidak retry terus
    return res.status(200).json({ ok: true });
  }
}
