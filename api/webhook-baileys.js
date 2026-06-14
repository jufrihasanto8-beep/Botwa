/**
 * Vercel Serverless — Webhook dari Baileys
 * Terima pesan → routing CTWA/form/inbound → Claude template prompt → balas via Baileys
 * Blueprint §2 (routing), §3 (template prompt), §4 (pricing engine akan ditambah)
 */

const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY      = process.env.ANTHROPIC_KEY;
const BAILEYS_URL        = process.env.BAILEYS_URL;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const MENGANTAR_KEY      = process.env.MENGANTAR_KEY;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const WA_GROUP_JID       = process.env.WA_GROUP_JID; // JID grup WA tujuan recap order

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
  // Ambil conversation terakhir customer ini (apapun statusnya)
  const existing = await sbGet('conversations',
    `?user_id=eq.${userId}&customer_id=eq.${customerId}&order=created_at.desc&limit=1`
  );

  if (existing.length) {
    const conv = existing[0];
    // Kalau sudah di-closing manual → re-open
    if (conv.status === 'selesai') {
      console.log(`Re-open conversation ${conv.id}`);
      const updated = await sbPatch('conversations', `?id=eq.${conv.id}`, {
        status: 'baru',
        last_msg_at: new Date().toISOString(),
        ringkasan: null, // reset ringkasan agar konteks lama tidak kebawa
        state: { tahap: 'sambut', produk_locked: !!conv.state?.produk_locked },
      });
      return updated[0] || conv;
    }
    return conv;
  }

  // Customer baru sama sekali → buat conversation baru
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
function buildTemplatePrompt(product, customer, conversation, sumber, userRekening = null) {
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

  const rekeningInfo = userRekening
    ? userRekening
    : '(belum diisi — jangan kasih info rekening, bilang "nanti kami kirimkan info rekeningnya ya kak 🙏")';

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
Rekening TF : ${rekeningInfo}

ALUR KONSULTASI
1. SAMBUT hangat (sambung ke iklan), jangan langsung jualan
2. GALI keluhan — tanya SATU per SATU: ${pertanyaan}
3. DENGARKAN & tunjukkan ngerti ("oh berarti...")
4. EDUKASI ringan — kenapa keluhannya begitu
5. REKOMENDASI ${namaProduk} dengan alasan SPESIFIK ke keluhan
6. Baru kalau customer mantap → bantu order

WAJIB — simpan data penting customer dengan marker berikut (tulis SEKALI saja saat pertama kali tahu):
- Saat tahu keluhan: [KELUHAN:keluhan singkat] — contoh: [KELUHAN:sinusitis kronis]
- Saat customer konfirmasi alamat lengkap: [ALAMAT_OK:alamat lengkap] — contoh: [ALAMAT_OK:Jl. Dahlia RT 4 RW 3, Kelurahan Mariso]
Jangan tulis ulang marker yang sama di pesan berikutnya.

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
- ⚠️ WAJIB: Setiap kali kamu menyebut/mengkonfirmasi wilayah ke customer (contoh: "Oke kak, Mariso Makassar ya!"), SELALU tulis [WILAYAH_OK:nama wilayah] di akhir pesan. Sistem pakai ini untuk hitung ongkir otomatis. Tanpa marker ini, ongkir tidak bisa dihitung.
  Contoh: "Oke kak, Makassar, Sulawesi Selatan ya! 😊 [WILAYAH_OK:Makassar, Sulawesi Selatan]"
  Contoh: "Siap kak, Ambarawa, Jawa Tengah ya 😊 [WILAYAH_OK:Ambarawa, Jawa Tengah]"
- ⛔ DILARANG KERAS: Jangan pernah bilang "sebentar ya aku cek ongkir", "aku cek dulu", "tunggu aku cek", atau kalimat apapun yang minta customer menunggu. Sistem hitung ongkir OTOMATIS saat kamu tulis [WILAYAH_OK:]. Cukup tulis marker itu dan ongkir langsung tersedia — tidak perlu bilang "sebentar".
- Sebelum [WILAYAH_OK] → WAJIB pastikan wilayah sudah spesifik sampai provinsi atau kota/kab yang tidak mungkin salah.
- Wilayah parsial (nama desa/kecamatan kecil yang unik) → tebak & konfirmasi provinsinya: "Pringsewu, Lampung ya kak?"
- Wilayah ambigu → nama yang sama ada di banyak provinsi di Indonesia. Kamu sebagai AI tahu mana yang ambigu — kalau ragu, WAJIB tanya, jangan tebak.
  Prinsip: kalau nama itu bisa jadi kota/kab di lebih dari satu provinsi, TANYA dulu.
  Contoh respons: "Ambarawa-nya di Jateng atau Lampung ya kak? 😊" / "Batu yang di Malang atau yang lain kak?"
  JANGAN tulis [CEK_ONGKIR:...] sebelum provinsi dipastikan oleh customer.
- Wilayah tak konsisten → konfirmasi halus, jangan asal proses.
- Kurir dipilih SISTEM berdasarkan grade + ongkir daerah itu.
- Fee COD 5% ke customer, dibulatkan ke terdekat.
- JANGAN sebutkan dari mana barang dikirim / lokasi gudang / asal pengiriman. Fokus ke estimasi tiba dan total biaya saja.
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
8. Setelah customer konfirmasi dengan kata seperti "oke", "iya jadi", "deal", "lanjut", "fix", "setuju" → BARU tulis di akhir balasan:
   [ORDER_CONFIRMED]
   [ORDER_DATA:alamat="ALAMAT LENGKAP DARI CUSTOMER" keluhan="KELUHAN UTAMA CUSTOMER" metode="COD atau Transfer" qty=1]
   Isi ORDER_DATA dengan data AKTUAL yang sudah dikumpulkan dari customer. Jangan dikosongkan.
⛔ DILARANG tulis [ORDER_CONFIRMED] sebelum customer eksplisit konfirmasi order. Kirim rekening / info transfer BUKAN berarti order confirmed. Tunggu customer balas "oke" atau sejenisnya dulu.
JANGAN minta data diri SEBELUM tunjukkan total ongkir dan tanya pilihan bayar.

INFO PEMBAYARAN TRANSFER
- Kalau customer pilih Transfer → LANGSUNG kasih info rekening dari DATA PRODUK di atas.
- JANGAN bilang "tim kami akan hubungi" atau "nanti kami konfirmasi" — rekening sudah ada, kasih langsung.
- Format: "Silakan transfer ke: [rekening]. Setelah transfer, kirim bukti TF ya kak 🙏"
- Kalau rekening belum diisi di data produk → baru bilang "Nanti kami kirimkan info rekeningnya ya kak 🙏"

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
  // Ambil 30 pesan TERAKHIR — cukup untuk konteks panjang tanpa terlalu boros token
  const msgs = await sbGet('conv_messages',
    `?conversation_id=eq.${conversationId}&order=created_at.desc&limit=30`
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
      [{ role: 'user', content: transcript }],
      'claude-haiku-4-5-20251001'
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
async function callClaude(systemPrompt, messages, model = 'claude-sonnet-4-6', apiKey = null) {
  const key = apiKey || ANTHROPIC_KEY;
  if (!key) throw new Error('ANTHROPIC_KEY belum diset');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  return data.content?.[0]?.text || '';
}

/* ── TRANSCRIBE VOICE NOTE via Groq Whisper ──────────────────── */
async function transcribeAudio(base64Audio) {
  if (!GROQ_API_KEY) return null;
  try {
    const buffer = Buffer.from(base64Audio.replace('data:audio/ogg;base64,', ''), 'base64');
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'audio.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'id');
    formData.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });
    const data = await res.json();
    return data.text || null;
  } catch(e) {
    console.error('Groq transcribe error:', e.message);
    return null;
  }
}

