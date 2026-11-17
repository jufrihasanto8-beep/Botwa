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

// Batch fetch customers & products by IDs → Map
async function batchFetchCustomers(ids) {
  if (!ids.length) return new Map();
  const uniq = [...new Set(ids)];
  const rows = await sbGet('customers', `?id=in.(${uniq.join(',')})`).catch(() => []);
  return new Map(rows.map(r => [r.id, r]));
}
async function batchFetchProducts(ids) {
  if (!ids.length) return new Map();
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return new Map();
  const rows = await sbGet('products', `?id=in.(${uniq.join(',')})&select=id,nama,persona_cs_nama,harga,harga_bundling,berat_gram,promo_ongkir,wa_session_id`).catch(() => []);
  return new Map(rows.map(r => [r.id, r]));
}

// Ambil wa_session_id dari produk (fallback ke userId untuk backward compat)
async function getWaSession(userId, productId) {
  if (productId) {
    const rows = await sbGet('products', `?id=eq.${productId}&select=wa_session_id&limit=1`).catch(() => []);
    if (rows[0]?.wa_session_id) return rows[0].wa_session_id;
  }
  // fallback: produk pertama aktif user
  const rows = await sbGet('products', `?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=wa_session_id&limit=1`).catch(() => []);
  return rows[0]?.wa_session_id || userId;
}

// Kumpulkan semua pesan di queue, kirim 1x ke VPS di akhir handler
const _fuQueueItems = [];

function queueWA(sessionId, jid, message, imageUrl = null, caption = null, convId = null) {
  _fuQueueItems.push({
    session_id: sessionId,
    wa_number: jid,
    message: imageUrl ? undefined : (message || ''),
    image_url: imageUrl || undefined,
    caption: caption || undefined,
    conv_id: convId || undefined,
  });
}

