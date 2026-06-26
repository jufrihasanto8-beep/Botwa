/**
 * Cron: Tracking resi harian via Mengantar API
 * Schedule: 0 8 * * * (tiap pagi 08:00 WIB = 01:00 UTC)
 * Baca dari orders_new (status=dikirim, no_resi ada)
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MENGANTAR_KEY        = process.env.MENGANTAR_KEY;
const BAILEYS_URL          = process.env.BAILEYS_URL;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_KEY;

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

/* ── Normalisasi nama kurir ke format Mengantar ─────────── */
function normalizeKurir(eks) {
  const e = (eks || '').toUpperCase();
  if (e.includes('JNE'))                              return 'JNE';
  if (e.includes('JNT') || e.includes('J&T'))         return 'JT';
  if (e.includes('SICEPAT') || e.includes('SI CEPAT')) return 'SICEPAT';
  if (e.includes('SAP'))                              return 'SAP';
  if (e.includes('LION'))                             return 'LION';
  if (e.includes('NINJA'))                            return 'NINJA';
  if (e.includes('ANTERAJA'))                         return 'ANTERAJA';
  if (e.includes('IDX') || e.includes('IDEXPRESS'))   return 'IDEXPRESS';
  if (e.includes('POS'))                              return 'POS';
  return e;
}

/* ── Cek resi via Mengantar public API (tanpa key) ───────── */
async function fetchMengantar(resi, courier) {
  const url = courier
    ? `https://app.mengantar.com/api/order/getPublic?tracking_number=${encodeURIComponent(resi)}&courier=${encodeURIComponent(courier)}`
    : `https://app.mengantar.com/api/order/getPublic?tracking_number=${encodeURIComponent(resi)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.mengantar.com/',
      'Origin': 'https://www.mengantar.com',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data || json || null;
}

async function cekResi(resi, ekspedisi) {
  if (!resi) return null;
  const courier = normalizeKurir(ekspedisi);
  try {
    // Coba dengan kurir spesifik dulu
    let d = await fetchMengantar(resi, courier);

    // Kalau tidak ada data, coba auto-detect (tanpa kurir)
    if (!d || !(d.statusCategory || d.status || d.connote_state)) {
      console.log(`[tracking] Retry auto-detect tanpa kurir: ${resi}`);
      d = await fetchMengantar(resi, null);
    }

    if (!d) return null;

    const history    = d.history || d.connote_history || [];
    const statusCat  = (d.statusCategory || d.status || d.connote_state || '').toUpperCase();
    const destCity   = (d.RECEIVER_CITY || d.destination_city || '').toUpperCase();

    // Kalau tidak ada status sama sekali → API tidak kenal resi/kurir ini
    if (!statusCat) {
      console.warn(`[tracking] Tidak ada status dari API untuk ${resi} (kurir: ${ekspedisi}) — cek nama ekspedisi`);
      return null;
    }

    // Ambil history entry terakhir yang punya desc
    const lastHistory = [...history].reverse().find(h => h.desc || h.content || h.description);
    const deskripsi   = (lastHistory?.desc || lastHistory?.content || lastHistory?.description || '').trim();
    const lokasi      = (lastHistory?.location || lastHistory?.city || lastHistory?.city_name || '').trim();
    const lastCode    = (lastHistory?.code || '').toUpperCase();
    const lastStatusCode = lastHistory?.status_code ? Number(lastHistory.status_code) : null;
    const descUp      = deskripsi.toUpperCase();
    // Kalau lokasi kosong, coba ekstrak dari desc (banyak kurir tulis kota di desc)
    const lokasiFromDesc = lokasi || (deskripsi.match(/(?:DI|AT|HUB|KOTA)\s+([A-Z\s]+?)(?:\s*[-,]|$)/i)?.[1] || '').trim();

    // ── Deteksi event berdasarkan statusCategory (reliable semua kurir) ──
    let eventType = 'update';

    // ── Deteksi per kurir ───────────────────────────────────
    if (courier === 'JT') {
      // J&T: pakai status_code dari history (lebih reliable dari text)
      // 200 = delivered, 401 = retur, 152 = gagal antar (simpan di gudang)
      if (lastStatusCode === 200 || statusCat === 'PAKET TELAH DITERIMA') {
        eventType = 'delivered';
      } else if (lastStatusCode === 401 || statusCat.includes('DIRETUR') || statusCat.includes('AKAN DIRETUR')) {
        eventType = 'retur';
      } else if (lastStatusCode === 152) {
        // 152 = kurir sudah coba antar tapi gagal, paket balik ke gudang
        eventType = 'bermasalah';
      } else if (statusCat.includes('AKAN DIKIRIM KE ALAMAT PENERIMA')) {
        eventType = 'out_for_delivery';
      }
      // tiba_kota: J&T tidak return RECEIVER_CITY → skip untuk sekarang
    } else {
      // ── Kurir lain (JNE, SiCepat, dll) — pakai statusCategory normalized ──
      if (statusCat === 'DELIVERED' || statusCat === 'POD') {
        eventType = 'delivered';
      } else if (statusCat.includes('RETUR') || statusCat.includes('RETURN')) {
        eventType = 'retur';
      } else if (['DEX','UNDELIVERED','FAILED','UNDELL'].some(s => statusCat.includes(s))) {
        eventType = 'bermasalah';
      } else {
        // Untuk ON PROSES → cari granular event dari desc + statusCat
        const OTW_PATTERN = /WITH DELIVERY COURIER|OUT FOR DELIVERY|DIBAWA KURIR|ANTAR KE TUJUAN|ON DELIVERY|DRIVER PICKUP|SEDANG DIKIRIM|DALAM PENGIRIMAN/;
        const TIBA_PATTERN = /RECEIVED AT|ARRIVED AT|MASUK HUB|TIBA DI|INBOUND|RECEIVED AT WAREHOUSE/;

        const isOTW = OTW_PATTERN.test(descUp) || OTW_PATTERN.test(statusCat) || lastCode === 'IP3';

        const lokasiUp  = (lokasiFromDesc || lokasi).toUpperCase();
        const isDestLoc = destCity && lokasiUp && (
          destCity.split(',').some(c => lokasiUp.includes(c.trim())) ||
          lokasiUp.split(',').some(c => destCity.includes(c.trim()))
        );
        const isTibaKota = (
          (TIBA_PATTERN.test(descUp) || TIBA_PATTERN.test(statusCat)) && isDestLoc
        ) || /IP[12]/.test(lastCode);

        if (isOTW)           eventType = 'out_for_delivery';
        else if (isTibaKota) eventType = 'tiba_kota';
      }
    }

    return { statusCat, eventType, lokasi, deskripsi, raw: d };
  } catch (e) {
    console.error(`[tracking] cekResi error (${resi}):`, e.message);
    return null;
  }
}

/* ── Kirim notif WA via Baileys ──────────────────────────── */
async function kirimNotif(sessionId, waNumber, pesan) {
  if (!BAILEYS_URL || !waNumber) return;
  try {
    await fetch(`${BAILEYS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: WEBHOOK_SECRET,
        session_id: sessionId,
        wa_number: waNumber,
        message: pesan,
        is_outbound: true,
      }),
    });
  } catch (e) {
    console.error('[tracking] kirimNotif error:', e.message);
  }
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

