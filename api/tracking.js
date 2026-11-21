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
async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
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
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data || json || null;
}

/* ── Proses data Mengantar yang sudah di-fetch → extract event ── */
function processTrackingData(d, courier) {
  if (!d) return null;

  const history    = Array.isArray(d.history) ? d.history : (Array.isArray(d.connote_history) ? d.connote_history : []);
  const statusCat  = (d.statusCategory || d.status || d.connote_state || '').toUpperCase();
  const destCity   = (d.RECEIVER_CITY || d.destination_city || '').toUpperCase();

  if (!statusCat) return null;

  const lastHistory = [...history].reverse().find(h => h.desc || h.content || h.description);
  const deskripsi   = (lastHistory?.desc || lastHistory?.content || lastHistory?.description || '').trim();
  const lokasi      = (lastHistory?.location || lastHistory?.city || lastHistory?.city_name || '').trim();
  const lastCode    = (lastHistory?.code || '').toUpperCase();
  const lastStatusCode = lastHistory?.status_code ? Number(lastHistory.status_code) : null;
  const descUp      = deskripsi.toUpperCase();
  const lokasiFromDesc = lokasi || (deskripsi.match(/(?:DI|AT|HUB|KOTA)\s+([A-Z\s]+?)(?:\s*[-,]|$)/i)?.[1] || '').trim();

  let eventType = 'update';

  if (courier === 'JT') {
    if (lastStatusCode === 200 || statusCat === 'PAKET TELAH DITERIMA') {
      eventType = 'delivered';
    } else if (lastStatusCode === 401 || statusCat.includes('DIRETUR') || statusCat.includes('AKAN DIRETUR')) {
      eventType = 'retur';
    } else if (lastStatusCode === 152) {
      eventType = 'bermasalah';
    } else if (statusCat.includes('AKAN DIKIRIM KE ALAMAT PENERIMA')) {
      eventType = 'out_for_delivery';
    }
  } else {
    if (statusCat === 'DELIVERED' || statusCat === 'POD') {
      eventType = 'delivered';
    } else if (statusCat.includes('RETUR') || statusCat.includes('RETURN')) {
      eventType = 'retur';
    } else if (['DEX','UNDELIVERED','FAILED','UNDELL'].some(s => statusCat.includes(s))) {
      eventType = 'bermasalah';
    } else {
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
      else {
        // Status transit umum → dikirim (agar tracking_events terisi)
        const TRANSIT_PATTERN = /ON PROCESS|CARGO|TRANSIT|CRROTW|CRRNFD|SHPSCD|BKD|STI|PICKUP|MANIFESTED|SHIPMENT|PROCESSED|SORTING|RECEIVED/;
        if (TRANSIT_PATTERN.test(statusCat) || TRANSIT_PATTERN.test(descUp)) {
          eventType = 'dikirim';
        }
      }
    }
  }

  return { statusCat, eventType, lokasi, deskripsi, raw: d };
}

/* ── Fetch + proses resi (untuk cron & check-all) ── */
async function cekResi(resi, ekspedisi) {
  if (!resi) return null;
  const courier = normalizeKurir(ekspedisi);
  try {
    let d = await fetchMengantar(resi, courier);
    if (!d || !(d.statusCategory || d.status || d.connote_state)) {
      console.log(`[tracking] Retry auto-detect tanpa kurir: ${resi}`);
      d = await fetchMengantar(resi, null);
    }
    return processTrackingData(d, courier);
  } catch (e) {
    console.error(`[tracking] cekResi error (${resi}):`, e.message);
    return null;
  }
}

/* ── Helper: ambil wa_session_id dari produk ─────────────── */
async function getWaSession(userId, productId) {
  if (productId) {
    const rows = await sbGet(`products?id=eq.${productId}&select=wa_session_id&limit=1`).catch(() => []);
    if (rows[0]?.wa_session_id) return rows[0].wa_session_id;
  }
  const rows = await sbGet(`products?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=wa_session_id&limit=1`).catch(() => []);
  return rows[0]?.wa_session_id || userId;
}

