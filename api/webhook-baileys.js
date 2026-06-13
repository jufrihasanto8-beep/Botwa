/**
 * Vercel Serverless — Webhook dari Baileys
 * Terima pesan → routing CTWA/form/inbound → Claude template prompt → balas via Baileys
 * Blueprint §2 (routing), §3 (template prompt), §4 (pricing engine akan ditambah)
 */

const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY      = process.env.ANTHROPIC_KEY;
const BAILEYS_URL        = process.env.BAILEYS_URL;        // http://185.194.219.199:3000
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const MENGANTAR_KEY      = process.env.MENGANTAR_KEY;

/* ── SUPABASE HELPERS ─────────────────────────────────────── */
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

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${table}: ${await res.text()}`);
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

/* ── NORMALISASI NOMOR WA ─────────────────────────────────── */
function normalizeWA(num) {
  let n = String(num).replace(/\D/g, '');
  if (n.startsWith('0'))  n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n;
}

/* ── FIND / CREATE CUSTOMER ───────────────────────────────── */
async function findOrCreateCustomer(userId, waNumber, nama) {
  const normalized = normalizeWA(waNumber);
  const existing = await sbGet('customers', `?user_id=eq.${userId}&wa_number=eq.${normalized}`);
  if (existing.length) return existing[0];
  const rows = await sbPost('customers', {
    user_id: userId,
    wa_number: normalized,
    nama: nama || normalized,
  });
  return rows[0];
}

/* ── FIND / CREATE CONVERSATION ──────────────────────────── */
async function findOrCreateConversation(userId, customerId, sumber, productId) {
  // Cari conversation aktif (belum selesai)
  const existing = await sbGet('conversations',
    `?user_id=eq.${userId}&customer_id=eq.${customerId}&status=neq.selesai&order=created_at.desc&limit=1`
  );
  if (existing.length) return existing[0];

  const rows = await sbPost('conversations', {
    user_id: userId,
    customer_id: customerId,
    sumber,
    product_id: productId || null,
    status: 'baru',
    prioritas: 'low',
    state: { tahap: 'sambut', produk_locked: !!productId },
  });
  return rows[0];
}

/* ── ROUTING: CTWA referral → produk ─────────────────────── */
async function resolveProduct(userId, referral, messageText) {
  // 1. Coba dari CTWA referral
  if (referral?.ad_id || referral?.headline) {
    const identifier = referral.ad_id || referral.headline;
    const mapping = await sbGet('ad_mapping',
      `?user_id=eq.${userId}&identifier=eq.${encodeURIComponent(identifier)}&aktif=eq.true&limit=1`
    );
    if (mapping.length && mapping[0].product_id) {
      const prod = await sbGet('products', `?id=eq.${mapping[0].product_id}&aktif=eq.true&limit=1`);
      if (prod.length) return { product: prod[0], sumber: 'ctwa' };
    }
  }

  // 2. Fallback: deteksi dari isi chat (keyword sederhana)
  if (messageText) {
    const products = await sbGet('products', `?user_id=eq.${userId}&aktif=eq.true`);
    const msgLower = messageText.toLowerCase();
    for (const p of products) {
      const namaLower = p.nama.toLowerCase();
      if (msgLower.includes(namaLower) || namaLower.split(' ').some(w => w.length > 3 && msgLower.includes(w))) {
        return { product: p, sumber: 'inbound' };
      }
    }
    // Kembalikan produk pertama aktif jika hanya 1 produk
    if (products.length === 1) return { product: products[0], sumber: 'inbound' };
  }

  return { product: null, sumber: 'inbound' };
}

/* ── BUILD TEMPLATE SYSTEM PROMPT (Blueprint §3) ─────────── */
function buildTemplatePrompt(product, customer, conversation, sumber) {
  const csNama     = product?.persona_cs_nama || 'Sari';
  const namaToko   = product?.persona_cs_nama ? 'toko kami' : 'Adsy Store';
  const namaProduk = product?.nama || 'produk kami';
  const harga      = product?.harga ? `Rp ${product.harga.toLocaleString('id-ID')}` : '(akan dikonfirmasi)';

  const pertanyaan = Array.isArray(product?.pertanyaan_diagnosa)
    ? product.pertanyaan_diagnosa.join(' | ')
    : (product?.pertanyaan_diagnosa || 'Sudah berapa lama? Sudah pernah coba obat apa?');

  const keluhan = Array.isArray(product?.keluhan_cocok)
    ? product.keluhan_cocok.join(', ')
    : (product?.keluhan_cocok || '');

  const promoOngkir = product?.promo_ongkir
    ? formatPromoOngkir(product.promo_ongkir)
    : 'tidak ada';

  const namaCustomer = customer?.nama || '';

  return `IDENTITAS
