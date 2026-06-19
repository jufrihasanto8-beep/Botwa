/**
 * Cron: Tracking resi harian via Mengantar API
 * Schedule: 0 8 * * * (tiap pagi 08:00 WIB = 01:00 UTC)
 * Update status resi → notif proaktif ke customer jika ada update
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
  if (!res.ok) throw new Error(`sbGet: ${await res.text()}`);
  return res.json();
}
async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch: ${await res.text()}`);
  return res.json();
}

/* ── Cek resi via Mengantar ──────────────────────────────── */
async function cekResi(resi, ekspedisi) {
  if (!MENGANTAR_KEY) return null;
  try {
    const res = await fetch(
      `https://api.mengantar.com/v1/tracking?resi=${resi}&courier=${encodeURIComponent(ekspedisi)}`,
      { headers: { 'Authorization': `Bearer ${MENGANTAR_KEY}` } }
    );
    const data = await res.json();
    return data?.data || null;
  } catch (e) {
    console.error('Cek resi error:', e.message);
    return null;
  }
}

/* ── Kirim notif WA via Baileys ──────────────────────────── */
async function kirimNotif(waNumber, pesan, sessionId = null) {
  if (!BAILEYS_URL) return;
  try {
    await fetch(`${BAILEYS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: WEBHOOK_SECRET,
        session_id: sessionId || undefined,
        wa_number: waNumber,
        message: pesan,
        is_outbound: true,
      }),
    });
  } catch (e) {
    console.error('Kirim notif error:', e.message);
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

/* ── Generate pesan tracking via AI ────────────────────── */
async function buildAITrackingMsg({ namaKak, resi, ekspedisi, status, lokasi, sudahSampai, urlLacak }) {
  if (ANTHROPIC_KEY) {
    try {
      const konteks = sudahSampai
        ? `Paket sudah SAMPAI dan diterima di tujuan.`
        : `Status terbaru: "${status}"${lokasi ? `. Sekarang di lokasi: ${lokasi}` : ''}.`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content:
            `Kamu CS toko online Indonesia yang ramah. Kirim update status paket ke customer via WhatsApp.

Customer: ${namaKak ? 'kak ' + namaKak : 'kak'}
Kurir: ${ekspedisi || 'ekspedisi'}
No. Resi: ${resi}
${konteks}
${!sudahSampai ? `Link tracking: ${urlLacak}` : ''}

Ketentuan:
- 2-3 kalimat, natural dan hangat
- ${sudahSampai ? 'Ucapkan selamat paket sudah sampai, tanyakan kondisi barang' : 'Sertakan info status/lokasi dan link tracking'}
- 1-2 emoji saja
- JANGAN markdown (*, _, dll)

Tulis pesannya langsung.` }],
        }),
      });
      const d = await r.json();
      const txt = d.content?.[0]?.text?.trim();
      if (txt) return txt;
    } catch (e) {
      console.error('AI tracking msg error:', e.message);
    }
  }
  // Fallback
  if (sudahSampai) {
    return `Halo ${namaKak ? 'kak ' + namaKak : 'kak'}! Paket kakak sudah sampai nih 🎉 Semoga suka dengan produknya ya kak! Kalau ada pertanyaan, kami siap bantu 😊`;
  }
  return `Halo ${namaKak ? 'kak ' + namaKak : 'kak'}! Update paket kakak nih 📦 Status: ${status}${lokasi ? ` (${lokasi})` : ''}. Cek tracking di: ${urlLacak}`;
}

/* ── Pesan notif tracking (legacy untuk orders_new) ─────── */
function buildNotifPesan(tracking, resi, ekspedisi) {
  const status = tracking?.status || tracking?.description || 'dalam perjalanan';
  const lokasi = tracking?.location || '';
  return `📦 Update paket kak!\n\nResi: ${resi} (${ekspedisi})\nStatus: ${status}${lokasi ? `\nLokasi: ${lokasi}` : ''}\n\nAda pertanyaan? Balas pesan ini ya kak 😊`;
}

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.status(200).json({ ok: true, service: 'tracking-cron' });

  try {
    console.log('🚚 Mulai tracking resi...');

    // ══════════════════════════════════════════════
    // BAGIAN 1: Tracking conversations BotWA
    // Cari semua conv yang punya no_resi dan belum sampai
    // ══════════════════════════════════════════════
    const convs = await sbGet('conversations',
      `?select=id,user_id,customer_id,state&order=last_msg_at.desc&limit=500`
    );
    const activeConvs = convs.filter(c =>
      c.state?.no_resi && !c.state?.tracking_sampai
    );

    console.log(`[BotWA] Tracking ${activeConvs.length} conversations...`);
    let waUpdated = 0, waNotified = 0;

    for (const conv of activeConvs) {
      try {
        const st     = conv.state || {};
        const noResi = st.no_resi;
        const kurir  = st.kurir_resi || '';

        const tracking = await cekResi(noResi, kurir);
        if (!tracking) continue;

        const statusBaru  = tracking.status || tracking.description || '';
        const lokasiBaru  = tracking.location || '';
        const sudahSampai = /diterima|delivered|terkirim|sampai/i.test(statusBaru);
        const adaUpdate   = statusBaru && statusBaru !== st.tracking_status;

        if (!adaUpdate) {
          // Update last_checked saja
          await sbPatch('conversations', `?id=eq.${conv.id}`, {
            state: { ...st, tracking_last_checked: new Date().toISOString() },
          });
          continue;
        }

        // Update state
        await sbPatch('conversations', `?id=eq.${conv.id}`, {
          state: {
            ...st,
            tracking_status: statusBaru,
            tracking_lokasi: lokasiBaru,
            tracking_sampai: sudahSampai,
            tracking_last_checked: new Date().toISOString(),
            tracking_updated_at: new Date().toISOString(),
          },
        });
        waUpdated++;

        // Kirim notif ke customer
        const custs = await sbGet('customers', `?id=eq.${conv.customer_id}&limit=1`);
        if (!custs.length) continue;
        const cust    = custs[0];
        const jid     = cust.reply_jid || cust.wa_number;
        if (!jid) continue;

        const namaKak = (cust.nama || '').split(' ')[0];
        const urlLacak = trackingUrl(kurir, noResi);

        const pesan = await buildAITrackingMsg({
          namaKak, resi: noResi, ekspedisi: kurir,
          status: statusBaru, lokasi: lokasiBaru,
          sudahSampai, urlLacak,
        });

        await kirimNotif(jid, pesan, conv.user_id);
        waNotified++;
        console.log(`[BotWA] ${sudahSampai ? '✅ SAMPAI' : '📦 Update'}: ${noResi} → ${cust.wa_number}`);

        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        console.error(`[BotWA] Error conv ${conv.id}:`, e.message);
      }
    }

    console.log(`[BotWA] Done: ${waUpdated} updated, ${waNotified} notified`);

    // ══════════════════════════════════════════════
    // BAGIAN 2: Tracking orders_new / shipments (sistem lama)
    // ══════════════════════════════════════════════

    // Ambil semua shipment yang belum sampai
    const shipments = await sbGet('shipments',
      `?sampai=eq.false&select=*,orders_new(id,customer_id,user_id,flag_risiko)`
    );

    if (!shipments.length) {
      console.log('Tidak ada shipment aktif.');
      return;
    }

    console.log(`Tracking ${shipments.length} shipment...`);
    let updated = 0, notified = 0;

    for (const shipment of shipments) {
      try {
        const tracking = await cekResi(shipment.resi, shipment.ekspedisi);
        if (!tracking) continue;

        const statusBaru = tracking.status || tracking.description || '';
        const sudahSampai = statusBaru.toLowerCase().includes('diterima') ||
                            statusBaru.toLowerCase().includes('delivered') ||
                            statusBaru.toLowerCase().includes('terkirim');

        // Cek ada update baru
        const adaUpdate = statusBaru !== shipment.status_tracking;

        if (adaUpdate) {
          await sbPatch('shipments', `?id=eq.${shipment.id}`, {
            status_tracking: statusBaru,
            last_checked_at: new Date().toISOString(),
            last_status_update: new Date().toISOString(),
            sampai: sudahSampai,
          });

          // Update order status jika sudah sampai
          if (sudahSampai && shipment.orders_new?.id) {
            await sbPatch('orders_new', `?id=eq.${shipment.orders_new.id}`, {
              status: 'selesai',
            });
          }

          updated++;

          // Kirim notif ke customer
          const orderId = shipment.orders_new?.id;
          if (orderId) {
            const orders = await sbGet('orders_new',
              `?id=eq.${orderId}&select=*,customers(wa_number,nama)`
            );
            if (orders.length && orders[0].customers?.wa_number) {
              const cust = orders[0].customers;
              const pesan = buildNotifPesan(tracking, shipment.resi, shipment.ekspedisi);
              await kirimNotif(cust.wa_number, pesan);
              notified++;
            }
          }
        } else {
          // Hanya update last_checked_at
          await sbPatch('shipments', `?id=eq.${shipment.id}`, {
            last_checked_at: new Date().toISOString(),
          });
        }

        // Flag risiko: resi tidak gerak > 3 hari
        if (shipment.orders_new?.flag_risiko && shipment.last_status_update) {
          const lastUpdate = new Date(shipment.last_status_update);
          const daysSinceUpdate = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceUpdate > 3) {
            console.warn(`⚠️ RESI TIDAK GERAK: ${shipment.resi} (${daysSinceUpdate.toFixed(1)} hari)`);
          }
        }

      } catch (e) {
        console.error(`Error tracking ${shipment.resi}:`, e.message);
      }

      // Jeda 500ms antar request ke Mengantar (rate limit)
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`✅ Tracking selesai. Updated: ${updated}, Notified: ${notified}`);

  } catch (err) {
    console.error('Tracking cron error:', err.message);
  }
};
