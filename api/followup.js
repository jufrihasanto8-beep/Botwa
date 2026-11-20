// ══════════════════════════════════════════════════════════
//  Follow-up Otomatis — Stage-Based Queue System
//
//  Cron tiap 5 menit via VPS crontab:
//    */5 0-14 * * * curl -s ".../api/followup?secret=..."
//
//  Flow:
//    1. Greeting real-time (pending 3 menit)
//    2. Order Confirm FU — bertahap (niat beli tinggi!)
//       - Stage 1: 30 menit  → soft reminder
//       - Stage 2: 2 jam     → push + detail order
//       - Stage 3: 6 jam     → last call hari ini
//       - Stage 4: hari ke-2 → reminder
//       - Stage 5: hari ke-3 → final, pintu terbuka
//       - COD vs Transfer pesan beda
//       - Timer reset kalau customer bales (bukan confirm)
//    3. Stage-based FU (lead belum order):
//       - Scan conversation aktif
//       - Cek stage → delay (30m / 1j / 2j)
//       - last_msg_at + delay <= sekarang → eligible
//       - Cek followup_queue: udah di-FU hari ini? → skip
//       - Max 3 per produk per run
//
//  Stage delays (Bagian 3):
//    ongkir_no_metode  : 30 menit (paling dekat closing)
//    awaiting_bukti_tf : 1 jam (kasih waktu transfer)
//    wilayah_no_ongkir : 30 menit (perlu alamat ulang)
//    waiting_location  : 1 jam (belum kasih alamat)
//    cold_lead         : 2 jam (default)
// ══════════════════════════════════════════════════════════

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY= process.env.SUPABASE_SERVICE_KEY;
const BAILEYS_URL         = process.env.BAILEYS_URL;
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET;
const CRON_SECRET         = process.env.CRON_SECRET;
const ANTHROPIC_KEY       = process.env.ANTHROPIC_KEY;

const MAX_PER_PRODUCT = 3;   // max FU per produk per 5 menit
const MAX_FU_DAYS     = 3;   // stop FU setelah 3 hari tanpa response

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
  const rows = await sbGet('products', `?id=in.(${uniq.join(',')})&select=id,nama,persona_cs_nama,harga,harga_bundling,berat_gram,promo_ongkir,wa_session_id,ai_provider,ai_api_key`).catch(() => []);
  return new Map(rows.map(r => [r.id, r]));
}

async function getWaSession(userId, productId) {
  if (productId) {
    const rows = await sbGet('products', `?id=eq.${productId}&select=wa_session_id&limit=1`).catch(() => []);
    if (rows[0]?.wa_session_id) return rows[0].wa_session_id;
  }
  const rows = await sbGet('products', `?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=wa_session_id&limit=1`).catch(() => []);
  return rows[0]?.wa_session_id || userId;
}

// WA message queue — dikumpulin, flush 1x ke VPS di akhir
let _fuQueueItems = [];

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