/* ── DETEKSI KONFIRMASI WILAYAH (webhook-level, tidak bergantung Claude) ── */

// Kata-kata yang bukan nama wilayah
const BUKAN_WILAYAH = /^(via|pakai|dengan|pake|lewat|dari|ke|di|ya|oke|siap|baik|nanti|kalau|jika|untuk|sudah|belum|bisa|tidak|iya|tidak)\s/i;

// Ekstrak wilayah yang AI sedang konfirmasikan — pertanyaan ("Sumba NTT ya kak?")
function extractProposedWilayah(aiMsg) {
  const lines = aiMsg.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/(?:jadi\s+|ke\s+)?([A-Za-z][A-Za-z\s,]{2,50}?)\s+ya\s+kak[?😊🙏\s]/i);
    if (m) {
      const candidate = m[1].trim().replace(/,\s*$/, '');
      if (candidate.length >= 3 && !BUKAN_WILAYAH.test(candidate)) return candidate;
    }
  }
  return null;
}

// Ekstrak wilayah dari pernyataan konfirmasi AI ("Oke kak, Ambarawa Jawa Tengah ya! 😊")
function extractConfirmedWilayah(aiMsg) {
  const lines = aiMsg.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    // "Oke kak, Ambarawa Jawa Tengah ya!" / "Siap kak, pengirimannya ke Sumba NTT ya!"
    const m = line.match(/(?:oke|siap|dicatat|baik|noted)\s+kak[,!]?\s+(?:pengirimannya\s+ke\s+|jadi\s+ke\s+)?([A-Za-z][A-Za-z\s,]{2,50}?)\s+ya[!😊🙏\s]/i);
    if (m) {
      const candidate = m[1].trim().replace(/[,!]+$/, '');
      if (candidate.length >= 3) return candidate;
    }
  }
  return null;
}

// Deteksi apakah pesan customer adalah konfirmasi singkat
function isConfirmation(msg) {
  const lower = msg.toLowerCase().trim().replace(/[.!]+$/, '');
  return /^(iya|ya|yakin|bener|betul|ok|oke|okey|yep|yup|iyah|bnar|benar|yes|confirm|bisa|boleh|lanjut)(\s+kak)?$/.test(lower);
}

/* ── PEMBULATAN ke kelipatan terdekat ────────────────────── */
function bulatkan(nilai, kelipatan = 500) {
  const bawah = Math.floor(nilai / kelipatan) * kelipatan;
  const atas  = bawah + kelipatan;
  return (nilai - bawah) <= (atas - nilai) ? bawah : atas;
}

