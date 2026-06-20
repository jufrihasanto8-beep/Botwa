// ══════════════════════════════════════════════════════════
//  Follow-up Otomatis — Vercel Cron Job (tiap 30 menit via cron-job.org)
//
//  Hari H  : AI otomatis — 1 jam setelah AI balas terakhir
//  Hari 2+ : Sesuai jadwal followup_schedule (ai / testimoni / promo / custom)
// ══════════════════════════════════════════════════════════

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY= process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL         = process.env.BAILEYS_URL;
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET;
const CRON_SECRET         = process.env.CRON_SECRET;
const ANTHROPIC_KEY       = process.env.ANTHROPIC_KEY;

// ── Helpers ───────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally { clearTimeout(id); }
}

function sbH() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
}

async function sbGet(table, query = '') {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH() });
  if (!res.ok) throw new Error(`sbGet ${table}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(table, query, body) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { ...sbH(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch ${table}: ${await res.text()}`);
}

async function sbPost(table, body) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
}

async function sendWA(sessionId, jid, message, imageUrl = null, caption = null) {
  if (!BAILEYS_URL) throw new Error('BAILEYS_URL belum diset');
  const res = await fetchWithTimeout(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      session_id: sessionId,
      wa_number: jid,
      message: imageUrl ? undefined : (message || ''),
      is_outbound: true,
      image_url: imageUrl || undefined,
      caption: caption || undefined,
    }),
  }, 15000);
  if (!res.ok) throw new Error(`Baileys send error: ${await res.text()}`);
  return res.json();
}

// ── Generate pesan AI dari konteks percakapan ─────────────
async function generateAIFollowup(messages, namaKak, namaProduk, csNama, isLast = false, isFormLead = false) {
  if (!ANTHROPIC_KEY) return null;

  const recent = messages.slice(-6);
  const transcript = recent.map(m =>
    `${m.role === 'customer' ? 'Customer' : 'CS'}: ${(m.isi || '').replace(/\[.*?\]/g, '').trim()}`
  ).filter(l => l.split(': ')[1]).join('\n');

  const toneNote = isLast
    ? 'Ini follow-up TERAKHIR. Tone penutup — beri ruang, tidak maksa, pintu tetap terbuka.'
    : isFormLead
      ? 'Customer ini sudah isi form & niat beli (warm lead). Tone antusias, bantu segera, tunjukkan kamu prioritaskan mereka.'
      : 'Tone hangat, natural, sambung konteks.';

  const prompt = `Kamu ${csNama || 'Sari'}, CS WhatsApp toko ${namaProduk || 'produk kami'}.

Customer ${namaKak ? 'kak ' + namaKak : 'ini'} belum balas beberapa saat.

Akhir percakapan:
---
${transcript}
---

${toneNote}

Buat SATU pesan follow-up WhatsApp:
- 1-2 kalimat SAJA
- Natural, jangan kaku
- Sambung dari konteks terakhir
- Panggil "Kak" atau nama depannya
- 1 emoji saja
- DILARANG markdown

Tulis pesannya langsung tanpa penjelasan.`;

  try {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 20000);
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) {
    console.error('generateAIFollowup error:', e.message);
    return null;
  }
}

