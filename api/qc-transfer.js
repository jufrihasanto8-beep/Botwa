/**
 * QC Transfer API
 * Halaman QC bukti transfer — Finance ACC/Reject sebelum closing
 *
 * Routes:
 *   GET  ?action=list&status=pending|approved|rejected|all&date_from=&date_to=
 *   POST { action: 'approve', qc_id }
 *   POST { action: 'reject',  qc_id, note }
 *   POST + header x-cron-secret → reminder cron (tiap 15 menit)
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL          = process.env.BAILEYS_URL;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;
const CRON_SECRET          = process.env.CRON_SECRET;

const sbH = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
};

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH });
  if (!res.ok) throw new Error(`sbGet: ${await res.text()}`);
  return res.json();
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH, 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH, 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch ${table}: ${await res.text()}`);
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
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[qc-transfer] sendWA error ${res.status}: ${errText}`);
  }
  return res;
}

function resolveHargaBundling(product, qty) {
  const bundling = Array.isArray(product?.harga_bundling) ? product.harga_bundling : [];
  const match = bundling.find(b => b.qty === qty);
  return match ? match.harga : (product?.harga || 0) * qty;
}

/* ── GET ORDER NUMBER (sama logic dengan webhook-baileys.js) ── */
async function getOrderNumber(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sbGet(
    `conversations?user_id=eq.${userId}&status=eq.selesai&last_msg_at=gte.${today}T00:00:00Z&select=id`
  ).catch(() => []);
  return rows.length + 1;
}