/* ── MENGANTAR PUBLIC API (tanpa API key) ────────────────── */
const MENGANTAR_ORIGIN_ID = process.env.MENGANTAR_ORIGIN_ID || '5fc63315f8f44b34aa4c44c7'; // Kranggan, Galur, Kulon Progo
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

    // Response Mengantar adalah object { "JNE": {...}, "SAP": {...} }, bukan array
    const rawData = ratesJson.data || {};
    let rates = Object.entries(rawData)
      .filter(([name, info]) => {
        if (name.toLowerCase().includes('cargo')) return false;
        if (info.unsupported) return false;
        return (info.price || 0) > 0;
      })
      .map(([name, info]) => ({
        courier_name: name,
        price:        info.price, // tarif normal (sebelum diskon Mengantar)
      }));

    if (!rates.length) return null;

    // Step 4: Filter whitelist dari tabel courier_whitelist
    const whitelist = await sbGet('courier_whitelist',
      `?user_id=eq.${product?.user_id || ''}&aktif=eq.true`
    ).catch(() => []);

    console.log(`Whitelist (${whitelist.length}): ${whitelist.map(w => w.nama).join(', ')}`);
    console.log(`Rates sebelum filter: ${rates.map(r => `${r.courier_name}:${r.price}`).join(', ')}`);

    if (whitelist.length) {
      // Normalisasi: strip non-alphanumeric agar "J&T Express" cocok dengan "JT", "Lion Parcel" cocok dengan "lion", dll
      const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const filtered = rates.filter(r => {
        const rn = norm(r.courier_name);
        const match = whitelist.some(w => {
          const wn = norm(w.nama);
          return rn === wn || rn.startsWith(wn) || wn.startsWith(rn);
        });
        if (!match) console.log(`  [skip] ${r.courier_name} (${rn}) — tidak ada di whitelist`);
        return match;
      });
      if (filtered.length) rates = filtered;
    }

    console.log(`Rates setelah filter: ${rates.map(r => `${r.courier_name}:${r.price}`).join(', ')}`);

    // Step 5: Pilih termurah dari yang lolos filter
    rates.sort((a, b) => a.price - b.price);

    if (!rates.length) return null;

    const best       = rates[0];
    const ekspedisi  = best.courier_name;
    const ongkirAsli = best.price;

    // Step 6: Terapkan promo ongkir produk
    const promo = product?.promo_ongkir;
    console.log(`promo_ongkir product: ${JSON.stringify(promo)}`);
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

    // Hitung total untuk semua kurir (untuk ditampilkan ke Claude)
    const allRates = rates.map(r => {
      let rPromo = r.price;
      if (promo?.tipe === 'gratis_penuh')   rPromo = 0;
      else if (promo?.tipe === 'potong')    rPromo = Math.max(0, r.price - (promo.nilai || 0));
      else if (promo?.tipe === 'gratis_sd') rPromo = Math.max(0, r.price - (promo.nilai || 0));
      const rFeeCOD  = Math.ceil((harga + rPromo) * 0.05);
      const rTotalTF = bulatkan(harga + rPromo);
      const rTotalCOD= bulatkan(harga + rPromo + rFeeCOD);
      return { nama: r.courier_name, ongkir: r.price, ongkirPromo: rPromo, totalTF: rTotalTF, totalCOD: rTotalCOD };
    });

    return {
      ekspedisi,
      ongkirAsli,
      ongkirPromo,
      totalTransfer: totalTransferBulat,
      totalCOD: totalCODBulat,
      feeCOD: feeCODBulat,
      harga,
      allRates,
      area: {
        kelurahan: areas[0].subdistrict || '',
        kecamatan: areas[0].district   || '',
        kota:      areas[0].city       || areas[0].regency || '',
        provinsi:  areas[0].province   || '',
        kodePos:   areas[0].postal_code|| areas[0].zip     || '',
      },
    };
  } catch (e) {
    console.error('Hitung ongkir error:', e.message);
    return null;
  }
}

/* ── GOOGLE MAPS URL → KOORDINAT ─────────────────────────── */
function extractGoogleMapsCoords(text) {
  // Format: /@-7.9316498,110.2715208, (paling umum)
  const m1 = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
  // Format: ?q=-7.93,110.27
  const m2 = text.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  return null;
}

async function resolveGoogleMapsUrl(text) {
  // Cari URL Maps di teks (termasuk goo.gl shortlink)
  const urlMatch = text.match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl|maps\.google\.com|www\.google\.com\/maps)[^\s]*/);
  if (!urlMatch) return null;

  let url = urlMatch[0];

  // Kalau shortlink → resolve redirect untuk dapat URL panjang
  if (url.includes('goo.gl')) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      url = res.url; // URL final setelah redirect
      console.log(`Resolved goo.gl → ${url.slice(0, 100)}`);
    } catch(e) {
      console.error('Resolve goo.gl error:', e.message);
      return null;
    }
  }

  return extractGoogleMapsCoords(url);
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=id`,
      { headers: { 'User-Agent': 'BotWA-CS/1.0 (contact@adsy.id)' } }
    );
    const data = await res.json();
    const a = data.address || {};
    return {
      kelurahan: a.village || a.suburb || '',
      kecamatan: a.city_district || a.county || a.suburb || '',
      kota:      a.city || a.town || a.county || '',
      provinsi:  a.state || '',
    };
  } catch(e) {
    console.error('Nominatim error:', e.message);
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

/* ── BUILD INJEKSI ONGKIR untuk Claude ───────────────────── */
function buildOngkirInjeksi(hasil, product, konteks = '') {
  const fmt = (n) => `Rp ${n.toLocaleString('id-ID')}`;
  const ongkirDisplay = hasil.ongkirAsli !== hasil.ongkirPromo
    ? `~~${fmt(hasil.ongkirAsli)}~~ ${fmt(hasil.ongkirPromo)}`
    : fmt(hasil.ongkirPromo);

  // Tabel semua kurir yang tersedia
  const tabelKurir = (hasil.allRates || []).map(r => {
    const potongan = r.ongkir !== r.ongkirPromo ? ` (hemat ${fmt(r.ongkir - r.ongkirPromo)})` : '';
    return `- ${r.nama}: ongkir ${fmt(r.ongkir)}${potongan} → TF total ${fmt(r.totalTF)} | COD total ${fmt(r.totalCOD)}`;
  }).join('\n');

  return `[SISTEM] ${konteks}Ongkir sudah dihitung. Rekomendasi termurah: ${hasil.ekspedisi}.

