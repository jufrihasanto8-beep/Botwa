/**
 * Resi Webhook — dipanggil Supabase Validasiorder saat no_resi diupdate
 * Setup: Validasiorder Supabase → Database Webhooks → event UPDATE → table all_orderan → URL ini
 */

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL         = process.env.BAILEYS_URL;
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET;

const sbH = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
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
  if (k.includes('jne'))     return `https://www.jne.co.id/id/tracking/trace/${resi}`;
  if (k.includes('jt') || k.includes('j&t')) return `https://jet.id/tracking?awb=${resi}`;
  if (k.includes('sicepat')) return `https://www.sicepat.com/checkAwb?awb=${resi}`;
  if (k.includes('sap'))     return `https://sap-express.id/track?awb=${resi}`;
  if (k.includes('lion'))    return `https://lion.parcel.id/tracking?awb=${resi}`;
  if (k.includes('ninja'))   return `https://www.ninjaxpress.co/id-id/tracking?id=${resi}`;
  if (k.includes('anteraja'))return `https://anteraja.id/tracking/${resi}`;
  if (k.includes('pos'))     return `https://www.posindonesia.co.id/id/tracking/${resi}`;
  return `https://cekresi.com/?noresi=${resi}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body || {};

    // Supabase webhook payload: { type, table, record, old_record }
    const { type, record, old_record } = payload;

    // Hanya proses UPDATE dan kalau no_resi baru diisi (sebelumnya kosong)
    if (type !== 'UPDATE') return res.status(200).json({ ok: true, skip: 'bukan update' });

    const noResi   = record?.no_resi   || record?.resi || '';
    const oldResi  = old_record?.no_resi || old_record?.resi || '';
    const hp       = record?.hp || record?.no_hp || '';
    const kurir    = record?.ekspedisi || record?.kurir || '';
    const nama     = record?.nama || '';

    // Skip kalau resi belum ada atau tidak berubah
    if (!noResi || noResi === oldResi) {
      return res.status(200).json({ ok: true, skip: 'resi tidak berubah' });
    }

    const waNumber = normalizeHP(hp);
    if (!waNumber || waNumber.length < 10) {
      return res.status(200).json({ ok: true, skip: 'hp tidak valid' });
    }

    console.log(`Resi baru: ${noResi} (${kurir}) → ${waNumber}`);

    // Cari customer di BotWA by wa_number
    const customers = await sbGet(`customers?wa_number=eq.${waNumber}&limit=1`);
    if (!customers.length) {
      console.log(`Customer ${waNumber} tidak ditemukan di BotWA`);
      return res.status(200).json({ ok: true, skip: 'customer tidak ada di BotWA' });
    }

    const customer = customers[0];

    // Cari conversation yang punya order (flag order_placed=true) dan belum dapat resi
    // Pakai flag ini bukan status, karena customer bisa chat lagi dan status berubah ke 'baru'
    const convs = await sbGet(
      `conversations?customer_id=eq.${customer.id}&order=last_msg_at.desc&limit=10`
    );
    const conv = convs.find(c => c.state?.order_placed && !c.state?.no_resi);
    if (!conv) {
      console.log(`Tidak ada order aktif tanpa resi untuk ${waNumber}`);
      return res.status(200).json({ ok: true, skip: 'tidak ada order atau sudah ada resi' });
    }
    const convArr = [conv];

    const userId   = conv.user_id;

    // Skip kalau conversation ini sudah pernah dapat resi (hindari dobel kirim)
    if (conv.state?.no_resi) {
      console.log(`Conversation ${conv.id} sudah punya resi ${conv.state.no_resi}, skip`);
      return res.status(200).json({ ok: true, skip: 'sudah ada resi sebelumnya' });
    }

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

    await sendWA(userId, waNumber, pesanResi);
    console.log(`Resi ${noResi} terkirim ke ${waNumber}`);

    return res.status(200).json({ ok: true, resi: noResi, wa: waNumber });

  } catch(e) {
    console.error('Resi webhook error:', e.message);
    return res.status(200).json({ ok: true, error: e.message }); // tetap 200 agar Supabase tidak retry terus
  }
};