/* ── Kirim notif WA via Baileys ──────────────────────────── */
async function kirimNotif(sessionId, waNumber, pesan) {
  if (!BAILEYS_URL || !waNumber) return;
  try {
    await fetch(`${BAILEYS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
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
      signal: AbortSignal.timeout(12000),
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

/* ── Helper: extract field dari Mengantar area ──────────────── */
const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const aSubdistrict = a => a.SUBDISTRICT_NAME || a.subdistrict || '';
const aDistrict    = a => a.DISTRICT_NAME    || a.district    || '';
const aCity        = a => a.CITY_NAME        || a.city        || a.regency || '';
const aProvince    = a => a.PROVINCE_NAME    || a.province    || '';
const aZip         = a => a.ZIP_CODE         || a.posCode     || '';

/* ── Lookup destination dari Mengantar (smart scoring) ──────── */
async function lookupDest(alamat) {
  const { kelurahan, kecamatan, kabupaten, provinsi } = alamat || {};
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

  // Kumpulkan semua hasil dari semua query (dedup by _id)
  const seenIds = new Set();
  const allAreas = [];
  for (const q of queries) {
    try {
      const r = await fetch(`https://app.mengantar.com/api/address/autofill?keyword=${encodeURIComponent(q)}`, { headers, signal: AbortSignal.timeout(8000) });
      const json = await r.json();
      const results = json.data || json;
      if (Array.isArray(results)) {
        for (const a of results) {
          const id = a._id || a.id;
          if (id && !seenIds.has(id)) { seenIds.add(id); allAreas.push(a); }
        }
      }
    } catch(e) { /* coba query berikutnya */ }
  }
  if (!allAreas.length) return null;

  // Scoring — match field by field
  let best = allAreas[0], bestScore = -1;
  for (const a of allAreas) {
    let score = 0;
    if (kelurahan) {
      if (normStr(aSubdistrict(a)) === normStr(kelurahan)) score += 50;
      else if (aSubdistrict(a).toLowerCase().includes(kelurahan.toLowerCase())) score += 25;
    }
    if (kecamatan) {
      if (normStr(aDistrict(a)) === normStr(kecamatan)) score += 30;
      else if (aDistrict(a).toLowerCase().includes(kecamatan.toLowerCase())) score += 15;
    }
    if (kabupaten) {
      if (normStr(aCity(a)) === normStr(kabupaten)) score += 20;
      else if (aCity(a).toLowerCase().includes(kabupaten.toLowerCase())) score += 10;
    }
    if (provinsi) {
      if (normStr(aProvince(a)) === normStr(provinsi)) score += 10;
    }
    if (score > bestScore) { bestScore = score; best = a; }
  }

  return {
    id:         best._id || best.id,
    kelurahan:  aSubdistrict(best),
    kecamatan:  aDistrict(best),
    kabupaten:  aCity(best),
    provinsi:   aProvince(best),
    kodepos:    aZip(best),
    score:      bestScore,
    label:      [aProvince(best), aCity(best), aDistrict(best), aSubdistrict(best), aZip(best)].filter(Boolean).join(', '),
  };
}

// Backward-compat wrapper — returns just ID
async function lookupDestId(alamat) {
  const dest = await lookupDest(alamat);
  return dest?.id || null;
}

/* ── Fetch/create time slot untuk pickup hari ini ────────────── */
async function getTimeSlot(mngKey, originId) {
  try {
    // Hitung waktu WIB sekarang + 2 jam (aman dari batas 90 menit)
    const nowWIB = new Date(Date.now() + 7 * 3600 * 1000);
    const minPickupWIB = new Date(nowWIB.getTime() + 2 * 3600 * 1000);
    const dateStr = nowWIB.toISOString().slice(0, 10);

    // Tentukan jam pickup: minimal 2 jam dari sekarang, bulatkan ke atas ke jam penuh
    let pickupHour = minPickupWIB.getUTCHours();
    if (minPickupWIB.getUTCMinutes() > 0) pickupHour += 1; // 13:59 → 14:00 bukan 13:00
    if (pickupHour < 10) pickupHour = 10;
    if (pickupHour > 20) pickupHour = 20;
    const pickupTime = String(pickupHour).padStart(2, '0') + ':00';

    // 1. Cek time slots yang sudah ada
    const r = await fetch(`https://app.mengantar.com/api/public/${mngKey}/time`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const json = await r.json();
    const times = json.data || json;

    if (Array.isArray(times) && times.length) {
      // Cari slot yang waktunya >= pickupTime (masih valid)
      const valid = times.filter(t => {
        const slotTime = (t.time || '').slice(0, 5);
        return slotTime >= pickupTime;
      });
      if (valid.length) {
        const picked = valid[0]; // slot paling awal yang masih valid
        console.log('[getTimeSlot] pakai slot existing:', picked.time, picked._id || picked.id);
        return picked._id || picked.id;
      }
      // Semua slot sudah lewat — buat baru
    }

    // 2. Buat slot baru
    console.log(`[getTimeSlot] bikin slot baru jam ${pickupTime}...`);

    const cr = await fetch(`https://app.mengantar.com/api/public/${mngKey}/time`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        time: pickupTime,
        date: dateStr,
        address_id: originId,
      }),
    });
    const crJson = await cr.json();

    if (crJson.success && crJson.data?._id) {
      console.log('[getTimeSlot] slot baru dibuat:', pickupTime, crJson.data._id);
      return crJson.data._id;
    }

    console.error('[getTimeSlot] Gagal bikin slot:', JSON.stringify(crJson));
    return null;
  } catch(e) {
    console.error('[getTimeSlot] Error:', e.message);
    return null;
  }
}

