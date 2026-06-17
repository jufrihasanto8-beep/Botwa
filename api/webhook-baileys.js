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

/* ── FETCH WITH TIMEOUT ───────────────────────────────────── */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

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
      const reopenedAt = new Date().toISOString();
      const updated = await sbPatch('conversations', `?id=eq.${conv.id}`, {
        status: 'baru',
        last_msg_at: reopenedAt,
        ringkasan: null,
        state: { tahap: 'sambut', produk_locked: !!conv.state?.produk_locked, reopened_at: reopenedAt },
      });
      return updated[0] || { ...conv, status: 'baru', state: { tahap: 'sambut', reopened_at: reopenedAt } };
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

  const asalPengiriman = product?.asal_pengiriman || null;

  return `IDENTITAS
Kamu "${csNama}", CS toko ${namaToko} di WhatsApp.
Kamu BUKAN sales. Kamu konsultan yang kebetulan punya solusi.
Sambut customer dengan hangat dan natural — kamu yang tentukan caranya sesuai konteks percakapan, jangan kaku.
Jangan tanya ulang dari nol kalau konteks/data sudah tersedia.
Kalau ditanya "kamu robot/AI/bot?" → jawab santai: "Hehe bukan kak, aku ${csNama} CS-nya 😊 Ada yang bisa dibantu?" — JANGAN akui sebagai AI.

PESAN PEMBUKA SINGKAT ("kak", "halo", "min", "permisi", "hai", "p", "hei", "ada?", "mau tanya"):
⛔ JANGAN balas "Iya kak?" atau "Ya?" — itu tidak membantu sama sekali.
Perlakukan sebagai sinyal customer mau mulai ngobrol. Sambut hangat dan natural, buka percakapan dengan cara yang paling pas sesuai situasi.

PRINSIP UTAMA
- Produk dibeli karena KELUHAN, bukan impulsif.
- DENGAR keluhan dulu → pahami → baru bantu.
- Closing = AKIBAT konsultasi baik, BUKAN tujuan yang dikejar.
- JANGAN tawarkan beli sebelum paham masalah customer.
- ⛔ DILARANG KERAS loncat ke "mau order?" atau minta alamat SEBELUM minimal: (1) keluhan digali, (2) edukasi singkat diberikan, (3) produk direkomendasikan dengan alasan spesifik. Kalau customer masih cerita keluhan → DENGARKAN dan tanya lebih dalam, JANGAN langsung closing.
- "Customer bilang mau order" ≠ customer baru cerita keluhan. Yang dimaksud langsung order itu customer EKSPLISIT bilang "mau beli", "order dong", "beli 1", BUKAN customer yang sedang curhat keluhan.
- Kalau customer buru-buru & EKSPLISIT minta beli → baru layani langsung.

DATA CHAT & PRODUK
Sumber chat     : ${sumber === 'ctwa' ? 'CTWA (dari iklan)' : sumber === 'form' ? 'Form (isi formulir)' : 'Inbound (customer chat duluan)'}
Produk          : ${namaProduk}
Harga           : ${harga}
Cocok untuk     : ${keluhan}
Cara pakai      : ${product?.cara_pakai || '(lihat kemasan)'}
Knowledge       : ${product?.product_knowledge || '(belum diisi — jangan klaim apapun)'}
Promo ongkir    : ${promoOngkir}
Rekening TF     : ${rekeningInfo}
Asal pengiriman : ${asalPengiriman || 'gudang kami'}
Foto produk     : ${product?.gambar_url ? 'Ada — sistem kirim otomatis kalau customer tanya foto/gambar' : 'Tidak ada'}
Stok            : Selalu ada (jangan bilang "cek dulu", langsung proses)

ALUR KONSULTASI (WAJIB ikuti urutan, JANGAN loncat)
1. SAMBUT hangat (sambung ke iklan), jangan langsung jualan
2. GALI keluhan — tanya SATU per SATU: ${pertanyaan}
3. DENGARKAN & tunjukkan ngerti ("oh berarti...", "wah pasti nggak nyaman ya kak")
4. EDUKASI ringan — kenapa keluhannya begitu, apa penyebabnya
5. REKOMENDASI ${namaProduk} dengan alasan SPESIFIK ke keluhan mereka
6. Baru kalau customer mantap/tertarik → bantu order
⚠️ JANGAN loncat dari step 2/3 langsung ke step 6. Customer masih cerita keluhan = masih di tahap 2-3, BUKAN siap order.

WAJIB — simpan data penting customer dengan marker berikut (tulis SEKALI saja saat pertama kali tahu):
- Saat tahu keluhan: [KELUHAN:keluhan singkat] — contoh: [KELUHAN:sinusitis kronis]
- Saat customer konfirmasi alamat lengkap: [ALAMAT_OK:alamat lengkap] — contoh: [ALAMAT_OK:Jl. Dahlia RT 4 RW 3, Kelurahan Mariso]
Jangan tulis ulang marker yang sama di pesan berikutnya.

GAYA NGOBROL
- Panggil "Kak"; kalimat PENDEK (1–2 kalimat per balasan, MAX 3 kalimat kalau memang perlu)
- ⛔ DILARANG kirim balasan panjang 3+ paragraf. Kalau ada banyak yang mau disampaikan, pilih yang PALING PENTING saja, sisanya di pesan berikutnya.
- Hangat, sabar, peduli; emoji secukupnya 😊🙏, jangan lebay
- JANGAN paragraf panjang/kaku/formal/robot
- Tanya SATU hal per balasan, jangan gabung edukasi + rekomendasi + tanya data sekaligus
- Setelah jawab pertanyaan faktual (BPOM, halal, bahan, dll) → SELALU lanjut tanya balik yang relevan ke alur konsultasi (misal: "Kak sendiri ada keluhan apa?", "Udah berapa lama kak?"). Jangan jawab lalu diam.
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
  JANGAN tulis [WILAYAH_OK:...] sebelum provinsi dipastikan oleh customer.
- Wilayah tak konsisten → konfirmasi halus, jangan asal proses.
- Kurir dipilih SISTEM berdasarkan grade + ongkir daerah itu.
- Fee COD 5% ke customer, dibulatkan ke terdekat.
- Kalau ditanya "pengiriman dari mana" → jawab dari DATA PRODUK di atas (Asal pengiriman). Jangan bilang "tidak bisa info".
- Promo ongkir diterapkan SISTEM (berlaku COD & transfer).

FORMAT TAMPIL HARGA (pakai persis ini saat tampilkan total)
${namaProduk} ${harga} 😊

💳 Transfer
${namaProduk} ${harga} + ongkir ~{ongkir_asli}~ {ongkir_promo} = TOTAL

📦 COD
${namaProduk} ${harga} + ongkir ~{ongkir_asli}~ {ongkir_promo} + admin {fee} = TOTAL

Via {ekspedisi} ya kak 🚗
Kakak enaknya COD atau transfer? 🙏

Catatan format: ~text~ adalah strikethrough di WhatsApp. Kalau tidak ada promo ongkir, jangan pakai strikethrough — tulis angka ongkir langsung.

ALUR CATAT ORDER
Urutan WAJIB diikuti:
1. Dapat wilayah → konfirmasi dengan [WILAYAH_OK:nama wilayah] → sistem tampilkan total TF & COD otomatis → tanya "Kakak enaknya COD atau transfer? 🙏"
2. Customer pilih TF/COD → BARU minta data yang BELUM ADA saja
3. CEK dulu data dari form (nama/HP/alamat). Yang sudah ada → JANGAN ditanya ulang, cukup konfirmasi.
4. Yang kurang: (1) nama (2) no HP (3) alamat lengkap (jalan/gang, no rumah, RT/RW, kelurahan, kecamatan, patokan).
5. Alamat kurang → minta yang kurang aja, jangan ulang dari nol.
6. Ada jalan/gang → boleh proaktif tawarkan patokan dari maps.
7. Tutup dengan KONFIRMASI ORDER (rincian+total), minta "oke".
8. Setelah customer konfirmasi order (semua data terkumpul: nama ✓, alamat ✓, metode bayar ✓) DAN kamu sudah kirim ringkasan order lengkap ke customer → BARU tulis di akhir balasan:
   [ORDER_CONFIRMED]
   [ORDER_DATA:alamat="ALAMAT LENGKAP DARI CUSTOMER" keluhan="KELUHAN UTAMA CUSTOMER" metode="COD atau Transfer" qty=1]
   Isi ORDER_DATA dengan data AKTUAL yang sudah dikumpulkan dari customer. Jangan dikosongkan.
⛔ DILARANG tulis [ORDER_CONFIRMED] kecuali SEMUA kondisi ini terpenuhi:
   - Sudah tunjukkan total harga (termasuk ongkir)
   - Sudah dapat nama + alamat lengkap + metode bayar dari customer
   - Kamu sudah kirim ringkasan order ke customer di pesan ini atau sebelumnya
   Kirim rekening, tanya alamat, atau customer bilang "oke" untuk hal lain = BELUM boleh tulis [ORDER_CONFIRMED].
JANGAN minta data diri SEBELUM tunjukkan total ongkir dan tanya pilihan bayar.

JUMLAH / QTY
- Default qty = 1. Kalau customer bilang "mau 2" atau "buat 3 orang", hitung total = harga × qty + ongkir.
- Tanya konfirmasi: "Berarti 2 ${namaProduk} ya kak? Total jadi Rp X + ongkir 😊"
- Isi qty di ORDER_DATA sesuai jumlah yang dipesan.

INFO PEMBAYARAN TRANSFER
- Kalau customer pilih Transfer → LANGSUNG kasih info rekening dari DATA PRODUK di atas.
- JANGAN bilang "tim kami akan hubungi" atau "nanti kami konfirmasi" — rekening sudah ada, kasih langsung.
- Format: "Silakan transfer ke: [rekening]. Setelah transfer, kirim bukti TF ya kak 🙏"
- Kalau rekening belum diisi di data produk → baru bilang "Nanti kami kirimkan info rekeningnya ya kak 🙏"

REM ETIS
- JANGAN klaim medis berlebihan ("pasti sembuh").
- Keluhan serius/di luar produk → sarankan periksa, jangan paksa.

HANDLE PERTANYAAN UMUM
- "Stok masih ada?" → "Masih ready kak, langsung proses aja 😊"
- "Ada diskon/promo?" → Kalau ada promo ongkir, sebut itu. Kalau tidak ada, bilang "Untuk saat ini belum ada promo khusus kak, tapi harganya sudah yang terbaik 😊"
- "Bisa kirim hari ini?" → "Kalau ordernya sebelum jam 12 siang biasanya bisa kirim hari ini kak 😊" (atau sesuaikan dengan knowledge produk)
- "Estimasi sampai berapa hari?" → "Tergantung wilayahnya kak, biasanya 2-4 hari kerja 😊" (atau lihat dari kurir yang dipilih)
- "Pengiriman dari mana?" → Jawab dari DATA PRODUK (Asal pengiriman)

CUSTOMER LANGSUNG ORDER
Hanya berlaku kalau customer EKSPLISIT bilang: "mau order", "mau beli", "beli 1", "order dong", "langsung order aja", atau langsung kirim alamat lengkap.
⛔ Customer cerita keluhan (sakit, mumet, dll) BUKAN "langsung order" — itu masih tahap konsultasi, ikuti ALUR KONSULTASI.
- Kalau memang langsung order → JANGAN paksa konsultasi, layani
- Konfirmasi wilayah → hitung ongkir → tanya metode bayar → proses
- Tetap hangat: "Siap kak! 😊 Alamatnya di mana ya biar aku cek ongkirnya?"

HANDLE KEBERATAN (jangan langsung menyerah)
Kalau customer bilang "gak jadi", "cancel", "ga mau", "mahal", "pikir-pikir dulu", "nanti aja", "tidak jadi kalau...", "kalau gak bisa X":
- JANGAN langsung bilang "oke gak apa-apa" dan tutup percakapan
- GALI dulu alasannya dengan hangat: "Eh sayang banget kak, kenapa? Mungkin aku bisa bantu 😊"
- Kalau alasannya METODE BAYAR (misal "tidak jadi kalau tidak bisa COD"):
  → Kalau ongkir BELUM dihitung: JANGAN bilang COD tidak bisa — berarti wilayah belum diketahui, bukan COD tidak ada. Respons: "COD bisa kok kak! Aku cek ongkirnya dulu ya 😊 Kecamatannya mana?"
  → Kalau ongkir SUDAH dihitung dan COD memang tidak tersedia di wilayah itu:
     Akui dengan jujur TAPI langsung tawarkan transfer sebagai solusi:
     "Iya kak, untuk wilayah [X] kurir COD-nya memang belum tersedia saat ini 🙏 Tapi transfer aman banget kok kak — ada garansi dari kami, dan pengiriman tetap jalan normal. Mau aku bantu proses via transfer?"
     Kalau customer masih ragu soal keamanan transfer → jelaskan prosesnya, tawarkan bukti/garansi dari product knowledge
     Kalau customer bilang "malas ribet transfer" → "Tenang kak, transfernya simpel — tinggal kirim ke rekening kami, kirim bukti TF, selesai 😊 Aku pantau terus sampai barangnya sampai"
     JANGAN langsung bilang "oke tidak apa-apa ya kak" — itu menyerah terlalu cepat
- Kalau alasannya HARGA → ingatkan value: manfaat spesifik ke keluhan mereka, kualitas produk
- Kalau alasannya RAGU → tawarkan garansi/testimoni jika ada di knowledge produk
- Kalau alasannya WAKTU → beri ruang: "Gak papa kak, kalau mau tanya-tanya lagi aku siap 😊"
- ⚠️ DILARANG bilang "lokasinya susah", "COD tidak tersedia", "tidak bisa COD di sana" kecuali sistem sudah konfirmasi tidak ada kurir COD
- Baru lepaskan dengan ramah kalau customer sudah 2x+ tetap menolak setelah digali

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
async function getContextMessages(conversationId, afterTimestamp = null) {
  // Ambil 30 pesan TERAKHIR — cukup untuk konteks panjang tanpa terlalu boros token
  const timeFilter = afterTimestamp ? `&created_at=gte.${encodeURIComponent(afterTimestamp)}` : '';
  const msgs = await sbGet('conv_messages',
    `?conversation_id=eq.${conversationId}&order=created_at.desc&limit=30${timeFilter}`
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

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
  }, 30000); // 30 detik timeout untuk AI
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

    const res = await fetchWithTimeout('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    }, 15000); // 15 detik untuk transcribe audio
    const data = await res.json();
    return data.text || null;
  } catch(e) {
    console.error('Groq transcribe error:', e.message);
    return null;
  }
}

/* ── DETEKSI KONFIRMASI WILAYAH (webhook-level, tidak bergantung Claude) ── */

// Kata-kata yang bukan nama wilayah (di awal kandidat)
const BUKAN_WILAYAH = /^(via|pakai|dengan|pake|lewat|dari|ke|di|ya|oke|siap|baik|nanti|kalau|jika|untuk|sudah|belum|bisa|tidak|iya|tidak|biar|aku|kamu|kami|tim|gak|ga|mau|minta)\s/i;

// Kata kerja / kalimat aksi yang tidak mungkin ada di nama wilayah
const KATA_KERJA_WILAYAH = /\b(eskalasi|eskalasiin|cek|tanya|tanyain|hubungi|hubungin|konfirmasi|bantu|sambung|sambungin|tunggu|kasih|kirim|bayar|proses|lanjut|info|bilang|bilang|pesan|order|transfer|cod|rekening|ambil|atur|selesai|minta)\b/i;

// Ekstrak wilayah yang AI sedang konfirmasikan — pertanyaan ("Sumba NTT ya kak?")
function extractProposedWilayah(aiMsg) {
  const lines = aiMsg.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Prefix "ke" atau "jadi" WAJIB ada (tidak optional) untuk menghindari false positive
    const m = line.match(/(?:jadi\s+ke\s+|jadi\s+|ke\s+)([A-Za-z][A-Za-z\s,]{2,40}?)\s+ya\s+kak[?😊🙏\s]/i);
    if (m) {
      const candidate = m[1].trim().replace(/,\s*$/, '');
      const wordCount = candidate.split(/\s+/).length;
      if (
        candidate.length >= 3 &&
        wordCount <= 5 &&                        // nama wilayah max 5 kata
        !BUKAN_WILAYAH.test(candidate) &&        // tidak diawali kata filler
        !KATA_KERJA_WILAYAH.test(candidate)      // tidak mengandung kata kerja
      ) return candidate;
    }
  }
  return null;
}

// Ekstrak wilayah dari pernyataan konfirmasi AI ("Oke kak, Ambarawa Jawa Tengah ya! 😊")
function extractConfirmedWilayah(aiMsg) {
  const lines = aiMsg.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    // "Oke kak, Ambarawa Jawa Tengah ya!" / "Siap kak, pengirimannya ke Sumba NTT ya!"
    const m = line.match(/(?:oke|siap|dicatat|baik|noted)\s+kak[,!]?\s+(?:pengirimannya\s+ke\s+|jadi\s+ke\s+)?([A-Za-z][A-Za-z\s,]{2,40}?)\s+ya[!😊🙏\s]/i);
    if (m) {
      const candidate = m[1].trim().replace(/[,!]+$/, '');
      const wordCount = candidate.split(/\s+/).length;
      if (
        candidate.length >= 3 &&
        wordCount <= 5 &&
        !KATA_KERJA_WILAYAH.test(candidate)
      ) return candidate;
    }
  }
  return null;
}

/* ── SEARCH WILAYAH LOKAL (tabel wilayah_id di Supabase) ─── */
async function cariWilayah(keyword, limit = 5) {
  try {
    const cleanPart = s => s.trim().toLowerCase()
      .replace(/\bkota\b/gi, '').replace(/\bkabupaten\b/gi, '').replace(/\bkab\b/gi, '')
      .replace(/\bprovinsi\b/gi, '').replace(/\bprov\b/gi, '').trim();

    // Kalau input comma-separated (misal: "Kranggan, Galur, Kulonprogo"),
    // coba match kelurahan+kecamatan agar hasil lebih tepat
    const parts = keyword.split(',').map(cleanPart).filter(s => s.length >= 2);
    if (parts.length >= 2) {
      const [kel, kec, kab] = parts;
      // Coba kelurahan + kecamatan dulu
      const byKelKec = await sbGet('wilayah_id',
        `?kelurahan=ilike.*${encodeURIComponent(kel)}*&kecamatan=ilike.*${encodeURIComponent(kec)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
      ).catch(() => []);
      if (byKelKec.length > 0) return byKelKec;

      // Fallback: kecamatan + kabupaten
      if (kab) {
        const byKecKab = await sbGet('wilayah_id',
          `?kecamatan=ilike.*${encodeURIComponent(kec)}*&kabupaten=ilike.*${encodeURIComponent(kab)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
        ).catch(() => []);
        if (byKecKab.length > 0) return byKecKab;
      }

      // Fallback: cari part pertama saja (kemungkinan kecamatan atau kelurahan)
    }

    const kw = cleanPart(keyword);
    if (kw.length < 3) return [];

    // Cari di semua level: kecamatan, kabupaten, kelurahan
    const [byKec, byKab, byKel] = await Promise.all([
      sbGet('wilayah_id', `?kecamatan=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`).catch(() => []),
      sbGet('wilayah_id', `?kabupaten=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`).catch(() => []),
      sbGet('wilayah_id', `?kelurahan=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`).catch(() => []),
    ]);

    // Gabung & deduplikasi berdasarkan kecamatan+kabupaten
    const seen = new Set();
    const merged = [];
    for (const row of [...byKec, ...byKab, ...byKel]) {
      const key = `${row.kecamatan}||${row.kabupaten}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(row);
        if (merged.length >= limit) break;
      }
    }
    return merged;
  } catch(e) {
    console.error('cariWilayah error:', e.message);
    return [];
  }
}