Kamu "${csNama}", CS toko ${namaToko} di WhatsApp.
Kamu BUKAN sales. Kamu konsultan yang kebetulan punya solusi.
Sapaan pembuka SESUAIKAN sumber chat:
- Dari CTWA: "Halo kak, dari iklan ${namaProduk} ya? 😊" lalu gali keluhan.
- Dari Form: "Halo kak${namaCustomer ? ' ' + namaCustomer : ''}, makasih udah isi form buat ${namaProduk} 😊" (pakai nama kalau ada; jangan tanya ulang data yang sudah ada di form).
- Inbound (chat duluan): "Halo kak! 😊 Ada yang bisa aku bantu?"
Jangan tanya ulang dari nol kalau konteks/data sudah tersedia.
Kalau ditanya "kamu robot/AI/bot?" → jawab santai: "Hehe bukan kak, aku ${csNama} CS-nya 😊 Ada yang bisa dibantu?" — JANGAN akui sebagai AI.

PRINSIP UTAMA
- Produk dibeli karena KELUHAN, bukan impulsif.
- DENGAR keluhan dulu → pahami → baru bantu.
- Closing = AKIBAT konsultasi baik, BUKAN tujuan yang dikejar.
- JANGAN tawarkan beli sebelum paham masalah customer.
- Kalau customer buru-buru & langsung mau beli → layani.

DATA PRODUK (jangan ngarang di luar ini)
Produk      : ${namaProduk}
Harga       : ${harga}
Cocok untuk : ${keluhan}
Cara pakai  : ${product?.cara_pakai || '(lihat kemasan)'}
Knowledge   : ${product?.product_knowledge || '(belum diisi — jangan klaim apapun)'}
Promo ongkir: ${promoOngkir}

ALUR KONSULTASI
1. SAMBUT hangat (sambung ke iklan), jangan langsung jualan
2. GALI keluhan — tanya SATU per SATU: ${pertanyaan}
3. DENGARKAN & tunjukkan ngerti ("oh berarti...")
4. EDUKASI ringan — kenapa keluhannya begitu
5. REKOMENDASI ${namaProduk} dengan alasan SPESIFIK ke keluhan
6. Baru kalau customer mantap → bantu order

GAYA NGOBROL
- Panggil "Kak"; kalimat PENDEK (1–2 kalimat/balasan)
- Hangat, sabar, peduli; emoji secukupnya 😊🙏, jangan lebay
- JANGAN paragraf panjang/kaku/formal/robot
- Tanya SATU hal per balasan
- ⚠️ KERAS: DILARANG TOTAL semua markdown — JANGAN *bold*, JANGAN **bold**, JANGAN _italic_, JANGAN ---, JANGAN > quote. Ini WhatsApp, bukan dokumen.
- Angka & total tulis POLOS tanpa tanda apapun: "TOTAL Rp 142.500" BUKAN "**TOTAL Rp 142.500**"

KUNCI KONTEKS PRODUK
- Produk sudah ditentukan dari iklan: ${namaProduk}. KUNCI.
- JANGAN ganti produk kecuali customer minta sendiri.
- Angka/contoh dari percakapan lain JANGAN kebawa.

