/**
 * /api/gmail — handles semua Gmail integration
 *
 * Routing:
 *   GET  ?action=url&user_id=xxx&product_id=yyy  → generate Google OAuth URL (per produk)
 *   GET  ?action=status&product_id=yyy           → cek status koneksi Gmail produk
 *   GET  ?action=disconnect&product_id=yyy       → putus koneksi Gmail produk
 *   GET  ?code=xxx&state=xxx                     → OAuth callback dari Google
 *   POST header x-cron-secret                   → gmail poller (cron tiap 5 menit)
 *   POST body { form_token, ... }               → form lead dari orderonline.id / n8n
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
  const q = encodeURIComponent('from:support@orderonline.id is:unread in:anywhere');
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

  // HP: tangkap semua variasi label (No. Telepon, Telepon, HP, WA, WhatsApp, Phone, Handphone, Nomor)
  const hpMatch     = body.match(/(?:No\.?\s*)?(?:Telepon|HP|WA|WhatsApp|Phone|Handphone|Nomor\s*(?:WA|HP|Telepon)?)[^:]*:\s*<\/?(b|strong|td)[^>]*>\s*([+\d][\d\s\-()]{7,})/i)
                   || body.match(/(?:No\.?\s*)?(?:Telepon|HP|WA|WhatsApp|Phone|Handphone|Nomor\s*(?:WA|HP|Telepon)?)[^:]*:\s*([+\d][\d\s\-()]{7,})/i)
                   // fallback: cari pola nomor Indonesia di mana saja (08xx/628xx/+628xx, min 10 digit)
                   || body.match(/(?<!\d)((?:\+?62|0)[8]\d{8,11})(?!\d)/);

  const alamatMatch = body.match(/Alamat[^:]*:\s*<\/?(b|strong|td)[^>]*>\s*([^<\n]+)/i)
                   || body.match(/Alamat[^:]*:\s*([^\n<]+)/i);
  const produkMatch = body.match(/<td[^>]*>\s*([A-Za-z][^<]{3,80}?)\s*<\/td>\s*(?:<[^>]+>)*\s*Rp/i)
                   || body.match(/([A-Za-z][^\n<]{3,60}?)\s+Rp[\d.,]+/i);
  const orderIdMatch = body.match(/Order\s*ID[^:]*:\s*(\d+)/i);

  const hp = (hpMatch?.[hpMatch.length - 1] || '').replace(/[\s\-()]/g, '').trim();

  return {
    nama:    (namaMatch?.[namaMatch.length - 1]   || '').trim(),
    hp,
    alamat:  (alamatMatch?.[alamatMatch.length - 1]|| '').replace(/,\s*-\s*/g, ', ').trim(),
    produk:  (produkMatch?.[1]                    || '').trim(),
    orderId: (orderIdMatch?.[1]                   || '').trim(),
  };
}