/* ── Template pesan per event ────────────────────────────── */
const PESAN_TEMPLATE = {
  tiba_kota: (nama, resi, kurir, lokasi, isCOD, urlLacak) =>
    `${nama ? 'Kak ' + nama : 'Kak'}, paket udah sampai di kota tujuan nih 📦${isCOD ? '\n\nMohon siapkan uang COD-nya ya kak, sebentar lagi kurir datang!' : ''}\n\nResi: ${resi}${lokasi ? `\nLokasi: ${lokasi}` : ''}\nCek tracking: ${urlLacak}`,

  out_for_delivery: (nama, resi, kurir, lokasi, isCOD, urlLacak) =>
    `${nama ? 'Kak ' + nama : 'Kak'}, kurir lagi otw ke rumah kak hari ini! 🚚${isCOD ? '\n\n⚠️ Siapkan uang COD-nya ya kak!' : ''}\n\nResi: ${resi}\nCek tracking: ${urlLacak}`,

  delivered: (nama, resi, kurir, lokasi, isCOD, urlLacak) =>
    `${nama ? 'Kak ' + nama : 'Kak'}, paket sudah sampai dan diterima nih! 🎉\n\nSemoga produknya langsung bisa dipakai dan manfaatnya terasa ya kak 🙏 Kalau ada pertanyaan, kami siap bantu!`,

  bermasalah: (nama, resi, kurir, lokasi, isCOD, urlLacak) =>
    `${nama ? 'Kak ' + nama : 'Kak'}, ada kendala pengiriman paket kakak nih 😟\n\nKurir tidak berhasil mengantar. Mohon pastikan alamat dan nomor HP aktif ya kak.\n\nResi: ${resi}\nCek tracking: ${urlLacak}`,

  retur: (nama, resi, kurir, lokasi, isCOD, urlLacak) =>
    `${nama ? 'Kak ' + nama : 'Kak'}, paket kakak sedang dalam proses retur ke pengirim 😔\n\nResi: ${resi}\n\nNanti kami hubungi untuk koordinasi lebih lanjut ya kak.`,
};

