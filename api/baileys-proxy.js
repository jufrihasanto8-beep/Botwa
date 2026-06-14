/**
 * Baileys Proxy — forward request dari frontend (HTTPS) ke Baileys VPS (HTTP)
 * Semua endpoint: GET/POST ke /api/baileys-proxy?path=/session/status/xxx
 */

const BAILEYS_URL    = process.env.BAILEYS_URL    || 'http://13.140.178.4:3000';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.query.path || '/health';
  const url  = BAILEYS_URL + path;

  try {
    const fetchOpts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method === 'POST' && req.body) {
      // Inject secret dari env — frontend tidak perlu tahu secret-nya
      const body = { ...req.body, secret: WEBHOOK_SECRET };
      fetchOpts.body = JSON.stringify(body);
    }

    const upstream = await fetch(url, fetchOpts);
    const data     = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Tidak bisa terhubung ke Baileys server', detail: e.message });
  }
}