/* ── PREVIEW: lookup area Mengantar untuk verifikasi ────────── */
async function handlePreviewMengantar(req, res) {
  const { order_ids, user_id } = req.body || {};
  if (!order_ids?.length || !user_id) return res.status(400).json({ error: 'order_ids dan user_id wajib' });

  try {
    const orders = await sbGet('orders_new',
      `?id=in.(${order_ids.join(',')})&user_id=eq.${user_id}&select=id,customer_id,product_id,alamat,ekspedisi,metode,qty,harga,total`
    );
    if (!orders.length) return res.status(404).json({ error: 'Order tidak ditemukan' });

    const custIds = [...new Set(orders.map(o => o.customer_id))];
    const prodIds = [...new Set(orders.map(o => o.product_id).filter(Boolean))];
    const [customers, products] = await Promise.all([
      sbGet('customers', `?id=in.(${custIds.join(',')})&select=id,nama,wa_number`),
      prodIds.length ? sbGet('products', `?id=in.(${prodIds.join(',')})&select=id,nama,sku`) : Promise.resolve([]),
    ]);
    const custMap = Object.fromEntries(customers.map(c => [c.id, c]));
    const prodMap = Object.fromEntries(products.map(p => [p.id, p]));

    // Lookup area untuk setiap order
    const previews = [];
    for (const o of orders) {
      const al = o.alamat || {};
      const cu = custMap[o.customer_id] || {};
      const prod = prodMap[o.product_id] || {};

      // Cek apakah sudah ada cached dest_id
      let dest = null;
      if (al.mengantar_dest_id) {
        dest = { id: al.mengantar_dest_id, label: al.mengantar_dest_label || '(tersimpan)', score: 999 };
      } else {
        dest = await lookupDest(al);
      }

      previews.push({
        orderId:    o.id,
        nama:       cu.nama || '-',
        produk:     prod.nama || '-',
        kurir:      o.ekspedisi || '-',
        metode:     o.metode || 'cod',
        alamatOrder: {
          jalan:     al.jalan || '',
          kelurahan: al.kelurahan || '',
          kecamatan: al.kecamatan || '',
          kabupaten: al.kabupaten || '',
          provinsi:  al.provinsi || '',
          kodepos:   al.kodepos || '',
        },
        match: dest ? {
          id:        dest.id,
          label:     dest.label || '',
          kelurahan: dest.kelurahan || '',
          kecamatan: dest.kecamatan || '',
          kabupaten: dest.kabupaten || '',
          provinsi:  dest.provinsi || '',
          kodepos:   dest.kodepos || '',
          score:     dest.score ?? 0,
        } : null,
      });
    }

    return res.status(200).json({ ok: true, previews });
  } catch(e) {
    console.error('[previewMengantar] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

/* ── CREATE ORDER ke Mengantar ───────────────────────────────── */
async function handleCreateMengantar(req, res) {
  const { order_ids, user_id, dest_overrides } = req.body || {};
  // dest_overrides = { orderId: destId, ... } — dari preview jika user memilih area berbeda
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
      sbGet('customers', `?id=in.(${custIds.join(',')})&select=id,nama,wa_number,reply_jid`),
      prodIds.length ? sbGet('products', `?id=in.(${prodIds.join(',')})&select=id,nama,sku,harga,berat_gram,wa_session_id,harga_bundling,persona_cs_nama,advertiser,admin_nama`) : Promise.resolve([]),
      sbGet('users', `?id=eq.${user_id}&select=id,mengantar_key,mengantar_origin_id,template_resi_dikirim&limit=1`),
    ]);

    const custMap = Object.fromEntries(customers.map(c => [c.id, c]));
    const prodMap = Object.fromEntries(products.map(p => [p.id, p]));

    // Pakai key & origin_id per user, fallback ke env global
    const userRow      = userRows[0] || {};
    const mngKey       = userRow.mengantar_key       || MENGANTAR_KEY;
    const mngOriginId  = userRow.mengantar_origin_id || process.env.MENGANTAR_ORIGIN_ID || '5fc63315f8f44b34aa4c44c7';

    if (!mngKey) return res.status(400).json({ error: 'Mengantar API key belum dikonfigurasi. Isi di Settings → Mengantar.' });

    // 2. Fetch/create time slot pickup jam 16:00
    const timeId = await getTimeSlot(mngKey, mngOriginId);
    if (!timeId) return res.status(400).json({ error: 'Gagal membuat jadwal pickup di Mengantar. Cek konfigurasi Mengantar.' });

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
        const isCOD      = (o.metode || '').toLowerCase() === 'cod';
        const qty        = o.qty || 1;
        const hargaSatuan = o.harga || prod.harga || 0;
        const totalCOD   = o.total || (hargaSatuan * qty);
        const totalNilai = hargaSatuan * qty;
        const berat      = ((prod.berat_gram || 1000) / 1000);

        // Lookup dest ID — prioritas: override dari preview → cached → auto lookup
        let destId = dest_overrides?.[o.id] || al.mengantar_dest_id || null;
        if (!destId) {
          destId = await lookupDestId(al);
        }
        // Simpan dest_id ke order supaya tidak perlu lookup lagi
        if (destId && destId !== al.mengantar_dest_id) {
          await sbPatch('orders_new', `?id=eq.${o.id}`, {
            alamat: { ...al, mengantar_dest_id: destId }
          }).catch(() => {});
        }

        const alamatStr = destId
          ? [al.jalan, al.kodepos].filter(Boolean).join(', ')
          : [al.jalan, al.kelurahan, al.kecamatan, al.kabupaten, al.provinsi, al.kodepos].filter(Boolean).join(', ');

        // Format customerName: Nama|SKU qty+BONUS_SKU qty
        let custNameFormatted = cu.nama || '-';
        if (prod.sku) {
          const skuParts = [prod.sku + ' ' + qty];
          // Cek apakah ada bonus dari bundling yang sesuai qty
          const bundling = Array.isArray(prod.harga_bundling) ? prod.harga_bundling : [];
          const matchPaket = bundling.find(b => b.qty === qty);
          if (matchPaket?.bonus_sku) {
            skuParts.push(matchPaket.bonus_sku + ' 1');
          }
          custNameFormatted = (cu.nama || '-') + '|' + skuParts.join('+');
        }

        // Data tim untuk label Mengantar
        const csNama   = prod.persona_cs_nama || '';
        const advNama  = prod.advertiser      || '';
        const admNama  = prod.admin_nama      || '';

        const item = {
          customerName:           custNameFormatted,
          customerPhone:          (cu.wa_number || '').replace(/^62/, '0'),
          customerAddress:        alamatStr || '-',
          parcelContent:          (() => {
            const parts = ['New', (prod.nama || 'Produk'), qty];
            // Bonus dari bundling
            const bundling = Array.isArray(prod.harga_bundling) ? prod.harga_bundling : [];
            const matchPaket = bundling.find(b => b.qty === qty);
            if (matchPaket?.bonus) parts.push('Bonus', matchPaket.bonus, '1');
            if (csNama) parts.push('CS', csNama);
            return parts.join(' ');
          })(),
          weight:                 berat * qty,
          quantity:               qty,
          dontIncludeSubdistrict: false,
          customProducts: [{
            name:   prod.nama || 'Produk',
            qty:    qty,
            price:  hargaSatuan,
            weight: berat,
          }],
        };

        if (destId)   item.customerAddressDataId = destId;
        if (isCOD)    item.COD        = totalCOD;
        else          item.goodsValue = totalNilai;

        // Instruksi pengiriman: CS X/ADV Y/Admin|ongkir|potOngkir|admin|potAdmin|hargaProduk
        const pengirim = ['CS ' + csNama, advNama ? 'ADV ' + advNama : '', admNama].filter(Boolean).join('/');
        const ongkirAsli   = o.ongkir || 0;
        const ongkirPromo  = o.ongkir_after_promo ?? ongkirAsli;
        const potOngkir    = ongkirAsli - ongkirPromo;
        const feeCod       = o.fee_cod || 0;
        const potAdmin     = 0;
        const hargaProdukTotal = hargaSatuan * qty;
        item.deliveryInstruction = `${pengirim}|${ongkirAsli}|${potOngkir}|${feeCod}|${potAdmin}|${hargaProdukTotal}`;

        // Lengkapi orders_new dengan data flat sebelum kirim
        await sbPatch('orders_new', `?id=eq.${o.id}`, {
          customer_nama:    cu.nama || '-',
          customer_phone:   (cu.wa_number || '').replace(/^62/, '0'),
          product_nama:     prod.nama || '-',
          berat_gram:       prod.berat_gram || 0,
          mengantar_status: 'pending',
        }).catch(() => {});

        orderItems.push({ orderId: o.id, item });
      }

      // 5. POST ke Mengantar (JSON body)
      try {
        const pickupPayload = {
          address_id: mngOriginId,
          type: 'scheduledPickup',
          volume: 'volumeMobil',
          time_id: timeId,
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
          for (let i = 0; i < mJson.data.length; i++) {
            const mOrder  = mJson.data[i];
            const orderId = orderItems[i]?.orderId;
            const cnote   = mOrder.cnote_no || '';
            if (orderId) {
              await sbPatch('orders_new', `?id=eq.${orderId}`, {
                no_resi:          cnote,
                ekspedisi:        kurir,
                status:           'dikirim',
                status_tracking:  'menunggu_pickup',
                mengantar_status: 'sent',
                mengantar_sent_at: new Date().toISOString(),
                mengantar_error:  null,
              }).catch(() => {});
            }
            results.push({ orderId, kurir, success: true, cnote_no: cnote, unpaid: mOrder.unpaid || false });
          }
          if (mJson.errors?.length) {
            mJson.errors.forEach(err => results.push({ kurir, success: false, error: String(err?.message || err) }));
          }
        } else {
          const errDetail = mJson.errors?.length ? ` | ${JSON.stringify(mJson.errors).slice(0, 300)}` : '';
          const errMsg = (mJson.message || mJson.error || mJson.msg || JSON.stringify(mJson).slice(0, 200)) + errDetail;
          for (const x of orderItems) {
            await sbPatch('orders_new', `?id=eq.${x.orderId}`, {
              mengantar_status: 'failed',
              mengantar_error:  String(errMsg).slice(0, 500),
            }).catch(() => {});
            results.push({ orderId: x.orderId, kurir, success: false, error: String(errMsg) });
          }
        }
      } catch(e) {
        const errMsg = e?.message || e?.toString() || 'Unknown error';
        for (const x of orderItems) {
          await sbPatch('orders_new', `?id=eq.${x.orderId}`, {
            mengantar_status: 'failed',
            mengantar_error:  String(errMsg).slice(0, 500),
          }).catch(() => {});
          results.push({ orderId: x.orderId, kurir, success: false, error: errMsg });
        }
      }
    }

    // ── Kirim notif resi ke customer via WA ──────────────────
    const BAILEYS_URL    = process.env.BAILEYS_URL;
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
    const tmplResi       = userRow.template_resi_dikirim || null;

    for (const r of results) {
      if (!r.success || !r.orderId) continue;
      // Skip notif kalau resi belum ada (kurir belum assign AWB)
      if (!r.cnote_no) {
        console.log(`[resi-notif] Skip order ${r.orderId}: cnote_no kosong, kurir belum assign AWB`);
        continue;
      }
      const order = orders.find(o => o.id === r.orderId);
      if (!order) continue;

      const cu   = custMap[order.customer_id];
      const prod = prodMap[order.product_id];
      if (!cu?.wa_number) {
        console.log(`[resi-notif] Skip order ${r.orderId}: customer wa_number kosong`);
        continue;
      }

      const jid       = cu.reply_jid || cu.wa_number;
      const namaKak   = cu.nama ? cu.nama.split(' ')[0] : 'Kak';
      const prodNama  = prod?.nama || 'pesanan';
      const waSession = prod?.wa_session_id || user_id;

      // Generate tracking link
      const kurirLc = (r.kurir || '').toLowerCase();
      const linkLacak =
        kurirLc.includes('jne')      ? `https://www.jne.co.id/id/tracking/trace/${r.cnote_no}` :
        kurirLc.includes('jt') || kurirLc.includes('j&t') ? `https://jet.id/tracking?awb=${r.cnote_no}` :
        kurirLc.includes('sicepat')  ? `https://www.sicepat.com/checkAwb?awb=${r.cnote_no}` :
        kurirLc.includes('sap')      ? `https://sap-express.id/track?awb=${r.cnote_no}` :
        kurirLc.includes('lion')     ? `https://lion.parcel.id/tracking?awb=${r.cnote_no}` :
        kurirLc.includes('ninja')    ? `https://www.ninjaxpress.co/id-id/tracking?id=${r.cnote_no}` :
        kurirLc.includes('anteraja') ? `https://anteraja.id/tracking/${r.cnote_no}` :
        kurirLc.includes('pos')      ? `https://www.posindonesia.co.id/id/tracking/${r.cnote_no}` :
        `https://cekresi.com/?noresi=${r.cnote_no}`;

      // Bangun pesan resi
      let pesan;
      if (tmplResi) {
        pesan = tmplResi
          .replace(/\{nama\}/gi, namaKak)
          .replace(/\{produk\}/gi, prodNama)
          .replace(/\{resi\}/gi, r.cnote_no)
          .replace(/\{kurir\}/gi, r.kurir || '')
          .replace(/\{link\}/gi, linkLacak);
      } else {
        pesan = `Halo kak *${namaKak}* 👋\n\nPesanan *${prodNama}* kakak sudah dikirim! 🚚\n\nNo. Resi: *${r.cnote_no}*\nKurir: *${r.kurir || '-'}*\nLacak: ${linkLacak}\n\nKakak bisa cek status pengiriman pakai nomor resi di atas ya. Terima kasih sudah order! 🙏`;
      }

      try {
        const waResp = await fetch(`${BAILEYS_URL}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret: WEBHOOK_SECRET,
            session_id: waSession,
            wa_number: jid,
            message: pesan,
            is_outbound: true,
          }),
        });
        if (!waResp.ok) {
          const errText = await waResp.text().catch(() => '');
          console.error(`[resi-notif] Baileys error ${waResp.status} untuk ${cu.wa_number}: ${errText}`);
          continue;
        }
        console.log(`[resi-notif] Resi ${r.cnote_no} dikirim ke ${cu.wa_number} via session ${waSession}`);

        // Simpan ke conv_messages kalau ada conversation
        if (order.conversation_id) {
          await sbPost('conv_messages', {
            conversation_id: order.conversation_id,
            role: 'ai',
            isi: pesan,
          }).catch(() => {});
        }
      } catch(e) {
        console.error(`[resi-notif] Gagal kirim ke ${cu.wa_number}:`, e.message);
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

  // Route: search area Mengantar (proxy CORS)
  if (req.method === 'POST' && req.body?.action === 'search-area') {
    const keyword = (req.body.keyword || '').trim();
    if (!keyword || keyword.length < 3) return res.status(400).json({ error: 'Keyword minimal 3 karakter' });
    try {
      const r = await fetch(`https://app.mengantar.com/api/address/autofill?keyword=${encodeURIComponent(keyword)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.mengantar.com/', 'Origin': 'https://www.mengantar.com' },
      });
      const json = await r.json();
      const raw = json.data || json || [];
      const areas = (Array.isArray(raw) ? raw : []).slice(0, 10).map(a => ({
        id:        a._id || a.id,
        provinsi:  aProvince(a),
        kabupaten: aCity(a),
        kecamatan: aDistrict(a),
        kelurahan: aSubdistrict(a),
        kodepos:   aZip(a),
        label:     [aProvince(a), aCity(a), aDistrict(a), aSubdistrict(a), aZip(a)].filter(Boolean).join(', '),
      }));
      return res.status(200).json({ ok: true, areas });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Route: preview — lookup area Mengantar untuk verifikasi sebelum kirim
  if (req.method === 'POST' && req.body?.action === 'preview-mengantar') {
    return handlePreviewMengantar(req, res);
  }

  // Route: create mengantar order
  if (req.method === 'POST' && req.body?.action === 'create-mengantar') {
    return handleCreateMengantar(req, res);
  }

  // Route: cek detail 1 resi (untuk modal)
  if (req.method === 'POST' && req.body?.action === 'check-single') {
    const { resi, ekspedisi, order_id } = req.body;
    if (!resi) return res.status(400).json({ error: 'resi wajib' });
    try {
      const courier = normalizeKurir(ekspedisi);
      const d = await fetchMengantar(resi, courier || null);

      let records = [];
      let statusCat = '';

      if (d && d.statusCategory && d.statusCategory !== '-' && Array.isArray(d.history)) {
        statusCat = (d.statusCategory || '').toUpperCase();
        records = d.history.map(h => ({
          desc: h.desc || h.content || h.description || '',
          location: h.counter_name || h.location || h.city || h.city_name || '',
          time: h.date || h.actual_time || h.timestamp || null,
        })).reverse();
      }

      // Update DB — reuse data yang sudah di-fetch (tanpa call API lagi)
      if (order_id && statusCat) {
        const tracking = processTrackingData(d, courier);
        if (tracking) {
          const ordRows = await sbGet('orders_new', `?id=eq.${order_id}&select=id,tracking_events,status_tracking,tracking_lokasi&limit=1`);
          const order = ordRows[0];
          if (order) {
            const doneEvents = order.tracking_events || {};
            const patch = { status_tracking: tracking.statusCat, tracking_lokasi: tracking.lokasi || order.tracking_lokasi };
            if (tracking.eventType !== 'update' && !doneEvents[tracking.eventType]) {
              patch.tracking_events = { ...doneEvents, [tracking.eventType]: new Date().toISOString() };
              if (tracking.eventType === 'delivered') { patch.status = 'selesai'; patch.sampai = true; patch.sampai_at = new Date().toISOString(); }
            }
            await sbPatch('orders_new', `?id=eq.${order_id}`, patch);
          }
        }
      }

      return res.status(200).json({ ok: true, records, status: statusCat });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Route: cek semua resi manual (dari frontend)
  if (req.method === 'POST' && req.body?.action === 'check-all') {
    const userId = req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id wajib' });

    try {
      const orders = await sbGet('orders_new',
        `?user_id=eq.${userId}&status=eq.dikirim&no_resi=not.is.null&no_resi=neq.&select=id,user_id,customer_id,conversation_id,product_id,no_resi,ekspedisi,metode,status_tracking,tracking_lokasi,tracking_events`
      );
      if (!orders.length) return res.status(200).json({ ok: true, total: 0, message: 'Tidak ada order aktif' });

      const custIds = [...new Set(orders.map(o => o.customer_id))];
      const customers = await sbGet('customers', `?id=in.(${custIds.join(',')})&select=id,wa_number,nama,reply_jid`);
      const custMap2 = Object.fromEntries(customers.map(c => [c.id, c]));

      const userRows = await sbGet('users',
        `?id=eq.${userId}&select=id,template_tiba_kota,template_out_for_delivery,template_delivered,template_bermasalah,template_retur&limit=1`
      );
      const userTpl = userRows[0] || {};

      let updated = 0, notifSent = 0, errors = 0;
      const BATCH = 15;
      const startTime = Date.now();
      const MAX_TIME = 50000; // 50s safety margin (Vercel limit 60s)

      async function processOrder(order) {
        try {
          // Langsung fetch tanpa retry (kurir sudah pasti ada dari data order)
          const courier = normalizeKurir(order.ekspedisi);
          const d = await fetchMengantar(order.no_resi, courier || null);
          const tracking = processTrackingData(d, courier);
          if (!tracking) return;

          const { statusCat, eventType, lokasi, deskripsi } = tracking;
          const doneEvents = order.tracking_events || {};

          if (statusCat !== order.status_tracking || lokasi !== order.tracking_lokasi) {
            await sbPatch('orders_new', `?id=eq.${order.id}`, {
              status_tracking: statusCat,
              tracking_lokasi: lokasi || order.tracking_lokasi,
            });
            updated++;
          }

          // Skip kalau event sudah pernah dicatat, atau eventType masih 'update' (tidak dikenal)
          if ((doneEvents[eventType] && eventType !== 'update') || eventType === 'update') return;

          const now = new Date().toISOString();
          const patch = { tracking_events: { ...doneEvents, [eventType]: now } };
          if (eventType === 'delivered') { patch.status = 'selesai'; patch.sampai = true; patch.sampai_at = now; }
          await sbPatch('orders_new', `?id=eq.${order.id}`, patch);

          // Kirim notif WA ke customer untuk event penting
          const cust = custMap2[order.customer_id];
          if (cust && ['tiba_kota','out_for_delivery','delivered','bermasalah','retur'].includes(eventType)) {
            const waTarget = cust.reply_jid || cust.wa_number;
            const namaKak = (cust.nama || '').split(' ')[0];
            const urlLacak = trackingUrl(order.ekspedisi, order.no_resi);
            const isCOD = (order.metode || '').toLowerCase() === 'cod';
            const pesan = await buildPesan({ namaKak, resi: order.no_resi, ekspedisi: order.ekspedisi, eventType, deskripsi, lokasi, isCOD, urlLacak, userTpl });
            if (pesan && waTarget) {
              const waSession = await getWaSession(order.user_id, order.product_id);
              await kirimNotif(waSession, waTarget, pesan);
              notifSent++;

              // Bermasalah/Retur: update conversation state + simpan ke conv_messages
              if ((eventType === 'bermasalah' || eventType === 'retur') && order.conversation_id) {
                try {
                  const convs = await sbGet('conversations', `?id=eq.${order.conversation_id}&select=id,state&limit=1`).catch(() => []);
                  if (convs[0]) {
                    const convState = convs[0].state || {};
                    await sbPost('conv_messages', { conversation_id: convs[0].id, role: 'ai', isi: pesan }).catch(() => {});
                    await sbPatch('conversations', `?id=eq.${convs[0].id}`, {
                      state: { ...convState, delivery_issue: true, delivery_issue_type: eventType, delivery_issue_at: now, delivery_issue_status: statusCat, delivery_issue_resi: order.no_resi },
                      last_msg_at: now,
                    }).catch(() => {});
                  }
                } catch (e) { console.error(`[check-all] conv update error: ${e.message}`); }
              }
            }
          }
        } catch (e) {
          errors++;
          console.error(`[tracking] check-all error ${order.no_resi}:`, e.message);
        }
      }

      // Process in parallel batches, stop early if approaching timeout
      for (let i = 0; i < orders.length; i += BATCH) {
        if (Date.now() - startTime > MAX_TIME) {
          console.log(`[tracking] check-all timeout safety: processed ${i}/${orders.length}, stopping`);
          return res.status(200).json({ ok: true, total: orders.length, processed: i, updated, notifSent, errors, partial: true });
        }
        await Promise.all(orders.slice(i, i + BATCH).map(processOrder));
      }

      return res.status(200).json({ ok: true, total: orders.length, updated, notifSent, errors });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Route: sync manual pakai STATUS_MAP webhook (konsisten dengan mengantar-webhook.js)
  if (req.method === 'POST' && req.body?.action === 'sync-mengantar') {
    const userId = req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id wajib' });

    const STATUS_MAP = {
      'ACTIVE':'menunggu_pickup','WAITING NEXT PROCESS':'menunggu_pickup','PENDING PICKUP':'menunggu_pickup',
      'MANIFESTED':'menunggu_pickup','PICKED UP':'dikirim','INBOUND PROCESS':'dikirim',
      'OUTBOUND PROCESS':'dikirim','IN TRANSIT':'dikirim','ON SHIPPING':'dikirim',
      'ORIGIN GATEWAY':'dikirim','GATEWAY PROCESS':'dikirim',
      'DESTINATION GATEWAY':'tiba_kota','INCOMING':'tiba_kota',
      'WITH DELIVERY COURIER':'out_for_delivery','ON DELIVERY':'out_for_delivery',
      'DEL':'out_for_delivery','OUT FOR DELIVERY':'out_for_delivery',
      'DELIVERED':'delivered',
      'UNDELIVERED':'bermasalah','PICKUP FAILED':'bermasalah','REJECTED':'bermasalah',
      'DELIVERY PROBLEM':'bermasalah','SHIPPING PROBLEM':'bermasalah',
      'RTS':'retur','RETURN TO SHIPPER':'retur','DELIVERY RETURN':'retur',
      'CANCELED':'retur','CANCELLED':'retur',
    };

    try {
      const orders = await sbGet('orders_new',
        `?user_id=eq.${userId}&status=eq.dikirim&no_resi=not.is.null&no_resi=neq.&select=id,user_id,customer_id,conversation_id,product_id,no_resi,ekspedisi,metode,status_tracking,tracking_events`
      );
      if (!orders.length) return res.status(200).json({ ok: true, total: 0, message: 'Tidak ada order aktif' });

      const custIds = [...new Set(orders.map(o => o.customer_id).filter(Boolean))];
      const [customers, userRows] = await Promise.all([
        custIds.length ? sbGet('customers', `?id=in.(${custIds.join(',')})&select=id,wa_number,nama,reply_jid`) : Promise.resolve([]),
        sbGet('users', `?id=eq.${userId}&select=id,template_tiba_kota,template_out_for_delivery,template_delivered,template_bermasalah,template_retur&limit=1`),
      ]);
      const custMap = Object.fromEntries(customers.map(c => [c.id, c]));
      const userTpl = userRows[0] || {};

      let updated = 0, notifSent = 0, errors = 0;
      const startTime = Date.now();

      async function syncOrder(order) {
        try {
          const courier = normalizeKurir(order.ekspedisi);
          const d = await fetchMengantar(order.no_resi, courier || null);
          if (!d) return;

          const statusCat = (d.statusCategory || d.status || d.connote_state || '').toUpperCase();
          if (!statusCat) return;

          const eventType = STATUS_MAP[statusCat];
          if (!eventType) return;

          const doneEvents = order.tracking_events || {};
          const now = new Date().toISOString();

          // Anti-downgrade: jangan turun dari bermasalah ke in-transit
          const wasProb = doneEvents.bermasalah && !doneEvents.delivered;
          if (wasProb && ['menunggu_pickup','dikirim','tiba_kota','out_for_delivery'].includes(eventType)) return;

          // Update status_tracking selalu, tracking_events kalau event baru
          const patch = { status_tracking: statusCat };
          const isNewEvent = !doneEvents[eventType];
          if (isNewEvent || eventType === 'dikirim') {
            patch.tracking_events = { ...doneEvents, [eventType]: now };
          }
          if (eventType === 'delivered') {
            patch.status = 'selesai'; patch.sampai = true; patch.sampai_at = now;
          }
          await sbPatch('orders_new', `?id=eq.${order.id}`, patch);
          updated++;

          // Kirim notif WA hanya untuk event baru yang penting
          if (isNewEvent && ['tiba_kota','out_for_delivery','delivered','bermasalah','retur'].includes(eventType)) {
            const cust = custMap[order.customer_id];
            if (cust?.wa_number) {
              const waTarget = cust.reply_jid || cust.wa_number;
              const namaKak  = (cust.nama || '').split(' ')[0];
              const urlLacak = trackingUrl(order.ekspedisi, order.no_resi);
              const isCOD    = (order.metode || '').toLowerCase() === 'cod';
              const pesan = await buildPesan({ namaKak, resi: order.no_resi, ekspedisi: order.ekspedisi, eventType, deskripsi: '', lokasi: '', isCOD, urlLacak, userTpl });
              if (pesan) {
                const waSession = await getWaSession(order.user_id, order.product_id);
                await kirimNotif(waSession, waTarget, pesan);
                notifSent++;

                // Simpan ke conv_messages + update conversation untuk semua event notif
                const convQuery = order.conversation_id
                  ? `?id=eq.${order.conversation_id}&select=id,state&limit=1`
                  : `?customer_id=eq.${order.customer_id}&user_id=eq.${order.user_id}&select=id,state&order=created_at.desc&limit=1`;
                const convs = await sbGet('conversations', convQuery).catch(() => []);
                if (convs[0]) {
                  const convState = convs[0].state || {};
                  await sbPost('conv_messages', { conversation_id: convs[0].id, role: 'ai', isi: pesan }).catch(() => {});
                  const convPatch = { last_msg_at: now };
                  if (eventType === 'delivered') {
                    convPatch.state = { ...convState, delivered: true, delivered_at: now, delivered_resi: order.no_resi };
                  } else if (eventType === 'bermasalah' || eventType === 'retur') {
                    convPatch.state = { ...convState, delivery_issue: true, delivery_issue_type: eventType, delivery_issue_at: now, delivery_issue_status: statusCat, delivery_issue_resi: order.no_resi };
                  }
                  await sbPatch('conversations', `?id=eq.${convs[0].id}`, convPatch).catch(() => {});
                }
              }
            }
          }
        } catch(e) {
          errors++;
          console.error(`[sync-mng] Error ${order.no_resi}:`, e.message);
        }
      }

      const BATCH = 10;
      for (let i = 0; i < orders.length; i += BATCH) {
        if (Date.now() - startTime > 50000) {
          return res.status(200).json({ ok: true, total: orders.length, processed: i, updated, notifSent, errors, partial: true });
        }
        await Promise.all(orders.slice(i, i + BATCH).map(syncOrder));
      }

      return res.status(200).json({ ok: true, total: orders.length, updated, notifSent, errors });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Cron tracking sudah diganti oleh webhook Mengantar (mengantar-webhook.js)
  return res.status(200).json({ ok: true, message: 'Tracking cron disabled — pakai mengantar-webhook' });

    // Ambil semua order yang status=dikirim dan punya no_resi
    const orders = await sbGet('orders_new',
      `?status=eq.dikirim&no_resi=not.is.null&no_resi=neq.&select=id,user_id,customer_id,conversation_id,product_id,no_resi,ekspedisi,metode,status_tracking,tracking_lokasi,tracking_events`
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
    const cronStart = Date.now();
    const CRON_MAX_TIME = 50000; // 50s safety margin
    const CRON_BATCH = 10;

    async function processCronOrder(order) {
      try {
        const courier = normalizeKurir(order.ekspedisi);
        const d = await fetchMengantar(order.no_resi, courier || null);
        const tracking = processTrackingData(d, courier);
        if (!tracking) return;

        const { statusCat, eventType, lokasi, deskripsi } = tracking;
        const doneEvents = order.tracking_events || {};

        const lokasiUpdate = lokasi || order.tracking_lokasi;
        if (statusCat !== order.status_tracking || lokasi !== order.tracking_lokasi) {
          await sbPatch('orders_new', `?id=eq.${order.id}`, {
            status_tracking: statusCat,
            tracking_lokasi: lokasiUpdate,
          });
          updated++;
        }

        if (doneEvents[eventType] && eventType !== 'update') return;
        if (eventType === 'update') return;

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
        if (!cust) return;
        const waTarget = cust.reply_jid || cust.wa_number;
        if (!waTarget) return;

        const namaKak  = (cust.nama || '').split(' ')[0];
        const urlLacak = trackingUrl(order.ekspedisi, order.no_resi);
        const isCOD    = (order.metode || '').toLowerCase() === 'cod';

        const pesan = await buildPesan({
          namaKak, resi: order.no_resi, ekspedisi: order.ekspedisi,
          eventType, deskripsi, lokasi, isCOD, urlLacak,
          userTpl: userTplMap[order.user_id],
        });

        if (pesan && ['tiba_kota','out_for_delivery','delivered','bermasalah','retur'].includes(eventType)) {
          const waSession = await getWaSession(order.user_id, order.product_id);
          await kirimNotif(waSession, waTarget, pesan);
          notified++;

          // Bermasalah/Retur: update conversation state + simpan ke conv_messages
          if ((eventType === 'bermasalah' || eventType === 'retur') && order.conversation_id) {
            try {
              const convs = await sbGet('conversations', `?id=eq.${order.conversation_id}&select=id,state&limit=1`).catch(() => []);
              if (convs[0]) {
                const convState = convs[0].state || {};
                const now = new Date().toISOString();
                await sbPost('conv_messages', { conversation_id: convs[0].id, role: 'ai', isi: pesan }).catch(() => {});
                await sbPatch('conversations', `?id=eq.${convs[0].id}`, {
                  state: { ...convState, delivery_issue: true, delivery_issue_type: eventType, delivery_issue_at: now, delivery_issue_status: statusCat, delivery_issue_resi: order.no_resi },
                  last_msg_at: now,
                }).catch(() => {});
              }
            } catch (e2) { console.error(`[tracking-cron] conv update error: ${e2.message}`); }
          }
        }
      } catch (e) {
        errors++;
        console.error(`[tracking] Error order ${order.id} (${order.no_resi}):`, e.message);
      }
    }

    // Process in parallel batches, stop early if approaching timeout
    for (let i = 0; i < orders.length; i += CRON_BATCH) {
      if (Date.now() - cronStart > CRON_MAX_TIME) {
        console.log(`[tracking] Cron timeout safety: processed ${i}/${orders.length}, stopping`);
        return res.status(200).json({ ok: true, updated, notified, errors, partial: true, processed: i, total: orders.length });
      }
      await Promise.all(orders.slice(i, i + CRON_BATCH).map(processCronOrder));
    }

    console.log(`[tracking] ✅ Selesai. Updated: ${updated}, Notified: ${notified}, Errors: ${errors}`);
    return res.status(200).json({ ok: true, updated, notified, errors });

  } catch (err) {
    console.error('[tracking] Fatal error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  // Fallback: route tidak dikenal
  return res.status(400).json({ error: 'Unknown action: ' + (req.body?.action || 'none') });
};
