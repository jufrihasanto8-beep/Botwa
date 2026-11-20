/**
 * Webhook Mengantar — menerima push status order real-time
 * POST /api/mengantar-webhook
 *
 * Setiap kali status order berubah di Mengantar, mereka POST payload ke sini.
 * Verifikasi HMAC, map status_category → event, update orders_new, kirim notif WA.
 */

const crypto = require('crypto');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL          = process.env.BAILEYS_URL;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;

const sbH = () => ({
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
});

async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH() });
  if (!res.ok) throw new Error(`sbGet ${table}: ${await res.text()}`);
  return res.json();
}
async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch ${table}: ${await res.text()}`);
  return res.json();
}

// ── Status mapping dari Mengantar status_category ke event internal ──
const STATUS_MAP = {
  'ACTIVE':                 'dikirim',
  'WAITING NEXT PROCESS':   'dikirim',
  'PENDING PICKUP':         'dikirim',
  'PICKED UP':              'dikirim',
  'MANIFESTED':             'dikirim',
  'INBOUND PROCESS':        'dikirim',
  'OUTBOUND PROCESS':       'dikirim',
  'IN TRANSIT':             'dikirim',
  'ON SHIPPING':            'dikirim',
  'ORIGIN GATEWAY':         'dikirim',
  'DESTINATION GATEWAY':    'tiba_kota',
  'INCOMING':               'tiba_kota',
  'GATEWAY PROCESS':        'dikirim',
  'WITH DELIVERY COURIER':  'out_for_delivery',
  'ON DELIVERY':            'out_for_delivery',
  'DEL':                    'out_for_delivery',
  'OUT FOR DELIVERY':       'out_for_delivery',
  'DELIVERED':              'delivered',
  'UNDELIVERED':            'bermasalah',
  'PICKUP FAILED':          'bermasalah',
  'REJECTED':               'bermasalah',
  'DELIVERY PROBLEM':       'bermasalah',
  'SHIPPING PROBLEM':       'bermasalah',
  'RTS':                    'retur',
  'RETURN TO SHIPPER':      'retur',
  'DELIVERY RETURN':        'retur',
  'CANCELED':               'retur',
  'CANCELLED':              'retur',
};

// Normalisasi kurir
function normCourier(c) {
  if (!c) return '';
  const map = { jne:'JNE', jt:'J&T', 'j&t':'J&T', jnt:'J&T', sicepat:'SICEPAT', anteraja:'ANTERAJA', ninja:'NINJA', idexpress:'IDEXPRESS', lion:'LION', pos:'POS', spx:'SPX', sap:'SAP' };
  return map[String(c).toLowerCase()] || String(c).toUpperCase();
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

// Baca raw body untuk HMAC verification
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Helper: ambil wa_session_id dari produk
async function getWaSession(userId, productId) {
  if (productId) {
    const rows = await sbGet('products', `?id=eq.${productId}&select=wa_session_id&limit=1`).catch(() => []);
    if (rows[0]?.wa_session_id) return rows[0].wa_session_id;
  }
  const rows = await sbGet('products', `?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=wa_session_id&limit=1`).catch(() => []);
  return rows[0]?.wa_session_id || userId;
}

// Kirim notif WA
async function kirimNotif(sessionId, waNumber, pesan) {
  if (!BAILEYS_URL || !waNumber) return;
  try {
    await fetch(`${BAILEYS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, session_id: sessionId, wa_number: waNumber, message: pesan, is_outbound: true }),
    });
  } catch (e) {
    console.error('[mng-webhook] kirimNotif error:', e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Baca raw body
  const rawBody = await readRawBody(req);

  // 2. Verifikasi HMAC-SHA256
  const secrets = [
    process.env.MENGANTAR_WEBHOOK_SECRET,
    process.env.MENGANTAR_WEBHOOK_SECRET_2,
  ].filter(Boolean);

  const timestamp = req.headers['x-timestamp'] || '';
  const received  = req.headers['x-signature'] || '';

  if (secrets.length > 0) {
    const valid = secrets.some(secret => {
      const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
      return expected.length === received.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    });
    if (!valid) {
      console.error('[mng-webhook] Signature tidak valid');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    // Tolak replay > 5 menit
    if (timestamp && Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
      console.error('[mng-webhook] Request kadaluarsa');
      return res.status(401).json({ error: 'Request expired' });
    }
  }

  // 3. Parse payload
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { cnote_no, courier, status_category } = payload;
  if (!cnote_no || !status_category) return res.status(400).json({ error: 'cnote_no dan status_category wajib' });

  // 4. Map ke event internal
  const eventType = STATUS_MAP[status_category?.toUpperCase?.()] || STATUS_MAP[status_category];
  if (!eventType) {
    console.warn('[mng-webhook] Status tidak dikenal:', status_category);
    return res.status(200).json({ ok: true, ignored: true });
  }

  const now = new Date().toISOString();
  const ekspedisi = normCourier(courier);

  try {
    // 5. Cari order di orders_new berdasarkan no_resi
    const orders = await sbGet('orders_new', `?no_resi=eq.${encodeURIComponent(cnote_no)}&select=id,user_id,customer_id,product_id,metode,ekspedisi,status,tracking_events,status_tracking&limit=1`);
    if (!orders.length) {
      console.log(`[mng-webhook] Resi ${cnote_no} tidak ditemukan di orders_new`);
      return res.status(200).json({ ok: true, skip: 'resi_not_found' });
    }

    const order = orders[0];
    const doneEvents = order.tracking_events || {};

    // 6. Anti-downgrade: kalau sudah BERMASALAH, jangan turun ke dikirim/out_for_delivery/tiba_kota
    const wasProb = doneEvents.bermasalah && !doneEvents.delivered;
    const isRetry = ['dikirim', 'out_for_delivery', 'tiba_kota'].includes(eventType);
    if (wasProb && isRetry) {
      console.log(`[mng-webhook] ${cnote_no} retry (${eventType}) — tetap bermasalah`);
      return res.status(200).json({ ok: true, resi: cnote_no, event: eventType, retry: true });
    }

    // 7. Skip kalau event sudah pernah dicatat (kecuali update status_tracking)
    if (doneEvents[eventType] && eventType !== 'dikirim') {
      // Update status_tracking saja
      await sbPatch('orders_new', `?id=eq.${order.id}`, { status_tracking: status_category }).catch(() => {});
      console.log(`[mng-webhook] ${cnote_no} event "${eventType}" sudah ada, update status_tracking saja`);
      return res.status(200).json({ ok: true, resi: cnote_no, event: eventType, already: true });
    }

    // 8. Build patch
    const patch = {
      status_tracking: status_category,
      tracking_events: { ...doneEvents, [eventType]: now },
    };
    if (ekspedisi && !order.ekspedisi) patch.ekspedisi = ekspedisi;

    if (eventType === 'delivered') {
      patch.status = 'selesai';
      patch.sampai = true;
      patch.sampai_at = now;
    }

    await sbPatch('orders_new', `?id=eq.${order.id}`, patch);
    console.log(`[mng-webhook] ${cnote_no} → ${eventType} (${status_category})`);

    // Respond segera ke Mengantar
    res.status(200).json({ ok: true, resi: cnote_no, event: eventType });

    // 9. Kirim notif WA ke customer (async, setelah respond)
    if (['tiba_kota', 'out_for_delivery', 'delivered', 'bermasalah', 'retur'].includes(eventType)) {
      try {
        const custs = await sbGet('customers', `?id=eq.${order.customer_id}&select=id,wa_number,nama,reply_jid&limit=1`);
        const cust = custs[0];
        if (!cust?.wa_number) return;

        const waTarget = cust.reply_jid || cust.wa_number;
        const namaKak = (cust.nama || '').split(' ')[0];
        const isCOD = (order.metode || '').toLowerCase() === 'cod';
        const urlLacak = trackingUrl(ekspedisi || order.ekspedisi, cnote_no);

        // Ambil template custom user
        const userRows = await sbGet('users', `?id=eq.${order.user_id}&select=template_tiba_kota,template_out_for_delivery,template_delivered,template_bermasalah,template_retur&limit=1`).catch(() => []);
        const tpl = userRows[0] || {};
        const tplKey = { tiba_kota:'template_tiba_kota', out_for_delivery:'template_out_for_delivery', delivered:'template_delivered', bermasalah:'template_bermasalah', retur:'template_retur' };
        const customTpl = tpl[tplKey[eventType]];

        let pesan;
        if (customTpl) {
          pesan = customTpl
            .replace(/{nama}/g, namaKak || '')
            .replace(/{resi}/g, cnote_no)
            .replace(/{kurir}/g, ekspedisi || order.ekspedisi || '')
            .replace(/{link}/g, urlLacak);
          if (eventType === 'tiba_kota' && isCOD) pesan += '\n\n⚠️ Siapkan uang COD-nya ya kak!';
        } else {
          // Fallback template
          const templates = {
            tiba_kota: `${namaKak ? 'Kak '+namaKak : 'Kak'}, paket udah sampai di kota tujuan nih 📦${isCOD ? '\n\nMohon siapkan uang COD-nya ya kak!' : ''}\n\nResi: ${cnote_no}\nCek tracking: ${urlLacak}`,
            out_for_delivery: `${namaKak ? 'Kak '+namaKak : 'Kak'}, kurir lagi otw ke rumah kak hari ini! 🚚${isCOD ? '\n\n⚠️ Siapkan uang COD-nya ya kak!' : ''}\n\nResi: ${cnote_no}\nCek tracking: ${urlLacak}`,
            delivered: `${namaKak ? 'Kak '+namaKak : 'Kak'}, paket sudah sampai dan diterima nih! 🎉\n\nSemoga produknya langsung bisa dipakai dan manfaatnya terasa ya kak 🙏`,
            bermasalah: `${namaKak ? 'Kak '+namaKak : 'Kak'}, ada kendala pengiriman paket kakak nih 😟\n\nKurir tidak berhasil mengantar. Mohon pastikan alamat dan nomor HP aktif ya kak.\n\nResi: ${cnote_no}\nCek tracking: ${urlLacak}`,
            retur: `${namaKak ? 'Kak '+namaKak : 'Kak'}, paket kakak sedang dalam proses retur ke pengirim 😔\n\nResi: ${cnote_no}\nNanti kami hubungi untuk koordinasi lebih lanjut ya kak.`,
          };
          pesan = templates[eventType];
        }

        if (pesan) {
          const waSession = await getWaSession(order.user_id, order.product_id);
          await kirimNotif(waSession, waTarget, pesan);
          console.log(`[mng-webhook] Notif ${eventType} terkirim ke ${cust.wa_number}`);
        }
      } catch (e) {
        console.error('[mng-webhook] Notif error:', e.message);
      }
    }

  } catch (e) {
    console.error('[mng-webhook] Error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};

// Matikan body parser bawaan Vercel — butuh raw body untuk HMAC
module.exports.config = { api: { bodyParser: false } };