Tampilkan PERSIS ini ke customer (jangan ubah angka):

${product?.nama || 'Produk'} ${fmt(hasil.harga)}

💳 Transfer
${product?.nama || 'Produk'} ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(hasil.totalTransfer)}

📦 COD
${product?.nama || 'Produk'} ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} + admin ${fmt(hasil.feeCOD)} = TOTAL ${fmt(hasil.totalCOD)}

Via ${hasil.ekspedisi} ya kak 🚗

SETELAH tampilkan harga di atas, tanya dengan santai: "Biasanya kakak lebih suka pakai kurir apa kak? Bisa aku cekkan juga 😊"

DATA SEMUA KURIR TERSEDIA (untuk jawab kalau customer tanya kurir lain — jangan sebut ke customer kecuali ditanya):
${tabelKurir}

Kalau customer tanya harga kurir lain (misal "kalau JNE berapa?"), jawab langsung dari data di atas. Jangan bilang "sistem pilih otomatis".`;
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

/* ── NOMOR URUT ORDER HARIAN ──────────────────────────────── */
async function getOrderNumber(userId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rows = await sbGet('conversations',
    `?user_id=eq.${userId}&status=eq.selesai&last_msg_at=gte.${today}T00:00:00Z&select=id`
  ).catch(() => []);
  return rows.length + 1; // +1 karena yang sekarang baru mau di-close
}

/* ── BUILD CLOSING RECAP MESSAGE ─────────────────────────── */
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

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

module.exports = async function handler(req, res) {
  // Vercel body size config
  if (req.method === 'POST' && !req.body) {
    return res.status(400).json({ ok: false, reason: 'no_body' });
  }
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
    let message       = String(body.message || '').trim();
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

    // ── Ambil rekening dari users table ───────────────────────
    const userRows = await sbGet('users', `?id=eq.${userId}&select=rekening,anthropic_key&limit=1`).catch(() => []);
    const userRekening   = userRows[0]?.rekening     || null;
    const userAnthropicKey = userRows[0]?.anthropic_key || ANTHROPIC_KEY; // fallback ke env

    // ── Routing: cari produk dari referral/isi chat ────────────
    const { product, sumber } = await resolveProduct(userId, referral, message);
    console.log(`Produk: ${product?.nama || 'tidak diketahui'} (${sumber})`);

    // CTWA → Haiku (volume tinggi, hemat biaya), Form/Inbound → Sonnet (lebih pintar)
    const chatModel = sumber === 'ctwa' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';

    // ── Find/create customer & conversation ───────────────────
    const customer = await findOrCreateCustomer(userId, wa_number, pushName);

    // Simpan reply_jid (bisa berupa LID format seperti 224029940129807@lid)
    // supaya CS dari dashboard bisa kirim ke JID yang benar
    if (reply_jid && reply_jid !== customer.reply_jid) {
      await sbPatch('customers', `?id=eq.${customer.id}`, { reply_jid }).catch(() => {});
      customer.reply_jid = reply_jid;
    }

    const conversation = await findOrCreateConversation(userId, customer.id, sumber, product?.id);

    // Update produk ke conversation jika baru ketemu
    if (product?.id && !conversation.product_id) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, { product_id: product.id });
    }

    // ── Transcribe voice note jika ada (Groq Whisper) ─────────
    if (messageType === 'audio' && mediaUrl) {
      const transkripsi = await transcribeAudio(mediaUrl);
      // Cek apakah hasil transkripsi bermakna (bukan noise)
      const isNoise = !transkripsi || transkripsi.trim().length < 3
        || /^[^a-zA-Z0-9\u00C0-\u024F\u4E00-\u9FFF\u0600-\u06FF]*$/.test(transkripsi)
        || (transkripsi.match(/(.)\1{2,}/g) || []).length > 3; // banyak huruf berulang = noise

      if (transkripsi && !isNoise) {
        console.log(`VN transcribed: ${transkripsi.slice(0, 80)}`);
        message = `[SISTEM: Customer kirim voice note, isi: "${transkripsi}". Balas sesuai isi voice note tersebut, jangan bilang tidak bisa dengar VN.]`;
      } else {
        console.log(`VN noise/gagal: ${transkripsi}`);
        message = `[SISTEM: Customer kirim voice note tapi isinya tidak jelas/noise. Minta customer kirim ulang VN-nya atau ketik pesannya.]`;
      }
    }

    // ── Analisa gambar jika ada (Claude Vision) ────────────────
    let imageAnalysis = null;
    if (messageType === 'image' && mediaUrl && mediaUrl.startsWith('data:image')) {
      try {
        const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: mediaUrl.replace('data:image/jpeg;base64,', '') },
                },
                {
                  type: 'text',
                  text: `Analisa gambar ini. Kemungkinan tipenya:
1. Bukti transfer/pembayaran bank
2. KTP (Kartu Tanda Penduduk) Indonesia
3. Lainnya

Rekening tujuan yang valid di sistem: ${userRekening || '(tidak ada)'}

