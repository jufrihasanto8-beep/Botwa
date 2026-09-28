/**
 * Baileys Multi-Session WA Gateway — AI CS Adsy
 * Satu server, banyak nomor WA (1 user = 1 session)
 */

require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const express = require('express');
const QRCode  = require('qrcode');
const qrTerm  = require('qrcode-terminal');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const PORT             = process.env.PORT || 3000;
const WEBHOOK_URL      = process.env.VERCEL_WEBHOOK_URL;  // default fallback
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET;
const MAX_OUTBOUND     = parseInt(process.env.MAX_OUTBOUND_PER_DAY || '50');

// ── Per-session webhook URL config ───────────────────────
// File: /root/baileys-server/session-webhooks.json
// Format: { "session_id_1": "https://...", "session_id_2": "https://..." }
const SESSION_WEBHOOK_FILE = path.join(__dirname, 'session-webhooks.json');
function getWebhookUrl(sessionId) {
  try {
    const raw = fs.readFileSync(SESSION_WEBHOOK_FILE, 'utf8');
    const map = JSON.parse(raw);
    return map[sessionId] || WEBHOOK_URL;
  } catch {
    return WEBHOOK_URL;
  }
}

// ── Anti-blokir: counter outbound per session per hari ───
const outboundCount = new NodeCache({ stdTTL: 86400 });
function canSendOutbound(sessionId) {
  const key = `${sessionId}_${new Date().toDateString()}`;
  return (outboundCount.get(key) || 0) < MAX_OUTBOUND;
}
function incrementOutbound(sessionId) {
  const key = `${sessionId}_${new Date().toDateString()}`;
  outboundCount.set(key, (outboundCount.get(key) || 0) + 1);
}

// ── Jeda manusiawi ────────────────────────────────────────
function humanDelay() {
  return new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));
}

// ── Sessions store ────────────────────────────────────────
// Map: sessionId → { sock, status, qr, waNumber, saveCreds }
const sessions = new Map();

// ── Dedup message IDs per-session (cegah Baileys double-fire) ───
// Map: sessionId → Set of msgIds, auto-hapus setelah 60 detik
const processedMsgIds = new Map();
function markMsgProcessed(sessionId, msgId) {
  if (!processedMsgIds.has(sessionId)) processedMsgIds.set(sessionId, new Set());
  const s = processedMsgIds.get(sessionId);
  s.add(msgId);
  setTimeout(() => s.delete(msgId), 60000);
}
function isMsgProcessed(sessionId, msgId) {
  return processedMsgIds.has(sessionId) && processedMsgIds.get(sessionId).has(msgId);
}

// ── Pastikan folder auth_info ada ────────────────────────
const AUTH_DIR = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