// Format wilayah untuk tampil ke Claude/customer (kecamatan + kabupaten + provinsi)
function formatWilayah(row) {
  return [row.kecamatan, row.kabupaten, row.provinsi].filter(Boolean).join(', ');
}

// Format wilayah untuk query ke Mengantar — pakai kelurahan + kecamatan agar dapat destination_id yang tepat
function formatWilayahMengantar(row) {
  return [row.kelurahan, row.kecamatan, row.kabupaten].filter(Boolean).join(', ');
}

// Ambil semua kelurahan di satu kecamatan (untuk ditawarkan ke customer sebagai pilihan)
async function getKelurahanByKecamatan(kecamatan, kabupaten) {
  try {
    const rows = await sbGet('wilayah_id',
      `?kecamatan=ilike.${encodeURIComponent(kecamatan)}&kabupaten=ilike.${encodeURIComponent(kabupaten)}&select=kelurahan&order=kelurahan.asc&limit=20`
    );
    // Deduplikasi
    return [...new Set(rows.map(r => r.kelurahan))];
  } catch(e) {
    console.error('getKelurahanByKecamatan error:', e.message);
    return [];
  }
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
  const res = await fetchWithTimeout(`https://app.mengantar.com/api/${path}`, { headers: MENGANTAR_HEADERS }, 10000);
  const json = await res.json();
  return json;
}

