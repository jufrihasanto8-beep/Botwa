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
async function kirimNotif(waNumber, pesan) {
  if (!BAILEYS_URL) return;
  try {
    await fetch(`${BAILEYS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, wa_number: waNumber, message: pesan }),
    });
  } catch (e) {
    console.error('Kirim notif error:', e.message);
  }
}

/* ── Pesan notif tracking ────────────────────────────────── */
function buildNotifPesan(tracking, resi, ekspedisi) {
  const status = tracking?.status || tracking?.description || 'dalam perjalanan';
  const lokasi = tracking?.location || '';
  return `📦 Update paket kak!\n\nResi: ${resi} (${ekspedisi})\nStatus: ${status}${lokasi ? `\nLokasi: ${lokasi}` : ''}\n\nAda pertanyaan? Balas pesan ini ya kak 😊`;
}

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.status(200).json({ ok: true, service: 'tracking-cron' });

  try {
    console.log('🚚 Mulai tracking resi harian...');

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
