/**
 * Vercel Serverless — Save settings (service key, bypass RLS)
 * Handles: users.rekening PATCH + courier_whitelist CRUD
 */
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbH = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Prefer': 'return=representation',
};

async function sbReq(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: sbH,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return method === 'DELETE' ? null : res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};

  // ── Legacy: update kolom users (rekening / anthropic_key) ──
  if (body.user_id && ('rekening' in body || 'anthropic_key' in body)) {
    try {
      const patch = {};
      if ('rekening' in body)      patch.rekening      = body.rekening;
      if ('anthropic_key' in body) patch.anthropic_key = body.anthropic_key;
      await sbReq('PATCH', `users?id=eq.${body.user_id}`, patch);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Generic CRUD: table + action ──
  const { userId, table, action, id, payload } = body;
  const ALLOWED = ['courier_whitelist'];
  if (!userId || !table || !ALLOWED.includes(table)) {
    return res.status(400).json({ error: 'Parameter tidak valid' });
  }

  try {
    let data;
    if (action === 'insert') {
      data = await sbReq('POST', table, payload);
    } else if (action === 'update') {
      if (!id) return res.status(400).json({ error: 'id wajib untuk update' });
      data = await sbReq('PATCH', `${table}?id=eq.${id}&user_id=eq.${userId}`, payload);
    } else if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id wajib untuk delete' });
      await sbReq('DELETE', `${table}?id=eq.${id}&user_id=eq.${userId}`);
      data = null;
    } else {
      return res.status(400).json({ error: 'action tidak valid' });
    }
    return res.status(200).json({ ok: true, data });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