/* ── Generate pesan via AI (dengan fallback ke template) ─── */
async function buildPesan({ namaKak, resi, ekspedisi, eventType, deskripsi, lokasi, isCOD, urlLacak, userTpl }) {
  // Pakai template custom dari user kalau ada
  const tplKeyMap = {
    tiba_kota: 'template_tiba_kota',
    out_for_delivery: 'template_out_for_delivery',
    delivered: 'template_delivered',
    bermasalah: 'template_bermasalah',
    retur: 'template_retur',
  };
  const customTpl = userTpl?.[tplKeyMap[eventType]];
  if (customTpl) {
    let pesan = customTpl
      .replace(/{nama}/g, namaKak || '')
      .replace(/{resi}/g, resi || '')
      .replace(/{kurir}/g, ekspedisi || '')
      .replace(/{link}/g, urlLacak || '');
    if (eventType === 'tiba_kota' && isCOD) {
      pesan += '\n\n⚠️ Siapkan uang COD-nya ya kak!';
    }
    return pesan;
  }

  const tmpl = PESAN_TEMPLATE[eventType];
  const fallback = tmpl ? tmpl(namaKak, resi, ekspedisi, lokasi, isCOD, urlLacak) : null;

  if (!ANTHROPIC_KEY || eventType === 'retur' || eventType === 'bermasalah') return fallback;

  const konteksMap = {
    tiba_kota:        `Paket baru SAMPAI DI KOTA TUJUAN customer.${isCOD ? ' Ini order COD, customer perlu siapkan uang.' : ''} Lokasi sekarang: ${lokasi || 'kota tujuan'}.`,
    out_for_delivery: `Paket SEDANG DIANTAR kurir hari ini ke alamat customer.${isCOD ? ' Ini order COD, ingatkan siapkan uang.' : ''}`,
    delivered:        `Paket SUDAH SAMPAI dan diterima customer. Tanyakan kondisi/manfaat produk.`,
  };

  const konteks = konteksMap[eventType] || `Status terbaru: "${deskripsi}".`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content:
          `Kamu CS toko herbal yang hangat. Kirim notif WhatsApp ke customer soal status paket.

Customer: ${namaKak ? 'kak ' + namaKak : 'kak'}
Kurir: ${ekspedisi || 'ekspedisi'}
Resi: ${resi}
Situasi: ${konteks}
${eventType !== 'delivered' ? `Link tracking: ${urlLacak}` : ''}

Ketentuan:
- 2-3 kalimat, natural, seperti teman — bukan CS formal
- ${eventType === 'tiba_kota' || eventType === 'out_for_delivery' ? 'Sertakan link tracking' : 'Tanyakan kondisi/manfaat produknya'}
- 1-2 emoji saja
- JANGAN markdown (*, _, dll)

Tulis pesannya langsung.` }],
      }),
    });
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || fallback;
  } catch (e) {
    console.error('[tracking] AI msg error:', e.message);
    return fallback;
  }
}

/* ── Normalisasi kurir untuk CREATE ORDER Mengantar ─────────── */
function kurirCreate(eks) {
  const e = (eks || '').toUpperCase();
  if (e.includes('JNE'))                               return 'JNE';
  if (e.includes('JNT') || e.includes('J&T'))          return 'JT';
  if (e.includes('SICEPAT') || e.includes('SI CEPAT')) return 'SiCepat';
  if (e.includes('SAP'))                               return 'Sap';
  if (e.includes('LION'))                              return 'lion';
  if (e.includes('NINJA'))                             return 'Ninja';
  if (e.includes('ANTERAJA'))                          return 'anteraja';
  if (e.includes('IDX') || e.includes('IDEXPRESS'))    return 'iDexpress';
  return eks;
}