ATURAN HARGA, ONGKIR & COD
- Harga/dosis/klaim HANYA dari DATA PRODUK. JANGAN ngarang.
- Semua angka diambil dari SISTEM, bukan dihitung dari ingatan.
- Sebelum kasih TOTAL → WAJIB konfirmasi WILAYAH dulu.
- ⚠️ KRITIS: Begitu wilayah SUDAH dipastikan (customer konfirmasi "iya", "bener", "iya kak", dll) → LANGSUNG tulis [CEK_ONGKIR:wilayah] di akhir pesan yang SAMA. JANGAN bilang "bentar ya" dulu lalu tunggu pesan berikutnya. Sistem akan langsung hitung dan replace marker dengan total harga otomatis.
- Sebelum [CEK_ONGKIR] → WAJIB pastikan wilayah sudah spesifik sampai provinsi atau kota/kab yang tidak mungkin salah.
- Wilayah parsial (nama desa/kecamatan kecil yang unik) → tebak & konfirmasi provinsinya: "Pringsewu, Lampung ya kak?"
- Wilayah ambigu → nama yang sama ada di banyak provinsi di Indonesia. Kamu sebagai AI tahu mana yang ambigu — kalau ragu, WAJIB tanya, jangan tebak.
  Prinsip: kalau nama itu bisa jadi kota/kab di lebih dari satu provinsi, TANYA dulu.
  Contoh respons: "Ambarawa-nya di Jateng atau Lampung ya kak? 😊" / "Batu yang di Malang atau yang lain kak?"
  JANGAN tulis [CEK_ONGKIR:...] sebelum provinsi dipastikan oleh customer.
- Wilayah tak konsisten → konfirmasi halus, jangan asal proses.
- Kurir dipilih SISTEM berdasarkan grade + ongkir daerah itu.
- Fee COD 5% ke customer, dibulatkan ke terdekat.
- Promo ongkir diterapkan SISTEM (berlaku COD & transfer).

FORMAT TAMPIL HARGA (pakai persis ini saat tampilkan total)
${namaProduk} ${harga} 😊

💳 Transfer
${namaProduk} ${harga} + ongkir ~~{ongkir_asli}~~ {ongkir_promo} = TOTAL

📦 COD
${namaProduk} ${harga} + ongkir ~~{ongkir_asli}~~ {ongkir_promo} + admin {fee} = TOTAL

Via {ekspedisi} ya kak 🚗
Kakak enaknya COD atau transfer? 🙏

ALUR CATAT ORDER
Urutan WAJIB diikuti:
1. Dapat wilayah → [CEK_ONGKIR] → sistem tampilkan total TF & COD otomatis → tanya "Kakak enaknya COD atau transfer? 🙏"
2. Customer pilih TF/COD → BARU minta data yang BELUM ADA saja
3. CEK dulu data dari form (nama/HP/alamat). Yang sudah ada → JANGAN ditanya ulang, cukup konfirmasi.
4. Yang kurang: (1) nama (2) no HP (3) alamat lengkap (jalan/gang, no rumah, RT/RW, kelurahan, kecamatan, patokan).
5. Alamat kurang → minta yang kurang aja, jangan ulang dari nol.
6. Ada jalan/gang → boleh proaktif tawarkan patokan dari maps.
7. Tutup dengan KONFIRMASI ORDER (rincian+total), minta "oke".
8. Setelah customer konfirmasi → tulis [ORDER_CONFIRMED] di akhir balasan.
JANGAN minta data diri SEBELUM tunjukkan total ongkir dan tanya pilihan bayar.

REM ETIS
- JANGAN klaim medis berlebihan ("pasti sembuh").
- Keluhan serius/di luar produk → sarankan periksa, jangan paksa.

ESKALASI KE MANUSIA
Balas: "bentar ya kak, aku sambungin tim 🙏" lalu STOP (tulis [ESCALATE]), kalau:
- Customer kesel/emosi negatif
- Komplain berat / di luar alur normal
- Pertanyaan di luar knowledge yang tidak yakin
- Hal sensitif (refund, sengketa)

