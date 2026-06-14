/**
 * Resi Poller — dipanggil cron tiap 5 menit
 * Poll Validasiorder DB untuk no_resi baru, kirim notif WA ke customer
 *
 * Cara setup cron (gratis):
 *   cron-job.org → buat job → URL: https://csadsy.vercel.app/api/resi-poller
 *   Method: POST, Header: x-cron-secret: <CRON_SECRET env>
 *   Interval: setiap 5 menit
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL          = process.env.BAILEYS_URL;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;
const VALIDASI_URL         = process.env.VALIDASI_SUPABASE_URL;
const VALIDASI_KEY         = process.env.VALIDASI_SUPABASE_KEY;
const CRON_SECRET          = process.env.CRON_SECRET; // tambah ke env Vercel

const sbH = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
};

const valH = {
  'Content-Type': 'application/json',
  'apikey': VALIDASI_KEY,
  'Authorization': `Bearer ${VALIDASI_KEY}`,
};

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH, 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function valGet(path) {
  const res = await fetch(`${VALIDASI_URL}/rest/v1/${path}`, { headers: valH });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sendWA(sessionId, waNumber, message) {
  const res = await fetch(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      session_id: sessionId,
      wa_number: waNumber,
      message,
      is_outbound: true,
    }),
  });
  if (!res.ok) throw new Error(`Baileys error: ${await res.text()}`);
  return res.json();
}

function normalizeHP(hp) {
  let n = String(hp || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n;
}

function trackingUrl(kurir, resi) {
  const k = (kurir || '').toLowerCase();
  if (k.includes('jne'))      return `https://www.jne.co.id/id/tracking/trace/${resi}`;
  if (k.includes('jt') || k.includes('j&t')) return `https://jet.id/tracking?awb=${resi}`;
  if (k.includes('sicepat'))  return `https://www.sicepat.com/checkAwb?awb=${resi}`;
  if (k.includes('sap'))      return `https://sap-express.id/track?awb=${resi}`;
  if (k.includes('lion'))     return `https://lion.parcel.id/tracking?awb=${resi}`;
  if (k.includes('ninja'))    return `https://www.ninjaxpress.co/id-id/tracking?id=${resi}`;
  if (k.includes('anteraja')) return `https://anteraja.id/tracking/${resi}`;
  if (k.includes('pos'))      return `https://www.posindonesia.co.id/id/tracking/${resi}`;
  return `https://cekresi.com/?noresi=${resi}`;
}

async function processOrder(order) {
  const noResi = order.no_resi || order.resi || '';
  const hp     = order.hp || order.no_hp || '';
  const kurir  = order.ekspedisi || order.kurir || '';
  const nama   = order.nama || '';

  if (!noResi || !hp) return { skip: 'resi/hp kosong' };

  const waNumber = normalizeHP(hp);
  if (!waNumber || waNumber.length < 10) return { skip: 'hp tidak valid' };

  // Cari customer di BotWA
  const customers = await sbGet(`customers?wa_number=eq.${waNumber}&limit=1`);
  if (!customers.length) return { skip: 'customer tidak ada di BotWA' };

  const customer = customers[0];

  // Cari conversation aktif dengan order_placed=true dan belum ada resi
  const convs = await sbGet(
    `conversations?customer_id=eq.${customer.id}&order=last_msg_at.desc&limit=10`
  );
  const conv = convs.find(c => c.state?.order_placed && !c.state?.no_resi);
  if (!conv) return { skip: 'tidak ada order aktif tanpa resi' };

  const urlLacak = trackingUrl(kurir, noResi);

  // Simpan resi ke conversation state
  const currentState = conv.state || {};
  await sbPatch('conversations', `?id=eq.${conv.id}`, {
    state: { ...currentState, no_resi: noResi, kurir_resi: kurir },
  });

  // Kirim WA ke customer
  const pesanResi =
`Halo kak ${nama ? nama.split(' ')[0] : ''}! 😊

Pesanan kakak sudah dikirim nih!

🚚 Kurir: ${kurir || 'Ekspedisi'}
📦 No. Resi: ${noResi}
🔍 Lacak di: ${urlLacak}

Estimasi tiba 2-3 hari kerja ya kak. Kalau ada pertanyaan, kami siap bantu 🙏`.trim();

  await sendWA(conv.user_id, waNumber, pesanResi);
  console.log(`[resi-poller] Resi ${noResi} terkirim ke ${waNumber}`);
  return { sent: true, wa: waNumber, resi: noResi };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Verifikasi secret dari cron-job.org (opsional tapi dianjurkan)
  if (CRON_SECRET) {
    const secret = req.headers['x-cron-secret'];
    if (secret !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // Ambil order 3 hari terakhir yang sudah ada no_resi
    // Resi biasanya masuk D+1 atau D+2, jadi 3 hari cukup aman
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const orders = await valGet(
      `all_orderan?no_resi=not.is.null&no_resi=neq.&created_at=gte.${threeDaysAgo}&order=created_at.desc&limit=2000`
    );

    const results = { sent: 0, skipped: 0, errors: 0, detail: [] };

    for (const order of orders) {
      try {
        const result = await processOrder(order);
        if (result.sent) {
          results.sent++;
          results.detail.push({ resi: result.resi, wa: result.wa, status: 'sent' });
        } else {
          results.skipped++;
        }
      } catch (e) {
        results.errors++;
        console.error(`[resi-poller] Error order ${order.id}:`, e.message);
      }
    }

    console.log(`[resi-poller] Done: ${results.sent} sent, ${results.skipped} skipped, ${results.errors} errors`);
    return res.status(200).json({ ok: true, ...results });

  } catch (e) {
    console.error('[resi-poller] Fatal error:', e.message);
    return res.status(200).json({ ok: true, error: e.message });
  }
};