// ── Kirim follow-up ke satu conversation ─────────────────
async function kirimFollowup(conv, customer, namaProduk, csNama, schedule, now) {
  const state       = conv.state || {};
  const isFormLead  = conv.sumber === 'form' || state.is_form_lead === true;
  const jid         = customer.reply_jid || customer.wa_number;
  const namaKak  = customer.nama && customer.nama !== customer.wa_number
    ? customer.nama.split(' ')[0] : '';

  // Ambil pesan terakhir untuk konteks AI
  const recentMsgs = await sbGet('conv_messages',
    `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=6`
  );
  recentMsgs.reverse();

  let message  = null;
  let imageUrl = null;
  let caption  = null;

  const tipe = schedule?.tipe || 'ai';
  const hariIni = schedule?.hari || 1;
  const isLastDay = schedule?.is_last || false;

  if (tipe === 'ai') {
    message = await generateAIFollowup(recentMsgs, namaKak, namaProduk, csNama, isLastDay, isFormLead);
    if (!message) {
      message = namaKak
        ? `Kak ${namaKak}, masih ada yang bisa aku bantu? 😊`
        : `Masih ada yang bisa aku bantu kak? 😊`;
    }

  } else if (tipe === 'testimoni') {
    imageUrl = schedule.image_url || null;
    caption  = schedule.pesan_custom || `Ini testimoni dari customer kami kak ${namaKak} 😊 Banyak yang sudah merasakan manfaatnya!`;
    if (!imageUrl) message = caption; // fallback teks kalau tidak ada gambar

  } else if (tipe === 'promo') {
    imageUrl = schedule.image_url || null;
    caption  = schedule.pesan_custom || `Ada promo spesial hari ini kak ${namaKak}! 🎉 Jangan sampai kelewatan ya`;
    if (!imageUrl) message = caption; // fallback teks kalau tidak ada gambar

  } else if (tipe === 'custom') {
    message  = schedule.pesan_custom
      ? schedule.pesan_custom.replace('{nama}', namaKak || 'Kak')
      : `Halo kak ${namaKak}! Ada yang bisa aku bantu? 😊`;
    imageUrl = schedule.image_url || null;
    caption  = imageUrl ? (schedule.pesan_custom || '') : null;
    if (imageUrl) message = null; // kalau ada gambar, teks masuk ke caption
  }

  // Kirim
  if (imageUrl) {
    await sendWA(conv.user_id, jid, null, imageUrl, caption);
  } else if (message) {
    await sendWA(conv.user_id, jid, message);
  } else {
    return null; // tidak ada yang dikirim
  }

  // Simpan ke conv_messages
  const isiLog = imageUrl
    ? `[Follow-up Hari ${hariIni} - ${tipe}] ${caption || ''}`
    : `[Follow-up Hari ${hariIni} - ${tipe}] ${message}`;
  await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: isiLog });

  // Update state: tandai hari ini sudah terkirim
  const followedDays = state.followed_up_days || [];
  if (!followedDays.includes(hariIni)) followedDays.push(hariIni);

  await sbPatch('conversations', `?id=eq.${conv.id}`, {
    last_msg_at: now.toISOString(),
    state: {
      ...state,
      followed_up: true,
      followed_up_days: followedDays,
      followed_up_at: now.toISOString(),
    },
  });

  return message || caption;
}