async function flushQueueToVPS() {
  if (!_fuQueueItems.length || !BAILEYS_URL) return { queued: 0 };
  try {
    const res = await fetchWithTimeout(`${BAILEYS_URL}/followup-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, items: _fuQueueItems }),
    }, 10000);
    const data = await res.json();
    console.log(`[fu-queue] Flushed ${_fuQueueItems.length} items to VPS`);
    return data;
  } catch(e) {
    console.error(`[fu-queue] Flush failed: ${e.message}`);
    return { error: e.message };
  }
}

// ── Resolve AI endpoint (mwapi vs anthropic) ────────────
const MWAPI_BASE     = 'https://api.mwapi.dev';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
function resolveAI(product) {
  if (product?.ai_api_key) {
    const base = product.ai_provider === 'mwapi' ? MWAPI_BASE : ANTHROPIC_BASE;
    return { key: product.ai_api_key, base };
  }
  return { key: ANTHROPIC_KEY, base: ANTHROPIC_BASE };
}

// ── Stage Detection — tentuin delay berdasarkan state ────
function getStageDelay(state) {
  // cancelled → stop semua follow-up
  if (state.is_cancelled) return null;
  // awaiting_order_confirm di-handle order reminder terpisah
  if (state.awaiting_order_confirm || state.awaiting_order_correction) return null;
  // order sudah masuk → stop
  if (state.order_placed) return null;

  if (state.ongkir && !state.metode_bayar)
    return { stage: 'ongkir_no_metode', delayMs: 30 * 60 * 1000 };
  if (state.awaiting_bukti_tf)
    return { stage: 'awaiting_bukti_tf', delayMs: 60 * 60 * 1000 };
  if (state.wilayah && !state.ongkir)
    return { stage: 'wilayah_no_ongkir', delayMs: 30 * 60 * 1000 };
  if (state.waiting_for_location)
    return { stage: 'waiting_location', delayMs: 60 * 60 * 1000 };
  // default: cold lead / ga bales dari awal
  return { stage: 'cold_lead', delayMs: 2 * 60 * 60 * 1000 };
}

// ── Generate pesan AI dari konteks percakapan ─────────────
async function generateAIFollowup(messages, namaKak, namaProduk, csNama, isLast = false, isFormLead = false, convState = {}, product = null) {
  const ai = resolveAI(product);
  const apiKey = ai.key || ANTHROPIC_KEY;
  if (!apiKey) return null;

  const recent = messages.slice(-6);
  const transcript = recent.map(m =>
    `${m.role === 'customer' ? 'Customer' : 'CS'}: ${(m.isi || '').replace(/\[.*?\]/g, '').trim()}`
  ).filter(l => l.split(': ')[1]).join('\n');

  const toneNote = isLast
    ? 'Ini follow-up TERAKHIR. Tone penutup — beri ruang, tidak maksa, pintu tetap terbuka.'
    : isFormLead
      ? 'Customer ini sudah isi form & niat beli (warm lead). Tone antusias, bantu segera, tunjukkan kamu prioritaskan mereka.'
      : 'Tone hangat, natural, sambung konteks.';

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
    const res = await fetchWithTimeout(`${ai.base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
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
  const state = conv.state || {};

  if (state.waiting_for_location && !state.ongkir) {
    console.log(`[SKIP] conv ${conv.id}: waiting_for_location aktif & ongkir belum ada`);
    return null;
  }

  const isFormLead = conv.sumber === 'form' || state.is_form_lead === true;
  const jid = customer.reply_jid || customer.wa_number;
  const namaKak = customer.nama && customer.nama !== customer.wa_number
    ? customer.nama.split(' ')[0] : '';

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

  // ── Stage-based template: PRIORITAS UTAMA ──
  const panggilan = namaKak ? `Kak ${namaKak}` : 'Kak';
  const ongkir = state.ongkir;
  let isStageHandled = false;

  if (ongkir && !state.metode_bayar && !state.awaiting_order_confirm) {
    const fmt = n => `Rp ${Number(n||0).toLocaleString('id-ID')}`;
    message = hariIni <= 1
      ? `${panggilan}, pesanannya jadi kami proses? 😊\n\nTotal:\n💳 Transfer: ${fmt(ongkir.totalTransfer)}\n📦 COD: ${fmt(ongkir.totalCOD)}\n\nEnaknya COD atau Transfer kak?`
      : `${panggilan}, kemarin totalnya sudah kami hitung ya 😊\n\n💳 Transfer: ${fmt(ongkir.totalTransfer)}\n📦 COD: ${fmt(ongkir.totalCOD)}\n\nMasih jadi order kak? Enaknya COD atau Transfer? 🙏`;
    isStageHandled = true;
    console.log(`[stage-fu] conv ${conv.id} hari ${hariIni}: ongkir ada, tanya metode`);

  } else if (state.awaiting_bukti_tf) {
    message = hariIni <= 1
      ? `${panggilan}, sudah sempat transfer kak? Kalau sudah, kirim bukti TF-nya ya biar bisa segera kami proses 🙏`
      : `${panggilan}, kami masih nunggu bukti transfer-nya ya kak 😊 Kalau sudah transfer, langsung kirim foto buktinya biar bisa segera diproses 🙏`;
    isStageHandled = true;
    console.log(`[stage-fu] conv ${conv.id} hari ${hariIni}: awaiting bukti TF`);

  } else if (state.wilayah && !ongkir) {
    message = hariIni <= 1
      ? `${panggilan}, maaf tadi sempat ada kendala. Boleh konfirmasi lagi kak alamat pengirimannya ke mana? Biar kami cek ongkirnya 😊`
      : `${panggilan}, boleh info alamat lengkapnya kak? Biar kami cek ongkir dan totalnya ya 😊`;
    isStageHandled = true;
    console.log(`[stage-fu] conv ${conv.id} hari ${hariIni}: wilayah ada, ongkir gagal`);
  }

  if (!isStageHandled) {
    if (tipe === 'ai') {
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

  // Queue ke VPS
  const waSession = await getWaSession(conv.user_id, conv.product_id);
  if (imageUrl) {
    queueWA(waSession, jid, null, imageUrl, caption, conv.id);
  } else if (message) {
    queueWA(waSession, jid, message, null, null, conv.id);
  } else {
    return null;
  }

  // Simpan ke conv_messages
  const isiLog = imageUrl
    ? `[Follow-up Hari ${hariIni} - ${tipe}] ${caption || ''}`
    : `[Follow-up Hari ${hariIni} - ${tipe}] ${message}`;
  await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: isiLog });

  // Update state
  const followedDays     = state.followed_up_days || [];
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

// ══════════════════════════════════════════════════════════
//  MAIN HANDLER — Cron tiap 5 menit
// ══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const isManual   = req.method === 'GET' && req.query?.secret === CRON_SECRET;
  const isCron     = authHeader === `Bearer ${CRON_SECRET}`;

  if (CRON_SECRET && !isManual && !isCron) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  // Clear WA queue (safety: Vercel warm instance)
  _fuQueueItems.length = 0;

  const now       = new Date();
  const jamWIB    = (now.getUTCHours() + 7) % 24;
  const menitWIB  = now.getUTCMinutes();
  const jamNow    = `${String(jamWIB).padStart(2,'0')}:${String(menitWIB).padStart(2,'0')}`;
  // Tanggal WIB untuk daily dedup
  const todayWIB  = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`[followup] ${now.toISOString()} (WIB ${jamNow})`);

  let totalSent = 0, totalSkipped = 0;
  const details = [];
  const startTime = Date.now();
  const MAX_RUNTIME = 50000; // 50s safety (Vercel limit 60s)
  const isTimeUp = () => Date.now() - startTime > MAX_RUNTIME;

  try {
    // ── Filter: hanya produk dengan WA session aktif ──
    const activeProducts = await sbGet('products',
      `?wa_status=eq.connected&wa_session_id=not.is.null&aktif=eq.true&select=id,wa_session_id`
    ).catch(() => []);
    const activeProductIds = activeProducts.map(p => p.id);
    const activeSessionIds = new Set(activeProducts.map(p => p.wa_session_id));

    if (!activeProductIds.length) {
      return res.status(200).json({ ok: true, sent: 0, reason: 'no_active_sessions' });
    }
    const activeProductFilter = `&product_id=in.(${activeProductIds.join(',')})`;
    console.log(`[followup] ${activeProductIds.length} produk aktif`);

    // ═══════════════════════════════════════════════════
    //  BAGIAN 1: Greeting real-time (pending 3 menit)
    // ═══════════════════════════════════════════════════
    const GREETING_DELAY_MS = 3 * 60 * 1000;
    const greetingCutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const pendingConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)&created_at=gte.${greetingCutoff}${activeProductFilter}&select=id,user_id,state&limit=50`
    ).catch(() => []);
    const pendingGreetings = pendingConvs.filter(c => c.state?.pending_greeting?.created_at);

    for (const conv of pendingGreetings) {
      if (isTimeUp()) break;
      const pg = conv.state.pending_greeting;
      const elapsed = now.getTime() - new Date(pg.created_at).getTime();
      if (elapsed < GREETING_DELAY_MS) continue;

      const custMsgs = await sbGet('conv_messages',
        `?conversation_id=eq.${conv.id}&role=eq.customer&limit=1`
      ).catch(() => []);
      if (custMsgs.length) {
        await sbPatch('conversations', `?id=eq.${conv.id}`, {
          state: { ...conv.state, pending_greeting: null },
        }).catch(() => {});
        continue;
      }

      if (pg.wa_session && !activeSessionIds.has(pg.wa_session)) continue;

      console.log(`[greeting] → ${pg.wa_number}`);
      queueWA(pg.wa_session, pg.wa_number, pg.message, null, null, conv.id);
      await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: pg.message });
      await sbPatch('conversations', `?id=eq.${conv.id}`, {
        state: { ...conv.state, pending_greeting: null },
      }).catch(() => {});
      totalSent++;
      details.push({ type: 'greeting', conv: conv.id });
    }

    // ═══════════════════════════════════════════════════
    //  BAGIAN 2: Order Confirm Follow-up — bertahap
    //
    //  Stage 1: 30 menit  → soft reminder
    //  Stage 2: 2 jam     → push lebih tegas
    //  Stage 3: 6 jam     → last call hari ini
    //  Stage 4: hari ke-2 → reminder besok
    //  Stage 5: hari ke-3 → final, pintu terbuka
    // ═══════════════════════════════════════════════════
    const CONFIRM_FU_STAGES = [
      { stage: 1, delayMs: 30 * 60 * 1000 },      // 30 menit
      { stage: 2, delayMs: 2 * 60 * 60 * 1000 },   // 2 jam
      { stage: 3, delayMs: 6 * 60 * 60 * 1000 },   // 6 jam
      { stage: 4, delayMs: 24 * 60 * 60 * 1000 },  // 1 hari
      { stage: 5, delayMs: 48 * 60 * 60 * 1000 },  // 2 hari (final)
    ];

    const cutoff3d = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff30m = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    const awaitingConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)&created_at=gte.${cutoff3d}&last_msg_at=lte.${cutoff30m}${activeProductFilter}` +
      `&state->>awaiting_order_confirm=eq.true&state->>order_placed=neq.true` +
      `&select=id,user_id,customer_id,product_id,state,last_msg_at&order=last_msg_at.asc&limit=200`
    ).catch(() => []);

    const eligibleAwaiting = awaitingConvs.filter(c => {
      const state = c.state || {};
      return state.awaiting_order_confirm && !state.order_placed && !state.is_cancelled;
    });

    if (eligibleAwaiting.length) {
      const awCustMap = await batchFetchCustomers(eligibleAwaiting.map(c => c.customer_id));
      const awProdMap = await batchFetchProducts(eligibleAwaiting.map(c => c.product_id).filter(Boolean));

      for (const conv of eligibleAwaiting) {
        if (isTimeUp()) break;

        const state = conv.state || {};
        const customer = awCustMap.get(conv.customer_id);
        if (!customer) continue;
        const jid = customer.reply_jid || customer.wa_number;
        if (!jid) continue;

        // Cek pesan terakhir harus dari bot (customer belum bales)
        const lastMsgs = await sbGet('conv_messages',
          `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
        ).catch(() => []);
        if (!lastMsgs.length || lastMsgs[0].role !== 'ai') continue;

        // Hitung stage berikutnya berdasarkan order_confirmed_at
        const confirmedAt = state.order_confirmed_at
          ? new Date(state.order_confirmed_at).getTime()
          : new Date(conv.last_msg_at).getTime(); // fallback: last_msg_at
        const currentStage = state.confirm_fu_stage || 0;
        const elapsed = now.getTime() - confirmedAt;

        // Cari stage berikutnya yang eligible
        const nextStageInfo = CONFIRM_FU_STAGES.find(s => s.stage > currentStage && elapsed >= s.delayMs);
        if (!nextStageInfo) continue;

        let productNama = '', csNama = 'Sari';
        if (conv.product_id) {
          const prod = awProdMap.get(conv.product_id);
          productNama = prod?.nama || '';
          csNama      = prod?.persona_cs_nama || 'Sari';
        }

        const snap      = state.order_snapshot || {};
        const area      = snap.area || {};
        const isTransfer = (snap.metode || 'COD').toLowerCase() === 'transfer';
        const ekspLabel = (snap.ekspedisi || 'KURIR').toUpperCase();
        const total     = isTransfer
          ? (snap.harga || 0) + (snap.ongkirPromo || 0)
          : (snap.harga || 0) + (snap.ongkirPromo || 0) + (snap.feeCOD || 0);
        const fmt       = n => `Rp ${Number(n||0).toLocaleString('id-ID')}`;
        const namaKak   = customer.nama && customer.nama !== customer.wa_number
          ? customer.nama.split(' ')[0] : '';
        const panggilan = namaKak ? `Kak ${namaKak}` : 'Kak';

        // ── Generate pesan berbeda per stage ──
        let reminderMsg = '';
        const stg = nextStageInfo.stage;

        if (isTransfer) {
          // ── TRANSFER: minta bukti TF ──
          if (stg === 1) {
            reminderMsg = `${panggilan}, pesanannya sudah sesuai kak? 😊 Kalau sudah oke, langsung transfer aja ya ke rekening yang tadi. Ditunggu bukti TF-nya 🙏`;
          } else if (stg === 2) {
            reminderMsg = `${panggilan}, mau konfirmasi lagi kak soal pesanannya 😊 Totalnya ${fmt(total)} via ${ekspLabel}. Kalau sudah transfer, kirim bukti TF-nya ya biar bisa segera kami proses 🙏`;
          } else if (stg === 3) {
            reminderMsg = `${panggilan}, pesanannya masih kami hold ya kak. Kami siap proses kirim hari ini kalau bukti TF-nya masuk sebelum jam 3 sore 😊 Ditunggu ya kak 🙏`;
          } else if (stg === 4) {
            reminderMsg = `Halo ${panggilan}! Mau follow up soal pesanan kemarin ya kak 😊 Masih jadi order? Totalnya ${fmt(total)} via Transfer ${ekspLabel}. Kalau sudah transfer, langsung kirim bukti TF-nya ya kak 🙏`;
          } else {
            reminderMsg = `${panggilan}, ini terakhir kami follow up ya kak soal pesanannya 🙏 Kalau masih berminat, tinggal transfer ${fmt(total)} dan kirim bukti TF-nya. Kalau ada kendala, kabari aja kak, kami siap bantu 😊`;
          }
        } else {
          // ── COD: minta konfirmasi order ──
          if (stg === 1) {
            reminderMsg = `${panggilan}, pesanannya sudah sesuai kak? 😊 Kalau sudah oke, tinggal konfirmasi biar bisa langsung kami proses kirim hari ini ya kak 🙏`;
          } else if (stg === 2) {
            reminderMsg = `${panggilan}, mau konfirmasi lagi ya kak 😊\n\n*${productNama || 'Pesanan'}* — ${snap.qty || 1} pcs\n*Total COD:* ${fmt(total)} via ${ekspLabel}\n\nSudah bener kak? Biar bisa langsung kami kirim 🙏`;
          } else if (stg === 3) {
            reminderMsg = `${panggilan}, pesanannya masih kami hold ya kak. Kalau mau dikirim hari ini, tinggal konfirmasi aja kak 😊 Kami siap proses 🙏`;
          } else if (stg === 4) {
            reminderMsg = `Halo ${panggilan}! Mau follow up soal pesanan kemarin ya kak 😊\n\n*${productNama || 'Produk'}* — ${snap.qty || 1} pcs\n*Total COD:* ${fmt(total)} via ${ekspLabel}\n\nMasih jadi dikirim kak? Tinggal konfirmasi aja ya 🙏`;
          } else {
            reminderMsg = `${panggilan}, ini terakhir kami follow up soal pesanannya ya kak 🙏 Kalau masih berminat, tinggal bilang "iya" aja dan langsung kami proses. Kalau ada yang mau diubah, kabari aja kak 😊`;
          }
        }

        const waSession = await getWaSession(conv.user_id, conv.product_id);
        queueWA(waSession, jid, reminderMsg, null, null, conv.id);
        await sbPost('conv_messages', { conversation_id: conv.id, role: 'ai', isi: `[Konfirmasi FU Stage ${stg}${isTransfer ? ' - Transfer' : ' - COD'}] ${reminderMsg}` });
        await sbPatch('conversations', `?id=eq.${conv.id}`, {
          last_msg_at: now.toISOString(),
          state: { ...state, confirm_fu_stage: stg, confirm_fu_at: now.toISOString() },
        });
        totalSent++;
        details.push({ type: 'confirm_fu', stage: stg, conv: conv.id, customer: customer.nama, metode: isTransfer ? 'transfer' : 'cod' });
        console.log(`[confirm-fu] Stage ${stg} → ${customer.nama || customer.wa_number} (${isTransfer ? 'TF' : 'COD'})`);
      }
    }

    // ═══════════════════════════════════════════════════
    //  BAGIAN 3: Stage-based Follow-up (queue system)
    // ═══════════════════════════════════════════════════

    // 3a. Ambil conversation yang sudah di-FU hari ini (dedup)
    const todayQueue = await sbGet('followup_queue',
      `?fu_day=eq.${todayWIB}&status=eq.sent&select=conversation_id`
    ).catch(() => []);
    const sentTodaySet = new Set(todayQueue.map(q => q.conversation_id));
    console.log(`[fu] Already sent today: ${sentTodaySet.size}`);

    // 3b. Scan conversation aktif yang diam >= 30 menit (minimum delay)
    // cutoff30m sudah dideclare di Bagian 2
    const allConvs = await sbGet('conversations',
      `?status=in.(baru,diproses)` +
      `&last_msg_at=lte.${cutoff30m}` +
      `&last_msg_at=gte.${cutoff3d}` +
      activeProductFilter +
      `&select=id,user_id,customer_id,product_id,sumber,state,last_msg_at` +
      `&order=last_msg_at.asc` +
      `&limit=500`
    ).catch(() => []);

    console.log(`[fu] Candidates: ${allConvs.length}`);

    // 3c. Filter eligible + rate limit per produk
    const productCount = {};
    const eligible = [];

    for (const conv of allConvs) {
      // Sudah di-FU hari ini?
      if (sentTodaySet.has(conv.id)) { totalSkipped++; continue; }

      const state = conv.state || {};

      // Stage + delay
      const stageInfo = getStageDelay(state);
      if (!stageInfo) { totalSkipped++; continue; } // handled by order reminder or already ordered

      // Sudah di-FU 3 hari berturut? Stop.
      const followedDays = state.followed_up_days || [];
      if (followedDays.length >= MAX_FU_DAYS) { totalSkipped++; continue; }

      // Cek delay: last_msg_at + delay <= sekarang?
      const lastMsg = new Date(conv.last_msg_at);
      if (lastMsg.getTime() + stageInfo.delayMs > now.getTime()) { totalSkipped++; continue; }

      // Rate limit per produk (max 3 per run)
      const pid = conv.product_id || 'default';
      if ((productCount[pid] || 0) >= MAX_PER_PRODUCT) { totalSkipped++; continue; }

      eligible.push({ conv, stage: stageInfo.stage });
      productCount[pid] = (productCount[pid] || 0) + 1;
    }

    console.log(`[fu] Eligible: ${eligible.length}`);

    if (eligible.length) {
      // 3d. Batch fetch customers + products
      const custMap = await batchFetchCustomers(eligible.map(e => e.conv.customer_id));
      const prodMap = await batchFetchProducts(eligible.map(e => e.conv.product_id).filter(Boolean));

      // 3e. Kirim FU + insert ke queue
      for (const { conv, stage } of eligible) {
        if (isTimeUp()) { console.log('[timeout] fu loop'); break; }

        try {
          const customer = custMap.get(conv.customer_id);
          if (!customer || (!customer.reply_jid && !customer.wa_number)) { totalSkipped++; continue; }

          const product = conv.product_id ? prodMap.get(conv.product_id) : null;
          const namaProduk = product?.nama || '';
          const csNama = product?.persona_cs_nama || 'Sari';

          // Hitung hari FU ke berapa
          const followedDays = (conv.state || {}).followed_up_days || [];
          const hari = followedDays.length + 1;
          const schedule = { hari, tipe: 'ai', is_last: hari >= MAX_FU_DAYS };

          // Cek pesan terakhir (non-stage: harus dari AI)
          const isStageFollow = (conv.state || {}).awaiting_bukti_tf
            || ((conv.state || {}).ongkir && !(conv.state || {}).metode_bayar)
            || ((conv.state || {}).wilayah && !(conv.state || {}).ongkir);

          if (!isStageFollow) {
            const lastMsgs = await sbGet('conv_messages',
              `?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
            ).catch(() => []);
            if (!lastMsgs.length || lastMsgs[0].role !== 'ai') {
              totalSkipped++;
              continue;
            }
          }

          const pesan = await kirimFollowup(conv, customer, namaProduk, csNama, schedule, now, product);

          if (pesan !== null) {
            // Insert ke queue — tandai sudah FU hari ini
            await sbPost('followup_queue', {
              conversation_id: conv.id,
              product_id: conv.product_id || null,
              fu_stage: stage,
              fu_day: todayWIB,
              status: 'sent',
            }).catch(e => console.error(`[fu] Queue insert error: ${e.message}`));

            totalSent++;
            details.push({ type: 'fu', stage, conv: conv.id, customer: customer.nama, hari });
            console.log(`[fu] → ${customer.nama || customer.wa_number} (${stage}, hari ${hari})`);
          } else {
            totalSkipped++;
          }
        } catch(e) {
          console.error(`[fu] Error conv ${conv.id}:`, e.message);
        }
      }
    }

    // ═══════════════════════════════════════════════════
    //  FLUSH semua WA messages ke VPS
    // ═══════════════════════════════════════════════════
    const flushResult = await flushQueueToVPS();

    console.log(`[followup] Done: ${totalSent} sent, ${totalSkipped} skipped`);
    return res.status(200).json({
      ok: true, sent: totalSent, skipped: totalSkipped,
      flush: flushResult, details,
    });

  } catch(err) {
    await flushQueueToVPS().catch(() => {});
    console.error('[followup] Error:', err.message);
    return res.status(200).json({
      ok: true, sent: totalSent, skipped: totalSkipped, error: err.message,
    });
  }
};