/* ── BUILD CLOSING MESSAGE (duplikat dari webhook-baileys.js) ── */
function buildClosingMessage({ nomorUrut, customer, alamat, ongkir, product, keluhan, metode, qty, csNama }) {
  const h          = ongkir?.harga      || 0;
  const ongkirAsli = ongkir?.ongkirAsli || 0;
  const ongkirPromo= ongkir?.ongkirPromo|| 0;
  const potongan   = ongkirAsli - ongkirPromo;
  const feeCOD     = ongkir?.feeCOD    || 0;
  const diskon     = 0;
  const ekspLabel  = (ongkir?.ekspedisi || 'KURIR').toUpperCase();
  const area       = ongkir?.area || {};
  const isCOD      = (metode || '').toLowerCase() !== 'transfer';
  const total      = isCOD ? (h + ongkirPromo + feeCOD) : (h + ongkirPromo);
  const no         = String(nomorUrut).padStart(2, '0');
  const cs         = (csNama || 'CS').toUpperCase();

  const formula = isCOD
    ? `${h}+${ongkirPromo}+${feeCOD}=${total}`
    : `${h}+${ongkirPromo}=${total}`;

  return `No. ${no}. ${ekspLabel}-MENG

Nama   : ${(customer?.nama || '').toUpperCase()}
No. Hp : ${customer?.wa_number || ''}
Alamat : ${(alamat || '-').toUpperCase()}|Pengirim CS ${cs}|${ongkirAsli}|${potongan}|${feeCOD}|${diskon}|${h}

${(area.kelurahan || '').toUpperCase()}
${(area.kecamatan || '').toUpperCase()}
${(area.kota      || '').toUpperCase()}
${(area.provinsi  || '').toUpperCase()}
${area.kodePos    || ''}

Jumlah pesanan: ${qty} ${(product?.nama || 'PRODUK').toUpperCase()}
Pembayaran: ${isCOD ? `COD ${ekspLabel}-MENG` : 'TRANSFER'}
Total pembayaran: ${formula}

${(product?.nama || 'PRODUK').toUpperCase()} ${qty} CS ${cs}

KELUHAN: ${keluhan || 'tidak disebutkan'}`.trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET: List QC entries ──
    if (req.method === 'GET') {
      const { action, status, date_from, date_to } = req.query || {};
      if (action !== 'list') return res.status(400).json({ error: 'action=list required' });

      let query = 'transfer_qc?order=created_at.desc';
      if (status && status !== 'all') {
        query += `&qc_status=eq.${status}`;
      }
      if (date_from) query += `&created_at=gte.${date_from}T00:00:00Z`;
      if (date_to)   query += `&created_at=lte.${date_to}T23:59:59Z`;
      query += '&limit=200';

      const rows = await sbGet(query);
      return res.status(200).json({ ok: true, data: rows });
    }

    // ── POST: Cron reminder / Approve / Reject ──
    if (req.method === 'POST') {
      // Route: cron reminder (header x-cron-secret, tanpa body action)
      const cronSecret = req.headers['x-cron-secret'];
      if (cronSecret) {
        if (CRON_SECRET && cronSecret !== CRON_SECRET) {
          return res.status(401).json({ error: 'unauthorized' });
        }
        return handleReminder(res);
      }

      const { action, qc_id, note } = req.body || {};

      if (!qc_id) return res.status(400).json({ error: 'qc_id wajib' });

      // Fetch QC entry
      const qcRows = await sbGet(`transfer_qc?id=eq.${qc_id}&limit=1`);
      if (!qcRows.length) return res.status(404).json({ error: 'QC entry tidak ditemukan' });
      const qc = qcRows[0];

      if (qc.qc_status !== 'pending') {
        return res.status(400).json({ error: `QC sudah ${qc.qc_status}` });
      }

      // ── APPROVE ──
      if (action === 'approve') {
        // 1. Update QC status
        await sbPatch('transfer_qc', `?id=eq.${qc_id}`, {
          qc_status: 'approved',
          qc_at: new Date().toISOString(),
          qc_note: note || null,
        });

        // 2. Fetch user, customer, product, conversation
        const [userRows, custRows, prodRows, convRows] = await Promise.all([
          sbGet(`users?id=eq.${qc.user_id}&select=id,rekening,group_jid&limit=1`).catch(() => []),
          sbGet(`customers?id=eq.${qc.customer_id}&select=*&limit=1`).catch(() => []),
          sbGet(`products?id=eq.${qc.product_id}&select=*&limit=1`).catch(() => []),
          sbGet(`conversations?id=eq.${qc.conversation_id}&select=id,state&limit=1`).catch(() => []),
        ]);

        const user    = userRows[0] || {};
        const customer = custRows[0] || {};
        const product  = prodRows[0] || {};
        const conv     = convRows[0] || {};
        const snap     = qc.order_snapshot || {};

        // 3. Get order number
        const nomorUrut = await getOrderNumber(qc.user_id);

        // 4. Close conversation
        await sbPatch('conversations', `?id=eq.${qc.conversation_id}`, { status: 'selesai' });

        // 5. Update conversation state
        const newState = {
          ...(conv.state || {}),
          awaiting_order_confirm: false,
          awaiting_bukti_tf: false,
          awaiting_qc_tf: false,
          order_placed: true,
        };
        await sbPatch('conversations', `?id=eq.${qc.conversation_id}`, { state: newState });

        // 6. Cek anti-double
        const existingOrder = await sbGet(`orders_new?conversation_id=eq.${qc.conversation_id}&limit=1`).catch(() => []);

        let insertedOrderId = null;
        if (!existingOrder.length) {
          // 7. Build alamat
          const area = snap.area || {};
          const alamatSnap = {
            jalan:      snap.alamat || '',
            kelurahan:  area.kelurahan || customer?.alamat?.kelurahan || '',
            kecamatan:  area.kecamatan || customer?.alamat?.kecamatan || '',
            kabupaten:  area.kota      || customer?.alamat?.kabupaten || '',
            provinsi:   area.provinsi  || customer?.alamat?.provinsi  || '',
            kodepos:    area.kodePos   || customer?.alamat?.kodepos   || '',
            ...(snap.mengantar_dest_id ? { mengantar_dest_id: snap.mengantar_dest_id } : {}),
          };

          // 8. Insert orders_new
          const insertedRows = await sbPost('orders_new', {
            user_id:            qc.user_id,
            customer_id:        qc.customer_id,
            conversation_id:    qc.conversation_id,
            product_id:         qc.product_id,
            metode:             'transfer',
            qty:                qc.qty || 1,
            harga:              snap.harga || qc.total || 0,
            ongkir:             snap.ongkirAsli || 0,
            ongkir_after_promo: snap.ongkirPromo || 0,
            fee_cod:            0,
            total:              qc.total || 0,
            ekspedisi:          snap.ekspedisi || '',
            alamat:             alamatSnap,
            keluhan:            snap.keluhan || '',
            status:             'pending',
            customer_nama:      qc.customer_nama || '',
            customer_phone:     qc.customer_phone || '',
            product_nama:       qc.product_nama || '',
            berat_gram:         product?.berat_gram || 0,
          });
          insertedOrderId = insertedRows?.[0]?.id || null;
          console.log(`[qc-approve] Insert orders_new OK — qc_id ${qc_id}, order_id: ${insertedOrderId}`);

          // 9. Set closed_order_id
          if (insertedOrderId) {
            const updState = { ...newState, closed_order_id: insertedOrderId };
            await sbPatch('conversations', `?id=eq.${qc.conversation_id}`, { state: updState }).catch(() => {});
          }

          // 10. Update customer stats
          if (qc.customer_id) {
            await sbPatch('customers', `?id=eq.${qc.customer_id}`, {
              total_order:   (customer.total_order || 0) + 1,
              last_order_at: new Date().toISOString(),
            }).catch(() => {});
          }

          // 11. Recap ke grup WA
          const userGroupJid = user.group_jid || process.env.WA_GROUP_JID;
          if (userGroupJid) {
            const closingMsg = buildClosingMessage({
              nomorUrut, customer,
              alamat:  snap.alamat || '-',
              ongkir:  snap,
              product,
              keluhan: snap.keluhan || '-',
              metode:  'Transfer',
              qty:     qc.qty || 1,
              csNama:  product?.persona_cs_nama || 'CS',
            });
            const waSession = product?.wa_session_id || qc.user_id;
            await sendWA(waSession, userGroupJid, closingMsg).catch(() => {});
            console.log(`[qc-approve] Recap #${nomorUrut} terkirim ke grup`);
          }
        } else {
          console.log(`[qc-approve] Order sudah ada — skip insert`);
        }

        // 12. Kirim notif ke customer: pesanan diproses
        if (customer?.wa_number) {
          const waSession = product?.wa_session_id || qc.user_id;
          const jid       = customer.reply_jid || customer.wa_number;
          const namaKak   = customer.nama ? customer.nama.split(' ')[0] : 'Kak';
          const msgOk     = `Halo kak ${namaKak} 😊\n\nTransfernya sudah kami terima dan dikonfirmasi oleh tim finance ✅\nPesanan kakak akan segera kami proses dan kirimkan ya. Terima kasih! 🙏`;
          await sendWA(waSession, jid, msgOk).catch(() => {});

          // Simpan ke conv_messages
          if (qc.conversation_id) {
            await sbPost('conv_messages', {
              conversation_id: qc.conversation_id,
              role: 'ai',
              isi: msgOk,
            }).catch(() => {});
          }
        }

        return res.status(200).json({ ok: true, action: 'approved', order_id: insertedOrderId });
      }

      // ── REJECT ──
      if (action === 'reject') {
        // 1. Update QC status
        await sbPatch('transfer_qc', `?id=eq.${qc_id}`, {
          qc_status: 'rejected',
          qc_at: new Date().toISOString(),
          qc_note: note || 'Bukti transfer tidak valid',
        });

        // 2. Update conversation state — balik ke awaiting_bukti_tf
        const convRows = await sbGet(`conversations?id=eq.${qc.conversation_id}&select=id,state&limit=1`).catch(() => []);
        const conv = convRows[0] || {};
        const updState = {
          ...(conv.state || {}),
          awaiting_qc_tf: false,
          awaiting_bukti_tf: true, // biar customer bisa kirim ulang
        };
        await sbPatch('conversations', `?id=eq.${qc.conversation_id}`, { state: updState });

        // 3. Kirim WA ke customer
        if (qc.customer_id) {
          const custRows = await sbGet(`customers?id=eq.${qc.customer_id}&select=wa_number,reply_jid,nama&limit=1`).catch(() => []);
          const cu = custRows[0];
          if (cu?.wa_number) {
            const prodRows = await sbGet(`products?id=eq.${qc.product_id}&select=wa_session_id&limit=1`).catch(() => []);
            const waSession = prodRows[0]?.wa_session_id || qc.user_id;
            const jid       = cu.reply_jid || cu.wa_number;
            const namaKak   = cu.nama ? cu.nama.split(' ')[0] : 'Kak';
            const rejectMsg = `Halo kak ${namaKak}, mohon maaf setelah kami cek, bukti transfer uangnya belum masuk nih kak 🙏\n\nBoleh kirim ulang bukti transfernya ya kak, pastikan sudah transfer ke rekening yang benar. Terima kasih!`;
            await sendWA(waSession, jid, rejectMsg).catch(() => {});

            // Simpan ke conv_messages
            if (qc.conversation_id) {
              await sbPost('conv_messages', {
                conversation_id: qc.conversation_id,
                role: 'ai',
                isi: rejectMsg,
              }).catch(() => {});
            }
          }
        }

        return res.status(200).json({ ok: true, action: 'rejected' });
      }

      return res.status(400).json({ error: 'action harus approve atau reject' });
    }

    return res.status(405).end();

  } catch(e) {
    console.error('[qc-transfer] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

/* ── REMINDER HANDLER (cron tiap 15 menit) ────────────────── */
async function handleReminder(res) {
  try {
    const pending = await sbGet('transfer_qc?qc_status=eq.pending&order=created_at.asc');
    if (!pending.length) {
      console.log('[qc-reminder] Tidak ada pending QC');
      return res.status(200).json({ ok: true, pending: 0 });
    }

    // Group by user_id
    const byUser = {};
    for (const qc of pending) {
      if (!byUser[qc.user_id]) byUser[qc.user_id] = [];
      byUser[qc.user_id].push(qc);
    }

    let sent = 0;
    for (const [userId, items] of Object.entries(byUser)) {
      const [userRows, prodRows] = await Promise.all([
        sbGet(`users?id=eq.${userId}&select=group_jid&limit=1`).catch(() => []),
        sbGet(`products?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=wa_session_id&limit=1`).catch(() => []),
      ]);

      const groupJid = process.env.QC_GROUP_JID || userRows[0]?.group_jid || process.env.WA_GROUP_JID;
      const waSession = prodRows[0]?.wa_session_id || userId;

      if (!groupJid) continue;

      const oldest = new Date(items[0].created_at);
      const diffMin = Math.round((Date.now() - oldest.getTime()) / 60000);
      const durasi = diffMin >= 60
        ? `${Math.floor(diffMin / 60)} jam ${diffMin % 60} menit`
        : `${diffMin} menit`;

      const daftar = items.slice(0, 5).map((q, i) =>
        `${i + 1}. ${q.customer_nama || '-'} — ${q.product_nama || '-'} x${q.qty || 1} (${q.nominal || '?'})`
      ).join('\n');
      const more = items.length > 5 ? `\n... dan ${items.length - 5} lainnya` : '';

      const reminderMsg = `⏰ *Reminder QC Transfer*\n\nAda *${items.length}* bukti TF menunggu verifikasi (terlama: ${durasi} lalu)\n\n${daftar}${more}\n\nSegera cek & ACC di:\nhttps://csadsy.vercel.app/qc-transfer`;

      await sendWA(waSession, groupJid, reminderMsg).catch(() => {});
      console.log(`[qc-reminder] Reminder terkirim ke grup user ${userId}: ${items.length} pending`);
      sent++;
    }

    return res.status(200).json({ ok: true, pending: pending.length, users_notified: sent });
  } catch(e) {
    console.error('[qc-reminder] Error:', e.message);
    return res.status(200).json({ ok: true, error: e.message });
  }
}