// ── Parse alamat dari string → JSONB + cek kelengkapan ───
function parseAlamat(raw) {
  if (!raw) return { jsonb: null, lengkap: false };

  // Coba parse format prose dengan keyword embedded
  // Contoh: "Dusun X desa Y kecamatan Z kabupaten A provinsi B"
  const kecamatanMatch = raw.match(/\bkecamatan\s+(.+?)(?=\s+(?:kabupaten|kota|provinsi)|,|$)/i);
  const kabupatenMatch = raw.match(/\b(?:kabupaten|kota)\s+(.+?)(?=\s+provinsi|,|$)/i);
  const provinsiMatch  = raw.match(/\bprovinsi\s+(\w+(?:\s+\w+)?)/i); // maks 2 kata (semua nama provinsi RI ≤ 2 kata)
  const desaMatch      = raw.match(/\b(?:desa|kelurahan|kel\.?)\s+(.+?)(?=\s+(?:kecamatan|kabupaten|provinsi)|,|$)/i);

  if (kecamatanMatch || kabupatenMatch || provinsiMatch) {
    const kecamatan = kecamatanMatch?.[1]?.trim() || '';
    const kabupaten = kabupatenMatch?.[1]?.trim() || '';
    const provinsi  = provinsiMatch?.[1]?.trim() || '';
    const kelurahan = desaMatch?.[1]?.trim() || '';

    // Jalan = teks sebelum keyword admin pertama (desa/kelurahan/kecamatan/kabupaten/provinsi)
    const firstKeywordIdx = raw.search(/\b(?:desa|kelurahan|kel\.?|kecamatan|kabupaten|kota|provinsi)\b/i);
    let jalan = firstKeywordIdx > 0 ? raw.slice(0, firstKeywordIdx).trim().replace(/,+$/, '') : '';

    // Teks setelah provinsi (landmark/patokan) → tambahkan ke jalan
    if (provinsiMatch) {
      const afterIdx = raw.toLowerCase().indexOf(provinsiMatch[0].toLowerCase()) + provinsiMatch[0].length;
      const afterProv = raw.slice(afterIdx).replace(/^[\s,]+/, '').trim();
      if (afterProv) jalan = jalan ? `${jalan}, ${afterProv}` : afterProv;
    }

    if (!jalan) jalan = raw; // fallback kalau tidak ada teks sebelum keyword

    const jsonb = { jalan, kelurahan, kecamatan, kabupaten, provinsi };
    const lengkap = !!(jalan && kabupaten && jalan.length > 3 && kabupaten.length > 2);
    return { jsonb, lengkap };
  }

  // Fallback: split by comma (format: "jalan, kecamatan, kabupaten, provinsi")
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
// overrideProduct: objek produk dari DB (kalau sudah diketahui, misal dari cron per-produk)
//                  null → akan cari sendiri berdasarkan nama produk di email
async function processLead(userId, { nama, hp, alamat, produk }, overrideProduct = null) {
  const waNumber = normalizeWA(hp);

  // Parse alamat
  const { jsonb: alamatJsonb, lengkap: alamatLengkap } = parseAlamat(alamat);

  // ── Cek apakah customer sudah ada ───────────────────────
  const existing    = await sbGet('customers', `?user_id=eq.${userId}&wa_number=eq.${waNumber}&limit=1`);
  const isNewCustomer = existing.length === 0;
  let customerId;

  if (existing.length) {
    customerId = existing[0].id;
    const patch = {};
    if (nama && !existing[0].nama) patch.nama = nama;
    if (alamatJsonb && !existing[0].alamat?.kabupaten) patch.alamat = alamatJsonb;
    if (Object.keys(patch).length) await sbPatch('customers', `?id=eq.${customerId}`, patch);
  } else {
    const c = await sbPost('customers', {
      user_id: userId, wa_number: waNumber,
      nama: nama || null, alamat: alamatJsonb || null,
    });
    customerId = c[0]?.id;
  }

  // ── Tentukan produk yang dipakai ────────────────────────
  let matchedProd = overrideProduct;
  if (!matchedProd) {
    // Fallback: cari berdasarkan nama produk di email (untuk form_lead)
    const prodRows = await sbGet('products',
      `?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=id,nama,wa_session_id,template_form_lead`
    ).catch(() => []);
    if (produk && prodRows.length) {
      const produkLower = produk.toLowerCase();
      matchedProd = prodRows.find(p => p.nama && p.nama.toLowerCase().includes(produkLower))
                 || prodRows.find(p => produkLower.includes(p.nama?.toLowerCase()));
    }
    if (!matchedProd) matchedProd = prodRows[0] || null;
  }

  const waSession = matchedProd?.wa_session_id || userId;
  console.log('[gmail] waSession:', waSession, '| produk email:', produk, '| matched:', matchedProd?.nama || 'none');

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
    });
  } else {
    const c = await sbPost('conversations', {
      user_id: userId, customer_id: customerId || null,
      product_id: matchedProd?.id || null,
      sumber: 'form', status: 'baru', prioritas: 'high',
      state: convState,
    });
    convId = c[0]?.id;
  }

  // ── Customer lama → simpan data saja, tidak kirim WA ────
  if (!isNewCustomer) {
    return { waNumber, convId, ok: true, skipped: true, reason: 'customer lama, data diperbarui' };
  }

  // ── Customer baru → kirim WA template ───────────────────
  // Template diambil dari produk (per-produk), bukan dari users
  const tmpl = matchedProd?.template_form_lead || null;

  const namaSapa     = nama ? nama.split(' ')[0] : 'kak';
  const produkTxt    = produk ? ` untuk *${produk}*` : '';
  const defaultPesan = `Halo *${namaSapa}* 👋\n\nTerima kasih sudah melakukan pemesanan${produkTxt}! 🙏\n\nKami sedang memproses pesanan kakak. Boleh kami konfirmasi dulu beberapa detailnya?`;
  const pesan        = tmpl ? renderTemplate(tmpl, { nama, produk, alamat, hp }) : defaultPesan;

  const br = await fetch(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, session_id: waSession,
                           wa_number: waNumber, message: pesan, is_outbound: true }),
  });

  const brText = await br.text().catch(() => '');
  let brBody = {};
  try { brBody = JSON.parse(brText); } catch(e) {}
  const sendFailed = !br.ok;
  const errMsg = brBody?.error || brText?.slice(0, 100) || '';
  const notRegistered = sendFailed && (
    errMsg.includes('not registered') ||
    errMsg.includes('not on WhatsApp') ||
    errMsg.includes('No account')
  );

  if (convId) {
    if (sendFailed) {
      const infoMsg = notRegistered
        ? `⚠️ Nomor ${waNumber} tidak terdaftar di WhatsApp. Pesan tidak terkirim.`
        : `⚠️ Gagal kirim WA ke ${waNumber}: ${errMsg || 'Unknown error'}`;
      await sbPost('conv_messages', {
        conversation_id: convId, role: 'cs', isi: infoMsg,
      }).catch(() => {});
      if (notRegistered) {
        await sbPatch('conversations', `?id=eq.${convId}`, {
          state: { ...convState, wa_not_registered: true },
        }).catch(() => {});
      }
    } else {
      const saveResult = await sbPost('conv_messages', {
        conversation_id: convId, role: 'ai', isi: pesan,
      }).catch(e => ({ _err: e.message }));
      const saveErr = saveResult?._err || null;
      if (saveErr) console.error('[gmail] conv_messages save error:', saveErr);
      return { waNumber, convId, ok: true, not_registered: false, send_error: null, conv_saved: !saveErr, conv_error: saveErr };
    }
  }
  return { waNumber, convId, ok: !sendFailed, not_registered: notRegistered, send_error: sendFailed ? errMsg : null, conv_saved: false };
}