Jawab dalam format JSON:
{
  "tipe": "bukti_tf" atau "ktp" atau "lainnya",
  "is_bukti_tf": true/false,
  "keterangan": "penjelasan singkat",
  "bank": "nama bank pengirim jika ada",
  "nominal": "nominal transfer jika terbaca",
  "tanggal": "tanggal jika ada",
  "no_rekening_tujuan": "nomor rekening tujuan yang tertera di struk",
  "rekening_cocok": true/false/null,
  "ktp": {
    "nama": "nama lengkap di KTP",
    "alamat": "isi kolom ALAMAT di KTP (jalan/gang/nomor/RT/RW)",
    "kelurahan": "nama kelurahan/desa",
    "kecamatan": "nama kecamatan",
    "kota": "nama kota atau kabupaten",
    "provinsi": "nama provinsi"
  }
}

Field "ktp" hanya diisi jika tipe = "ktp", selainnya null.
rekening_cocok: true jika cocok dengan rekening sistem, false jika tidak, null jika tidak terbaca.`,
                },
              ],
            }],
          }),
        });
        const visionData = await visionRes.json();
        const raw = visionData.content?.[0]?.text || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) imageAnalysis = JSON.parse(jsonMatch[0]);
        console.log('Image analysis:', JSON.stringify(imageAnalysis));
      } catch(e) {
        console.error('Vision error:', e.message);
      }
    }

    // ── Simpan pesan masuk ─────────────────────────────────────
    const msgText = message || (imageAnalysis
      ? imageAnalysis.tipe === 'ktp'
        ? `[KTP terkirim — ${imageAnalysis.ktp?.nama || 'nama tidak terbaca'}]`
        : `[Gambar terkirim — ${imageAnalysis.is_bukti_tf ? `Bukti TF ${imageAnalysis.bank || ''} ${imageAnalysis.nominal || ''}`.trim() : 'Bukan bukti transfer'}]`
      : `[${messageType}]`);
    await saveMessage(conversation.id, 'customer', msgText);

    // ── Cek apakah sudah eskalasi → AI diam, CS manusia yang balas ──
    if (conversation.status === 'eskalasi') {
      console.log(`Conversation ${conversation.id} status eskalasi — AI skip, tunggu CS manusia`);
      return res.status(200).json({ ok: true, skipped: 'eskalasi' });
    }

    // ── State conversation ────────────────────────────────────
    const convState = conversation.state || {};

    // ── Deteksi Google Maps URL di pesan ──────────────────────
    if (messageType === 'text' && !convState.ongkir && /goo\.gl|google\.com\/maps|maps\.app/i.test(message)) {
      const coords = await resolveGoogleMapsUrl(message);
      if (coords) {
        console.log(`Google Maps coords: ${coords.lat}, ${coords.lng}`);
        const geo = await reverseGeocode(coords.lat, coords.lng);
        if (geo?.kota || geo?.kecamatan) {
          const wilayahGeo = [geo.kecamatan, geo.kota, geo.provinsi].filter(Boolean).join(', ');
          const alamatGeo  = [geo.kelurahan, geo.kecamatan, geo.kota, geo.provinsi].filter(Boolean).join(', ');
          console.log(`Reverse geocode: ${wilayahGeo}`);
          const hasilGeo = await hitungOngkir(wilayahGeo, product).catch(() => null);
          if (hasilGeo) {
            await updateConvState(conversation.id, { wilayah: wilayahGeo, ongkir: hasilGeo, alamat: alamatGeo });
            convState.ongkir  = hasilGeo;
            convState.wilayah = wilayahGeo;
            message = `[SISTEM] Customer kirim lokasi Google Maps.\nHasil geocoding: ${alamatGeo}\n${buildOngkirInjeksi(hasilGeo, product, `Ongkir ke ${wilayahGeo} sudah dihitung. `)}\nKonfirmasi lokasi ke customer dan tampilkan total harga.`;
          } else {
            message = `[SISTEM] Customer kirim lokasi Google Maps → ${wilayahGeo}, tapi ongkir tidak ditemukan. Konfirmasi lokasi ke customer dan minta sebutkan nama kota/kabupatennya.`;
          }
        }
      }
    }

    // ── Refresh ongkir jika wilayah sudah diketahui (ambil promo terbaru) ──
    if (convState.wilayah && product) {
      try {
        const freshOngkir = await hitungOngkir(convState.wilayah, product);
        if (freshOngkir) {
          await updateConvState(conversation.id, { ongkir: freshOngkir });
          convState.ongkir = freshOngkir;
          console.log(`Ongkir di-refresh: ${convState.wilayah} → asli ${freshOngkir.ongkirAsli} promo ${freshOngkir.ongkirPromo}`);
        }
      } catch(e) {
        console.error('Refresh ongkir error:', e.message);
      }
    }

    // ── Build system prompt + inject ringkasan ────────────────
    let systemPrompt = buildTemplatePrompt(product, customer, conversation, sumber, userRekening);

    // Inject data customer yang sudah tersimpan di state
    const savedKeluhan = convState.keluhan;
    const savedAlamat  = convState.alamat;
    {
      let ctx = '\n\nDATA CUSTOMER TERSIMPAN (jangan tanya ulang):';
      ctx += `\n- No HP/WA: ${wa_number} (ini nomor WA mereka = nomor HP — JANGAN tanya nomor HP lagi)`;
      if (customer?.nama && customer.nama !== wa_number) ctx += `\n- Nama: ${customer.nama}`;
      if (savedKeluhan) ctx += `\n- Keluhan: ${savedKeluhan}`;
      if (savedAlamat)  ctx += `\n- Alamat: ${savedAlamat}`;
      systemPrompt += ctx;
    }

    if (conversation.ringkasan) {
      systemPrompt += `\n\nKONTEKS PERCAKAPAN SEBELUMNYA (ringkasan otomatis)\n${conversation.ringkasan}\n\nLanjutkan percakapan dari konteks ini. Jangan ulangi salam dari awal.`;
    }

    // ── Ambil 10 pesan terakhir ────────────────────────────────
    const history = await getContextMessages(conversation.id);

    // ── Inject hasil analisa gambar ke history ─────────────────
    if (imageAnalysis) {
      let notif;
      if (imageAnalysis.tipe === 'ktp') {
        const ktp = imageAnalysis.ktp || {};
        const wilayahKTP = [ktp.kecamatan, ktp.kota, ktp.provinsi].filter(Boolean).join(', ');

        // Update nama customer dari KTP
        if (ktp.nama && ktp.nama !== customer.nama) {
          await sbPatch('customers', `?id=eq.${customer.id}`, { nama: ktp.nama });
        }

        // Simpan alamat lengkap ke state
        const alamatLengkap = [ktp.alamat, ktp.kelurahan, ktp.kecamatan, ktp.kota, ktp.provinsi].filter(Boolean).join(', ');
        const stateKTP = {};
        if (alamatLengkap) stateKTP.alamat = alamatLengkap;

        // Hitung ongkir otomatis dari wilayah KTP
        let hasilKTP = null;
        if (wilayahKTP && !convState.ongkir) {
          hasilKTP = await hitungOngkir(wilayahKTP, product).catch(() => null);
          if (hasilKTP) {
            stateKTP.wilayah = wilayahKTP;
            stateKTP.ongkir  = hasilKTP;
            convState.ongkir  = hasilKTP;
            convState.wilayah = wilayahKTP;
          }
        }
        if (Object.keys(stateKTP).length) await updateConvState(conversation.id, stateKTP);

        const ongkirInfo = hasilKTP
          ? buildOngkirInjeksi(hasilKTP, product, 'Ongkir sudah dihitung dari alamat KTP. ')
          : 'Wilayah tidak ditemukan di sistem ongkir — minta customer konfirmasi kota/kabupatennya.';

        notif = `[SISTEM] Customer kirim foto KTP ✅