TUJUAN AKHIR
Customer merasa DIDENGAR & terbantu. Kalau cocok → order tercatat.
Customer puas balik lagi & rekomendasiin > maksa satu transaksi.`;
}

function formatPromoOngkir(promo) {
  if (!promo || promo.tipe === 'none') return 'tidak ada';
  if (promo.tipe === 'gratis_penuh') return 'GRATIS ongkir';
  if (promo.tipe === 'potong') return `Potongan ongkir Rp ${promo.nilai?.toLocaleString('id-ID')}`;
  if (promo.tipe === 'gratis_sd') return `Gratis ongkir s/d Rp ${promo.nilai?.toLocaleString('id-ID')}`;
  return 'ada promo';
}

/* ── GET HISTORY & CONTEXT INJECTION ─────────────────────── */
async function getContextMessages(conversationId) {
  // Ambil 10 pesan TERAKHIR saja — ringkasan berjalan yang pegang konteks panjang
  const msgs = await sbGet('conv_messages',
    `?conversation_id=eq.${conversationId}&order=created_at.desc&limit=10`
  );
  msgs.reverse();

  const mapped = msgs.map(m => ({
    role: m.role === 'customer' ? 'user' : 'assistant',
    content: m.isi || '',
  })).filter(m => m.content.trim());

  // Gabungkan consecutive same role (Claude API wajib alternating)
  const result = [];
  for (const msg of mapped) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n' + msg.content;
    } else {
      result.push({ ...msg });
    }
  }

  // Harus mulai dari 'user'
  if (result.length && result[0].role === 'assistant') result.shift();

  return result;
}

/* ── UPDATE RINGKASAN BERJALAN (non-blocking) ─────────────── */
async function updateRingkasan(conversationId) {
  try {
    const msgs = await sbGet('conv_messages',
      `?conversation_id=eq.${conversationId}&order=created_at.asc`
    );
    if (msgs.length < 6) return; // belum cukup untuk diringkas

    const transcript = msgs.map(m =>
      `${m.role === 'customer' ? 'Customer' : 'AI'}: ${m.isi}`
    ).join('\n');

    const ringkasan = await callClaude(
      'Buat ringkasan singkat percakapan CS ini dalam 3-5 kalimat bahasa Indonesia. Fokus pada: keluhan customer, produk yang dibahas, tahap percakapan (konsultasi/tertarik/mau beli/sudah order), dan data yang sudah terkumpul (nama/HP/alamat). Singkat dan padat.',
      [{ role: 'user', content: transcript }]
    );

    if (ringkasan) {
      await sbPatch('conversations', `?id=eq.${conversationId}`, { ringkasan });
    }
  } catch (e) {
    console.error('updateRingkasan error:', e.message);
  }
}

async function saveMessage(conversationId, role, isi) {
  return sbPost('conv_messages', { conversation_id: conversationId, role, isi });
}

/* ── CALL CLAUDE ──────────────────────────────────────────── */
async function callClaude(systemPrompt, messages) {
  const key = ANTHROPIC_KEY;
  if (!key) throw new Error('ANTHROPIC_KEY belum diset');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  return data.content?.[0]?.text || '';
}

/* ── PEMBULATAN ke kelipatan terdekat ────────────────────── */
function bulatkan(nilai, kelipatan = 500) {
  const bawah = Math.floor(nilai / kelipatan) * kelipatan;
  const atas  = bawah + kelipatan;
  return (nilai - bawah) <= (atas - nilai) ? bawah : atas;
}

/* ── MENGANTAR PUBLIC API (tanpa API key) ────────────────── */
const MENGANTAR_ORIGIN_ID = '5fc63315f8f44b34aa4c44ca'; // Kranggan, Galur, Kulon Progo
const MENGANTAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.mengantar.com/',
  'Origin': 'https://www.mengantar.com',
};

async function mengantarFetch(path) {
  const res = await fetch(`https://app.mengantar.com/api/${path}`, { headers: MENGANTAR_HEADERS });
  const json = await res.json();
  return json;
}