// ── Buat / restart session ────────────────────────────────
async function startSession(sessionId) {
  // Kalau sudah ada session aktif, skip
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.status === 'connected') return;
  }

  console.log(`[${sessionId}] Memulai session...`);

  const sessionDir = path.join(AUTH_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // Ambil versi WA
  let version = [2, 3000, 1035194821];
  try {
    const latest = await fetchLatestBaileysVersion();
    if (latest?.version) version = latest.version;
  } catch(e) {}

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  // Simpan ke map (contacts: LID → nomor HP asli)
  sessions.set(sessionId, { sock, status: 'connecting', qr: null, waNumber: null, saveCreds, contacts: new Map() });

  // ── Connection update ─────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    if (qr) {
      session.qr = qr;
      session.status = 'qr_ready';
      console.log(`[${sessionId}] QR siap → http://localhost:${PORT}/qr/${sessionId}`);
      qrTerm.generate(qr, { small: true });
    }

    if (connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      session.waNumber = sock.user?.id?.split(':')[0];
      console.log(`[${sessionId}] ✅ Terhubung! Nomor: ${session.waNumber}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
      const isLoggedOut = statusCode === 401 || statusCode === DisconnectReason?.loggedOut;
      console.log(`[${sessionId}] Terputus, status: ${statusCode}`);

      if (isLoggedOut) {
        console.log(`[${sessionId}] Logged out — hapus session`);
        session.status = 'logged_out';
        // Hapus auth agar scan ulang
        fs.rmSync(sessionDir, { recursive: true, force: true });
        sessions.delete(sessionId);
      } else {
        session.status = 'reconnecting';
        console.log(`[${sessionId}] Reconnect dalam 5 detik...`);
        setTimeout(() => startSession(sessionId), 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── LID → Phone mapping ──────────────────────────────
  // Source 1: messaging-history.set (saat sync awal, berisi lidPnMappings)
  sock.ev.on('messaging-history.set', ({ contacts, lidPnMappings }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (lidPnMappings?.length) {
      for (const m of lidPnMappings) {
        const lid   = String(m.lid).split('@')[0];
        const phone = String(m.pn).split('@')[0].split(':')[0];
        if (lid && phone) {
          session.contacts.set(lid, phone);
          console.log(`[${sessionId}] history-sync map: ${lid} → ${phone}`);
        }
      }
    }
    // Contacts yang punya id + lid
    if (contacts?.length) {
      for (const c of contacts) {
        if (c.id && c.lid) {
          const lid   = String(c.lid).split('@')[0];
          const phone = String(c.id).split('@')[0].split(':')[0];
          if (lid && phone && !phone.includes('lid')) {
            session.contacts.set(lid, phone);
          }
        }
      }
    }
  });

  // Source 2: contacts.upsert / update (kalau ada id + lid)
  const syncContacts = (list) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    for (const c of list) {
      if (c.id && c.lid) {
        const lid   = String(c.lid).split('@')[0];
        const phone = String(c.id).split('@')[0].split(':')[0];
        if (lid && phone && !phone.includes('lid')) {
          session.contacts.set(lid, phone);
        }
      }
    }
  };
  sock.ev.on('contacts.upsert', syncContacts);
  sock.ev.on('contacts.update', syncContacts);

  // ── Pesan masuk → forward ke Vercel ──────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await processIncoming(sessionId, msg); }
      catch(e) { console.error(`[${sessionId}] Error proses pesan:`, e.message); }
    }
  });
}

// ── Proses pesan masuk ────────────────────────────────────
async function processIncoming(sessionId, msg) {
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  console.log(`[${sessionId}] Raw JID: ${jid}`);
  if (!jid || jid.includes('@g.us') || jid.includes('@broadcast') || jid.includes('@newsletter')) return;

  // Dedup per-session: skip kalau message ID ini sudah diforward oleh session ini
  const msgId = msg.key.id;
  if (msgId && isMsgProcessed(sessionId, msgId)) {
    console.log(`[${sessionId}] Skip duplicate message: ${msgId}`);
    return;
  }
  if (msgId) markMsgProcessed(sessionId, msgId);

  // reply_jid = full JID untuk kirim balas (termasuk @lid)
  // wa_number = nomor HP asli untuk simpan ke DB
  const reply_jid = jid;
  let wa_number;
  if (jid.includes('@lid')) {
    const lidNum  = jid.split('@')[0];
    const session = sessions.get(sessionId);
    let resolved = null;

    // Method 1: Cek msg.key.remoteJidAlt (nomor HP langsung dari pesan)
    if (msg.key.remoteJidAlt && !msg.key.remoteJidAlt.includes('@lid')) {
      resolved = String(msg.key.remoteJidAlt).split('@')[0].split(':')[0];
      session?.contacts?.set(lidNum, resolved);
      console.log(`[${sessionId}] remoteJidAlt: ${lidNum} → ${resolved}`);
    }

    // Method 2: Cek cache contacts
    if (!resolved) {
      resolved = session?.contacts?.get(lidNum) || null;
    }

    // Method 3: Cek signalRepository internal Baileys
    if (!resolved) {
      try {
        const pnJid = await session?.sock?.signalRepository?.lidMapping?.getPNForLID(jid);
        if (pnJid) {
          resolved = String(pnJid).split('@')[0].split(':')[0];
          session.contacts.set(lidNum, resolved);
          console.log(`[${sessionId}] signalRepo: ${lidNum} → ${resolved}`);
        }
      } catch(e) {}
    }

    wa_number = resolved || lidNum;
    console.log(`[${sessionId}] LID ${lidNum} → ${resolved ? 'nomor: ' + resolved : 'pakai LID'}`);
  } else {
    wa_number = jid.replace('@s.whatsapp.net', '').split(':')[0];
  }
  console.log(`[${sessionId}] wa_number: ${wa_number}`);
  const pushName  = msg.pushName || wa_number;
  const msgContent = msg.message;
  if (!msgContent) return;

  let messageType = 'text', text = '', mediaUrl = null, referral = null;

  if (msgContent.conversation) {
    text = msgContent.conversation;
  } else if (msgContent.extendedTextMessage) {
    text = msgContent.extendedTextMessage.text;
    referral = msgContent.extendedTextMessage.contextInfo?.externalAdReply || null;
  } else if (msgContent.imageMessage) {
    messageType = 'image';
    text = msgContent.imageMessage.caption || '';
    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      mediaUrl = 'data:image/jpeg;base64,' + buffer.toString('base64');
    } catch(e) {
      console.error('Gagal download image:', e.message);
      mediaUrl = null;
    }
  } else if (msgContent.audioMessage) {
    messageType = 'audio';
    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      mediaUrl = 'data:audio/ogg;base64,' + buffer.toString('base64');
    } catch(e) {
      console.error('Gagal download audio:', e.message);
      mediaUrl = null;
    }
  }

  if (!text && messageType === 'text') return;

  const webhookUrl = getWebhookUrl(sessionId);
  if (!webhookUrl) { console.warn('VERCEL_WEBHOOK_URL belum diset'); return; }

  const payload = {
    session_id: sessionId,
    wa_number,
    reply_jid,  // full JID untuk reply (termasuk @lid)
    push_name: pushName,
    msg_id: msgId,  // WA message ID untuk idempotency check di Vercel
    message: text,
    message_type: messageType,
    media_url: mediaUrl,
    referral: referral ? {
      ad_id: referral.sourceId,
      headline: referral.title,
    } : null,
    timestamp: msg.messageTimestamp,
    secret: WEBHOOK_SECRET,
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`[${sessionId}] ↗ Webhook (${webhookUrl}): ${res.status}`);
  } catch(e) {
    console.error(`[${sessionId}] Webhook error:`, e.message);
  }
}

// ── Kirim pesan (teks atau gambar) ───────────────────────
async function sendMessage(sessionId, waNumber, text, isOutbound = false, imageUrl = null, caption = null) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'connected') {
    throw new Error(`Session ${sessionId} tidak aktif`);
  }
  if (isOutbound && !canSendOutbound(sessionId)) {
    throw new Error(`Batas outbound harian tercapai`);
  }

  const jid = normalizeJid(waNumber);
  const isGroup = jid.endsWith('@g.us');

  await humanDelay();
  if (!isGroup) {
    try {
      await session.sock.sendPresenceUpdate('composing', jid);
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
      await session.sock.sendPresenceUpdate('paused', jid);
    } catch(e) {
      // LID JID tidak support presence update, skip saja
      console.warn(`[${sessionId}] sendPresenceUpdate skip (${jid}): ${e.message}`);
    }
  }

  let sentResult = null;
  if (imageUrl) {
    // Kirim gambar dari URL (bisa http/https atau data:image/...)
    if (imageUrl.startsWith('data:image')) {
      const matches = imageUrl.match(/^data:image\/([a-z]+);base64,(.+)$/i);
      if (!matches) throw new Error('Format base64 gambar tidak valid');
      const buffer = Buffer.from(matches[2], 'base64');
      const mimetype = `image/${matches[1].toLowerCase()}`;
      sentResult = await session.sock.sendMessage(jid, {
        image: buffer,
        mimetype,
        caption: caption || text || '',
      });
    } else {
      // URL publik — fetch dulu sebagai buffer agar lebih reliable
      try {
        const imgRes = await fetch(imageUrl, { timeout: 15000 });
        if (!imgRes.ok) throw new Error(`Fetch gambar gagal: ${imgRes.status}`);
        const arrayBuf = await imgRes.arrayBuffer();
        const buffer   = Buffer.from(arrayBuf);
        const mime     = imgRes.headers.get('content-type') || 'image/jpeg';
        sentResult = await session.sock.sendMessage(jid, {
          image: buffer,
          mimetype: mime,
          caption: caption || text || '',
        });
      } catch(fetchErr) {
        console.error('Fetch buffer gagal, fallback ke URL:', fetchErr.message);
        sentResult = await session.sock.sendMessage(jid, {
          image: { url: imageUrl },
          caption: caption || text || '',
        });
      }
    }
    // Kirim teks terpisah kalau ada teks dan caption juga ada
    if (text && caption) {
      await new Promise(r => setTimeout(r, 800));
      await session.sock.sendMessage(jid, { text });
    }
  } else {
    sentResult = await session.sock.sendMessage(jid, { text });
  }

  if (isOutbound) incrementOutbound(sessionId);
  const wamid = sentResult?.key?.id || null;
  console.log(`[${sessionId}] 📤 Terkirim ke ${waNumber}${imageUrl ? ' [+gambar]' : ''} wamid=${wamid}`);
  return wamid;
}

function normalizeJid(num) {
  const s = String(num);
  // Kalau sudah berupa JID lengkap (pakai @), kembalikan langsung
  if (s.includes('@')) return s;
  let n = s.replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return `${n}@s.whatsapp.net`;
}

// ── Auto-load session yang sudah ada (dari auth_info/) ────
async function loadExistingSessions() {
  if (!fs.existsSync(AUTH_DIR)) return;
  const dirs = fs.readdirSync(AUTH_DIR);
  for (const dir of dirs) {
    const full = path.join(AUTH_DIR, dir);
    if (fs.statSync(full).isDirectory()) {
      console.log(`Auto-load session: ${dir}`);
      await startSession(dir);
      await new Promise(r => setTimeout(r, 2000)); // jeda antar session
    }
  }
}

// ── Express API ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Health
app.get('/health', (req, res) => {
  const data = {};
  sessions.forEach((s, id) => {
    data[id] = { status: s.status, waNumber: s.waNumber };
  });
  res.json({ ok: true, sessions: data });
});

// Start session baru
app.post('/session/start', async (req, res) => {
  const { secret, session_id } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!session_id) return res.status(400).json({ error: 'session_id wajib' });

  try {
    await startSession(session_id);
    res.json({ ok: true, message: 'Session dimulai, buka /qr/' + session_id + ' untuk scan' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Stop / logout session
app.post('/session/stop', async (req, res) => {
  const { secret, session_id } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const session = sessions.get(session_id);
  if (!session) return res.status(404).json({ error: 'Session tidak ditemukan' });

  try {
    await session.sock.logout();
    sessions.delete(session_id);
    const sessionDir = path.join(AUTH_DIR, session_id);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch(e) {
    sessions.delete(session_id);
    res.json({ ok: true });
  }
});

// Status session
app.get('/session/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ status: 'not_found', waNumber: null });
  res.json({ status: session.status, waNumber: session.waNumber });
});

// QR page — buka di browser
app.get('/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  // Kalau belum ada session, mulai dulu
  if (!session) {
    await startSession(sessionId);
    return res.send(htmlWaiting('Memulai koneksi...', sessionId));
  }

  if (session.status === 'connected') {
    return res.send(htmlConnected(session.waNumber));
  }

  if (!session.qr) {
    return res.send(htmlWaiting('Menunggu QR code...', sessionId));
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(session.qr, { width: 280, margin: 2 });
    res.send(htmlQR(qrDataUrl, sessionId));
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// QR data — return JSON (untuk proxy dari Vercel)
app.get('/qr-data/:sessionId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session || !session.qr) {
    return res.json({ qrDataUrl: null, status: session?.status || 'not_found' });
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(session.qr, { width: 280, margin: 2 });
    res.json({ qrDataUrl, status: 'qr_ready' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// List grup WA
app.get('/groups', async (req, res) => {
  const { secret, session_id } = req.query;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!session_id) return res.status(400).json({ error: 'session_id wajib' });
  const session = sessions.get(session_id);
  if (!session || session.status !== 'connected') return res.status(400).json({ error: 'Session tidak aktif' });
  try {
    const chats = await session.sock.groupFetchAllParticipating();
    const groups = Object.values(chats)
      .map(g => ({ jid: g.id, nama: g.subject }))
      .sort((a, b) => a.nama.localeCompare(b.nama));
    res.json({ ok: true, groups });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Kirim pesan (dipanggil Vercel)
app.post('/send', async (req, res) => {
  const { secret, session_id, wa_number, message, is_outbound, image_url, caption } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!session_id || !wa_number || (!message && !image_url)) return res.status(400).json({ error: 'Kurang parameter' });

  try {
    const wamid = await sendMessage(session_id, wa_number, message, is_outbound, image_url, caption);
    res.json({ ok: true, wamid });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Hapus pesan (delete for everyone)
app.post('/delete-msg', async (req, res) => {
  const { secret, session_id, wa_number, wamid } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!session_id || !wa_number || !wamid) return res.status(400).json({ error: 'Kurang parameter' });
  const session = sessions.get(session_id);
  if (!session || session.status !== 'connected') return res.status(400).json({ error: 'Session tidak aktif' });
  try {
    const jid = normalizeJid(wa_number);
    await session.sock.sendMessage(jid, { delete: { remoteJid: jid, id: wamid, fromMe: true } });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Edit pesan
app.post('/edit-msg', async (req, res) => {
  const { secret, session_id, wa_number, wamid, new_text } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!session_id || !wa_number || !wamid || !new_text) return res.status(400).json({ error: 'Kurang parameter' });
  const session = sessions.get(session_id);
  if (!session || session.status !== 'connected') return res.status(400).json({ error: 'Session tidak aktif' });
  try {
    const jid = normalizeJid(wa_number);
    await session.sock.sendMessage(jid, { edit: { remoteJid: jid, id: wamid, fromMe: true }, text: new_text });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Kirim batch
app.post('/send-batch', async (req, res) => {
  const { secret, session_id, messages } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const results = [];
  for (const item of messages) {
    try {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
      await sendMessage(session_id, item.wa_number, item.message, true);
      results.push({ wa_number: item.wa_number, ok: true });
    } catch(e) {
      results.push({ wa_number: item.wa_number, ok: false, error: e.message });
    }
  }
  res.json({ results });
});

// ── HTML templates ────────────────────────────────────────
function htmlBase(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Adsy CS · WhatsApp</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .box{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;text-align:center;max-width:380px;width:100%;}
    h2{font-size:20px;font-weight:700;margin-bottom:8px;color:#0f172a}
    p{font-size:13px;color:#64748b;line-height:1.6;margin:6px 0}
    .badge{display:inline-block;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;margin:12px 0}
  </style></head>
  <body><div class="box">${content}</div></body></html>`;
}

function htmlQR(qrDataUrl, sessionId) {
  return htmlBase(`
    <h2>📱 Hubungkan WhatsApp</h2>
    <p>Buka WhatsApp → <strong>Perangkat Tertaut</strong> → Tautkan Perangkat</p>
    <img src="${qrDataUrl}" style="width:260px;border-radius:12px;margin:16px 0">
    <p style="color:#94a3b8;font-size:12px">QR berlaku ~60 detik</p>
    <p style="color:#94a3b8;font-size:12px">Halaman refresh otomatis</p>
    <meta http-equiv="refresh" content="20">
  `);
}

function htmlConnected(waNumber) {
  return htmlBase(`
    <div style="font-size:56px;margin-bottom:12px">✅</div>
    <h2>WhatsApp Terhubung!</h2>
    <span class="badge" style="background:#dcfce7;color:#166534">+${waNumber}</span>
    <p>Nomor aktif dan siap menerima pesan</p>
    <p style="margin-top:16px"><a href="javascript:window.close()" style="color:#3b82f6">Tutup halaman ini</a></p>
  `);
}

function htmlWaiting(msg, sessionId) {
  return htmlBase(`
    <div style="font-size:48px;margin-bottom:12px">⏳</div>
    <h2>${msg}</h2>
    <p>Halaman akan refresh otomatis...</p>
    <meta http-equiv="refresh" content="3">
  `);
}

// ── Start server ──────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Baileys multi-session server di port ${PORT}`);
  await loadExistingSessions();
});

process.on('uncaughtException', (err) => { console.error('Uncaught:', err.message); });
process.on('unhandledRejection', (r) => { console.error('Unhandled:', r); });
