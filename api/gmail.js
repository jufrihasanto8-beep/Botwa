/**
 * /api/gmail — handles semua Gmail integration
 *
 * Routing:
 *   GET  ?action=url&user_id=xxx        → generate Google OAuth URL
 *   GET  ?action=status&user_id=xxx     → cek status koneksi Gmail
 *   GET  ?action=disconnect&user_id=xxx → putus koneksi Gmail
 *   GET  ?code=xxx&state=xxx            → OAuth callback dari Google
 *   POST header x-cron-secret          → gmail poller (cron tiap 5 menit)
 *   POST body { form_token, ... }       → form lead dari orderonline.id / n8n
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BAILEYS_URL          = process.env.BAILEYS_URL;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;
const CRON_SECRET          = process.env.CRON_SECRET;
const APP_URL              = 'https://csadsy.vercel.app';
const REDIRECT_URI         = `${APP_URL}/api/gmail`;

const SCOPE = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ── Supabase helpers ──────────────────────────────────────
const sbH = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Prefer': 'return=representation',
};
async function sbGet(table, query = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbPost(table, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: sbH, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbPatch(table, query, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
}

// ── Normalisasi nomor WA ──────────────────────────────────
function normalizeWA(hp) {
  let n = (hp || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('8')) n = '62' + n;
  if (!n.startsWith('62')) n = '62' + n;
  return n;
}

// ── Google OAuth helpers ──────────────────────────────────
async function getAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Token error: ${d.error} — ${d.error_description}`);
  return d.access_token;
}

// ── Gmail API helpers ─────────────────────────────────────
async function searchEmails(accessToken) {
  const q = encodeURIComponent('from:support@orderonline.id is:unread');
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=10`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const d = await r.json();
  return d.messages || [];
}
async function getEmail(accessToken, id) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return r.json();
}
async function markAsRead(accessToken, id) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });
}
function decodeBase64(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}
function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    const html = payload.parts.find(p => p.mimeType === 'text/html');
    if (html?.body?.data) return decodeBase64(html.body.data);
    const txt = payload.parts.find(p => p.mimeType === 'text/plain');
    if (txt?.body?.data) return decodeBase64(txt.body.data);
    for (const p of payload.parts) { const b = extractBody(p); if (b) return b; }
  }
  return '';
}
function parseOrderEmail(body) {
  const namaMatch   = body.match(/Nama[^:]*:\s*<\/?(b|strong|td)[^>]*>\s*([^<\n]+)/i)
                   || body.match(/Nama[^:]*:\s*([^\n<]+)/i);
  const hpMatch     = body.match(/No\.?\s*Telepon[^:]*:\s*<\/?(b|strong|td)[^>]*>\s*([+\d\s]+)/i)
                   || body.match(/No\.?\s*(?:Telepon|HP)[^:]*:\s*([+\d][\d\s\-]{7,})/i);
  const alamatMatch = body.match(/Alamat[^:]*:\s*<\/?(b|strong|td)[^>]*>\s*([^<\n]+)/i)
                   || body.match(/Alamat[^:]*:\s*([^\n<]+)/i);
  const produkMatch = body.match(/<td[^>]*>\s*([A-Za-z][^<]{3,80}?)\s*<\/td>\s*(?:<[^>]+>)*\s*Rp/i)
                   || body.match(/([A-Za-z][^\n<]{3,60}?)\s+Rp[\d.,]+/i);
  const orderIdMatch = body.match(/Order\s*ID[^:]*:\s*(\d+)/i);
  return {
    nama:    (namaMatch?.[namaMatch.length - 1]   || '').trim(),
    hp:      (hpMatch?.[hpMatch.length - 1]       || '').replace(/[\s\-]/g, '').trim(),
    alamat:  (alamatMatch?.[alamatMatch.length - 1]|| '').replace(/,\s*-\s*/g, ', ').trim(),
    produk:  (produkMatch?.[1]                    || '').trim(),
    orderId: (orderIdMatch?.[1]                   || '').trim(),
  };
}