/* ── HITUNG ONGKIR: step 4–8 blueprint §4 ───────────────── */
async function hitungOngkir(wilayah, product) {
  try {
    // Step 1: Cari di tabel lokal wilayah_id
    // Coba kelurahan+kecamatan dulu (paling spesifik), fallback ke kecamatan/kabupaten
    const lokalMatch = await cariWilayah(wilayah, 3);
    let lokal = lokalMatch[0] || null;

    // Kalau ada lebih dari 1 hasil, pilih yang paling mirip dengan input
    if (lokalMatch.length > 1) {
      const kw = wilayah.toLowerCase();
      const scored = lokalMatch.map(r => {
        let score = 0;
        if (r.kelurahan.toLowerCase() === kw) score += 50;
        else if (r.kelurahan.toLowerCase().includes(kw)) score += 30;
        if (r.kecamatan.toLowerCase() === kw) score += 40;
        else if (r.kecamatan.toLowerCase().includes(kw)) score += 20;
        if (r.kabupaten.toLowerCase().includes(kw)) score += 10;
        return { row: r, score };
      });
      scored.sort((a, b) => b.score - a.score);
      lokal = scored[0].row;
    }

    // Step 2: Bangun query Mengantar — kelurahan + kecamatan (paling spesifik)
    // Ini memberi Mengantar info yang cukup untuk match destination_id yang benar
    let queryMengantar = wilayah; // fallback kalau tidak ada di lokal
    let queryDisplay   = wilayah; // untuk ditampilkan ke Claude/customer

    if (lokal) {
      queryMengantar = formatWilayahMengantar(lokal); // kelurahan, kecamatan, kabupaten
      queryDisplay   = formatWilayah(lokal);           // kecamatan, kabupaten, provinsi
      console.log(`Wilayah lokal match: "${wilayah}" → kelurahan="${lokal.kelurahan}", kecamatan="${lokal.kecamatan}", kab="${lokal.kabupaten}"`);
      console.log(`Query Mengantar: "${queryMengantar}"`);
    }

    // Step 3: Cari destination_id dari Mengantar
    const searchJson = await mengantarFetch(`address/autofill?keyword=${encodeURIComponent(queryMengantar)}`);
    const areas = searchJson.data || searchJson;
    if (!Array.isArray(areas) || !areas.length) return null;

    // Scoring: pilih area Mengantar yang paling cocok
    // Prioritas: subdistrict (kelurahan) match > district (kecamatan) > city (kabupaten)
    const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let bestArea = areas[0], bestScore = -1;
    for (const a of areas) {
      let score = 0;
      if (lokal) {
        // Match exact kelurahan → skor tertinggi
        if (normStr(a.subdistrict) === normStr(lokal.kelurahan)) score += 50;
        else if ((a.subdistrict || '').toLowerCase().includes(lokal.kelurahan.toLowerCase())) score += 30;
        // Match kecamatan
        if (normStr(a.district) === normStr(lokal.kecamatan)) score += 30;
        else if ((a.district || '').toLowerCase().includes(lokal.kecamatan.toLowerCase())) score += 15;
        // Match kabupaten
        if (normStr(a.city || a.regency || '') === normStr(lokal.kabupaten)) score += 20;
      } else {
        // Fallback: scoring berdasarkan keyword wilayah asli
        const kwParts = wilayah.toLowerCase().split(',').map(s => s.trim());
        const aFull = [a.subdistrict, a.district, a.city || a.regency, a.province].filter(Boolean).join(' ').toLowerCase();
        for (const part of kwParts) {
          if (aFull.includes(part)) score += 10;
          if (normStr(a.city || a.regency || '') === normStr(part)) score += 20;
          if (normStr(a.subdistrict || '') === normStr(part)) score += 30;
        }
      }
      if (score > bestScore) { bestScore = score; bestArea = a; }
    }

    console.log(`Mengantar best match: "${bestArea.subdistrict}, ${bestArea.district}, ${bestArea.city || bestArea.regency}" (score ${bestScore})`);

    const areaId   = bestArea._id || bestArea.id;
    const areaNama = bestArea.subdistrict || bestArea.name || wilayah;
    console.log(`Mengantar match: "${queryMengantar}" → "${areaNama}" (score ${bestScore})`);
    const weight = (product?.berat_gram || 1000) / 1000; // gram → kg untuk Mengantar

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
        // Prioritaskan data dari tabel lokal (lebih bersih & standar)
        // Fallback ke data Mengantar kalau lokal tidak ada
        kelurahan: lokal?.kelurahan   || bestArea.subdistrict || '',
        kecamatan: lokal?.kecamatan   || bestArea.district    || '',
        kota:      lokal?.kabupaten   || bestArea.city        || bestArea.regency || '',
        provinsi:  lokal?.provinsi    || bestArea.province    || '',
        kodePos:   bestArea.postal_code || bestArea.zip       || '',
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
      const res = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, 8000);
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
    const res = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=id`,
      { headers: { 'User-Agent': 'BotWA-CS/1.0 (contact@adsy.id)' } },
      8000
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
async function sendWA(sessionId, waNumber, message, isOutbound = false, imageUrl = null, caption = null) {
  if (!BAILEYS_URL) throw new Error('BAILEYS_URL belum diset');
  const res = await fetchWithTimeout(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      session_id: sessionId,
      wa_number: waNumber,
      message,
      is_outbound: isOutbound,
      image_url: imageUrl || undefined,
      caption: caption || undefined,
    }),
  }, 15000); // 15 detik untuk gambar
  if (!res.ok) throw new Error(`Baileys send error: ${await res.text()}`);
  return res.json();
}

/* ── BUILD INJEKSI ONGKIR untuk Claude ───────────────────── */
function buildOngkirInjeksi(hasil, product, konteks = '') {
  const fmt = (n) => `Rp ${n.toLocaleString('id-ID')}`;
  // Single tilde ~ untuk strikethrough WhatsApp (bukan double ~~)
  const ongkirDisplay = hasil.ongkirAsli !== hasil.ongkirPromo
    ? `~${fmt(hasil.ongkirAsli)}~ ${fmt(hasil.ongkirPromo)}`
    : fmt(hasil.ongkirPromo);

  // Tabel semua kurir yang tersedia
  const tabelKurir = (hasil.allRates || []).map(r => {
    const potongan = r.ongkir !== r.ongkirPromo ? ` (hemat ${fmt(r.ongkir - r.ongkirPromo)})` : '';
    return `- ${r.nama}: ongkir ${fmt(r.ongkir)}${potongan} → TF total ${fmt(r.totalTF)} | COD total ${fmt(r.totalCOD)}`;
  }).join('\n');

  const areaFull = hasil.area
    ? [hasil.area.kecamatan, hasil.area.kota, hasil.area.provinsi].filter(Boolean).join(', ')
    : '';

  return `[SISTEM] ${konteks}Ongkir sudah dihitung. Rekomendasi termurah: ${hasil.ekspedisi}.
${areaFull ? `Area yang dicocokkan sistem: ${areaFull}. Sebutkan nama area ini ke customer saat konfirmasi, contoh: "Oke kak, ongkir ke ${areaFull} ya 😊"` : ''}

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

Kalau customer tanya harga kurir lain (misal "kalau JNE berapa?"), jawab langsung dari data di atas. Jangan bilang "sistem pilih otomatis".
Kalau customer MINTA kurir tertentu (misal "JNE aja", "pakai sicepat dong") → konfirmasi dan tampilkan total baru pakai kurir itu, lalu tulis marker [GANTI_KURIR:nama_kurir] di akhir pesan.
Contoh: "Oke kak, pakai JNE ya! Total Transfer Rp X / COD Rp Y 😊 [GANTI_KURIR:JNE]"`;
}

/* ── UPDATE CONVERSATION STATE ───────────────────────────── */
// ⚠️ CATATAN: Fungsi ini punya potensi race condition jika 2 request masuk bersamaan.
// Debounce 1500ms di handler utama sudah mitigasi sebagian besar kasus.
// Untuk fix penuh, perlu pakai Supabase RPC dengan jsonb_concat atau optimistic locking.
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
      // Noise = tidak ada huruf/angka sama sekali, ATAU terlalu banyak huruf berulang (5+ kali, >5 kemunculan)
      const isNoise = !transkripsi || transkripsi.trim().length < 3
        || /^[^a-zA-Z0-9\u00C0-\u024F\u4E00-\u9FFF\u0600-\u06FF]*$/.test(transkripsi)
        || (transkripsi.match(/([a-zA-Z])\1{4,}/g) || []).length > 5; // huruf berulang 5+ kali, >5 kemunculan

      if (transkripsi && !isNoise) {
        console.log(`VN transcribed: ${transkripsi.slice(0, 80)}`);
        message = `[SISTEM: Customer kirim voice note, isi: "${transkripsi}". Balas sesuai isi voice note tersebut, jangan bilang tidak bisa dengar VN.]`;
      } else {
        console.log(`VN noise/gagal: ${transkripsi}`);
        message = `[SISTEM: Customer kirim voice note tapi isinya tidak jelas/noise. Minta customer kirim ulang VN-nya atau ketik pesannya.]`;
      }
    }

    // ── Handle sticker, video, dokumen, dan media lain ─────────
    if (messageType === 'sticker') {
      message = `[SISTEM: Customer kirim sticker. Balas dengan ramah dan lanjutkan percakapan, jangan bilang tidak bisa lihat sticker.]`;
    } else if (messageType === 'video') {
      message = `[SISTEM: Customer kirim video. Tanya dengan ramah apa isi videonya atau minta jelaskan dalam bentuk teks/foto.]`;
    } else if (messageType === 'document') {
      message = `[SISTEM: Customer kirim dokumen/file. Tanya dengan ramah isi dokumennya apa, karena sistem tidak bisa baca dokumen.]`;
    } else if (messageType === 'location') {
      // Location biasanya sudah di-handle via Google Maps URL, tapi kalau native location:
      if (!message || message === '[location]') {
        message = `[SISTEM: Customer kirim lokasi. Konfirmasi nama kota/kecamatannya untuk cek ongkir.]`;
      }
    }

    // ── Analisa gambar jika ada (Claude Vision) ────────────────
    let imageAnalysis = null;
    if (messageType === 'image' && mediaUrl && mediaUrl.startsWith('data:image')) {
      try {
        // Deteksi media type dari data URL (jpeg, png, webp, gif) — case-insensitive
        const mediaTypeMatch = mediaUrl.match(/^data:image\/([a-z0-9]+);base64,/i);
        const imageFormat = (mediaTypeMatch?.[1] || 'jpeg').toLowerCase();
        const mediaType = `image/${imageFormat}`;
        const base64Data = mediaUrl.replace(/^data:image\/[a-z0-9]+;base64,/i, '');

        const visionRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
                  source: { type: 'base64', media_type: mediaType, data: base64Data },
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
        }, 20000); // 20 detik untuk vision analysis
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
    const savedMsg = await saveMessage(conversation.id, 'customer', msgText);
    const savedMsgId = savedMsg?.[0]?.id;

    // ── Debounce: kalau customer kirim 2+ pesan cepat, proses hanya yang terakhir ──
    // 2500ms cukup untuk menangkap ketikan cepat berturut-turut
    await new Promise(r => setTimeout(r, 2500));
    if (savedMsgId) {
      const latestMsg = await sbGet('conv_messages',
        `?conversation_id=eq.${conversation.id}&role=eq.customer&order=created_at.desc&limit=1`
      );
      if (latestMsg[0]?.id && latestMsg[0].id !== savedMsgId) {
        console.log(`Debounce: ada pesan lebih baru (${latestMsg[0].id}), skip`);
        return res.status(200).json({ ok: true, skipped: 'debounced' });
      }
    }

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

    // Inject ulang allRates setiap pesan agar Claude selalu bisa jawab pertanyaan kurir
    if (convState.ongkir?.allRates?.length) {
      const fmt = n => `Rp ${n.toLocaleString('id-ID')}`;
      const tabel = convState.ongkir.allRates.map(r => {
        const potongan = r.ongkir !== r.ongkirPromo ? ` (hemat ${fmt(r.ongkir - r.ongkirPromo)})` : '';
        return `- ${r.nama}: ongkir ${fmt(r.ongkir)}${potongan} → TF ${fmt(r.totalTF)} | COD ${fmt(r.totalCOD)}`;
      }).join('\n');
      systemPrompt += `\n\nDATA SEMUA KURIR TERSEDIA (selalu gunakan ini kalau customer tanya kurir lain — JANGAN bilang "ditentukan sistem"):\n${tabel}\nRekomendasi sistem: ${convState.ongkir.ekspedisi}`;
    }

    // ── Ambil pesan terakhir (filter setelah re-open jika ada) ───
    const history = await getContextMessages(conversation.id, convState.reopened_at || null);

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
      } else if (imageAnalysis.rekening_cocok === true) {
        notif = `[SISTEM] Bukti transfer VALID dan rekening COCOK ✅
Bank: ${imageAnalysis.bank || '?'} | Nominal: ${imageAnalysis.nominal || '?'} | Tanggal: ${imageAnalysis.tanggal || '?'}
Konfirmasi penerimaan bukti TF, informasikan pesanan akan segera diproses dan estimasi pengiriman.`;
      } else {
        // rekening_cocok === null artinya tidak bisa dibaca — jangan anggap valid
        notif = `[SISTEM] Customer kirim gambar yang terlihat seperti bukti transfer tapi rekening tujuan tidak bisa terbaca dengan jelas.
Bank: ${imageAnalysis.bank || '?'} | Nominal: ${imageAnalysis.nominal || '?'}
Minta customer konfirmasi apakah sudah transfer ke rekening yang benar: ${userRekening || '(belum diisi)'}.`;
      }
      history.push({ role: 'user', content: notif });
    }

    // ── WEBHOOK-LEVEL: Auto-search wilayah via tabel lokal wilayah_id ──
    const lastAiMsg = history.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    const aiTanyaLokasi = /daerah|wilayah|provinsi|kota|kabupaten|kecamatan|kelurahan|alamat|kirim ke|tinggal di|dari mana|lokasi/i.test(lastAiMsg);
    if (!convState.wilayah && !convState.ongkir && aiTanyaLokasi && message.length >= 3 && message.length <= 80) {
      try {
        // ── Kalau bot sedang menunggu jawaban kelurahan (pending_kecamatan ada di state),
        //    cari kelurahan di kecamatan itu saja — jangan search global (bisa salah kecamatan)
        const pendingKec = convState.pending_kecamatan; // { kecamatan, kabupaten, provinsi }
        let hasil;
        if (pendingKec?.kecamatan) {
          const kw = message.trim().toLowerCase();
          const byKel = await sbGet('wilayah_id',
            `?kelurahan=ilike.*${encodeURIComponent(kw)}*&kecamatan=ilike.${encodeURIComponent(pendingKec.kecamatan)}&kabupaten=ilike.${encodeURIComponent(pendingKec.kabupaten)}&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
          ).catch(() => []);
          hasil = byKel;
          if (byKel.length > 0) {
            console.log(`[pendingKec] "${message}" → ${byKel.length} kelurahan di ${pendingKec.kecamatan}`);
          } else {
            // Tidak ketemu di kecamatan pending → fallback global
            hasil = await cariWilayah(message, 5);
          }
        } else {
          hasil = await cariWilayah(message, 5);
        }

        if (hasil.length > 0) {
          // Cek apakah semua hasil dari kecamatan yang sama → customer menyebut kecamatan
          const kecamatanUnik = [...new Set(hasil.map(r => `${r.kecamatan}||${r.kabupaten}`))];

          if (kecamatanUnik.length === 1) {
            // Satu kecamatan teridentifikasi → ambil semua kelurahan untuk ditawarkan ke customer
            const first = hasil[0];
            const kelurahanList = await getKelurahanByKecamatan(first.kecamatan, first.kabupaten);

            if (kelurahanList.length <= 1) {
              // Hanya 1 kelurahan → langsung konfirmasi, clear pending_kecamatan
              await updateConvState(conversation.id, { pending_kecamatan: null });
              const hint = `[SISTEM] Sistem menemukan: ${first.kelurahan}, ${formatWilayah(first)}.\n`
                + `Konfirmasi ke customer lalu tulis [WILAYAH_OK:${first.kelurahan}, ${formatWilayah(first)}].`;
              history.push({ role: 'user', content: hint });
            } else {
              // Beberapa kelurahan → simpan pending_kecamatan supaya ronde berikutnya ingat konteks
              await updateConvState(conversation.id, {
                pending_kecamatan: { kecamatan: first.kecamatan, kabupaten: first.kabupaten, provinsi: first.provinsi },
              });
              const contohKel = kelurahanList.slice(0, 3).join(', ');
              const hint = `[SISTEM] Kecamatan "${first.kecamatan}", ${first.kabupaten}, ${first.provinsi} ditemukan.\n`
                + `Semua kelurahan valid: ${kelurahanList.join(', ')}\n`
                + `Tanyakan kelurahannya dengan NATURAL — sebut 2-3 contoh (misal: ${contohKel}) supaya customer lebih mudah jawab, jangan listing semuanya. Gaya WhatsApp santai, 1-2 kalimat.\n`
                + `Setelah customer sebut kelurahan yang valid, konfirmasi dan tulis [WILAYAH_OK:nama kelurahan, ${first.kecamatan}, ${first.kabupaten}, ${first.provinsi}].`;
              history.push({ role: 'user', content: hint });
              console.log(`Tawarkan ${kelurahanList.length} kelurahan di Kec. ${first.kecamatan}`);
            }
          } else if (pendingKec?.kecamatan) {
            // Sedang nunggu kelurahan tapi tidak ketemu → minta ulang dengan lebih jelas
            const kelAll = await getKelurahanByKecamatan(pendingKec.kecamatan, pendingKec.kabupaten);
            const contoh = kelAll.slice(0, 3).join(', ');
            const hint = `[SISTEM] Kelurahan "${message}" tidak ditemukan di Kecamatan ${pendingKec.kecamatan}.\n`
              + `Kelurahan valid di sana: ${kelAll.join(', ')}\n`
              + `Minta customer pilih kelurahan yang ada dengan ramah, contoh: ${contoh}. Jangan tulis [WILAYAH_OK] sampai customer sebut kelurahan yang valid.`;
            history.push({ role: 'user', content: hint });
          } else {
            // Beberapa kecamatan berbeda → tampilkan pilihan kecamatan dulu (tanpa nomor)
            const candidates = hasil.map(r => formatWilayah(r));
            const hint = `[SISTEM] Sistem menemukan beberapa wilayah cocok untuk "${message}":\n`
              + candidates.map(c => `- ${c}`).join('\n')
              + `\nTanyakan ke customer kecamatannya yang mana dengan natural, lalu setelah dikonfirmasi tulis [WILAYAH_OK:nama wilayah].`;
            history.push({ role: 'user', content: hint });
            console.log(`Multiple kecamatan untuk "${message}": ${candidates.join(' | ')}`);
          }
        }
      } catch(e) { console.error('Wilayah hint error:', e.message); }
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
          pending_kecamatan: null,
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
    const gantiKurirMatch  = rawReply.match(/\[GANTI_KURIR:([^\]]+)\]/);

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

    // ── Handle [WILAYAH_OK:] → cek spesifisitas dulu, baru hitung ongkir ────────
    if (wilayahOkMatch && !autoOngkirResult && !convState.ongkir) {
      const wilayah = wilayahOkMatch[1].trim();
      console.log(`[WILAYAH_OK] detected: ${wilayah}`);

      // Cek apakah wilayah sudah spesifik (minimal kecamatan level)
      const lokalCek = await cariWilayah(wilayah, 15);
      const kecamatanUnik = [...new Set(lokalCek.map(r => `${r.kecamatan}||${r.kabupaten}`))];

      if (lokalCek.length > 0 && kecamatanUnik.length > 1) {
        // Wilayah masih terlalu umum (kabupaten/kota) → tanya kecamatan dulu
        console.log(`[WILAYAH_OK] "${wilayah}" terlalu umum — ${kecamatanUnik.length} kecamatan ditemukan`);
        const kecList = [...new Set(lokalCek.map(r => r.kecamatan))];
        const contohKec = kecList.slice(0, 3).join(', ');
        const injeksi = `[SISTEM] "${wilayah}" masih terlalu umum, ada ${kecList.length} kecamatan di sana. JANGAN hitung ongkir dulu.\n`
          + `Semua kecamatan valid: ${kecList.join(', ')}\n`
          + `Tanyakan kecamatannya dengan NATURAL — sebut 2-3 contoh kecamatan (misal: ${contohKec}) supaya customer lebih mudah jawab, tapi jangan listing semuanya. Gaya WhatsApp santai, 1-2 kalimat.\n`
          + `Setelah customer sebut kecamatan yang valid, sistem akan proses lebih lanjut.`;

        const histTanya = [
          ...history,
          { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
          { role: 'user', content: injeksi },
        ];
        rawReply = await callClaude(systemPrompt, histTanya, chatModel, userAnthropicKey);

      } else if (lokalCek.length > 0 && kecamatanUnik.length === 1) {
        // Satu kecamatan teridentifikasi → cek jumlah kelurahan
        const first = lokalCek[0];
        const kelurahanList = await getKelurahanByKecamatan(first.kecamatan, first.kabupaten);

        if (kelurahanList.length > 1) {
          // Masih perlu tanya kelurahan — simpan pending_kecamatan supaya ronde berikut ingat konteks
          console.log(`[WILAYAH_OK] Kec. "${first.kecamatan}" punya ${kelurahanList.length} kelurahan → tanya dulu`);
          await updateConvState(conversation.id, {
            pending_kecamatan: { kecamatan: first.kecamatan, kabupaten: first.kabupaten, provinsi: first.provinsi },
          });
          const contohKel = kelurahanList.slice(0, 3).join(', ');
          const injeksi = `[SISTEM] Kecamatan "${first.kecamatan}", ${first.kabupaten} ditemukan, tapi perlu kelurahan spesifik.\n`
            + `Semua kelurahan valid: ${kelurahanList.join(', ')}\n`
            + `Tanyakan kelurahannya dengan NATURAL — sebut 2-3 contoh kelurahan (misal: ${contohKel}) supaya customer lebih mudah jawab, tapi jangan listing semuanya. Gaya WhatsApp santai, 1-2 kalimat.\n`
            + `Setelah customer sebut kelurahan yang valid, konfirmasi dan tulis [WILAYAH_OK:nama kelurahan, ${first.kecamatan}, ${first.kabupaten}, ${first.provinsi}].`;

          const histTanya = [
            ...history,
            { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
            { role: 'user', content: injeksi },
          ];
          rawReply = await callClaude(systemPrompt, histTanya, chatModel, userAnthropicKey);

        } else {
          // Sudah spesifik sampai kelurahan → langsung hitung ongkir, clear pending
          await updateConvState(conversation.id, { wilayah, proposed_wilayah: null, pending_kecamatan: null });
          const hasil = await hitungOngkir(wilayah, product);
          if (hasil) {
            await updateConvState(conversation.id, { ongkir: hasil });
            convState.ongkir = hasil; // update local state
            const injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. Lanjutkan balasan di atas dan `);
            const histWithOngkir = [
              ...history,
              { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
              { role: 'user', content: injeksi },
            ];
            rawReply = await callClaude(systemPrompt, histWithOngkir, chatModel, userAnthropicKey);
          } else {
            await updateConvState(conversation.id, { proposed_wilayah: wilayah });
            rawReply = rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim();
          }
        }

      } else {
        // Tidak ditemukan di local DB → langsung hitung (fallback ke Mengantar), clear pending
        await updateConvState(conversation.id, { wilayah, proposed_wilayah: null, pending_kecamatan: null });
        const hasil = await hitungOngkir(wilayah, product);
        if (hasil) {
          await updateConvState(conversation.id, { ongkir: hasil });
          convState.ongkir = hasil; // update local state
          const injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. Lanjutkan balasan di atas dan `);
          const histWithOngkir = [
            ...history,
            { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
            { role: 'user', content: injeksi },
          ];
          rawReply = await callClaude(systemPrompt, histWithOngkir, chatModel, userAnthropicKey);
        } else {
          console.warn(`hitungOngkir gagal untuk wilayah: ${wilayah}`);
          await updateConvState(conversation.id, { proposed_wilayah: wilayah });
          rawReply = rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim();
        }
      }
    }

    // ── Handle cek ongkir (dari marker Claude — fallback) ─────
    if (cekOngkirMatch && !autoOngkirResult && !wilayahOkMatch) {
      const wilayah = cekOngkirMatch[1].trim();
      await updateConvState(conversation.id, { wilayah });
      const hasil = await hitungOngkir(wilayah, product);
      if (hasil) {
        await updateConvState(conversation.id, { ongkir: hasil });
        convState.ongkir = hasil; // update local state
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
    // Skip kalau sudah diproses via [WILAYAH_OK:] marker
    if (!autoOngkirResult && !cekOngkirMatch && !wilayahOkMatch) {
      const confirmedWilayah = extractConfirmedWilayah(rawReply);
      if (confirmedWilayah && !convState.ongkir) {
        console.log(`Auto-trigger ongkir dari konfirmasi wilayah: ${confirmedWilayah}`);
        const hasil = await hitungOngkir(confirmedWilayah, product);
        if (hasil) {
          await updateConvState(conversation.id, { wilayah: confirmedWilayah, ongkir: hasil, proposed_wilayah: null });
          convState.ongkir = hasil; // update local state
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
    if (orderDataParsed.metode && !convState.metode_bayar) {
      stateUpdate.metode_bayar = orderDataParsed.metode;
      console.log(`Metode bayar tersimpan: ${stateUpdate.metode_bayar}`);
    }
    if (Object.keys(stateUpdate).length) {
      await updateConvState(conversation.id, stateUpdate);
    }

    // ── Handle [GANTI_KURIR:] → update ongkir state ke kurir pilihan customer ──
    if (gantiKurirMatch && convState.ongkir?.allRates?.length) {
      const requestedKurir = gantiKurirMatch[1].trim().toLowerCase();
      const match = convState.ongkir.allRates.find(r =>
        r.nama.toLowerCase().includes(requestedKurir) ||
        requestedKurir.includes(r.nama.toLowerCase())
      );
      if (match) {
        const promo = product?.promo_ongkir;
        let ongkirPromo = match.ongkir;
        if (promo?.tipe === 'gratis_penuh')   ongkirPromo = 0;
        else if (promo?.tipe === 'potong')    ongkirPromo = Math.max(0, match.ongkir - (promo.nilai || 0));
        else if (promo?.tipe === 'gratis_sd') ongkirPromo = Math.max(0, match.ongkir - (promo.nilai || 0));

        const harga = product?.harga || 0;
        const totalTransferBulat = bulatkan(harga + ongkirPromo);
        const feeCODRaw = Math.ceil((harga + ongkirPromo) * 0.05);
        const totalCODBulat = bulatkan(harga + ongkirPromo + feeCODRaw);
        const feeCODBulat = totalCODBulat - harga - ongkirPromo; // derive dari total agar konsisten
        const newOngkir = {
          ...convState.ongkir,
          ekspedisi:     match.nama,
          ongkirAsli:    match.ongkir,
          ongkirPromo:   ongkirPromo,
          totalTransfer: totalTransferBulat,
          totalCOD:      totalCODBulat,
          feeCOD:        feeCODBulat,
        };
        await updateConvState(conversation.id, { ongkir: newOngkir });
        convState.ongkir = newOngkir;
        console.log(`[GANTI_KURIR] switched to ${match.nama}`);
      } else {
        console.warn(`[GANTI_KURIR] kurir "${requestedKurir}" tidak ditemukan di allRates`);
      }
    }

    // ── Bersihkan marker dari reply final (pakai /g agar semua instance terhapus) ──
    let reply = rawReply
      .replace(/\[ESCALATE\]/g, '')
      .replace(/\[ORDER_CONFIRMED\]/g, '')
      .replace(/\[ORDER_DATA:[^\]]+\]/g, '')
      .replace(/\[KELUHAN:[^\]]+\]/g, '')
      .replace(/\[ALAMAT_OK:[^\]]+\]/g, '')
      .replace(/\[CEK_ONGKIR:[^\]]+\]/g, '')
      .replace(/\[WILAYAH_OK:[^\]]+\]/g, '')
      .replace(/\[GANTI_KURIR:[^\]]+\]/g, '')
      .replace(/\[SISTEM[^\]]*\]/g, '')
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

    // ── Auto-kirim gambar produk kalau customer tanya foto ────
    const tanyaFoto = /\b(foto|gambar|pic|photo|tampilan|bentuk|wujud|lihat produk|gambarnya|fotonya)\b/i.test(message);
    const adaGambarProduk = product?.gambar_url;
    const sudahKirimFoto  = convState.foto_terkirim;

    // Kirim teks reply dulu
    await sendWA(userId, reply_jid, reply);

    // Kalau customer tanya foto dan ada gambar produk → kirim gambar juga
    if (tanyaFoto && adaGambarProduk && !sudahKirimFoto) {
      await new Promise(r => setTimeout(r, 800));
      await sendWA(userId, reply_jid, null, false, product.gambar_url, product.nama);
      await updateConvState(conversation.id, { foto_terkirim: true });
      console.log(`Gambar produk terkirim: ${product.gambar_url}`);
    }

    res.status(200).json({ ok: true });

    // ── Update ringkasan berjalan (non-blocking, setiap 5 pesan) ──
    sbGet('conv_messages', `?conversation_id=eq.${conversation.id}&select=id`)
      .then(all => { if (all.length % 5 === 0) updateRingkasan(conversation.id); })
      .catch(e => console.error('Ringkasan fetch error:', e.message));

  } catch (err) {
    console.error('Webhook error:', err.message, err.stack);
    if (!res.headersSent) res.status(200).json({ ok: true, error: err.message });
  }
};
