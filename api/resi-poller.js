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
const CRON_SECRET          = process.env.CRON_SECRET;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_KEY;

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
  const namaKak  = (customer.nama || '').split(' ')[0]; // ambil dari customers BotWA

  // Cari order di orders_new yang belum ada resi
  const orderRows = await sbGet(
    `orders_new?customer_id=eq.${customer.id}&no_resi=is.null&status=eq.pending&order=created_at.desc&limit=1`
  );
  if (!orderRows.length) return { skip: 'tidak ada order pending tanpa resi' };

  const orderRow = orderRows[0];
  const urlLacak = trackingUrl(kurir, noResi);

  // Simpan resi ke orders_new
  await sbPatch('orders_new', `?id=eq.${orderRow.id}`, {
    no_resi:         noResi,
    ekspedisi:       kurir || orderRow.ekspedisi,
    status:          'dikirim',
    status_tracking: 'dikirim',
  });

  // Generate pesan AI
  let pesanResi = null;
  if (ANTHROPIC_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content:
            `Kamu CS produk herbal yang hangat dan peduli. Tulis pesan WhatsApp ke customer yang pesanannya baru dikirim.

Data:
- Nama: ${namaKak ? 'kak ' + namaKak : 'kak'}
- No. Resi: ${noResi}
- Link lacak: ${urlLacak}

Gaya penulisan:
- Seperti teman yang excited kasih kabar baik, bukan CS formal
- Bangun antusias customer buat nunggu produknya datang, yakinkan manfaatnya akan segera terasa
- Resi dan link lacak wajib ada, taruh di baris terpisah
- Maksimal 4 kalimat pendek
- 2 emoji yang hangat dan relevan
- JANGAN sebut nama kurir kalau tidak ada
- JANGAN pakai markdown (*, _, dll)
- JANGAN mulai dengan "Halo kak" atau salam kaku

Langsung tulis pesannya.` }],
        }),
      });
      const d = await r.json();
      pesanResi = d.content?.[0]?.text?.trim() || null;
    } catch (e) {
      console.error('[resi-poller] AI msg error:', e.message);
    }
  }

  // Fallback kalau AI gagal
  if (!pesanResi) {
    pesanResi = `${namaKak ? 'Kak ' + namaKak : 'Kak'}, pesanan sudah kami kirim nih 📦 Semoga produknya cepat sampai dan langsung terasa manfaatnya ya!\n\nResi: ${noResi} (${kurir || 'ekspedisi'})\nLacak di: ${urlLacak}`;
  }

  await sendWA(orderRow.user_id, waNumber, pesanResi);
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
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const orders = await valGet(
      `all_orderan?resi=not.is.null&resi=neq.&created_at=gte.${fiveDaysAgo}&order=created_at.desc&limit=500`
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
          results.detail.push({ resi: order.resi, hp: order.hp, status: 'skipped', alasan: result.skip });
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
