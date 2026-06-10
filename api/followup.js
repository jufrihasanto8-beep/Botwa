// ══════════════════════════════════════════════
//  Follow-up Otomatis — Vercel Cron Job
//  Dipanggil setiap 2 jam oleh Vercel Cron
//  Kirim WA ke leads yang diam lebih dari X jam
// ══════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

async function sendWA(token, phone, message) {
  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: { 'Authorization': token },
    body: new URLSearchParams({ target: phone, message, countryCode: '62' }),
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  // Bisa dipanggil manual via GET atau otomatis via cron POST
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  console.log('Follow-up job started:', new Date().toISOString());

  let totalSent = 0;
  let totalSkipped = 0;
  const results = [];

  try {
    // Ambil semua user configs yang punya followup aktif
    const configs = await sbGet('configs', `?followup_enabled=eq.true`);

    if (!configs.length) {
      // Fallback: ambil semua config dan cek manual
      const allConfigs = await sbGet('configs', `?limit=50`);
      for (const cfg of allConfigs) {
        if (cfg.followup_enabled !== true && cfg.followup_enabled !== 'true') continue;
        configs.push(cfg);
      }
    }

    for (const config of configs) {
      const userId = config.user_id;
      const fonnte = config.fonnte_token;
      const delayHours = parseInt(config.followup_delay || '3');
      const followupMsg = config.followup_message ||
        'Halo kak, masih ada yang bisa kami bantu? 😊 Jangan ragu kalau ada pertanyaan ya!';

      if (!fonnte) continue;

      const cutoffTime = new Date(Date.now() - delayHours * 60 * 60 * 1000).toISOString();

      // Ambil semua kontak user ini
      const contacts = await sbGet('contacts', `?user_id=eq.${userId}`);

      for (const contact of contacts) {
        try {
          // Cek pesan terakhir dari kontak ini
          const lastMsgs = await sbGet('messages',
            `?contact_id=eq.${contact.id}&user_id=eq.${userId}&order=created_at.desc&limit=1`
          );

          if (!lastMsgs.length) continue;
          const lastMsg = lastMsgs[0];

          // Follow-up hanya jika:
          // 1. Pesan terakhir dari customer (user), bukan AI (assistant)
          // 2. Sudah lebih dari X jam yang lalu
          if (lastMsg.role !== 'user') { totalSkipped++; continue; }
          if (lastMsg.created_at >= cutoffTime) { totalSkipped++; continue; }

          // Kirim follow-up
          const sent = await sendWA(fonnte, contact.phone, followupMsg);
          if (sent.status === true || sent.status === 'true') {
            // Simpan ke messages
            await sbPost('messages', {
              contact_id: contact.id,
              user_id: userId,
              role: 'assistant',
              content: `[Follow-up] ${followupMsg}`,
              sent_to_wa: true,
            });
            totalSent++;
            results.push({ contact: contact.name, phone: contact.phone, status: 'sent' });
            console.log(`Follow-up terkirim ke ${contact.name} (+${contact.phone})`);
            // Delay antar kirim
            await new Promise(r => setTimeout(r, 1500));
          }
        } catch(e) {
          console.error(`Error follow-up ${contact.name}:`, e.message);
        }
      }
    }

    const summary = `Follow-up selesai: ${totalSent} terkirim, ${totalSkipped} dilewati`;
    console.log(summary);
    return res.status(200).json({ ok: true, sent: totalSent, skipped: totalSkipped, results });

  } catch(err) {
    console.error('Follow-up job error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