/* ── HITUNG ONGKIR: step 4–8 blueprint §4 ───────────────── */
async function hitungOngkir(wilayah, product) {
  try {
    // Step 3a: Cari destination_id dari nama wilayah
    const searchJson = await mengantarFetch(`address/autofill?keyword=${encodeURIComponent(wilayah)}`);
    const areas = searchJson.data || searchJson;
    if (!Array.isArray(areas) || !areas.length) return null;

    const areaId   = areas[0]._id || areas[0].id;
    const areaNama = areas[0].subdistrict || areas[0].name || wilayah;
    const weight = product?.berat_gram || 1; // Mengantar public pakai satuan kg

    // Step 3b: Ambil estimasi semua kurir
    const ratesJson = await mengantarFetch(
      `order/allEstimatePublic?origin_id=${MENGANTAR_ORIGIN_ID}&destination_id=${areaId}&weight=${weight}`
    );
    if (!ratesJson.success) return null;
    let rates = ratesJson.data || [];
    if (!rates.length) return null;

    // Step 4: Filter whitelist dari tabel courier_whitelist
    // (jika tabel kosong, pakai semua kurir)
    const whitelist = await sbGet('courier_whitelist',
      `?user_id=eq.${product?.user_id || ''}&aktif=eq.true`
    ).catch(() => []);

    // Normalize field names dari Mengantar public API
    rates = rates.map(r => ({
      courier_name: r.courier_name || r.courierName || r.name || r.ekspedisi || '',
      price: r.price || r.ongkir || r.cost || r.total || 0,
    })).filter(r => r.courier_name && r.price > 0);

    if (whitelist.length) {
      const allowed = new Set(whitelist.map(w => w.nama.toLowerCase()));
      const filtered = rates.filter(r => allowed.has(r.courier_name.toLowerCase()));
      if (filtered.length) rates = filtered;
    }

    // Step 5: Pilih termurah dari yang lolos filter
    rates.sort((a, b) => a.price - b.price);

    if (!rates.length) return null;

    const best       = rates[0];
    const ekspedisi  = best.courier_name;
    const ongkirAsli = best.price;

    // Step 6: Terapkan promo ongkir produk
    const promo = product?.promo_ongkir;
    let ongkirPromo = ongkirAsli;
    if (promo?.tipe === 'gratis_penuh')   ongkirPromo = 0;
    else if (promo?.tipe === 'potong')    ongkirPromo = Math.max(0, ongkirAsli - (promo.nilai || 0));
    else if (promo?.tipe === 'gratis_sd') ongkirPromo = Math.max(0, ongkirAsli - (promo.nilai || 0));

    const harga = product?.harga || 0;

    // Step 7: Hitung total
    const totalTransfer = harga + ongkirPromo;
    const feeCOD        = Math.ceil((harga + ongkirPromo) * 0.05);
    const totalCOD      = harga + ongkirPromo + feeCOD;

    // Step 8: Bulatkan
    const totalTransferBulat = bulatkan(totalTransfer);
    const totalCODBulat      = bulatkan(totalCOD);
    const feeCODBulat        = totalCODBulat - harga - ongkirPromo;

    return {
      ekspedisi,
      ongkirAsli,
      ongkirPromo,
      totalTransfer: totalTransferBulat,
      totalCOD: totalCODBulat,
      feeCOD: feeCODBulat,
      harga,
    };
  } catch (e) {
    console.error('Hitung ongkir error:', e.message);
    return null;
  }
}

/* ── KIRIM WA via Baileys server ──────────────────────────── */
async function sendWA(sessionId, waNumber, message, isOutbound = false) {
  if (!BAILEYS_URL) throw new Error('BAILEYS_URL belum diset');
  const res = await fetch(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      session_id: sessionId,
      wa_number: waNumber,
      message,
      is_outbound: isOutbound,
    }),
  });
  if (!res.ok) throw new Error(`Baileys send error: ${await res.text()}`);
  return res.json();
}

