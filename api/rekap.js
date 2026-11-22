// ══════════════════════════════════════════════
//  Rekap + Company Auth API
//  - GET/POST tanpa action → rekap harian (cron)
//  - POST ?action=company-login/logout/check
//  - GET/POST ?action=company-list/create/update/delete (SPV only)
// ══════════════════════════════════════════════

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SPV_USERNAME = 'Alam';
const SPV_PASSWORD = 'Sukses2023';

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
    method: 'POST', headers: { ...sbH(), 'Prefer': 'return=representation' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
  return res.json();
}
async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH', headers: { ...sbH(), 'Prefer': 'return=representation' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch ${table}: ${await res.text()}`);
  return res.json();
}
async function sbDelete(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { method: 'DELETE', headers: sbH() });
  if (!res.ok) throw new Error(`sbDelete ${table}: ${await res.text()}`);
}

function hashPw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

function setCookie(res, name, val, maxAge) {
  res.setHeader('Set-Cookie', `${name}=${val}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}
function getCookie(req, name) {
  const c = (req.headers.cookie || '').split(';').find(s => s.trim().startsWith(name + '='));
  return c ? c.split('=')[1].trim() : null;
}

// ── Company Auth ──────────────────────────────────────────
async function companyLogin(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib' });

  // SPV login
  if (username === SPV_USERNAME && password === SPV_PASSWORD) {
    const token = crypto.randomUUID();
    setCookie(res, 'company_session', `spv_${token}`, 7 * 86400);
    return res.json({ ok: true, role: 'spv', name: 'SPV Admin' });
  }

  // Company login
  const rows = await sbGet('companies', `?username=eq.${encodeURIComponent(username)}&aktif=eq.true&limit=1`);
  if (!rows.length) return res.status(401).json({ error: 'Username tidak ditemukan' });

  const company = rows[0];
  if (company.password_hash !== hashPw(password)) return res.status(401).json({ error: 'Password salah' });

  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  await sbPatch('companies', `?id=eq.${company.id}`, { session_token: token, session_expires_at: expires });

  setCookie(res, 'company_session', token, 7 * 86400);
  return res.json({ ok: true, role: 'company', name: company.name, assigned_user_ids: company.assigned_user_ids });
}

async function companyCheck(req, res) {
  const token = getCookie(req, 'company_session');
  if (!token) return res.json({ logged_in: false });

  // SPV session
  if (token.startsWith('spv_')) return res.json({ logged_in: true, role: 'spv', name: 'SPV Admin' });

  // Company session
  const rows = await sbGet('companies', `?session_token=eq.${encodeURIComponent(token)}&aktif=eq.true&limit=1`);
  if (!rows.length) return res.json({ logged_in: false });

  const c = rows[0];
  if (c.session_expires_at && new Date(c.session_expires_at) < new Date()) {
    await sbPatch('companies', `?id=eq.${c.id}`, { session_token: null, session_expires_at: null }).catch(() => {});
    return res.json({ logged_in: false });
  }

  return res.json({ logged_in: true, role: 'company', name: c.name, company_id: c.id, assigned_user_ids: c.assigned_user_ids || [] });
}

async function companyLogout(req, res) {
  const token = getCookie(req, 'company_session');
  if (token && !token.startsWith('spv_')) {
    await sbPatch('companies', `?session_token=eq.${encodeURIComponent(token)}`, { session_token: null, session_expires_at: null }).catch(() => {});
  }
  clearCookie(res, 'company_session');
  return res.json({ ok: true });
}

// ── SPV: manage companies ─────────────────────────────────
async function requireSpv(req, res) {
  const token = getCookie(req, 'company_session');
  if (!token || !token.startsWith('spv_')) { res.status(403).json({ error: 'SPV only' }); return false; }
  return true;
}

async function companyList(req, res) {
  if (!(await requireSpv(req, res))) return;
  const rows = await sbGet('companies', '?order=created_at.desc&select=id,name,username,assigned_user_ids,aktif,created_at');
  return res.json(rows);
}

async function companyCreate(req, res) {
  if (!(await requireSpv(req, res))) return;
  const { name, username, password, assigned_user_ids } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'name, username, password wajib' });
  const rows = await sbPost('companies', { name, username, password_hash: hashPw(password), assigned_user_ids: assigned_user_ids || [] });
  return res.json(rows[0]);
}

async function companyUpdate(req, res) {
  if (!(await requireSpv(req, res))) return;
  const { id, name, username, password, assigned_user_ids, aktif } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id wajib' });
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (username !== undefined) patch.username = username;
  if (password) patch.password_hash = hashPw(password);
  if (assigned_user_ids !== undefined) patch.assigned_user_ids = assigned_user_ids;
  if (aktif !== undefined) patch.aktif = aktif;
  const rows = await sbPatch('companies', `?id=eq.${id}`, patch);
  return res.json(rows[0]);
}

async function companyDelete(req, res) {
  if (!(await requireSpv(req, res))) return;
  const { id } = req.body || req.query || {};
  if (!id) return res.status(400).json({ error: 'id wajib' });
  await sbDelete('companies', `?id=eq.${id}`);
  return res.json({ ok: true });
}

// ── Rekap Harian ──────────────────────────────────────────
async function sendWA(token, phone, message) {
  const r = await fetch('https://api.fonnte.com/send', {
    method: 'POST', headers: { 'Authorization': token },
    body: new URLSearchParams({ target: phone, message, countryCode: '62' }),
  });
  return r.json();
}

function formatRupiah(n) {
  return 'Rp ' + (n || 0).toLocaleString('id-ID');
}

async function rekapHarian(req, res) {
  console.log('Rekap harian started:', new Date().toISOString());

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const dateStr = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  try {
    const configs = await sbGet('configs', `?limit=50`);

    for (const config of configs) {
      const userId = config.user_id;
      const rekapWa = config.rekap_wa;
      const fonnte = config.fonnte_token;
      const storeName = config.store_name || 'Toko';

      if (!fonnte || !rekapWa) continue;

      const [todayMsgs, todayCases, todayOrders, contacts] = await Promise.all([
        sbGet('messages', `?user_id=eq.${userId}&created_at=gte.${todayISO}`),
        sbGet('cases', `?user_id=eq.${userId}&created_at=gte.${todayISO}`).catch(() => []),
        sbGet('orders', `?user_id=eq.${userId}&created_at=gte.${todayISO}`).catch(() => []),
        sbGet('contacts', `?user_id=eq.${userId}&created_at=gte.${todayISO}`).catch(() => []),
      ]);

      const totalPesan = todayMsgs.length;
      const pesanMasuk = todayMsgs.filter(m => m.role === 'user').length;
      const pesanAI = todayMsgs.filter(m => m.role === 'assistant').length;
      const aiRate = pesanMasuk > 0 ? Math.round((pesanAI / pesanMasuk) * 100) : 0;

      const kasesSelesai = todayCases.filter(c => c.status === 'selesai').length;
      const kasesEskalasi = todayCases.filter(c => c.status === 'eskalasi').length;

      const ordersPaid = todayOrders.filter(o => o.payment_status === 'paid');
      const totalRevenue = ordersPaid.reduce((sum, o) => sum + (o.total || 0), 0);
      const ordersTotal = todayOrders.length;

      const newContacts = contacts.length;

      const rekap = `📊 *REKAP HARIAN ${storeName.toUpperCase()}*
${dateStr}
━━━━━━━━━━━━━━━━━━━━━

💬 *PERCAKAPAN*
• Pesan masuk: ${pesanMasuk}
• Dibalas AI: ${pesanAI} (${aiRate}%)
• Kontak baru: ${newContacts}

📋 *CASES*
• Total case hari ini: ${todayCases.length}
• Selesai: ${kasesSelesai} ✅
• Eskalasi: ${kasesEskalasi} ${kasesEskalasi > 0 ? '🚨' : ''}

🛒 *ORDERS*
• Total order: ${ordersTotal}
• Lunas: ${ordersPaid.length}
• Revenue: ${formatRupiah(totalRevenue)}

━━━━━━━━━━━━━━━━━━━━━
🤖 _Laporan otomatis dari Adsy CS_`;

      const sent = await sendWA(fonnte, rekapWa, rekap);
      console.log(`Rekap terkirim ke ${rekapWa}:`, sent.status);
    }

    return res.status(200).json({ ok: true, date: dateStr });

  } catch(err) {
    console.error('Rekap job error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── Router ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || '';

  // Parse body for POST
  if (req.method === 'POST' && !req.body) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      req.body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { req.body = {}; }
  }

  switch (action) {
    case 'company-login':  return companyLogin(req, res);
    case 'company-check':  return companyCheck(req, res);
    case 'company-logout': return companyLogout(req, res);
    case 'company-list':   return companyList(req, res);
    case 'company-create': return companyCreate(req, res);
    case 'company-update': return companyUpdate(req, res);
    case 'company-delete': return companyDelete(req, res);
    default:               return rekapHarian(req, res);
  }
};