Nama     : ${ktp.nama || '?'}
Alamat   : ${ktp.alamat || '?'}
Kel/Desa : ${ktp.kelurahan || '?'}
Kecamatan: ${ktp.kecamatan || '?'}
Kota/Kab : ${ktp.kota || '?'}
Provinsi : ${ktp.provinsi || '?'}

${ongkirInfo}

Data sudah tersimpan. Konfirmasi ke customer bahwa data sudah tercatat, lanjutkan proses order (tanya metode bayar COD/Transfer jika belum).`;

      } else if (!imageAnalysis.is_bukti_tf) {
        notif = `[SISTEM] Customer kirim gambar tapi BUKAN bukti transfer. Keterangan: ${imageAnalysis.keterangan}. Minta dengan sopan kirim bukti transfer yang benar.`;
      } else if (imageAnalysis.rekening_cocok === false) {
        notif = `[SISTEM] Customer kirim bukti transfer TAPI nomor rekening tujuan TIDAK COCOK dengan rekening toko.
Rekening di struk: ${imageAnalysis.no_rekening_tujuan || '?'}
Rekening toko: ${userRekening || '?'}
Nominal: ${imageAnalysis.nominal || '?'} | Bank: ${imageAnalysis.bank || '?'}
Beritahu customer dengan sopan bahwa transfer sepertinya salah rekening, minta konfirmasi ulang atau kirim ulang ke rekening yang benar.`;
      } else {
        notif = `[SISTEM] Bukti transfer VALID dan rekening COCOK ✅
