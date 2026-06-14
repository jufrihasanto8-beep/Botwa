/**
 * AI Suggest Reply — dipanggil dari dashboard untuk generate saran balasan
 */
const ANTHROPIC_KEY     = process.env.ANTHROPIC_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getUserAnthropicKey(userId) {
  if (!userId) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=anthropic_key&limit=1`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    const data = await res.json();
    return data[0]?.anthropic_key || null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { messages, product, userId } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: 'messages wajib' });

  const userKey = await getUserAnthropicKey(userId);
  const apiKey  = userKey || ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY belum diset' });

  const sysPrompt = `Kamu CS toko yang membalas pesan WhatsApp customer. Nama kamu "Sari".
Tugas: buat SATU balasan terbaik untuk melanjutkan percakapan ini.
${product ? `Produk: ${product.nama}, Harga: Rp ${product.harga?.toLocaleString('id-ID')}` : ''}
Rules:
- Pendek (1-3 kalimat), hangat, natural, tidak formal
- DILARANG markdown (*bold*, _italic_, dll) — ini WhatsApp
- Panggil "Kak", emoji secukupnya
- Jangan ulangi apa yang sudah dibahas`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages,
      }),
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    return res.status(200).json({ reply: data.content?.[0]?.text || '' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
