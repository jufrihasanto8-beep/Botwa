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

  // ── GET: baca courier_whitelist pakai service key (bypass RLS) ──
  if (req.method === 'GET') {
    const { userId, user_id, action, key } = req.query || {};

    // Proxy: fetch Mengantar origin addresses (bypass CORS)
    if (action === 'mengantar-origins') {
      if (!key) return res.status(400).json({ error: 'key wajib' });
      try {
        const BASE = `https://app.mengantar.com/api/public/${key}`;
        const CANDIDATES = ['address', 'warehouse', 'pickup', 'origin', 'sender'];
        let found = null;
        for (const slug of CANDIDATES) {
          const mRes = await fetch(`${BASE}/${slug}`, { headers: { 'Accept': 'application/json' } });
          const mText = await mRes.text();
          if (mRes.ok) {
            let json; try { json = JSON.parse(mText); } catch { json = mText; }
            found = { slug, json };
            break;
          }
          // 404 → coba berikutnya; error lain → stop
          if (mRes.status !== 404) {
            return res.status(200).json({ ok: false, status: mRes.status, slug, raw: mText });
          }
        }
        if (!found) return res.status(200).json({ ok: false, error: 'Tidak ada endpoint yang cocok', tried: CANDIDATES });
        return res.status(200).json({ ok: true, slug: found.slug, data: found.json });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    const uid = userId || user_id;
    if (!uid) return res.status(400).json({ error: 'userId wajib' });
    try {
      const data = await sbReq('GET', `courier_whitelist?user_id=eq.${uid}&order=nama.asc`);
      return res.status(200).json({ ok: true, data });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};

  // ── Legacy: update kolom users (rekening / anthropic_key) ──
  if (body.user_id && ('rekening' in body || 'anthropic_key' in body || 'group_jid' in body || 'mengantar_key' in body || 'mengantar_origin_id' in body)) {
    try {
      const patch = {};
      if ('rekening' in body)            patch.rekening            = body.rekening;
      if ('anthropic_key' in body)       patch.anthropic_key       = body.anthropic_key;
      if ('group_jid' in body)           patch.group_jid           = body.group_jid;
      if ('mengantar_key' in body)       patch.mengantar_key       = body.mengantar_key;
      if ('mengantar_origin_id' in body) patch.mengantar_origin_id = body.mengantar_origin_id;
      await sbReq('PATCH', `users?id=eq.${body.user_id}`, patch);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Template notif ──
  if (body.userId && body.table === 'users_template' && body.payload) {
    const allowed = ['template_resi_dikirim', 'template_tiba_kota', 'template_out_for_delivery', 'template_delivered', 'template_bermasalah', 'template_retur', 'template_form_lead'];
    const patch = {};
    for (const key of allowed) {
      if (key in body.payload) patch[key] = body.payload[key];
    }
    try {
      await sbReq('PATCH', `users?id=eq.${body.userId}`, patch);
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