// Kirim semua queue ke VPS dalam 1 request (fire-and-forget)
async function flushQueueToVPS() {
  if (!_fuQueueItems.length || !BAILEYS_URL) return { queued: 0 };
  try {
    const res = await fetchWithTimeout(`${BAILEYS_URL}/followup-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, items: _fuQueueItems }),
    }, 10000);
    const data = await res.json();
    console.log(`[fu-queue] Flushed ${_fuQueueItems.length} items to VPS: ${JSON.stringify(data)}`);
    return data;
  } catch(e) {
    console.error(`[fu-queue] Flush failed: ${e.message}`);
    return { error: e.message };
  }
}

// Legacy sendWA — masih dipakai untuk backward compat (tapi bisa di-phase out)
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
async function generateAIFollowup(messages, namaKak, namaProduk, csNama, isLast = false, isFormLead = false, convState = {}, product = null) {
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

  // Inject data ongkir kalau sudah ada di state
  const ongkir = convState.ongkir || null;
  let ongkirInfo = '';
  if (ongkir) {
    const fmt = n => `Rp ${Number(n||0).toLocaleString('id-ID')}`;
    const qty = convState.qty || 1;
    let bundling = product?.harga_bundling || [];
    if (typeof bundling === 'string') try { bundling = JSON.parse(bundling); } catch { bundling = []; }
    let harga = (product?.harga || ongkir.harga || 0) * qty;
    const exact = Array.isArray(bundling) && bundling.find(b => b.qty == qty);
    if (exact) harga = exact.harga;
    const totalTF  = harga + (ongkir.ongkirPromo ?? ongkir.ongkirAsli ?? 0);
    const totalCOD = totalTF + (ongkir.feeCOD || 0);
    ongkirInfo = `\n\nDATA ONGKIR AKTUAL (gunakan angka ini, JANGAN mengarang):
- Produk: ${namaProduk}, qty: ${qty}
- Harga: ${fmt(harga)}
- Ongkir via ${ongkir.ekspedisi || 'kurir'}: ${fmt(ongkir.ongkirPromo ?? ongkir.ongkirAsli)}
- Total Transfer: ${fmt(totalTF)}
- Total COD: ${fmt(totalCOD)}`;
  }

  const prompt = `Kamu ${csNama || 'Sari'}, CS WhatsApp toko ${namaProduk || 'produk kami'}.

Customer ${namaKak ? 'kak ' + namaKak : 'ini'} belum balas beberapa saat.

Akhir percakapan:
---
${transcript}
---

${toneNote}${ongkirInfo}

Buat SATU pesan follow-up WhatsApp:
- 1-2 kalimat SAJA
- Natural, jangan kaku
- Sambung dari konteks terakhir
- Panggil "Kak" atau nama depannya
- 1 emoji saja
- DILARANG markdown
- ⛔ DILARANG sebut harga, total, rekening, atau angka apapun kecuali ada di DATA ONGKIR AKTUAL di atas
- ⛔ DILARANG mengarang angka dari percakapan

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
async function kirimFollowup(conv, customer, namaProduk, csNama, schedule, now, product = null) {
  const state       = conv.state || {};

  // Skip kalau bot sedang nunggu jawaban lokasi dari customer
  if (state.waiting_for_location) {
    console.log(`[SKIP] conv ${conv.id}: waiting_for_location aktif`);
    return null;
  }

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

  // ── Stage-based template: PRIORITAS UTAMA untuk semua tipe & hari ──
  // Kalau customer stuck di stage tertentu, kirim pesan sesuai stage-nya
  // bukan testimoni/promo yang ga nyambung
  const panggilan = namaKak ? `Kak ${namaKak}` : 'Kak';
  const ongkir = state.ongkir;
  let isStageHandled = false;

  if (ongkir && !state.metode_bayar && !state.awaiting_order_confirm) {
    // Sudah ada ongkir tapi belum pilih metode → langsung tanya
    const fmt = n => `Rp ${Number(n||0).toLocaleString('id-ID')}`;
    message = hariIni <= 1
      ? `${panggilan}, pesanannya jadi kami proses? 😊\n\nTotal:\n💳 Transfer: ${fmt(ongkir.totalTransfer)}\n📦 COD: ${fmt(ongkir.totalCOD)}\n\nEnaknya COD atau Transfer kak?`
      : `${panggilan}, kemarin totalnya sudah kami hitung ya 😊\n\n💳 Transfer: ${fmt(ongkir.totalTransfer)}\n📦 COD: ${fmt(ongkir.totalCOD)}\n\nMasih jadi order kak? Enaknya COD atau Transfer? 🙏`;
    isStageHandled = true;
    console.log(`[stage-fu] conv ${conv.id} hari ${hariIni}: ongkir ada, tanya metode`);

  } else if (state.awaiting_bukti_tf) {
    // Nunggu bukti TF
    message = hariIni <= 1
      ? `${panggilan}, sudah sempat transfer kak? Kalau sudah, kirim bukti TF-nya ya biar bisa segera kami proses 🙏`
      : `${panggilan}, kami masih nunggu bukti transfer-nya ya kak 😊 Kalau sudah transfer, langsung kirim foto buktinya biar bisa segera diproses 🙏`;
    isStageHandled = true;
    console.log(`[stage-fu] conv ${conv.id} hari ${hariIni}: awaiting bukti TF`);

  } else if (state.wilayah && !ongkir) {
    // Wilayah ada tapi ongkir gagal
    message = hariIni <= 1
      ? `${panggilan}, maaf tadi sempat ada kendala. Boleh konfirmasi lagi kak alamat pengirimannya ke mana? Biar kami cek ongkirnya 😊`
      : `${panggilan}, boleh info alamat lengkapnya kak? Biar kami cek ongkir dan totalnya ya 😊`;
    isStageHandled = true;
    console.log(`[stage-fu] conv ${conv.id} hari ${hariIni}: wilayah ada, ongkir gagal`);
  }

  // Kalau stage sudah di-handle → skip schedule tipe (testimoni/promo/dll)
  if (!isStageHandled) {
    if (tipe === 'ai') {
      // Default: panggil Claude AI
      message = await generateAIFollowup(recentMsgs, namaKak, namaProduk, csNama, isLastDay, isFormLead, state, product);

      if (!message) {
        message = namaKak
          ? `Kak ${namaKak}, masih ada yang bisa aku bantu? 😊`
          : `Masih ada yang bisa aku bantu kak? 😊`;
      }

    } else if (tipe === 'testimoni') {
      imageUrl = schedule.image_url || null;
      const defaultTesti = `Ini testimoni dari customer kami kak ${namaKak} 😊 Banyak yang sudah merasakan manfaatnya!`;
      caption  = (schedule.pesan_custom || defaultTesti).replace('{nama}', namaKak || 'Kak');
      if (!imageUrl) message = caption;

    } else if (tipe === 'promo') {
      imageUrl = schedule.image_url || null;
      const defaultPromo = `Ada promo spesial hari ini kak ${namaKak}! 🎉 Jangan sampai kelewatan ya`;
      caption  = (schedule.pesan_custom || defaultPromo).replace('{nama}', namaKak || 'Kak');
      if (!imageUrl) message = caption;

    } else if (tipe === 'custom') {
      const rawPesan = schedule.pesan_custom || `Halo kak ${namaKak}! Ada yang bisa aku bantu? 😊`;
      const pesanFinal = rawPesan.replace('{nama}', namaKak || 'Kak');
      imageUrl = schedule.image_url || null;
      if (imageUrl) {
        caption = pesanFinal;
        message = null;
      } else {
        message = pesanFinal;
      }
    }
  }

  // Queue ke VPS (ga langsung kirim — dikumpulin, flush di akhir)
  const waSession = await getWaSession(conv.user_id, conv.product_id);
  if (imageUrl) {
    queueWA(waSession, jid, null, imageUrl, caption, conv.id);
  } else if (message) {
    queueWA(waSession, jid, message, null, null, conv.id);
  } else {
    return null; // tidak ada yang dikirim
  }

  // Simpan ke conv_messages
  const isiLog = imageUrl
    ? `[Follow-up Hari ${hariIni} - ${tipe}] ${caption || ''}`
    : `[Follow-up Hari ${hariIni} - ${tipe}] ${message}`;
  await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: isiLog });

  // Update state: tandai hari ini sudah terkirim (per schedule ID untuk support multi-jadwal 1 hari)
  const followedDays    = state.followed_up_days || [];
  const followedSchedIds = state.followed_up_sched_ids || [];
  if (!followedDays.includes(hariIni)) followedDays.push(hariIni);
  if (schedule?.id && !followedSchedIds.includes(schedule.id)) followedSchedIds.push(schedule.id);

  await sbPatch('conversations', `?id=eq.${conv.id}`, {
    last_msg_at: now.toISOString(),
    state: {
      ...state,
      followed_up: true,
      followed_up_days: followedDays,
      followed_up_sched_ids: followedSchedIds,
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

  // ── Respond langsung ke cron-job.org (max 30s timeout) ──
  // Proses lanjut di background via waitUntil
  res.status(200).json({ ok: true, status: 'processing' });

  const doWork = async () => {

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
  const startTime = Date.now();
  const MAX_RUNTIME = 50000; // 50 detik safety margin (Vercel limit 60s)
  const isTimeUp = () => Date.now() - startTime > MAX_RUNTIME;

  try {
    // ── Filter: hanya produk dengan WA session aktif ──
    const activeProducts = await sbGet('products',
      `?wa_status=eq.connected&wa_session_id=not.is.null&aktif=eq.true&select=id,wa_session_id`
    ).catch(() => []);
    const activeProductIds = activeProducts.map(p => p.id);
    const activeSessionIds = new Set(activeProducts.map(p => p.wa_session_id));

    if (!activeProductIds.length) {
      console.log('[followup] Tidak ada produk dengan WA session aktif, skip semua');
      return res.status(200).json({ ok: true, sent: 0, skipped: 0, reason: 'no_active_sessions' });
    }
    console.log(`[followup] ${activeProductIds.length} produk aktif: ${activeProductIds.join(', ')}`);

    const activeProductFilter = `&product_id=in.(${activeProductIds.join(',')})`;

    // ── BAGIAN -1: Pending Greeting — kirim greeting form lead yang dijeda 3 menit ──
    const GREETING_DELAY_MS = 3 * 60 * 1000;
    // Hanya cek conversation 15 menit terakhir (bukan semua 800+)
    const greetingCutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const pendingConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)&created_at=gte.${greetingCutoff}${activeProductFilter}&select=id,user_id,state&limit=50`
    ).catch(() => []);
    const pendingGreetings = pendingConvs.filter(c => c.state?.pending_greeting?.created_at);

    for (const conv of pendingGreetings) {
      if (isTimeUp()) { console.log('[timeout] greeting loop'); break; }
      const pg = conv.state.pending_greeting;
      const elapsed = now.getTime() - new Date(pg.created_at).getTime();
      if (elapsed < GREETING_DELAY_MS) continue;

      // Cek ada pesan customer (sudah redirect & chat duluan)
      const custMsgs = await sbGet('conv_messages',
        `?conversation_id=eq.${conv.id}&role=eq.customer&limit=1`
      ).catch(() => []);
      if (custMsgs.length) {
        await sbPatch('conversations', `?id=eq.${conv.id}`, {
          state: { ...conv.state, pending_greeting: null },
        }).catch(() => {});
        console.log(`[greeting] conv ${conv.id}: customer sudah chat duluan, skip`);
        continue;
      }

      // Skip kalau session greeting bukan dari WA aktif
      if (pg.wa_session && !activeSessionIds.has(pg.wa_session)) {
        console.log(`[greeting] SKIP conv ${conv.id}: session ${pg.wa_session} tidak aktif`);
        continue;
      }

      // Queue greeting ke VPS
      console.log(`[greeting] Queue ke ${pg.wa_number} (delay ${Math.round(elapsed/1000)}s)`);
      queueWA(pg.wa_session, pg.wa_number, pg.message, null, null, conv.id);
      await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: pg.message });
      results.push({ type: 'greeting', conv: conv.id, ok: true });
      totalSent++;
      // Clear pending
      await sbPatch('conversations', `?id=eq.${conv.id}`, {
        state: { ...conv.state, pending_greeting: null },
      }).catch(() => {});
    }

    if (pendingGreetings.length) {
      console.log(`[greeting] Processed ${pendingGreetings.length} pending greetings`);
    }

    // ── BAGIAN 0: Reminder konfirmasi order — customer belum balas konfirmasi pesanan ──
    // Cek conversation dengan awaiting_order_confirm = true + diam minimal 2 jam
    // Hanya cek yg dibuat max 3 hari lalu (bukan semua 900+), limit 50
    const cutoff2h = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const cutoff3d = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const awaitingConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)` +
      `&created_at=gte.${cutoff3d}` +
      `&last_msg_at=lte.${cutoff2h}` +
      activeProductFilter +
      `&select=id,user_id,customer_id,product_id,state,last_msg_at` +
      `&limit=50`
    ).catch(() => []);

    // Filter dulu yang eligible sebelum batch fetch
    const eligibleAwaiting = [];
    const todayISO = new Date(now).toISOString().slice(0, 10);
    for (const conv of awaitingConvs) {
      const state = conv.state || {};
      if (!state.awaiting_order_confirm) continue;
      if (state.confirm_reminder_sent_at?.startsWith(todayISO)) continue;
      eligibleAwaiting.push(conv);
    }

    // Batch fetch customers & products untuk semua eligible conversations
    const awCustMap = await batchFetchCustomers(eligibleAwaiting.map(c => c.customer_id));
    const awProdMap = await batchFetchProducts(eligibleAwaiting.map(c => c.product_id).filter(Boolean));

    for (const conv of eligibleAwaiting) {
      if (isTimeUp()) { console.log('[timeout] order reminder loop'); break; }
      // Cek pesan terakhir harus dari AI (konfirmasi order) — bukan customer
      const lastMsgs = await sbGet('conv_messages',
        `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
      ).catch(() => []);
      if (!lastMsgs.length || lastMsgs[0].role !== 'ai') continue;

      const state = conv.state || {};

      try {
        const customer = awCustMap.get(conv.customer_id);
        if (!customer) continue;
        const jid = customer.reply_jid || customer.wa_number;
        if (!jid) continue;

        let productNama = '', csNama = 'Sari';
        if (conv.product_id) {
          const prod = awProdMap.get(conv.product_id);
          productNama = prod?.nama || '';
          csNama      = prod?.persona_cs_nama || 'Sari';
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

        const waSessionReminder = await getWaSession(conv.user_id, conv.product_id);
        queueWA(waSessionReminder, jid, reminderMsg, null, null, conv.id);
        await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: `[Reminder konfirmasi order] ${reminderMsg}` });
        await sbPatch('conversations', `?id=eq.${conv.id}`, {
          state: { ...state, confirm_reminder_sent_at: now.toISOString() },
        });

        totalSent++;
        results.push({ type: 'order_reminder', conv_id: conv.id, customer: customer.nama, status: 'sent' });
        console.log(`[Order Reminder] → ${customer.nama || customer.wa_number}`);
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
      activeProductFilter +
      `&select=id,user_id,customer_id,product_id,sumber,state,last_msg_at,created_at` +
      `&limit=100`
    ).catch(() => []);

    // Query 1b: lead biasa baru hari ini (cutoff 1 jam)
    const newConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)` +
      `&sumber=neq.form` +
      `&created_at=gte.${todayStartISO}` +
      `&last_msg_at=lte.${cutoff1h}` +
      activeProductFilter +
      `&select=id,user_id,customer_id,product_id,sumber,state,last_msg_at,created_at` +
      `&limit=100`
    );

    // Query 2: customer lama yang chat lagi hari ini (last_msg_at >= hari ini)
    const reopenedConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)` +
      `&created_at=lt.${todayStartISO}` +
      `&last_msg_at=gte.${todayStartISO}` +
      `&last_msg_at=lte.${cutoff1h}` +
      activeProductFilter +
      `&select=id,user_id,customer_id,product_id,sumber,state,last_msg_at,created_at` +
      `&limit=100`
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

    // Batch fetch customers & products untuk semua hariH conversations
    const hhCustMap = await batchFetchCustomers(hariHConvs.map(c => c.customer_id));
    const hhProdMap = await batchFetchProducts(hariHConvs.map(c => c.product_id).filter(Boolean));

    for (const conv of hariHConvs) {
      if (isTimeUp()) { console.log('[timeout] hari H loop'); break; }
      try {
        const state = conv.state || {};
        const followedDays = state.followed_up_days || [];

        // Skip jika hari 1 sudah terkirim, eskalasi, atau sedang menunggu konfirmasi order
        if (followedDays.includes(1)) { totalSkipped++; console.log(`[SKIP] conv ${conv.id}: hari 1 sudah terkirim`); continue; }
        if (conv.status === 'eskalasi') { totalSkipped++; console.log(`[SKIP] conv ${conv.id}: status eskalasi`); continue; }
        if (state.awaiting_order_confirm || state.awaiting_order_correction) { totalSkipped++; console.log(`[SKIP] conv ${conv.id}: menunggu konfirmasi order`); continue; }

        // Cek pesan terakhir harus dari AI (kecuali stage-based: awaiting_bukti_tf, ongkir ada tapi belum metode)
        const isStageFollow = state.awaiting_bukti_tf || (state.ongkir && !state.metode_bayar) || (state.wilayah && !state.ongkir);
        const lastMsgs = await sbGet('conv_messages',
          `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
        );
        if (!isStageFollow && (!lastMsgs.length || lastMsgs[0].role !== 'ai')) {
          totalSkipped++;
          console.log(`[SKIP] conv ${conv.id}: pesan terakhir bukan dari AI (role=${lastMsgs[0]?.role || 'none'})`);
          continue;
        }

        const customer = hhCustMap.get(conv.customer_id);
        if (!customer) { totalSkipped++; continue; }
        if (!customer.reply_jid && !customer.wa_number) { totalSkipped++; continue; }

        let namaProduk = '', csNama = 'Sari', product = null;
        if (conv.product_id) {
          product    = hhProdMap.get(conv.product_id) || null;
          namaProduk = product?.nama || '';
          csNama     = product?.persona_cs_nama || 'Sari';
        }

        // Cek schedule hari 1 — cari yang product_id match dulu, fallback ke null (global)
        let schedHari1 = [];
        if (conv.product_id) {
          schedHari1 = await sbGet('followup_schedule',
            `?user_id=eq.${conv.user_id}&hari=eq.1&aktif=eq.true&product_id=eq.${conv.product_id}&order=jam_kirim.asc&limit=1`
          ).catch(() => []);
        }
        if (!schedHari1.length) {
          schedHari1 = await sbGet('followup_schedule',
            `?user_id=eq.${conv.user_id}&hari=eq.1&aktif=eq.true&product_id=is.null&order=jam_kirim.asc&limit=1`
          ).catch(() => []);
        }

        const schedule = schedHari1[0] || { hari: 1, tipe: 'ai' };
        const pesan = await kirimFollowup(conv, customer, namaProduk, csNama, schedule, now, product);

        if (pesan !== null) {
          totalSent++;
          results.push({ hari: 1, conv_id: conv.id, customer: customer.nama, status: 'sent' });
          console.log(`[Hari H] → ${customer.nama || customer.wa_number}`);
        }
      } catch(e) {
        console.error(`Error hari H conv ${conv.id}:`, e.message);
      }
    }

    // ── BAGIAN 2: Hari 2+ — berdasarkan followup_schedule ──
    // Ambil semua schedule aktif (hari 2+)
    const allSchedules = await sbGet('followup_schedule',
      `?hari=gte.2&aktif=eq.true&order=hari.asc,jam_kirim.asc`
    ).catch(() => []);

    // Kelompokkan per user + product (key = "userId::productId" atau "userId::null")
    const schedByKey = {};
    for (const s of allSchedules) {
      const key = `${s.user_id}::${s.product_id || 'null'}`;
      if (!schedByKey[key]) schedByKey[key] = { userId: s.user_id, productId: s.product_id || null, schedules: [] };
      schedByKey[key].schedules.push(s);
    }

    for (const { userId, productId, schedules } of Object.values(schedByKey)) {
      if (isTimeUp()) { console.log('[timeout] schedule loop'); break; }
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
        const hariMulai = new Date(now);
        hariMulai.setUTCDate(hariMulai.getUTCDate() - (hariKe - 1));
        hariMulai.setUTCHours(0 - 7, 0, 0, 0); // 00:00 WIB

        const hariAkhir = new Date(hariMulai);
        hariAkhir.setUTCDate(hariAkhir.getUTCDate() + 1);

        // Filter product: kalau schedule punya product_id → filter conversation by product
        // Kalau null (global/semua produk) → tidak filter
        const productQ = productId ? `&product_id=eq.${productId}` : '';

        const convs = await sbGet('conversations',
          `?user_id=eq.${userId}` +
          productQ +
          `&status=in.(baru,diproses)` +
          `&created_at=gte.${hariMulai.toISOString()}` +
          `&created_at=lt.${hariAkhir.toISOString()}` +
          `&last_msg_at=lte.${cutoff1h}` +
          activeProductFilter +
          `&select=id,user_id,customer_id,product_id,state,last_msg_at,created_at` +
          `&limit=100`
        ).catch(() => []);

        // Tandai schedule terakhir (per grup product)
        const maxHari = Math.max(...schedules.map(s => s.hari));
        sched.is_last = sched.hari === maxHari;

        // Batch fetch customers & products untuk convs di schedule ini
        const d2CustMap = await batchFetchCustomers(convs.map(c => c.customer_id));
        const d2ProdMap = await batchFetchProducts(convs.map(c => c.product_id).filter(Boolean));

        for (const conv of convs) {
          if (isTimeUp()) { console.log('[timeout] hari 2+ loop'); break; }
          try {
            const state            = conv.state || {};
            const followedSchedIds = state.followed_up_sched_ids || [];
            const followedDays     = state.followed_up_days || [];

            // Skip jika schedule ini sudah terkirim (cek per sched ID untuk support multi-jadwal 1 hari)
            // Fallback: kalau sched belum punya ID (data lama), cek by hari
            const sudahTerkirim = sched.id
              ? followedSchedIds.includes(sched.id)
              : followedDays.includes(hariKe);
            if (sudahTerkirim)                 { totalSkipped++; continue; }
            if (conv.status === 'eskalasi')    { totalSkipped++; continue; }
            if (state.awaiting_order_confirm || state.awaiting_order_correction) { totalSkipped++; continue; }

            const customer = d2CustMap.get(conv.customer_id);
            if (!customer) { totalSkipped++; continue; }
            if (!customer.reply_jid && !customer.wa_number) { totalSkipped++; continue; }

            let namaProduk = '', csNama = 'Sari', product = null;
            if (conv.product_id) {
              product    = d2ProdMap.get(conv.product_id) || null;
              namaProduk = product?.nama || '';
              csNama     = product?.persona_cs_nama || 'Sari';
            }

            const pesan = await kirimFollowup(conv, customer, namaProduk, csNama, sched, now, product);

            if (pesan !== null) {
              totalSent++;
              results.push({ hari: hariKe, conv_id: conv.id, customer: customer.nama, tipe: sched.tipe, status: 'sent' });
              console.log(`[Hari ${hariKe} - ${sched.tipe}] → ${customer.nama || customer.wa_number}`);
            }
          } catch(e) {
            console.error(`Error hari ${hariKe} conv ${conv.id}:`, e.message);
          }
        }
      }
    }

    // Flush semua queue ke VPS dalam 1 request
    const flushResult = await flushQueueToVPS();

    console.log(`Done: ${totalSent} queued, ${totalSkipped} dilewati, flush: ${JSON.stringify(flushResult)}`);

  } catch(err) {
    // Tetap flush meski ada error — jangan buang pesan yang sudah dikumpulkan
    await flushQueueToVPS().catch(() => {});
    console.error('Follow-up job error:', err.message);
  }

  }; // end doWork

  // Jalankan di background — response sudah dikirim ke cron-job.org
  // Vercel tetap jalankan function sampai maxDuration (60s) meski response sudah terkirim
  doWork().catch(e => console.error('doWork error:', e.message));
};