// ── Parse alamat dari string → JSONB + cek kelengkapan ───
function parseAlamat(raw) {
  if (!raw) return { jsonb: null, lengkap: false };

  // Bersihkan tanda "-" tunggal di setiap bagian
  const parts = raw.split(',').map(p => p.trim()).filter(p => p && p !== '-');

  let jalan = '', kecamatan = '', kabupaten = '', provinsi = '';

  if (parts.length >= 4) {
    [jalan, kecamatan, kabupaten, provinsi] = parts;
  } else if (parts.length === 3) {
    [jalan, kabupaten, provinsi] = parts;
  } else if (parts.length === 2) {
    [jalan, kabupaten] = parts;
  } else {
    jalan = parts[0] || raw;
  }

  const jsonb = { jalan, kecamatan, kabupaten, provinsi };

  // Alamat dianggap lengkap kalau minimal ada jalan + kabupaten
  const lengkap = !!(jalan && kabupaten && jalan.length > 3 && kabupaten.length > 2);

  return { jsonb, lengkap };
}

// ── Render template dengan variabel ──────────────────────
function renderTemplate(template, { nama, produk, alamat, hp }) {
  const namaSapa = nama ? nama.split(' ')[0] : 'kak';
  return template
    .replace(/\{nama\}/gi,   namaSapa)
    .replace(/\{produk\}/gi, produk  || '')
    .replace(/\{alamat\}/gi, alamat  || '')
    .replace(/\{wa\}/gi,     hp      || '')
    .trim();
}

// ── Proses satu order lead (shared oleh poller & form-lead) ──
async function processLead(userId, { nama, hp, alamat, produk }) {
  const waNumber = normalizeWA(hp);
  const now = new Date().toISOString();

  // Parse alamat
  const { jsonb: alamatJsonb, lengkap: alamatLengkap } = parseAlamat(alamat);

  // ── Cek apakah customer sudah ada ───────────────────────
  const existing    = await sbGet('customers', `?user_id=eq.${userId}&wa_number=eq.${waNumber}&limit=1`);
  const isNewCustomer = existing.length === 0;
  let customerId;

  if (existing.length) {
    // Customer lama — update data yang kurang saja
    customerId = existing[0].id;
    const patch = {};
    if (nama && !existing[0].nama) patch.nama = nama;
    if (alamatJsonb && !existing[0].alamat?.kabupaten) patch.alamat = alamatJsonb;
    if (Object.keys(patch).length) await sbPatch('customers', `?id=eq.${customerId}`, patch);
  } else {
    // Customer baru — insert
    const c = await sbPost('customers', {
      user_id: userId, wa_number: waNumber,
      nama: nama || null, alamat: alamatJsonb || null,
    });
    customerId = c[0]?.id;
  }

  // ── Upsert conversation ──────────────────────────────────
  const existingConv = customerId ? await sbGet('conversations',
    `?user_id=eq.${userId}&customer_id=eq.${customerId}&order=created_at.desc&limit=1`
  ) : [];

  let convId;
  const convState = {
    tahap: isNewCustomer ? 'awal' : existingConv[0]?.state?.tahap || 'awal',
    is_form_lead: true,
    form_produk: produk || null,
    form_alamat: alamat || null,
    alamat_lengkap: alamatLengkap,
    followed_up: false,
    order_placed: existingConv[0]?.state?.order_placed || false,
  };

  if (existingConv.length) {
    convId = existingConv[0].id;
    await sbPatch('conversations', `?id=eq.${convId}`, {
      state: { ...existingConv[0].state, ...convState },
      updated_at: now,
    });
  } else {
    const c = await sbPost('conversations', {
      user_id: userId, customer_id: customerId || null,
      state: convState, eskalasi: false, created_at: now, updated_at: now,
    });
    convId = c[0]?.id;
  }

  // ── Customer lama → simpan data saja, tidak kirim WA ────
  if (!isNewCustomer) {
    return { waNumber, convId, ok: true, skipped: true, reason: 'customer lama, data diperbarui' };
  }

  // ── Customer baru → kirim WA template ───────────────────
  const userRows = await sbGet('users', `?id=eq.${userId}&select=template_form_lead&limit=1`);
  const tmpl     = userRows[0]?.template_form_lead;

  const namaSapa     = nama ? nama.split(' ')[0] : 'kak';
  const produkTxt    = produk ? ` untuk *${produk}*` : '';
  const defaultPesan = `Halo *${namaSapa}* 👋\n\nTerima kasih sudah melakukan pemesanan${produkTxt}! 🙏\n\nKami sedang memproses pesanan kakak. Boleh kami konfirmasi dulu beberapa detailnya?`;
  const pesan        = tmpl ? renderTemplate(tmpl, { nama, produk, alamat, hp }) : defaultPesan;

  const br = await fetch(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, session_id: userId,
                           wa_number: waNumber, message: pesan, is_outbound: true }),
  });

  if (br.ok && convId) {
    await sbPost('conv_messages', {
      conversation_id: convId, role: 'assistant', content: pesan, created_at: now,
    }).catch(() => {});
  }
  return { waNumber, convId, ok: br.ok };
}