/* ── UPDATE CONVERSATION STATE ───────────────────────────── */
async function updateConvState(convId, stateUpdate) {
  // Ambil state sekarang dulu
  const existing = await sbGet('conversations', `?id=eq.${convId}&limit=1`);
  if (!existing.length) return;
  const currentState = existing[0].state || {};
  await sbPatch('conversations', `?id=eq.${convId}`, {
    state: { ...currentState, ...stateUpdate },
    last_msg_at: new Date().toISOString(),
  });
}

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Webhook Baileys aktif ✅');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body || {};

    // Verifikasi secret
    console.log(`Secret check: body="${body.secret}" env="${WEBHOOK_SECRET}"`);
    if (body.secret !== WEBHOOK_SECRET) {
      console.warn('Secret tidak valid — tidak cocok');
      return res.status(200).json({ ok: false, reason: 'invalid_secret' });
    }

    const reply_jid   = body.reply_jid || normalizeWA(body.wa_number || ''); // untuk kirim WA (LID atau normal)
    const wa_number   = normalizeWA(body.wa_number || '');                  // nomor asli untuk disimpan ke customer
    const pushName    = body.push_name || wa_number;
    const message     = String(body.message || '').trim();
    const messageType = body.message_type || 'text';
    const mediaUrl    = body.media_url || null;
    const referral    = body.referral || null; // dari CTWA

    console.log(`wa_number="${wa_number}" reply_jid="${reply_jid}" message="${message}" type="${messageType}"`);
    if (!reply_jid || (!message && messageType === 'text')) {
      console.warn('wa_number atau message kosong');
      return res.status(200).json({ ok: false, reason: 'empty_message' });
    }

    console.log(`Pesan dari ${pushName} (${wa_number}): ${message.slice(0, 80)}`);

    // ── Ambil userId dari session_id (= user UUID dari dashboard) ──
    const userId = body.session_id;
    if (!userId) {
      console.warn('session_id kosong');
      return res.status(200).json({ ok: false, reason: 'no_session_id' });
    }

    // ── Routing: cari produk dari referral/isi chat ────────────
    const { product, sumber } = await resolveProduct(userId, referral, message);
    console.log(`Produk: ${product?.nama || 'tidak diketahui'} (${sumber})`);

    // ── Find/create customer & conversation ───────────────────
    const customer = await findOrCreateCustomer(userId, wa_number, pushName);
    const conversation = await findOrCreateConversation(userId, customer.id, sumber, product?.id);

    // Update produk ke conversation jika baru ketemu
    if (product?.id && !conversation.product_id) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, { product_id: product.id });
    }

    // ── Simpan pesan masuk ─────────────────────────────────────
    await saveMessage(conversation.id, 'customer', message || `[${messageType}]`);

    // ── Cek apakah sudah eskalasi → AI diam, CS manusia yang balas ──
    if (conversation.status === 'eskalasi') {
      console.log(`Conversation ${conversation.id} status eskalasi — AI skip, tunggu CS manusia`);
      return res.status(200).json({ ok: true, skipped: 'eskalasi' });
    }

    // ── Build system prompt + inject ringkasan ────────────────
    let systemPrompt = buildTemplatePrompt(product, customer, conversation, sumber);
    if (conversation.ringkasan) {
      systemPrompt += `\n\nKONTEKS PERCAKAPAN SEBELUMNYA (ringkasan otomatis)\n${conversation.ringkasan}\n\nLanjutkan percakapan dari konteks ini. Jangan ulangi salam dari awal.`;
    }

    // ── Ambil 10 pesan terakhir & panggil Claude ──────────────
    const history = await getContextMessages(conversation.id);
    let rawReply  = await callClaude(systemPrompt, history);
    if (!rawReply) return res.status(200).json({ ok: true, skipped: 'no_reply' });

    // ── Deteksi marker khusus ──────────────────────────────────
    const isEscalated      = rawReply.includes('[ESCALATE]');
    const orderConfirmed   = rawReply.includes('[ORDER_CONFIRMED]');
    const cekOngkirMatch   = rawReply.match(/\[CEK_ONGKIR:([^\]]+)\]/);

    // ── Handle cek ongkir ──────────────────────────────────────
    if (cekOngkirMatch) {
      const wilayah = cekOngkirMatch[1].trim();
      await updateConvState(conversation.id, { wilayah });
      const hasil = await hitungOngkir(wilayah, product);
      if (hasil) {
        // Simpan hasil ke conversation state
        await updateConvState(conversation.id, { ongkir: hasil });

        const fmt = (n) => `Rp ${n.toLocaleString('id-ID')}`;
        const ongkirDisplay = hasil.ongkirAsli !== hasil.ongkirPromo
          ? `~~${fmt(hasil.ongkirAsli)}~~ ${fmt(hasil.ongkirPromo)}`
          : fmt(hasil.ongkirPromo);

        // Inject angka final — Claude tinggal tampilkan, TIDAK perlu hitung lagi
        const injeksi = `[SISTEM] Data ongkir ke ${wilayah} sudah dihitung. Gunakan PERSIS angka ini:
Produk: ${product?.nama || 'produk'} ${fmt(hasil.harga)}

💳 Transfer
${product?.nama || 'produk'} ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(hasil.totalTransfer)}

📦 COD
${product?.nama || 'produk'} ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} + admin ${fmt(hasil.feeCOD)} = TOTAL ${fmt(hasil.totalCOD)}

Via ${hasil.ekspedisi} ya kak 🚗
Kakak enaknya COD atau transfer? 🙏

PENTING: Jangan ubah angka di atas. Tampilkan persis seperti itu ke customer.`;

        const historyWithOngkir = [
          ...history,
          { role: 'assistant', content: rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '').trim() },
          { role: 'user', content: injeksi },
        ];
        rawReply = await callClaude(systemPrompt, historyWithOngkir);
      } else {
        // Ongkir gagal — minta customer konfirmasi wilayah lagi
        rawReply = rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '').trim() ||
          'Maaf kak, aku belum bisa cek ongkir ke wilayah itu. Bisa sebutkan nama kota/kabupatennya lengkap? 🙏';
      }
    }

    // ── Bersihkan marker dari reply final ─────────────────────
    let reply = rawReply
      .replace('[ESCALATE]', '')
      .replace('[ORDER_CONFIRMED]', '')
      .replace(/\[CEK_ONGKIR:[^\]]+\]/, '')
      .trim();

    if (!reply) return res.status(200).json({ ok: true, skipped: 'empty_reply' });

    console.log(`Reply untuk ${wa_number}${isEscalated?' [ESKALASI]':''}${orderConfirmed?' [ORDER]':''}: ${reply.slice(0, 80)}`);

    // ── Update conversation status jika eskalasi ──────────────
    if (isEscalated) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, {
        status: 'eskalasi',
        prioritas: 'high',
      });
    }

    // ── Update state jika order confirmed ─────────────────────
    if (orderConfirmed) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, { status: 'selesai' });
    }

    // ── Simpan & kirim balasan ─────────────────────────────────
    await saveMessage(conversation.id, 'ai', reply);
    await sendWA(userId, reply_jid, reply);

    res.status(200).json({ ok: true });

    // ── Update ringkasan berjalan (non-blocking, setiap 5 pesan) ──
    sbGet('conv_messages', `?conversation_id=eq.${conversation.id}&select=id`)
      .then(all => { if (all.length % 5 === 0) updateRingkasan(conversation.id); })
      .catch(() => {});

  } catch (err) {
    console.error('Webhook error:', err.message, err.stack);
    if (!res.headersSent) res.status(200).json({ ok: true, error: err.message });
  }
};