// ── MAIN HANDLER ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const isManual   = req.method === 'GET' && req.query?.secret === CRON_SECRET;
  const isCron     = authHeader === `Bearer ${CRON_SECRET}`;

  if (CRON_SECRET && !isManual && !isCron) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const now     = new Date();
  // Jam WIB (UTC+7)
  const jamWIB  = now.getUTCHours() + 7 >= 24
    ? now.getUTCHours() + 7 - 24
    : now.getUTCHours() + 7;
  const menitWIB = now.getUTCMinutes();
  const jamNow  = `${String(jamWIB).padStart(2,'0')}:${String(menitWIB).padStart(2,'0')}`;

  console.log(`Follow-up job: ${now.toISOString()} (WIB ${jamNow})`);

  let totalSent = 0, totalSkipped = 0;
  const results = [];

  try {
    // ── BAGIAN 0: Reminder konfirmasi order — customer belum balas konfirmasi pesanan ──
    // Cek conversation dengan awaiting_order_confirm = true + diam minimal 2 jam
    const cutoff2h = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const awaitingConvs = await sbGet('conversations',
      `?status=in.(baru,diproses,selesai)` +
      `&last_msg_at=lte.${cutoff2h}` +
      `&select=id,user_id,customer_id,product_id,state,last_msg_at`
    ).catch(() => []);

    for (const conv of awaitingConvs) {
      const state = conv.state || {};
      if (!state.awaiting_order_confirm) continue;

      // Cek pesan terakhir harus dari AI (konfirmasi order) — bukan customer
      const lastMsgs = await sbGet('conv_messages',
        `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
      ).catch(() => []);
      if (!lastMsgs.length || lastMsgs[0].role !== 'ai') continue;

      // Cek sudah pernah kirim reminder hari ini (max 1x per hari)
      const todayISO = new Date(now).toISOString().slice(0, 10);
      if (state.confirm_reminder_sent_at?.startsWith(todayISO)) continue;

      try {
        const customers = await sbGet('customers', `?id=eq.${conv.customer_id}&limit=1`).catch(() => []);
        if (!customers.length) continue;
        const customer = customers[0];
        const jid = customer.reply_jid || customer.wa_number;
        if (!jid) continue;

        let productNama = '', csNama = 'Sari';
        if (conv.product_id) {
          const prods = await sbGet('products', `?id=eq.${conv.product_id}&select=nama,persona_cs_nama&limit=1`).catch(() => []);
          productNama = prods[0]?.nama || '';
          csNama      = prods[0]?.persona_cs_nama || 'Sari';
        }

        const snap      = state.order_snapshot || {};
        const area      = snap.area || {};
        const isCOD     = (snap.metode || 'COD').toLowerCase() !== 'transfer';
        const ekspLabel = (snap.ekspedisi || 'KURIR').toUpperCase();
        const total     = isCOD
          ? (snap.harga || 0) + (snap.ongkirPromo || 0) + (snap.feeCOD || 0)
          : (snap.harga || 0) + (snap.ongkirPromo || 0);

        const reminderMsg =
`⏰ *Pengingat Konfirmasi Order ${productNama || 'Produk'}*

Kak, kami ingin memastikan pesanan berikut:

*Nama:* ${customer.nama || '-'}
*No HP:* ${customer.wa_number || '-'}
*Alamat Lengkap:* ${snap.alamat || '-'}

*Kelurahan/Desa:* ${area.kelurahan || '-'}
*Kecamatan:* ${area.kecamatan || '-'}
*Kabupaten:* ${area.kota || '-'}
*Provinsi:* ${area.provinsi || '-'}
*Kode Pos:* ${area.kodePos || '-'}

*Produk:* ${productNama || '-'}
*Jumlah Pesanan:* ${snap.qty || 1} pcs
*Pembayaran:* ${isCOD ? `COD via ${ekspLabel}` : `Transfer via ${ekspLabel}`}
*Total Pembayaran:* Rp ${total.toLocaleString('id-ID')}

Sudah bener kak? Agar bisa segera kami proses pengiriman 🙏`;

        await sendWA(conv.user_id, jid, reminderMsg);
        await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: `[Reminder konfirmasi order] ${reminderMsg}` });
        await sbPatch('conversations', `?id=eq.${conv.id}`, {
          state: { ...state, confirm_reminder_sent_at: now.toISOString() },
        });

        totalSent++;
        results.push({ type: 'order_reminder', conv_id: conv.id, customer: customer.nama, status: 'sent' });
        console.log(`[Order Reminder] → ${customer.nama || customer.wa_number}`);
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {
        console.error(`Error order reminder conv ${conv.id}:`, e.message);
      }
    }

    // ── BAGIAN 1: Hari H — 1 jam setelah AI balas, untuk leads hari ini ──
    // Termasuk customer LAMA yang chat lagi hari ini (reopened_at >= hari ini)
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    // Kurangi offset WIB: hari ini = 00:00 WIB = 17:00 UTC kemarin
    todayStart.setTime(todayStart.getTime() - 7 * 60 * 60 * 1000);
    const todayStartISO = todayStart.toISOString();

    // Minimal 1 jam diam sebelum difollow-up (form lead: 30 menit)
    const cutoff1h  = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const cutoff30m = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    // Query 1a: form leads baru hari ini (cutoff 30 menit)
    const formConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)` +
      `&sumber=eq.form` +
      `&created_at=gte.${todayStartISO}` +
      `&last_msg_at=lte.${cutoff30m}` +
      `&select=id,user_id,customer_id,product_id,sumber,state,last_msg_at,created_at`
    ).catch(() => []);

    // Query 1b: lead biasa baru hari ini (cutoff 1 jam)
    const newConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)` +
      `&sumber=neq.form` +
      `&created_at=gte.${todayStartISO}` +
      `&last_msg_at=lte.${cutoff1h}` +
      `&select=id,user_id,customer_id,product_id,sumber,state,last_msg_at,created_at`
    );

    // Query 2: customer lama yang chat lagi hari ini (last_msg_at >= hari ini)
    const reopenedConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)` +
      `&created_at=lt.${todayStartISO}` +
      `&last_msg_at=gte.${todayStartISO}` +
      `&last_msg_at=lte.${cutoff1h}` +
      `&select=id,user_id,customer_id,product_id,sumber,state,last_msg_at,created_at`
    ).catch(() => []);

    const reopenedToday = Array.isArray(reopenedConvs) ? reopenedConvs : [];

    // Gabung keduanya, hindari duplikat
    const seenIds = new Set();
    const hariHConvs = [...(Array.isArray(formConvs) ? formConvs : []), ...newConvs, ...reopenedToday].filter(c => {
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    });

    console.log(`[DEBUG] newConvs=${newConvs.length}, reopenedToday=${reopenedToday.length}, total hariH=${hariHConvs.length}`);

    for (const conv of hariHConvs) {
      try {
        const state = conv.state || {};
        const followedDays = state.followed_up_days || [];

        // Skip jika hari 1 sudah terkirim, eskalasi, atau sedang menunggu konfirmasi order
        if (followedDays.includes(1)) { totalSkipped++; console.log(`[SKIP] conv ${conv.id}: hari 1 sudah terkirim`); continue; }
        if (conv.status === 'eskalasi') { totalSkipped++; console.log(`[SKIP] conv ${conv.id}: status eskalasi`); continue; }
        if (state.awaiting_order_confirm || state.awaiting_order_correction) { totalSkipped++; console.log(`[SKIP] conv ${conv.id}: menunggu konfirmasi order`); continue; }

        // Cek pesan terakhir harus dari AI
        const lastMsgs = await sbGet('conv_messages',
          `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
        );
        if (!lastMsgs.length || lastMsgs[0].role !== 'ai') {
          totalSkipped++;
          console.log(`[SKIP] conv ${conv.id}: pesan terakhir bukan dari AI (role=${lastMsgs[0]?.role || 'none'})`);
          continue;
        }

        const customers = await sbGet('customers', `?id=eq.${conv.customer_id}&limit=1`);
        if (!customers.length) { totalSkipped++; continue; }
        const customer = customers[0];
        if (!customer.reply_jid && !customer.wa_number) { totalSkipped++; continue; }

        let namaProduk = '', csNama = 'Sari';
        if (conv.product_id) {
          const prods = await sbGet('products', `?id=eq.${conv.product_id}&select=nama,persona_cs_nama&limit=1`);
          namaProduk = prods[0]?.nama || '';
          csNama     = prods[0]?.persona_cs_nama || 'Sari';
        }

        // Cek apakah ada schedule khusus untuk hari 1
        const schedHari1 = await sbGet('followup_schedule',
          `?user_id=eq.${conv.user_id}&hari=eq.1&aktif=eq.true&limit=1`
        ).catch(() => []);

        const schedule = schedHari1[0] || { hari: 1, tipe: 'ai' };
        const pesan = await kirimFollowup(conv, customer, namaProduk, csNama, schedule, now);

        if (pesan !== null) {
          totalSent++;
          results.push({ hari: 1, conv_id: conv.id, customer: customer.nama, status: 'sent' });
          console.log(`[Hari H] → ${customer.nama || customer.wa_number}`);
        }

        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {
        console.error(`Error hari H conv ${conv.id}:`, e.message);
      }
    }

    // ── BAGIAN 2: Hari 2+ — berdasarkan followup_schedule ──
    // Ambil semua schedule aktif per user (hari 2+)
    const allSchedules = await sbGet('followup_schedule',
      `?hari=gte.2&aktif=eq.true&order=hari.asc`
    ).catch(() => []);

    // Kelompokkan per user
    const schedByUser = {};
    for (const s of allSchedules) {
      if (!schedByUser[s.user_id]) schedByUser[s.user_id] = [];
      schedByUser[s.user_id].push(s);
    }

    for (const [userId, schedules] of Object.entries(schedByUser)) {
      // Cari schedule yang jam_kirimnya cocok dengan sekarang (±30 menit)
      const scheduleSekarang = schedules.filter(s => {
        if (!s.jam_kirim) return false;
        const [jamS, menitS] = s.jam_kirim.slice(0, 5).split(':').map(Number);
        const totalMenitSchedule = jamS * 60 + menitS;
        const totalMenitNow      = jamWIB * 60 + menitWIB;
        // Window ±30 menit (cron jalan tiap 30 menit)
        return Math.abs(totalMenitNow - totalMenitSchedule) <= 30;
      });

      if (!scheduleSekarang.length) continue;

      // Cari conversations yang perlu difollow-up untuk hari ini
      for (const sched of scheduleSekarang) {
        const hariKe = sched.hari;

        // Hitung tanggal mulai dan akhir untuk "hari ke-N"
        // Hari ke-2 = lead masuk kemarin, hari ke-3 = 2 hari lalu, dst
        const hariMulai = new Date(now);
        hariMulai.setUTCDate(hariMulai.getUTCDate() - (hariKe - 1));
        hariMulai.setUTCHours(0 - 7, 0, 0, 0); // 00:00 WIB

        const hariAkhir = new Date(hariMulai);
        hariAkhir.setUTCDate(hariAkhir.getUTCDate() + 1);

        // Hanya follow-up kalau customer diam minimal 1 jam (last_msg_at <= 1 jam lalu)
        const convs = await sbGet('conversations',
          `?user_id=eq.${userId}` +
          `&status=in.(baru,diproses)` +
          `&created_at=gte.${hariMulai.toISOString()}` +
          `&created_at=lt.${hariAkhir.toISOString()}` +
          `&last_msg_at=lte.${cutoff1h}` +
          `&select=id,user_id,customer_id,product_id,state,last_msg_at,created_at`
        ).catch(() => []);

        // Tandai schedule terakhir
        const maxHari = Math.max(...schedules.map(s => s.hari));
        sched.is_last = sched.hari === maxHari;

        for (const conv of convs) {
          try {
            const state       = conv.state || {};
            const followedDays = state.followed_up_days || [];

            // Skip jika hari ini sudah terkirim, eskalasi, atau sedang menunggu konfirmasi order
            if (followedDays.includes(hariKe)) { totalSkipped++; continue; }
            if (conv.status === 'eskalasi')    { totalSkipped++; continue; }
            if (state.awaiting_order_confirm || state.awaiting_order_correction) { totalSkipped++; continue; }

            const customers = await sbGet('customers', `?id=eq.${conv.customer_id}&limit=1`);
            if (!customers.length) { totalSkipped++; continue; }
            const customer = customers[0];
            if (!customer.reply_jid && !customer.wa_number) { totalSkipped++; continue; }

            let namaProduk = '', csNama = 'Sari';
            if (conv.product_id) {
              const prods = await sbGet('products', `?id=eq.${conv.product_id}&select=nama,persona_cs_nama&limit=1`);
              namaProduk = prods[0]?.nama || '';
              csNama     = prods[0]?.persona_cs_nama || 'Sari';
            }

            const pesan = await kirimFollowup(conv, customer, namaProduk, csNama, sched, now);

            if (pesan !== null) {
              totalSent++;
              results.push({ hari: hariKe, conv_id: conv.id, customer: customer.nama, tipe: sched.tipe, status: 'sent' });
              console.log(`[Hari ${hariKe} - ${sched.tipe}] → ${customer.nama || customer.wa_number}`);
            }

            await new Promise(r => setTimeout(r, 1500));
          } catch(e) {
            console.error(`Error hari ${hariKe} conv ${conv.id}:`, e.message);
          }
        }
      }
    }

    console.log(`Done: ${totalSent} terkirim, ${totalSkipped} dilewati`);
    return res.status(200).json({ ok: true, sent: totalSent, skipped: totalSkipped, results });

  } catch(err) {
    console.error('Follow-up job error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