// ═══════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, user_id, product_id, code, state, error } = req.query;

  // ──────────────────────────────────────────────────────
  // GET: OAuth & Status routes
  // ──────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // Generate OAuth URL — state = "userId::productId"
    if (action === 'url') {
      if (!user_id || !product_id) return res.status(400).json({ error: 'user_id dan product_id wajib' });
      const oauthState = `${user_id}::${product_id}`;
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI,
        response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state: oauthState,
      });
      return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    }

    // Cek status — per produk
    if (action === 'status') {
      if (!product_id) return res.status(400).json({ error: 'product_id wajib' });
      const rows = await sbGet('products', `?id=eq.${product_id}&select=gmail_email,gmail_last_checked&limit=1`);
      const row  = rows[0] || {};
      return res.json({ connected: !!row.gmail_email, gmail_email: row.gmail_email || null,
                        gmail_last_checked: row.gmail_last_checked || null });
    }

    // Disconnect — per produk
    if (action === 'disconnect') {
      if (!product_id) return res.status(400).json({ error: 'product_id wajib' });
      await sbPatch('products', `?id=eq.${product_id}`,
        { gmail_email: null, gmail_refresh_token: null, gmail_last_checked: null });
      return res.json({ ok: true });
    }

    // OAuth callback dari Google — state = "userId::productId"
    if (error) return res.redirect(`${APP_URL}/settings.html?gmail=cancelled`);

    if (code && state) {
      try {
        const [stateUserId, stateProductId] = state.split('::');
        if (!stateUserId || !stateProductId) throw new Error('state tidak valid');

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

        // Simpan ke products table (per produk)
        await sbPatch('products', `?id=eq.${stateProductId}&user_id=eq.${stateUserId}`, {
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

    // ── Gmail Poller (cron) — loop per produk ─────────────
    if (cronSecret === CRON_SECRET || cronSecret === WEBHOOK_SECRET) {
      const start   = Date.now();
      const results = [];

      // Ambil semua produk yang sudah hubungkan Gmail
      const products = await sbGet('products',
        `?gmail_refresh_token=not.is.null&aktif=eq.true&select=id,nama,user_id,gmail_email,gmail_refresh_token,gmail_last_checked,wa_session_id,template_form_lead`
      );

      if (!products.length) return res.json({ ok: true, message: 'Tidak ada Gmail terhubung di produk manapun' });

      for (const product of products) {
        const log = { product_id: product.id, produk: product.nama, user_id: product.user_id, gmail: product.gmail_email, processed: 0, errors: [] };
        try {
          const token    = await getAccessToken(product.gmail_refresh_token);
          const messages = await searchEmails(token);
          log.emails_found = messages.length;

          for (const msg of messages) {
            try {
              const email     = await getEmail(token, msg.id);
              const emailBody = extractBody(email.payload);
              if (!emailBody) { await markAsRead(token, msg.id); continue; }

              const orderData = parseOrderEmail(emailBody);
              if (!orderData.hp) {
                console.warn('[gmail] HP tidak ditemukan di email', msg.id, '— snippet:', emailBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
                await markAsRead(token, msg.id);
                continue;
              }

              // Kirim produk langsung — tidak perlu match nama lagi
              const leadResult = await processLead(product.user_id, orderData, product);
              await markAsRead(token, msg.id);
              log.processed++;
              if (!log.details) log.details = [];
              log.details.push({
                hp: orderData.hp,
                nama: orderData.nama,
                wa_sent: leadResult.ok && !leadResult.skipped,
                skipped: leadResult.skipped || false,
                skip_reason: leadResult.reason || null,
                not_registered: leadResult.not_registered || false,
                send_error: leadResult.send_error || null,
                conv_saved: leadResult.conv_saved || false,
                conv_error: leadResult.conv_error || null,
              });
            } catch(e) {
              log.errors.push({ msg_id: msg.id, error: e.message });
              try { await markAsRead(token, msg.id); } catch(_) {}
            }
          }
          // Update gmail_last_checked di products table
          await sbPatch('products', `?id=eq.${product.id}`, { gmail_last_checked: new Date().toISOString() });
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