// ═══════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, user_id, code, state, error } = req.query;

  // ──────────────────────────────────────────────────────
  // GET: OAuth & Status routes
  // ──────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // Generate OAuth URL
    if (action === 'url') {
      if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI,
        response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state: user_id,
      });
      return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    }

    // Cek status
    if (action === 'status') {
      if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
      const rows = await sbGet('users', `?id=eq.${user_id}&select=gmail_email,gmail_last_checked&limit=1`);
      const row  = rows[0] || {};
      return res.json({ connected: !!row.gmail_email, gmail_email: row.gmail_email || null,
                        gmail_last_checked: row.gmail_last_checked || null });
    }

    // Disconnect
    if (action === 'disconnect') {
      if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
      await sbPatch('users', `?id=eq.${user_id}`,
        { gmail_email: null, gmail_refresh_token: null, gmail_last_checked: null });
      return res.json({ ok: true });
    }

    // OAuth callback dari Google
    if (error) return res.redirect(`${APP_URL}/settings.html?gmail=cancelled`);

    if (code && state) {
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
          }),
        });
        const tokens = await tokenRes.json();
        if (tokens.error) return res.redirect(`${APP_URL}/settings.html?gmail=error&reason=${tokens.error}`);

        const uiRes  = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
          { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        const uiData = await uiRes.json();

        await sbPatch('users', `?id=eq.${state}`, {
          gmail_email: uiData.email || null,
          gmail_refresh_token: tokens.refresh_token,
          gmail_last_checked: null,
        });

        return res.redirect(`${APP_URL}/settings.html?gmail=success&email=${encodeURIComponent(uiData.email || '')}`);
      } catch(e) {
        console.error('OAuth callback error:', e);
        return res.redirect(`${APP_URL}/settings.html?gmail=error&reason=server`);
      }
    }

    return res.status(400).json({ error: 'Invalid GET request' });
  }

  // ──────────────────────────────────────────────────────
  // POST: Cron poller atau Form Lead
  // ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const cronSecret = req.headers['x-cron-secret'];
    const body       = req.body || {};

    // ── Gmail Poller (cron) ────────────────────────────
    if (cronSecret === CRON_SECRET || cronSecret === WEBHOOK_SECRET) {
      const start   = Date.now();
      const results = [];
      const users   = await sbGet('users',
        `?gmail_refresh_token=not.is.null&select=id,gmail_email,gmail_refresh_token`);

      if (!users.length) return res.json({ ok: true, message: 'Tidak ada Gmail terhubung' });

      for (const user of users) {
        const log = { user_id: user.id, gmail: user.gmail_email, processed: 0, errors: [] };
        try {
          const token    = await getAccessToken(user.gmail_refresh_token);
          const messages = await searchEmails(token);
          log.emails_found = messages.length;

          for (const msg of messages) {
            try {
              const email     = await getEmail(token, msg.id);
              const emailBody = extractBody(email.payload);
              if (!emailBody) { await markAsRead(token, msg.id); continue; }

              const orderData = parseOrderEmail(emailBody);
              if (!orderData.hp) { await markAsRead(token, msg.id); continue; }

              await processLead(user.id, orderData);
              await markAsRead(token, msg.id);
              log.processed++;
            } catch(e) {
              log.errors.push({ msg_id: msg.id, error: e.message });
              try { await markAsRead(token, msg.id); } catch(_) {}
            }
          }
          await sbPatch('users', `?id=eq.${user.id}`, { gmail_last_checked: new Date().toISOString() });
        } catch(e) { log.errors.push({ error: e.message }); }
        results.push(log);
      }
      return res.json({ ok: true, duration_ms: Date.now() - start, results });
    }

    // ── Form Lead (dari n8n atau manual) ──────────────
    const { form_token, nama, hp, alamat, produk } = body;
    if (form_token) {
      if (!hp) return res.status(400).json({ error: 'hp wajib diisi' });
      const users = await sbGet('users', `?form_token=eq.${form_token}&select=id&limit=1`);
      if (!users.length) return res.status(401).json({ error: 'form_token tidak valid' });
      const result = await processLead(users[0].id, { nama, hp, alamat, produk });
      return res.status(200).json({ ok: true, ...result });
    }

    return res.status(400).json({ error: 'Invalid POST request' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