/* ── Lookup destination ID dari Mengantar ───────────────────── */
async function lookupDestId(alamat) {
  const { kelurahan, kecamatan, kabupaten } = alamat || {};
  if (!kecamatan) return null;
  const queries = [
    [kelurahan, kecamatan, kabupaten].filter(Boolean).join(', '),
    [kecamatan, kabupaten].filter(Boolean).join(', '),
    kecamatan,
  ];
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
    'Referer': 'https://www.mengantar.com/',
    'Origin': 'https://www.mengantar.com',
  };
  for (const q of queries) {
    try {
      const r = await fetch(`https://app.mengantar.com/api/address/autofill?keyword=${encodeURIComponent(q)}`, { headers });
      const json = await r.json();
      const results = json.data || json;
      if (Array.isArray(results) && results.length) return results[0]._id || results[0].id;
    } catch(e) { /* coba query berikutnya */ }
  }
  return null;
}

/* ── Fetch time slots, pilih yang jam 15:00 ─────────────────── */
async function getTimeId15(mngKey) {
  try {
    const r = await fetch(`https://app.mengantar.com/api/public/${mngKey}/time`, {
      headers: { 'Accept': 'application/json' },
    });
    const json = await r.json();
    const times = json.data || json;
    if (!Array.isArray(times) || !times.length) return null;
    // Pilih slot jam 15 (atau terdekat setelah 14:00)
    const find = times.find(t => {
      const label = (t.label || t.name || t.time || '').toString();
      return label.includes('15') || label.includes('3 PM') || label.includes('15:00');
    });
    return (find || times[times.length - 1])._id || (find || times[times.length - 1]).id;
  } catch(e) {
    console.error('[createOrder] Gagal fetch time slots:', e.message);
    return null;
  }
}

