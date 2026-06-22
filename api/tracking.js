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
  if (e.includes('JNT') || e.includes('J&T'))         return 'JNT';
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
async function cekResi(resi, ekspedisi) {
  if (!resi) return null;
  const courier = normalizeKurir(ekspedisi);
  try {
    const res = await fetch(
      `https://app.mengantar.com/api/order/getPublic?tracking_number=${encodeURIComponent(resi)}&courier=${encodeURIComponent(courier)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.mengantar.com/',
          'Origin': 'https://www.mengantar.com',
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) {
      console.warn(`[tracking] Mengantar API ${res.status} untuk ${resi}`);
      return null;
    }
    const json = await res.json();
    const d = json?.data || json;
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
    const lokasi      = (lastHistory?.location || lastHistory?.city || '').trim();
    const lastCode    = (lastHistory?.code || '').toUpperCase();
    const descUp      = deskripsi.toUpperCase();
    // Kalau lokasi kosong, coba ekstrak dari desc (banyak kurir tulis kota di desc)
    const lokasiFromDesc = lokasi || (deskripsi.match(/(?:DI|AT|HUB|KOTA)\s+([A-Z\s]+?)(?:\s*[-,]|$)/i)?.[1] || '').trim();

    // ── Deteksi event berdasarkan statusCategory (reliable semua kurir) ──
    let eventType = 'update';

    if (statusCat === 'DELIVERED' || statusCat === 'POD') {
      eventType = 'delivered';
    } else if (statusCat.includes('RETUR') || statusCat.includes('RETURN')) {
      eventType = 'retur';
    } else if (['DEX','UNDELIVERED','FAILED','UNDELL'].some(s => statusCat.includes(s))) {
      eventType = 'bermasalah';
    } else {
      // Untuk ON PROSES → cari granular event dari desc text (universal semua kurir)

      // Out for delivery: kurir lagi antar hari ini
      const isOTW = /WITH DELIVERY COURIER|OUT FOR DELIVERY|DIBAWA KURIR|ANTAR KE TUJUAN|ON DELIVERY|DRIVER PICKUP|SEDANG DIKIRIM|DALAM PENGIRIMAN/.test(descUp)
                 || lastCode === 'IP3';

      // Tiba kota tujuan: masuk hub/gudang di kota customer
      // Deteksi: desc mengandung kata "RECEIVED AT" / "ARRIVED" DAN lokasi cocok dengan kota tujuan
      const lokasiUp  = (lokasiFromDesc || lokasi).toUpperCase();
      const isDestLoc = destCity && lokasiUp && (
        destCity.split(',').some(c => lokasiUp.includes(c.trim())) ||
        lokasiUp.split(',').some(c => destCity.includes(c.trim()))
      );
      const isTibaKota = (
        /RECEIVED AT|ARRIVED AT|MASUK HUB|TIBA DI|INBOUND|RECEIVED AT WAREHOUSE/.test(descUp) && isDestLoc
      ) || /IP[12]/.test(lastCode);

      if (isOTW)       eventType = 'out_for_delivery';
      else if (isTibaKota) eventType = 'tiba_kota';
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

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