Bank: ${imageAnalysis.bank || '?'} | Nominal: ${imageAnalysis.nominal || '?'} | Tanggal: ${imageAnalysis.tanggal || '?'}
Konfirmasi penerimaan bukti TF, informasikan pesanan akan segera diproses dan estimasi pengiriman.`;
      }
      history.push({ role: 'user', content: notif });
    }

    // ── WEBHOOK-LEVEL: Auto-search wilayah via Mengantar (bantu Claude identifikasi lokasi) ──
    // Jika belum ada wilayah tersimpan, coba cari pesan customer di Mengantar autocomplete
    // Hasilnya diinject ke Claude agar Claude bisa langsung konfirmasi tanpa tanya balik
    // Hanya search Mengantar kalau AI sebelumnya lagi nanya soal lokasi/wilayah
    const lastAiMsg = history.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    const aiTanyaLokasi = /daerah|wilayah|provinsi|kota|kabupaten|kecamatan|alamat|kirim ke|tinggal di|dari mana|lokasi/i.test(lastAiMsg);
    if (!convState.wilayah && !convState.ongkir && aiTanyaLokasi && message.length >= 4 && message.length <= 80) {
      try {
        const searchJson = await mengantarFetch(`address/autofill?keyword=${encodeURIComponent(message)}`);
        const areas = searchJson.data || searchJson;
        if (Array.isArray(areas) && areas.length >= 1 && areas.length <= 6) {
          const candidates = areas.slice(0, 3).map(a => {
            return [a.subdistrict, a.district, a.city || a.regency, a.province]
              .filter(Boolean).join(', ');
          });
          const hint = `[SISTEM] Mengantar menemukan lokasi yang cocok untuk "${message}":\n`
            + candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')
            + `\nKalau ini cocok, langsung konfirmasi ke customer (jangan tanya provinsi lagi). Pilih yang paling relevan lalu tulis [WILAYAH_OK:nama wilayah].`;
          history.push({ role: 'user', content: hint });
          console.log(`Wilayah autocomplete untuk "${message}": ${candidates.join(' | ')}`);
        }
      } catch(e) { /* silent — tidak blokir flow utama */ }
    }

    // ── WEBHOOK-LEVEL: Auto-trigger ongkir jika customer konfirmasi wilayah ──
    // Cek apakah AI sebelumnya sedang tanya konfirmasi wilayah ("Sumba NTT ya kak?")
    // dan customer menjawab konfirmasi singkat ("iya", "yakin", "bener", dll)
    let autoOngkirResult = null;
    const proposedWilayah = convState.proposed_wilayah;
    if (proposedWilayah && isConfirmation(message) && !convState.ongkir) {
      console.log(`Auto-trigger ongkir untuk wilayah: ${proposedWilayah}`);
      const hasil = await hitungOngkir(proposedWilayah, product);
      if (hasil) {
        await updateConvState(conversation.id, {
          wilayah: proposedWilayah,
          proposed_wilayah: null,
          ongkir: hasil,
        });
        autoOngkirResult = { wilayah: proposedWilayah, hasil };
      }
    }

    let rawReply;

    if (autoOngkirResult) {
      // Inject hasil ongkir langsung ke Claude — skip nunggu marker
      const { wilayah, hasil } = autoOngkirResult;
      const injeksi = buildOngkirInjeksi(hasil, product, `Customer konfirmasi wilayah: ${wilayah}. `);

      const historyWithOngkir = [
        ...history,
        { role: 'user', content: injeksi },
      ];
      rawReply = await callClaude(systemPrompt, historyWithOngkir, chatModel, userAnthropicKey);
    } else {
      rawReply = await callClaude(systemPrompt, history, chatModel, userAnthropicKey);
    }

    if (!rawReply) return res.status(200).json({ ok: true, skipped: 'no_reply' });

    // ── Deteksi marker khusus ──────────────────────────────────
    const isEscalated      = rawReply.includes('[ESCALATE]');
    const orderConfirmed   = rawReply.includes('[ORDER_CONFIRMED]');
    const cekOngkirMatch   = rawReply.match(/\[CEK_ONGKIR:([^\]]+)\]/);
    const wilayahOkMatch   = rawReply.match(/\[WILAYAH_OK:([^\]]+)\]/);

    // Parse ORDER_DATA sebelum rawReply mungkin di-overwrite ongkir handler
    let orderDataParsed = {};
    const orderDataMatch = rawReply.match(/\[ORDER_DATA:([^\]]+)\]/);
    if (orderDataMatch) {
      try {
        const s = orderDataMatch[1];
        const alamatM  = s.match(/alamat="([^"]+)"/);
        const keluhanM = s.match(/keluhan="([^"]+)"/);
        const metodeM  = s.match(/metode="([^"]+)"/);
        const qtyM     = s.match(/qty=(\d+)/);
        orderDataParsed = {
          alamat:  alamatM?.[1]  || '',
          keluhan: keluhanM?.[1] || '',
          metode:  metodeM?.[1]  || 'COD',
          qty:     parseInt(qtyM?.[1] || '1'),
        };
        console.log('ORDER_DATA parsed:', JSON.stringify(orderDataParsed));
      } catch(e) { console.error('ORDER_DATA parse error:', e.message); }
    }

    // ── Handle [WILAYAH_OK:] → langsung hitung ongkir ────────
    if (wilayahOkMatch && !autoOngkirResult && !convState.ongkir) {
      const wilayah = wilayahOkMatch[1].trim();
      console.log(`[WILAYAH_OK] detected: ${wilayah}`);
      await updateConvState(conversation.id, { wilayah, proposed_wilayah: null });
      const hasil = await hitungOngkir(wilayah, product);
      if (hasil) {
        await updateConvState(conversation.id, { ongkir: hasil });
        const injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. Lanjutkan balasan di atas dan `);

        const histWithOngkir = [
          ...history,
          { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
          { role: 'user', content: injeksi },
        ];
        rawReply = await callClaude(systemPrompt, histWithOngkir, chatModel, userAnthropicKey);
      } else {
        console.warn(`hitungOngkir gagal untuk wilayah: ${wilayah}`);
        // Simpan sebagai proposed_wilayah untuk retry di pesan berikutnya
        await updateConvState(conversation.id, { proposed_wilayah: wilayah });
        rawReply = rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim();
      }
    }

    // ── Handle cek ongkir (dari marker Claude — fallback) ─────
    if (cekOngkirMatch && !autoOngkirResult && !wilayahOkMatch) {
      const wilayah = cekOngkirMatch[1].trim();
      await updateConvState(conversation.id, { wilayah });
      const hasil = await hitungOngkir(wilayah, product);
      if (hasil) {
        await updateConvState(conversation.id, { ongkir: hasil });
        const injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. `);

        const historyWithOngkir = [
          ...history,
          { role: 'assistant', content: rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '').trim() },
          { role: 'user', content: injeksi },
        ];
        rawReply = await callClaude(systemPrompt, historyWithOngkir, chatModel, userAnthropicKey);
      } else {
        rawReply = rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '').trim() ||
          'Maaf kak, aku belum bisa cek ongkir ke wilayah itu. Bisa sebutkan nama kota/kabupatennya lengkap? 🙏';
      }
    }

    // ── Jika Claude baru KONFIRMASI wilayah ("Oke kak, X ya!") → langsung hitung ongkir ──
    if (!autoOngkirResult && !cekOngkirMatch) {
      const confirmedWilayah = extractConfirmedWilayah(rawReply);
      if (confirmedWilayah && !convState.ongkir) {
        console.log(`Auto-trigger ongkir dari konfirmasi wilayah: ${confirmedWilayah}`);
        const hasil = await hitungOngkir(confirmedWilayah, product);
        if (hasil) {
          await updateConvState(conversation.id, { wilayah: confirmedWilayah, ongkir: hasil, proposed_wilayah: null });
          const injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${confirmedWilayah}. Lanjutkan balasan di atas dengan `);

          const histCombined = [
            ...history,
            { role: 'assistant', content: rawReply.trim() },
            { role: 'user', content: injeksi },
          ];
          rawReply = await callClaude(systemPrompt, histCombined, chatModel, userAnthropicKey);
        }
      }
    }

    // ── Simpan proposed_wilayah jika Claude baru tanya/sebut lokasi ──
    // Skip jika ongkir sudah ada (tidak perlu tanya wilayah lagi)
    if (!convState.ongkir) {
      let newProposed = extractProposedWilayah(rawReply);

      // Fallback: Claude bilang "cek ongkir ke X" / "ongkir ke X dulu" tanpa marker
      if (!newProposed) {
        const cekMatch = rawReply.match(/(?:cek ongkir ke|ongkir ke|kirim ke)\s+([A-Za-z][A-Za-z\s,]{2,40}?)(?:\s+dulu|\s+ya|\s*[😊🙏]|$)/i);
        if (cekMatch) {
          const candidate = cekMatch[1].trim().replace(/[,!.]+$/, '');
          if (candidate.length >= 3) newProposed = candidate;
        }
      }

      if (newProposed && newProposed !== convState.proposed_wilayah) {
        console.log(`Simpan proposed_wilayah: ${newProposed}`);
        await updateConvState(conversation.id, { proposed_wilayah: newProposed });
      }
    }

    // ── Simpan data penting ke state kalau baru terdeteksi ────
    const keluhanMatch = rawReply.match(/\[KELUHAN:([^\]]+)\]/);
    const alamatMatch  = rawReply.match(/\[ALAMAT_OK:([^\]]+)\]/);
    const stateUpdate  = {};
    if (keluhanMatch && !convState.keluhan) {
      stateUpdate.keluhan = keluhanMatch[1].trim();
      console.log(`Keluhan tersimpan: ${stateUpdate.keluhan}`);
    }
    if (alamatMatch && !convState.alamat) {
      stateUpdate.alamat = alamatMatch[1].trim();
      console.log(`Alamat tersimpan: ${stateUpdate.alamat}`);
    }
    if (Object.keys(stateUpdate).length) {
      await updateConvState(conversation.id, stateUpdate);
    }

    // ── Bersihkan marker dari reply final ─────────────────────
    let reply = rawReply
      .replace('[ESCALATE]', '')
      .replace('[ORDER_CONFIRMED]', '')
      .replace(/\[ORDER_DATA:[^\]]+\]/, '')
      .replace(/\[KELUHAN:[^\]]+\]/, '')
      .replace(/\[ALAMAT_OK:[^\]]+\]/, '')
      .replace(/\[CEK_ONGKIR:[^\]]+\]/, '')
      .replace(/\[WILAYAH_OK:[^\]]+\]/, '')
      .trim();

    // ── Update conversation status jika eskalasi ──────────────
    if (isEscalated) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, {
        status: 'eskalasi',
        prioritas: 'high',
      });
    }

    // ── Update state jika order confirmed → auto closing + kirim recap ke grup ──
    // (dijalankan SEBELUM cek reply kosong agar tidak terlewat meski Claude hanya tulis marker)
    if (orderConfirmed) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, { status: 'selesai' });
      // Tandai bahwa conversation ini punya order — dipakai resi webhook untuk filter
      await updateConvState(conversation.id, { order_placed: true });

      if (WA_GROUP_JID) {
        try {
          // Ambil state terbaru (ongkir + area sudah tersimpan di state)
          const convFull = await sbGet('conversations', `?id=eq.${conversation.id}&limit=1`);
          const latestState = convFull[0]?.state || {};
          const ongkirData  = latestState.ongkir || convState.ongkir;
          const csNama      = product?.persona_cs_nama || 'CS';
          const nomorUrut   = await getOrderNumber(userId);

          const closingMsg = buildClosingMessage({
            nomorUrut,
            customer,
            alamat:  orderDataParsed.alamat  || latestState.alamat  || '-',
            ongkir:  ongkirData,
            product,
            keluhan: orderDataParsed.keluhan || latestState.keluhan || '-',
            metode:  orderDataParsed.metode  || latestState.metode_bayar || 'COD',
            qty:     orderDataParsed.qty     || latestState.qty     || 1,
            csNama,
          });

          await sendWA(userId, WA_GROUP_JID, closingMsg, true);
          console.log(`Recap order #${nomorUrut} terkirim ke grup`);
        } catch(e) {
          console.error('Send recap ke grup error:', e.message);
        }
      }
    }

    if (!reply) return res.status(200).json({ ok: true, skipped: 'empty_reply' });

    console.log(`Reply untuk ${wa_number}${isEscalated?' [ESKALASI]':''}${orderConfirmed?' [ORDER]':''}: ${reply.slice(0, 80)}`);

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