/* ── CREATE ORDER ke Mengantar ───────────────────────────────── */
async function handleCreateMengantar(req, res) {
  const { order_ids, user_id } = req.body || {};
  if (!order_ids?.length || !user_id) return res.status(400).json({ error: 'order_ids dan user_id wajib' });

  try {
    // 1. Fetch orders + customers + products + user
    const orders = await sbGet('orders_new',
      `?id=in.(${order_ids.join(',')})&user_id=eq.${user_id}&select=*`
    );
    if (!orders.length) return res.status(404).json({ error: 'Order tidak ditemukan' });

    const custIds = [...new Set(orders.map(o => o.customer_id))];
    const prodIds = [...new Set(orders.map(o => o.product_id).filter(Boolean))];

    const [customers, products, userRows] = await Promise.all([
      sbGet('customers', `?id=in.(${custIds.join(',')})&select=id,nama,wa_number`),
      prodIds.length ? sbGet('products', `?id=in.(${prodIds.join(',')})&select=id,nama,harga,berat_gram`) : Promise.resolve([]),
      sbGet('users', `?id=eq.${user_id}&select=id,mengantar_key,mengantar_origin_id&limit=1`),
    ]);

    const custMap = Object.fromEntries(customers.map(c => [c.id, c]));
    const prodMap = Object.fromEntries(products.map(p => [p.id, p]));

    // Pakai key & origin_id per user, fallback ke env global
    const userRow      = userRows[0] || {};
    const mngKey       = userRow.mengantar_key       || MENGANTAR_KEY;
    const mngOriginId  = userRow.mengantar_origin_id || process.env.MENGANTAR_ORIGIN_ID || '5fc63315f8f44b34aa4c44c7';

    if (!mngKey) return res.status(400).json({ error: 'Mengantar API key belum dikonfigurasi. Isi di Settings → Mengantar.' });

    // 2. Fetch time_id jam 15:00
    const timeId = await getTimeId15(mngKey);

    // 3. Group orders by kurir
    const grouped = {};
    for (const o of orders) {
      const kurir = kurirCreate(o.ekspedisi) || 'JNE';
      if (!grouped[kurir]) grouped[kurir] = [];
      grouped[kurir].push(o);
    }

    const results = [];

    // 4. Proses per kurir
    for (const [kurir, kurirOrders] of Object.entries(grouped)) {
      const orderItems = [];

      for (const o of kurirOrders) {
        const cu   = custMap[o.customer_id] || {};
        const prod = prodMap[o.product_id]  || {};
        const al   = o.alamat || {};
        const isCOD = (o.metode || '').toLowerCase() === 'cod';
        const qty   = o.qty || 1;
        const harga = o.harga || prod.harga || 0;
        const berat = ((prod.berat_gram || 1000) / 1000) * qty;

        // Lookup dest ID (cache di alamat.mengantar_dest_id)
        let destId = al.mengantar_dest_id || null;
        if (!destId) {
          destId = await lookupDestId(al);
          // Simpan ke orders_new untuk cache
          if (destId) {
            await sbPatch('orders_new', `?id=eq.${o.id}`, {
              alamat: { ...al, mengantar_dest_id: destId }
            }).catch(() => {});
          }
        }

        const alamatStr = [al.jalan, al.kelurahan, al.kecamatan, al.kabupaten, al.provinsi, al.kodepos]
          .filter(Boolean).join(', ');

        const beratSatuan = (prod.berat_gram || 1000) / 1000; // kg per unit
        const item = {
          customerName:          cu.nama || '-',
          customerPhone:         (cu.wa_number || '').replace(/^62/, '0'),
          customerAddress:       alamatStr || '-',
          parcelContent:         prod.nama || 'Produk',
          weight:                beratSatuan * qty,  // total weight
          quantity:              qty,
          dontIncludeSubdistrict: false,
          customProducts: [{
            name:   prod.nama || 'Produk',
            qty:    qty,
            price:  harga,
            weight: beratSatuan,  // weight per unit — wajib ada agar validasi Mengantar lolos
          }],
        };

        if (destId) item.customerAddressDataId = destId;
        if (isCOD)  item.COD = o.total || 0;
        else        item.goodsValue = harga * qty;

        orderItems.push({ orderId: o.id, item });
      }

      // 5. POST ke Mengantar (JSON body)
      try {
        const pickupPayload = {
          address_id: mngOriginId,
          type: 'scheduledPickup',
          volume: 'volumeMobil',
          ...(timeId ? { time_id: timeId } : {}),
        };
        const ordersPayload = orderItems.map(x => x.item);
        console.log('[createMengantar] payload kurir', kurir, JSON.stringify({ courier: kurir, pickup: pickupPayload, orders: ordersPayload }));

        const mResp = await fetch(`https://app.mengantar.com/api/public/${mngKey}/order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ courier: kurir, pickup: pickupPayload, orders: ordersPayload }),
        });
        const mText = await mResp.text();
        console.log('[createMengantar] HTTP', mResp.status, 'kurir', kurir, mText.slice(0, 800));
        let mJson;
        try { mJson = JSON.parse(mText); } catch { mJson = { success: false, message: `Non-JSON (${mResp.status}): ${mText.slice(0, 200)}` }; }

        if (mJson.success && Array.isArray(mJson.data)) {
          // Update orders_new dengan cnote_no dan status dikirim
          for (let i = 0; i < mJson.data.length; i++) {
            const mOrder = mJson.data[i];
            const orderId = orderItems[i]?.orderId;
            const cnote = mOrder.cnote_no || '';
            if (orderId) {
              await sbPatch('orders_new', `?id=eq.${orderId}`, {
                no_resi:    cnote,
                ekspedisi:  kurir,
                status:     'dikirim',
                status_tracking: 'dikirim',
              }).catch(() => {});
            }
            results.push({
              orderId,
              kurir,
              success: true,
              cnote_no: cnote,
              unpaid:   mOrder.unpaid || false,
            });
          }
          // Catat errors dari Mengantar
          if (mJson.errors?.length) {
            mJson.errors.forEach(err => results.push({ kurir, success: false, error: String(err?.message || err) }));
          }
        } else {
          const errDetail = mJson.errors?.length ? ` | ${JSON.stringify(mJson.errors).slice(0, 300)}` : '';
          const errMsg = (mJson.message || mJson.error || mJson.msg || JSON.stringify(mJson).slice(0, 200)) + errDetail;
          orderItems.forEach(x => results.push({
            orderId: x.orderId, kurir, success: false,
            error: String(errMsg),
          }));
        }
      } catch(e) {
        const errMsg = e?.message || e?.toString() || 'Unknown error';
        orderItems.forEach(x => results.push({ orderId: x.orderId, kurir, success: false, error: errMsg }));
      }
    }

    return res.status(200).json({ ok: true, results });

  } catch(e) {
    console.error('[createOrder] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Route: create mengantar order
  if (req.method === 'POST' && req.body?.action === 'create-mengantar') {
    return handleCreateMengantar(req, res);
  }

  // Verifikasi cron secret
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const secret = req.headers['x-cron-secret'];
    if (secret !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    console.log('🚚 Mulai tracking resi dari orders_new...');

    // Ambil semua order yang status=dikirim dan punya no_resi
    const orders = await sbGet('orders_new',
      `?status=eq.dikirim&no_resi=not.is.null&no_resi=neq.&select=id,user_id,customer_id,no_resi,ekspedisi,metode,status_tracking,tracking_lokasi,tracking_events`
    );

    if (!orders.length) {
      console.log('[tracking] Tidak ada order aktif yang perlu di-tracking.');
      return res.status(200).json({ ok: true, message: 'tidak ada order aktif' });
    }

    // Ambil semua customer sekaligus
    const custIds = [...new Set(orders.map(o => o.customer_id))];
    const customers = await sbGet('customers',
      `?id=in.(${custIds.join(',')})&select=id,user_id,wa_number,nama,reply_jid`
    );
    const custMap = Object.fromEntries(customers.map(c => [c.id, c]));

    // Ambil template notif per user
    const userIds = [...new Set(orders.map(o => o.user_id))];
    const userRows = await sbGet('users',
      `?id=in.(${userIds.join(',')})&select=id,template_tiba_kota,template_out_for_delivery,template_delivered,template_bermasalah,template_retur`
    );
    const userTplMap = Object.fromEntries(userRows.map(u => [u.id, u]));

    console.log(`[tracking] ${orders.length} order akan di-tracking...`);
    let updated = 0, notified = 0, errors = 0;

    for (const order of orders) {
      try {
        const tracking = await cekResi(order.no_resi, order.ekspedisi);
        if (!tracking) {
          console.log(`[tracking] No data: ${order.no_resi}`);
          continue;
        }

        const { statusCat, eventType, lokasi, deskripsi } = tracking;

        console.log(`[tracking] ${order.no_resi} | kurir: ${order.ekspedisi || '?'} | statusCat: ${statusCat} | event: ${eventType} | lokasi: ${lokasi || '-'} | desc: ${deskripsi?.slice(0,60) || '-'}`);

        const doneEvents = order.tracking_events || {};

        // Selalu update status & lokasi terbaru ke DB
        const lokasiUpdate = lokasi || order.tracking_lokasi;
        if (statusCat !== order.status_tracking || lokasi !== order.tracking_lokasi) {
          await sbPatch('orders_new', `?id=eq.${order.id}`, {
            status_tracking: statusCat,
            tracking_lokasi: lokasiUpdate,
          });
          updated++;
        }

        // Cek apakah ada event baru yang perlu dinotif
        if (doneEvents[eventType] && eventType !== 'update') {
          console.log(`[tracking] Event "${eventType}" sudah pernah dinotif: ${order.no_resi}`);
          continue;
        }
        if (eventType === 'update') {
          console.log(`[tracking] Lokasi update (no notif): ${order.no_resi} → ${lokasiUpdate || '-'}`);
          continue;
        }

        // Catat event ke tracking_events
        const patch = {
          tracking_events: { ...doneEvents, [eventType]: new Date().toISOString() },
        };
        if (eventType === 'delivered') {
          patch.status    = 'selesai';
          patch.sampai    = true;
          patch.sampai_at = new Date().toISOString();
        }
        await sbPatch('orders_new', `?id=eq.${order.id}`, patch);

        const label = { tiba_kota: '🏙️ TIBA KOTA', out_for_delivery: '🚚 OTW', delivered: '✅ SAMPAI', bermasalah: '⚠️ BERMASALAH', retur: '🔄 RETUR' };
        console.log(`[tracking] ${label[eventType] || eventType}: ${order.no_resi} (${statusCat})`);

        const cust = custMap[order.customer_id];
        if (!cust) continue;
        const waTarget = cust.reply_jid || cust.wa_number;
        if (!waTarget) continue;

        const namaKak  = (cust.nama || '').split(' ')[0];
        const urlLacak = trackingUrl(order.ekspedisi, order.no_resi);
        const isCOD    = (order.metode || '').toLowerCase() === 'cod';

        const pesan = await buildPesan({
          namaKak, resi: order.no_resi, ekspedisi: order.ekspedisi,
          eventType, deskripsi, lokasi, isCOD, urlLacak,
          userTpl: userTplMap[order.user_id],
        });

        if (pesan) {
          await kirimNotif(order.user_id, waTarget, pesan);
          notified++;
        }

        // Jeda antar request ke Mengantar
        await new Promise(r => setTimeout(r, 600));

      } catch (e) {
        errors++;
        console.error(`[tracking] Error order ${order.id} (${order.no_resi}):`, e.message);
      }
    }

    console.log(`[tracking] ✅ Selesai. Updated: ${updated}, Notified: ${notified}, Errors: ${errors}`);
    return res.status(200).json({ ok: true, updated, notified, errors });

  } catch (err) {
    console.error('[tracking] Fatal error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
