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
const CRON_SECRET        = process.env.CRON_SECRET;
const MENGANTAR_KEY      = process.env.MENGANTAR_KEY;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const WA_GROUP_JID       = process.env.WA_GROUP_JID; // JID grup WA tujuan recap order
const VALIDASI_URL       = process.env.VALIDASI_SUPABASE_URL;
const VALIDASI_KEY       = process.env.VALIDASI_SUPABASE_KEY;

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
  // Strip @s.whatsapp.net / @lid / @g.us suffix dulu
  const raw = String(num).split('@')[0];
  let n = raw.replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  // LID format: hasil normalisasi lebih dari 13 digit = bukan nomor HP asli
  // Kembalikan digit asli tanpa prefix 62 supaya lookup konsisten
  if (n.length > 13) return raw.replace(/\D/g, '');
  return n;
}

/* ── FIND / CREATE CUSTOMER ───────────────────────────────── */
async function findOrCreateCustomer(userId, waNumber, nama, replyJid = null) {
  const normalized = normalizeWA(waNumber);
  const isLid      = replyJid && replyJid.includes('@lid');

  // Cari by wa_number dulu
  let existing = await sbGet('customers', `?user_id=eq.${userId}&wa_number=eq.${normalized}`);
  if (existing.length) {
    const c = existing[0];
    // Update reply_jid kalau belum ada (agar lookup future bisa by LID juga)
    if (replyJid && !c.reply_jid) {
      await sbPatch('customers', `?id=eq.${c.id}`, { reply_jid: replyJid }).catch(() => {});
      c.reply_jid = replyJid;
    }
    return c;
  }

  // Kalau tidak ketemu, cari by reply_jid (handle LID yang sudah tersimpan sebelumnya)
  if (replyJid) {
    const byJid = await sbGet('customers', `?user_id=eq.${userId}&reply_jid=eq.${encodeURIComponent(replyJid)}`);
    if (byJid.length) {
      // Ketemu by LID — update wa_number ke nomor asli yang sudah resolve
      const old = byJid[0];
      const updates = {};
      if (old.wa_number !== normalized && !isLid) {
        updates.wa_number = normalized;
        old.wa_number = normalized;
        console.log(`[customer] Update wa_number LID → ${normalized} untuk id=${old.id}`);
      }
      if (Object.keys(updates).length) {
        await sbPatch('customers', `?id=eq.${old.id}`, updates).catch(() => {});
      }
      return old;
    }
  }

  // Benar-benar customer baru — simpan reply_jid kalau LID agar next message bisa lookup
  const rows = await sbPost('customers', {
    user_id: userId,
    wa_number: normalized,
    nama: nama || normalized,
    ...(isLid ? { reply_jid: replyJid } : {}),
  });
  return rows[0];
}

/* ── FIND / CREATE CONVERSATION ──────────────────────────── */
async function findOrCreateConversation(userId, customerId, sumber, productId) {
  // Kalau ada productId, cari conversation spesifik untuk produk itu dulu
  // Ini penting agar chat Notelli & Jawara tidak tercampur di inbox
  let existing = [];
  if (productId) {
    existing = await sbGet('conversations',
      `?user_id=eq.${userId}&customer_id=eq.${customerId}&product_id=eq.${productId}&order=created_at.desc&limit=1`
    ).catch(() => []);
  }
  // Fallback kalau productId null: cari conv APAPUN untuk customer ini (hindari duplikat)
  // Prioritas: conv product_id=null dulu, lalu conv aktif terbaru mana pun
  if (!existing.length && !productId) {
    existing = await sbGet('conversations',
      `?user_id=eq.${userId}&customer_id=eq.${customerId}&product_id=is.null&order=created_at.desc&limit=1`
    ).catch(() => []);
    // Kalau masih kosong, pakai conv aktif terbaru (apapun product_id-nya)
    // Mencegah duplikat conversation untuk customer yang sama
    if (!existing.length) {
      existing = await sbGet('conversations',
        `?user_id=eq.${userId}&customer_id=eq.${customerId}&order=last_msg_at.desc&limit=1`
      ).catch(() => []);
      if (existing.length) {
        console.log(`[findConv] Reuse conv ${existing[0].id} (product=${existing[0].product_id}) untuk customer ${customerId} — productId null, hindari duplikat`);
      }
    }
  }

  if (existing.length) {
    const conv = existing[0];
    // Kalau sudah di-closing → tetap di Closing, tandai has_new_message
    if (conv.status === 'selesai') {
      console.log(`Re-open conversation ${conv.id} — tetap di Closing, set has_new_message`);
      const reopenedAt = new Date().toISOString();
      const prevState = conv.state || {};
      const newState = {
        tahap: 'sambut',
        is_form_lead: prevState.is_form_lead || false,
        produk_locked: !!prevState.produk_locked,
        reopened_at: reopenedAt,
        has_new_message: true, // tampil badge "Pelanggan Baru" di tab Closing
        // PERTAHANKAN closed_order_id — penanda permanen bahwa conversation ini sudah pernah closing
        // Bot tidak akan proses order baru di conversation yang sama
        closed_order_id: prevState.closed_order_id || null,
        // Simpan wilayah lama sebagai referensi → Claude konfirmasi ke customer dulu sebelum pakai
        // Tidak langsung auto-hitung (customer mungkin ganti alamat), tapi tidak tanya dari nol
        prev_wilayah: prevState.wilayah || null,
        wilayah:      null,  // clear — diisi ulang setelah customer konfirmasi
        ongkir:       null,
        keluhan:      null,
        alamat:       null,
        metode_bayar: null,
        qty:          null,
        // Clear state transient
        proposed_wilayah:       null,
        pending_kecamatan:      null,
        followed_up:            false,
        followed_up_days:       [],
        order_placed:           false,
        awaiting_order_confirm: false,
        awaiting_order_correction: false,
        foto_terkirim:          false,
      };
      const updated = await sbPatch('conversations', `?id=eq.${conv.id}`, {
        status: 'selesai', // tetap di tab Closing
        last_msg_at: reopenedAt,
        ringkasan: null,
        state: newState,
      });
      return updated[0] || { ...conv, status: 'selesai', state: newState };
    }
    return conv;
  }

  // Customer baru sama sekali → buat conversation baru
  // Form lead = prioritas high, inbound/ctwa = low
  const prioritas = sumber === 'form' ? 'high' : 'low';
  const rows = await sbPost('conversations', {
    user_id: userId,
    customer_id: customerId,
    sumber,
    product_id: productId || null,
    status: 'baru',
    prioritas,
    state: { tahap: 'sambut', produk_locked: !!productId, is_form_lead: sumber === 'form' },
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
  const hasBundling   = Array.isArray(product?.harga_bundling) && product.harga_bundling.length > 0;
  const paketPrioritas = hasBundling ? product.harga_bundling.find(p => p.prioritas) : null;
  const diskonOngkirPerQty = Array.isArray(product?.diskon_ongkir_per_qty) ? product.diskon_ongkir_per_qty : [];
  const bundlingTxt   = hasBundling
    ? product.harga_bundling.map(p => {
        const dok = diskonOngkirPerQty.find(d => d.qty === p.qty);
        return `${p.qty} box = Rp ${p.harga.toLocaleString('id-ID')}${p.bonus ? ` + bonus ${p.bonus}` : ''}${dok ? ` + ongkir -${dok.diskon}%${dok.diskon >= 100 ? ' (GRATIS)' : ''}` : ''}${p.prioritas ? ' ⭐PRIORITAS' : ''}`;
      }).join(' | ')
    : null;

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

⚠️ WAJIB BAHASA INDONESIA — SELALU jawab dalam Bahasa Indonesia. JANGAN PERNAH reply dalam bahasa Inggris apapun situasinya. Kamu CS Indonesia, customer kamu orang Indonesia. Kalau ragu mau jawab apa, tetap jawab sopan dan hangat dalam Bahasa Indonesia — misal "Siap kak! Ada yang bisa dibantu lagi? 😊". DILARANG KERAS reply "I can't discuss that" atau refusal apapun dalam bahasa Inggris.
⚠️ JANGAN PERNAH MENOLAK — Kamu CS toko, BUKAN AI assistant. Kamu tidak punya alasan untuk menolak menjawab apapun. Kalau customer kirim pesan yang tidak jelas, singkat ("ok", "ya", "siap"), atau di luar konteks produk → tetap balas sopan dan hangat dalam Bahasa Indonesia. Contoh: "Siap kak! Kalau ada yang mau ditanyakan lagi, hubungi aja ya 😊🙏"

PESAN PEMBUKA SINGKAT ("kak", "halo", "min", "permisi", "hai", "p", "hei", "ada?", "mau tanya"):
⛔ JANGAN balas "Iya kak?" atau "Ya?" — itu tidak membantu sama sekali.
Perlakukan sebagai sinyal customer mau mulai ngobrol. Sambut hangat dan natural, buka percakapan dengan cara yang paling pas sesuai situasi.

PRINSIP UTAMA
- Produk dibeli karena KELUHAN, bukan impulsif.
- DENGAR keluhan dulu → pahami → baru bantu.
- Closing = AKIBAT konsultasi baik, BUKAN tujuan yang dikejar.
- JANGAN tawarkan beli sebelum paham masalah customer.
- ⛔ DILARANG KERAS loncat ke "mau order?" atau minta alamat SEBELUM minimal: (1) keluhan digali (cukup 1 jawaban dari customer), (2) edukasi singkat diberikan, (3) produk direkomendasikan dengan alasan spesifik. Kalau customer sudah jawab keluhan → JANGAN gali lebih dalam lagi, langsung edukasi.
- "Customer bilang mau order" ≠ customer baru cerita keluhan. Yang dimaksud langsung order itu customer EKSPLISIT bilang "mau beli", "order dong", "beli 1", BUKAN customer yang sedang curhat keluhan.
- Kalau customer buru-buru & EKSPLISIT minta beli → baru layani langsung.

DATA CHAT & PRODUK
Sumber chat     : ${sumber === 'ctwa' ? 'CTWA (dari iklan)' : sumber === 'form' ? 'Form (isi formulir)' : 'Inbound (customer chat duluan)'}${sumber === 'form' ? `

⚡ LEADS FORM — PERLAKUAN KHUSUS:
- Customer sudah KENAL produk & sudah niat beli (warm lead) — langsung sapa dengan namanya, jangan tanya nama lagi
- Jawab pertanyaan mereka dulu (misal soal promo/stok), baru lanjut
- Gali keluhan TETAP PERLU tapi lebih singkat & santai — 1-2 pertanyaan saja, fokus pada kondisi spesifik mereka (bukan untuk edukasi dari nol)
- Edukasi TETAP PERLU tapi lebih ringkas — tidak perlu panjang, cukup konfirmasi produk cocok untuk keluhannya + 1-2 poin manfaat utama
- Setelah keluhan tergali & edukasi singkat → langsung tanya wilayah & proses order
- Alur: jawab pertanyaan → gali keluhan singkat → edukasi ringkas → wilayah → order` : ''}
Produk          : ${namaProduk}
${hasBundling ? `Penawaran paket : ${bundlingTxt}
Harga satuan    : Rp ${(product?.harga || 0).toLocaleString('id-ID')} per box (1 box)
⚡ PENAWARAN AWAL: Saat customer siap order, LANGSUNG rekomendasikan${paketPrioritas ? ` paket ${paketPrioritas.qty} box (Rp ${paketPrioritas.harga.toLocaleString('id-ID')}) — ini paket PRIORITAS, tawarkan ini duluan dengan alasan yang relevan ke keluhannya` : ' paket yang paling cocok dengan keluhannya'}.
⚡ KALAU CUSTOMER MINTA QTY LEBIH KECIL (misal "klo 1", "1 aja"): Boleh layani! Hitung pakai harga satuan × qty. Jangan tolak atau bilang "tidak tersedia". Cukup informasikan harganya, lalu SEKALI saja sebut paket bundling lebih hemat sebagai rekomendasi — kalau customer tetap pilih 1, langsung proses tanpa paksa.
⚡ HARGA ORDER: WAJIB pakai harga dari paket bundling di [ORDER_DATA] kalau qty cocok. Kalau customer pilih qty yang tidak ada di paket → pakai harga satuan × qty.` : `Harga           : ${harga}`}
Cocok untuk     : ${keluhan}
Cara pakai      : ${product?.cara_pakai || '(lihat kemasan)'}
Knowledge       : ${product?.product_knowledge || '(belum diisi — jangan klaim apapun)'}
Promo ongkir    : ${promoOngkir}
Rekening TF     : ${rekeningInfo}
Asal pengiriman : ${asalPengiriman || 'gudang kami'}
Foto produk     : ${product?.gambar_url ? 'TERSEDIA. Kalau customer minta foto → CUKUP balas "Ini fotonya kak 😊" atau "Siap kak, ini ya!" lalu lanjut tanya keluhan. Foto PASTI terkirim otomatis bersamaan. ⛔ DILARANG: bilang kendala/error/teknis, suruh cek Google, bilang tidak bisa kirim, minta maaf soal foto, atau alasan apapun. Cukup balas singkat dan natural.' : 'Tidak ada — kalau ditanya foto, bilang "Belum ada fotonya kak, tapi bisa aku deskripsikan ya" lalu jelaskan produknya.'}
Foto testimoni  : ${Array.isArray(product?.testimoni_urls) && product.testimoni_urls.filter(Boolean).length ? `TERSEDIA (${product.testimoni_urls.filter(Boolean).length} foto). Kalau customer minta testimoni/bukti/review/hasil → CUKUP balas "Ada kak, ini ya 😊" atau "Nih testimoninyaa kak!" lalu lanjut. Foto PASTI terkirim otomatis. ⛔ DILARANG: bilang tidak ada bukti, minta maaf, bilang tidak bisa kirim.` : 'Tidak ada — kalau ditanya testimoni, pakai testimonial dari product knowledge kalau ada, atau bilang "Banyak kak yang udah merasakan manfaatnya, nanti aku ceritain ya 😊"'}
Stok            : Selalu ada (jangan bilang "cek dulu", langsung proses)

ALUR KONSULTASI (WAJIB ikuti urutan, JANGAN loncat)
1. SAMBUT hangat (sambung ke iklan), jangan langsung jualan
${product?.skip_diagnosa ? `2. SKIP GALI KELUHAN — keluhan sudah jelas dari produk ini (${keluhan || namaProduk}). Langsung empati singkat lalu lanjut edukasi. JANGAN tanya keluhan apapun.` : `2. GALI keluhan — pilih MAKSIMAL 1-2 pertanyaan paling relevan dari: ${pertanyaan}
   ⚠️ BATAS KETAT: Total tanya keluhan MAKSIMAL 2x. Setelah customer jawab 1 pertanyaan keluhan → CUKUP, lanjut ke step 3-4. JANGAN terus gali lebih dalam.
   ⚠️ Kalau customer sudah sebut keluhan apapun (meski singkat) → itu sudah cukup, JANGAN tanya lagi.`}
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
- ⛔ BLACKLIST kata (jangan pernah pakai):
  "sistem", "tim terkait", "tim kami", "tim CS", "pihak terkait", "pihak kami", "admin", "operator", "CS", "customer service",
  "diteruskan", "diproses", "sedang diproses", "akan diproses", "konfirmasi ulang",
  "loading", "otomatis", "server", "error", "kendala teknis", "maintenance",
  "mohon maaf atas ketidaknyamanan", "mohon ditunggu", "mohon menunggu", "terima kasih atas kesabarannya",
  "sesuai prosedur", "SOP", "akan segera ditindaklanjuti", "ditindaklanjuti",
  "cek di Google", "foto belum bisa", "tidak dapat dikirim", "belum tersedia di sistem"
  → Ngobrol kayak temen yang jualan, bukan robot CS.
- Angka & total tulis POLOS tanpa tanda apapun: "TOTAL Rp 142.500" BUKAN "**TOTAL Rp 142.500**"

KUNCI KONTEKS PRODUK
- Produk sudah ditentukan dari iklan: ${namaProduk}. KUNCI.
- JANGAN ganti produk kecuali customer minta sendiri.
- Angka/contoh dari percakapan lain JANGAN kebawa.
- SATUAN PRODUK: Customer bisa sebut "box", "botol", "sachet", "pcs", "bungkus", "kotak", "pak", "dus", atau istilah lain — SEMUANYA SAMA, mengacu ke satuan produk ini. JANGAN bilang tidak tahu atau tidak paham. Pahami dan proses seperti biasa.

ATURAN HARGA, ONGKIR & COD
- Harga/dosis/klaim HANYA dari DATA PRODUK. JANGAN ngarang.
- Semua angka diambil dari SISTEM, bukan dihitung dari ingatan.
- Sebelum kasih TOTAL → WAJIB konfirmasi WILAYAH dulu.
- ⚠️ WAJIB: Setiap kali kamu konfirmasi wilayah ke customer, tulis [WILAYAH_OK:wilayah lengkap] di akhir pesan. Sistem pakai ini untuk hitung ongkir.
  Contoh: "Oke kak, Medan Timur ya! 😊 [WILAYAH_OK:Medan Timur, Medan, Sumatera Utara]"
  Contoh: "Siap kak, Mariso Makassar ya 😊 [WILAYAH_OK:Mariso, Makassar, Sulawesi Selatan]"
- ⛔ JANGAN PERNAH bilang "sebentar aku cek ongkir", "aku cek ongkirnya dulu", "tunggu ya", "aku hitung dulu" — SEMUA variasi ini DILARANG. Sistem hitung OTOMATIS saat kamu tulis [WILAYAH_OK:]. Kamu TIDAK PERLU cek apapun — langsung tulis [WILAYAH_OK:] dan sistem yang handle.
- ⛔ DILARANG KERAS mengarang/estimasi ongkir sendiri (misal "ongkirnya sekitar Rp 35.000-45.000"). Kamu TIDAK TAHU ongkir — HANYA sistem yang bisa hitung. Kalau sistem belum kasih data ongkir, JANGAN sebut angka ongkir apapun. Tunggu sistem hitung via [WILAYAH_OK:].
- ⛔ JANGAN tanya "COD atau transfer?" SEBELUM ongkir dihitung. Urutan WAJIB: wilayah → [WILAYAH_OK:] → sistem tampilkan total → BARU tanya metode bayar.
- ⛔ HANYA KOTA/KABUPATEN = TANYA KECAMATAN DULU dengan natural, sebut 2-3 kecamatan sebagai contoh. Misal: "Bantulnya di Sewon, Kasihan, atau kecamatan mana kak? 😊". Sistem akan bantu deteksi otomatis.
- ⛔ KECAMATAN SAJA = TANYA KELURAHAN/DESA DULU dengan natural, sebut 2-3 contoh kelurahan. Misal: "Di desa mana kak? Pendowoharjo, Bangunharjo, atau yang lain? 😊". Sistem akan inject pilihan kelurahan yang valid.
- Sebelum [WILAYAH_OK] → wilayah HARUS sudah spesifik sampai KELURAHAN/DESA.
- Setelah customer sebut kelurahan → langsung confirm + tulis [WILAYAH_OK] di pesan yang SAMA → sistem otomatis hitung ongkir + tampilkan total.
  ⚠️ JANGAN tanya "sudah benar kak?" dulu sebelum tulis [WILAYAH_OK:] — langsung confirm sekalian. Contoh: "Siap kak! Desa Sipodeceng, Kec. Baranti, Kab. Sidrap ya 😊 [WILAYAH_OK:Sipodeceng, Baranti, Sidrap, Sulawesi Selatan]"
  ⚠️ Kalau kamu sudah terlanjur tampilkan ringkasan alamat dan tanya "sudah benar?", lalu customer jawab "benar/ya/iya/betul/oke/siap/betul sekali/benar sekali" → WAJIB langsung tulis [WILAYAH_OK:kecamatan, kabupaten, provinsi] di balasan itu. Jangan balas hanya "Siap kak!" tanpa [WILAYAH_OK:].
  ⚠️ Kalau kamu sudah tahu kelurahan/kecamatan/kabupaten dari percakapan sebelumnya (kamu sendiri sudah sebut di pesan lalu), tapi belum tulis [WILAYAH_OK:] → WAJIB tulis [WILAYAH_OK:] di pesan berikutnya sekarang juga. Jangan tunggu customer konfirmasi lagi. Jangan balas "noted" atau hal lain tanpa [WILAYAH_OK:].
  ⚠️ Customer marah/tidak mau ditanya ulang → JANGAN tanya lagi. Pakai wilayah yang sudah disebutkan customer, langsung tulis [WILAYAH_OK:] dan lanjut proses order.
  ⚠️ Kalau kamu sudah TAHU wilayah customer (dari percakapan, profil, atau context) → LANGSUNG tulis [WILAYAH_OK:] di pesan itu juga. JANGAN simpan di otak dan bilang "aku cek dulu" — tulis marker-nya SEKARANG.
- Wilayah parsial (nama desa/kecamatan kecil yang unik) → tebak & konfirmasi provinsinya: "Pringsewu, Lampung ya kak?"
- Wilayah ambigu → nama yang sama ada di banyak provinsi di Indonesia. Kamu sebagai AI tahu mana yang ambigu — kalau ragu, WAJIB tanya, jangan tebak.
  Prinsip: kalau nama itu bisa jadi kota/kab di lebih dari satu provinsi, TANYA dulu.
  Contoh respons: "Ambarawa-nya di Jateng atau Lampung ya kak? 😊" / "Batu yang di Malang atau yang lain kak?"
  JANGAN tulis [WILAYAH_OK:...] sebelum provinsi dipastikan oleh customer.
- Wilayah tak konsisten → konfirmasi halus, jangan asal proses.
- Kurir dipilih SISTEM berdasarkan grade + ongkir daerah itu.
- Fee COD sudah DIGABUNG ke angka ongkir. DILARANG KERAS menyebut "admin COD", "fee COD", atau "biaya admin" ke customer — cukup sebut "ongkir" saja.
- Kalau ditanya "pengiriman dari mana" → jawab dari DATA PRODUK di atas (Asal pengiriman). Jangan bilang "tidak bisa info".
- Promo ongkir diterapkan SISTEM (berlaku COD & transfer).

FORMAT TAMPIL HARGA (pakai persis ini saat tampilkan total)
${hasBundling ? `Paket ${namaProduk} — setelah customer pilih paket, tampilkan total:` : `${namaProduk} ${harga} 😊`}

💳 Transfer
${namaProduk} {qty} box ${hasBundling ? '{harga_paket}' : harga} + ongkir ~{ongkir_asli}~ {ongkir_promo} = TOTAL

📦 COD
${namaProduk} {qty} box ${hasBundling ? '{harga_paket}' : harga} + ongkir ~{ongkir_asli}~ {ongkir_promo} + admin {fee} = TOTAL

Via {ekspedisi} ya kak 🚗
Kakak enaknya COD atau transfer? 🙏

Catatan format: ~text~ adalah strikethrough di WhatsApp. Kalau tidak ada promo ongkir, jangan pakai strikethrough — tulis angka ongkir langsung.
⚠️ PENTING: TOTAL WAJIB dihitung pakai ongkir_promo (angka SETELAH diskon), BUKAN ongkir_asli. Angka ongkir_asli hanya untuk ditampilkan dengan strikethrough (~coret~), JANGAN dipakai untuk menghitung total.

ALUR CATAT ORDER
Urutan WAJIB diikuti:
1. Dapat wilayah → konfirmasi dengan [WILAYAH_OK:nama wilayah] → sistem tampilkan total TF & COD otomatis → tanya "Kakak enaknya COD atau transfer? 🙏"
2. Customer pilih TF/COD → BARU minta data yang BELUM ADA saja
3. CEK dulu data dari form (nama/HP/alamat). Yang sudah ada → JANGAN ditanya ulang, cukup konfirmasi.
4. Yang kurang: (1) nama (2) no HP (3) alamat lengkap (jalan/gang, no rumah, RT/RW, kelurahan, kecamatan, patokan).
5. Alamat kurang → minta yang kurang aja, jangan ulang dari nol.
6. Ada jalan/gang → boleh proaktif tawarkan patokan dari maps.
7. Setelah semua data terkumpul (nama ✓, alamat ✓, metode bayar ✓) dan total sudah ditampilkan → langsung tulis di akhir balasan:
   [ORDER_CONFIRMED]
   [ORDER_DATA:alamat="ALAMAT LENGKAP DARI CUSTOMER" keluhan="KELUHAN UTAMA CUSTOMER" metode="COD atau Transfer" qty=JUMLAH_YANG_DIPESAN]
   ⚠️ qty WAJIB diisi angka sesuai jumlah box yang dipesan customer (contoh: qty=4). JANGAN biarkan qty=1 kalau customer pesan lebih dari 1.
   Isi ORDER_DATA dengan data AKTUAL yang sudah dikumpulkan dari customer. Jangan dikosongkan.
   Sistem akan otomatis kirim konfirmasi detail ke customer — JANGAN tulis ulang ringkasan order di pesanmu.
⛔ DILARANG tulis [ORDER_CONFIRMED] kecuali SEMUA kondisi ini terpenuhi:
   - Sudah tunjukkan total harga (termasuk ongkir)
   - Sudah dapat nama + alamat lengkap + metode bayar dari customer
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
- "Estimasi sampai berapa hari?" → Ada 3 kondisi:
  1. Sudah ada data kurir (ongkir sudah dihitung) → jawab langsung pakai kurir yang sudah ada, contoh: "Via JNE biasanya 2-4 hari kerja kak 😊" — JANGAN tanya wilayah lagi.
  2. Wilayah sudah disebut tapi ongkir belum dihitung → JANGAN kasih estimasi ongkir atau estimasi hari. Langsung konfirmasi wilayahnya dan tulis [WILAYAH_OK:] biar sistem hitung. Contoh: "Siap kak, aku cekkan ongkirnya ke sana ya 😊 [WILAYAH_OK:Medan, Medan, Sumatera Utara]" — kalau belum tahu kecamatannya, tanya dulu kecamatan.
  3. Belum ada info wilayah sama sekali → "Tergantung wilayahnya kak, dari mana kak?" lalu setelah dapat wilayah baru cek.
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

TEKNIK CLOSING (gunakan sesuai konteks, jangan dipaksakan)

1. SOCIAL PROOF LOKAL — saat customer ragu atau tidak yakin
   - Sebut customer lain dari daerah/kondisi serupa yang sudah order/berhasil
   - Jangan generik "banyak yang beli" — spesifik lebih kuat
   - Contoh: "Kemarin ada yang dari Semarang juga, keluhan mirip, sekarang katanya udah jauh membaik 😊"
   - Versi singkat: "Ada beberapa kak dari Jawa Timur yang keluhan sama, rata-rata 2 minggu udah kerasa bedanya 😊"
   - ⚠️ Hanya gunakan kalau ada di product knowledge — JANGAN karang testimoni

2. HANDLE OBJECTION HARGA — customer bilang "di Shopee lebih murah", "mahal", dll
   - JANGAN pernah bilang "mungkin lebih murah di Shopee" atau "bisa jadi reseller" — itu validasi kompetitor, customer langsung kabur
   - JANGAN setuju bahwa Shopee adalah pilihan yang valid
   - Reframe ke RISIKO beli di luar: produk herbal palsu/expired/repackaged marak di marketplace
   - Tegaskan keunggulan beli langsung: langsung dari produsen, terjamin asli, ada garansi
   - Contoh respons pertama: "Wah kalau harganya jauh beda perlu hati-hati kak 🙏 Produk herbal di marketplace banyak yang palsu atau kualitasnya beda — kami langsung produsen, jadi 100% asli. Kalau tidak cocok kami tanggung"
   - Kalau customer bilang "sama persis merknya":
     ⛔ JANGAN bilang "bisa jadi reseller, harga memang beda" — itu bikin customer makin yakin beli di Shopee
     ✅ Jawab: "Merk sama belum tentu asli kak 🙏 Banyak yang jual Herbapil palsu atau sudah expired di marketplace. Di sini langsung dari gudang kami, ada garansi keaslian. Sayang kalau kak sudah keluar uang tapi tidak dapat hasil"
   - Kalau customer masih ragu → tutup dengan assumptive close: "Yuk kak, aku bantu proses sekarang — ongkirnya aku cek dulu, dari mana kak?"

3. ASSUMPTIVE CLOSE — saat customer sudah hampir deal, tanda-tanda mau order
   - JANGAN tanya "jadi beli ga?" — langsung tanya detail seolah sudah deal
   - Contoh: "Kak mau ambil 1 dulu atau langsung 2 botol? Kalau 2 ongkirnya bisa lebih hemat 😊"
   - Contoh: "Siap kak! Alamatnya di mana ya biar aku cek ongkirnya?"
   - Tanda-tanda mau order: tanya stok, tanya ongkir, minta rekening, sudah sebut alamat

4. PAIN AMPLIFIER — saat customer mulai mendingin, ragu, atau mau pikir-pikir dulu
   - Ingatkan kembali keluhan yang mereka ceritakan di awal dengan empati
   - Jangan menghakimi — frame sebagai kepedulian
   - Contoh: "Sayang kak kalau dibiarkan, tadi bilang udah [X bulan] — biasanya makin lama makin susah diatasi 🙏"
   - Contoh: "Aku ngerti kak, tapi yang kak ceritain tadi soal [keluhan] itu kalau terus dibiarkan kasihan juga kan 😊"
   - Gunakan keluhan spesifik customer dari [KELUHAN:] yang sudah tersimpan

5. FUTURE PACING — setelah jelasin produk, sebelum customer memutuskan
   - Ajak customer bayangkan kondisi setelah pakai produk
   - Buat terasa nyata dan relevan ke keluhan mereka
   - Contoh: "Biasanya minggu pertama udah mulai kerasa bedanya kak — tidur lebih nyenyak, napas lebih lega 😊"
   - Contoh: "Kalau rutin 2 minggu, keluhan yang kak rasain sekarang biasanya udah jauh berkurang"
   - ⚠️ Hanya klaim yang ada di product knowledge — jangan lebay atau janji berlebihan

URUTAN IDEAL CLOSING:
Konsultasi baik → Future Pacing → Assumptive Close → [kalau ragu] Pain Amplifier / Social Proof → [kalau keberatan harga] Handle Objection Harga

KALAU CUSTOMER MARAH / KOMPLAIN KERAS
Tetap tenang, empati, dan coba selesaikan sendiri. Contoh: "Aduh maaf banget kak, nanti aku bantu pastiin ya 🙏"
Jangan panik, jangan lepas tangan. CS manusia bisa ambil alih kapanpun dari dashboard kalau dibutuhkan.

TUJUAN AKHIR
Customer merasa DIDENGAR & terbantu. Kalau cocok → order tercatat.
Customer puas balik lagi & rekomendasiin > maksa satu transaksi.`;
}

const PROVINSI_JAWA = ['dki jakarta','jawa barat','jawa tengah','di yogyakarta','yogyakarta','jawa timur','banten'];
function isDalamJawa(provinsi) {
  if (!provinsi) return false;
  const p = provinsi.toLowerCase().trim();
  const result = PROVINSI_JAWA.some(j => p === j || p.includes(j));
  console.log(`[PROMO] isDalamJawa("${provinsi}") = ${result}`);
  return result;
}
function getPromoPotongan(promo, provinsi, ongkirAsli = 0) {
  if (!promo) return 0;
  const isPersen = promo.unit === 'persen';
  const calc = (nilai) => isPersen ? Math.round(ongkirAsli * (nilai / 100)) : (nilai || 0);
  if (promo.tipe === 'potong') return calc(promo.nilai);
  if (promo.tipe === 'potong_wilayah') return isDalamJawa(provinsi) ? calc(promo.nilai_jawa) : calc(promo.nilai_luar);
  return 0;
}

// Cari harga bundling untuk qty tertentu. Kalau tidak match → fallback harga satuan × qty
function resolveHargaBundling(product, qty = 1) {
  const satuan = product?.harga || 0;
  const bundling = product?.harga_bundling;
  if (!Array.isArray(bundling) || !bundling.length) return satuan * qty;
  const exact = bundling.find(p => p.qty === qty);
  if (exact) return exact.harga;
  // Tidak ada paket yang cocok → satuan × qty
  return satuan * qty;
}

function formatPromoOngkir(promo) {
  if (!promo || promo.tipe === 'none') return 'tidak ada';
  const isPersen = promo.unit === 'persen';
  const fmt = (v) => isPersen ? `${v}%` : `Rp ${(v||0).toLocaleString('id-ID')}`;
  if (promo.tipe === 'gratis_penuh') return 'GRATIS ongkir';
  if (promo.tipe === 'potong') return `Hemat ${fmt(promo.nilai)} dari ongkir (semua wilayah)`;
  if (promo.tipe === 'potong_wilayah') return `Dalam Jawa hemat ${fmt(promo.nilai_jawa)} · Luar Jawa hemat ${fmt(promo.nilai_luar)}`;
  if (promo.tipe === 'gratis_sd') return `Gratis ongkir s/d Rp ${promo.nilai?.toLocaleString('id-ID')}`;
  return 'ada promo';
}

/* ── GET HISTORY & CONTEXT INJECTION ─────────────────────── */
async function getContextMessages(conversationId, afterTimestamp = null, limit = 20) {
  // Ambil N pesan TERAKHIR — caller bisa set limit lebih kecil kalau ada ringkasan
  const timeFilter = afterTimestamp ? `&created_at=gte.${encodeURIComponent(afterTimestamp)}` : '';
  const msgs = await sbGet('conv_messages',
    `?conversation_id=eq.${conversationId}&order=created_at.desc&limit=${limit}${timeFilter}`
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

  // Harus diakhiri 'user' (Claude API tidak boleh berakhir dengan assistant)
  while (result.length && result[result.length - 1].role === 'assistant') result.pop();

  return result;
}

/* ── UPDATE RINGKASAN BERJALAN (non-blocking) ─────────────── */
async function updateRingkasan(conversationId, aiKey, aiBase) {
  try {
    const msgs = await sbGet('conv_messages',
      `?conversation_id=eq.${conversationId}&order=created_at.desc&limit=50`
    );
    if (msgs.length < 6) return; // belum cukup untuk diringkas

    const transcript = msgs.reverse().map(m =>
      `${m.role === 'customer' ? 'Customer' : 'AI'}: ${m.isi}`
    ).join('\n');

    const ringkasan = await callClaude(
      'Buat ringkasan singkat percakapan CS ini dalam 3-5 kalimat bahasa Indonesia. Fokus pada: keluhan customer, produk yang dibahas, tahap percakapan (konsultasi/tertarik/mau beli/sudah order), dan data yang sudah terkumpul (nama/HP/alamat). Singkat dan padat.',
      [{ role: 'user', content: transcript }],
      'claude-haiku-4-5-20251001',
      aiKey,
      aiBase
    );

    if (ringkasan) {
      await sbPatch('conversations', `?id=eq.${conversationId}`, { ringkasan });
    }
  } catch (e) {
    console.error('updateRingkasan error:', e.message);
  }
}

async function saveMessage(conversationId, role, isi, wamid = null) {
  const payload = { conversation_id: conversationId, role, isi };
  if (wamid) payload.wamid = wamid;
  try {
    return await sbPost('conv_messages', payload);
  } catch (e) {
    // 23505 = unique constraint violation (wamid sudah ada) — race condition, skip
    if (e.message?.includes('23505')) {
      console.log(`[saveMessage] Duplicate wamid ${wamid}, skip (race condition)`);
      return [];
    }
    throw e;
  }
}

/* ── RESOLVE AI ENDPOINT — product-level → user-level fallback ── */
const MWAPI_BASE = 'https://api.mwapi.dev';
const ANTHROPIC_BASE = 'https://api.anthropic.com';

function resolveAI(product, userAnthropicKey) {
  // 1. Product punya ai_api_key → pakai sesuai provider
  if (product?.ai_api_key) {
    const base = product.ai_provider === 'mwapi' ? MWAPI_BASE : ANTHROPIC_BASE;
    return { key: product.ai_api_key, base };
  }
  // 2. Fallback ke user anthropic_key dari Settings
  if (userAnthropicKey) {
    return { key: userAnthropicKey, base: ANTHROPIC_BASE };
  }
  return { key: null, base: ANTHROPIC_BASE };
}

/* ── CALL CLAUDE ──────────────────────────────────────────── */
async function callClaude(systemPrompt, messages, model = 'claude-sonnet-4-6', apiKey = null, baseUrl = null) {
  const key = apiKey;
  if (!key) throw new Error('API key AI belum diset (cek Settings atau Product)');
  const base = baseUrl || ANTHROPIC_BASE;

  const res = await fetchWithTimeout(`${base}/v1/messages`, {
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

// Filter dasar untuk kata yang PASTI bukan wilayah (validasi utama tetap via Supabase)
const BUKAN_WILAYAH = /^(ya|oke|siap|baik|iya|tidak|gak|ga|mau)\s/i;

// Ekstrak wilayah yang AI sedang konfirmasikan — pertanyaan ("Sumba NTT ya kak?")
function extractProposedWilayah(aiMsg) {
  const lines = aiMsg.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    // Pattern 1: "ke X ya kak?" / "jadi X ya kak?"
    let m = line.match(/(?:jadi\s+ke\s+|jadi\s+|ke\s+)([A-Za-z][A-Za-z\s,]{2,60}?)\s+ya\s+kak[?😊🙏\s]/i);

    // Pattern 2: "Berarti X ya kak?" / "Berarti X ya?"
    if (!m) m = line.match(/berarti\s+([A-Za-z][A-Za-z\s,]{2,60}?)\s+ya[\s?😊🙏]/i);

    // Pattern 3: "X ya kak?" di akhir (tanda tanya = pertanyaan)
    if (!m) m = line.match(/([A-Za-z][A-Za-z\s,]{5,60}?)\s+ya\s+kak\s*\?/i);

    // Pattern 4: "X ya 😊" — bot konfirmasi wilayah tanpa kata "kak" (misal: "Bangunjiwo, Kasihan, Bantul ya 😊")
    // Harus ada koma (agar tidak terlalu agresif menangkap kalimat biasa)
    if (!m) m = line.match(/([A-Za-z][A-Za-zÀ-ÿ\s,\.]{5,60}?,\s*[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s,\.]{2,40}?)\s+ya\s*[😊🙏😄🙂✅]/u);

    if (m) {
      let candidate = m[1].trim().replace(/[,?!]+$/, '');
      // Strip kata wrapper wilayah: "Kelurahannya Kota Baru" → "Kota Baru"
      candidate = candidate.replace(/\b(kelurahannya|kelurahan|desanya|desa|kecamatannya|kecamatan|kabupatennya|kabupaten|kotanya|provinsinya|provinsi|alamatnya|alamat|daerahnya|daerah|wilayahnya|wilayah)\b/gi, '').replace(/\s+/g, ' ').trim();
      // Kalau candidate diawali kata bukan-wilayah (misal "Baik kak, Sewon, Bantul") → strip prefix sebelum koma pertama
      if (BUKAN_WILAYAH.test(candidate)) {
        const firstComma = candidate.indexOf(',');
        if (firstComma > 0) candidate = candidate.slice(firstComma + 1).trim();
      }
      const wordCount = candidate.split(/\s+/).length;
      // Filter: reject garbage ("atau kecamatan lain", "mana ya", dll)
      if (/\b(atau|lain|mana|yang|belum|tidak|bukan|apakah)\b/i.test(candidate)) continue;
      // Filter dasar saja, validasi utama via Supabase
      if (candidate.length >= 3 && wordCount <= 8 && !BUKAN_WILAYAH.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// extractConfirmedWilayah dihapus — pakai [WILAYAH_OK:] marker saja

/* ── EXTRACT LOKASI PAKAI HAIKU (untuk reply customer setelah AI tanya alamat) ── */
async function extractLokasiHaiku(text, apiKey, baseUrl = null) {
  const key = apiKey;
  if (!key) return null;
  const base = baseUrl || ANTHROPIC_BASE;
  const prompt = `Dari teks berikut, ekstrak nama kelurahan/desa, kecamatan, dan kabupaten/kota di Indonesia jika ada.
Teks: "${text}"
Jawab dengan JSON saja tanpa penjelasan: {"kelurahan":"...","kecamatan":"...","kabupaten":"..."} atau null jika tidak ada nama wilayah Indonesia yang jelas.
Isi field yang ada saja, kosongkan yang tidak disebutkan. Jangan mengarang.`;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '';
    if (!raw || raw === 'null') return null;
    const parsed = JSON.parse(raw);
    if (!parsed.kecamatan && !parsed.kabupaten && !parsed.kelurahan) return null;
    return parsed;
  } catch { return null; }
}

/* ── AI MATCH KELURAHAN — pakai Sonnet untuk analisis jawaban customer ── */
// Kalau pending_kecamatan aktif dan customer jawab, kirim 1 pesan ke AI
// dengan list candidates → AI pilihkan kelurahan yang dimaksud
async function aiMatchKelurahan(customerMsg, candidates, kecamatan, kabupaten, apiKey, baseUrl = null) {
  if (!apiKey || !candidates?.length) return null;
  const base = baseUrl || ANTHROPIC_BASE;
  const prompt = `Customer sedang ditanya kelurahan di Kec. ${kecamatan}, ${kabupaten}.
Daftar kelurahan yang valid: ${candidates.join(', ')}

Customer menjawab: "${customerMsg}"

Kelurahan mana yang dimaksud customer? Pertimbangkan typo, singkatan, atau ejaan tidak baku.
Jawab HANYA dengan nama kelurahan persis dari daftar di atas, atau "null" jika benar-benar tidak bisa ditentukan.`;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 50, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const raw = (data.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    if (!raw || raw === 'null') return null;
    // Pastikan jawaban AI memang ada di candidates
    const matched = candidates.find(c => c.toLowerCase() === raw.toLowerCase());
    if (matched) {
      console.log(`[aiMatchKel] "${customerMsg}" → "${matched}" (Sonnet match)`);
      return matched;
    }
    // Fallback: cek partial match (AI mungkin jawab sedikit beda format)
    const partial = candidates.find(c => raw.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(raw.toLowerCase()));
    if (partial) {
      console.log(`[aiMatchKel] "${customerMsg}" → "${partial}" (partial match from "${raw}")`);
      return partial;
    }
    console.log(`[aiMatchKel] "${customerMsg}" → AI jawab "${raw}" tapi tidak ada di candidates`);
    return null;
  } catch(e) { console.error('[aiMatchKel] Error:', e.message); return null; }
}

/* ── NORMALISASI ANGKA → HURUF untuk nama wilayah Indonesia ── */
const ANGKA_MAP = { '1':'Satu','2':'Dua','3':'Tiga','4':'Empat','5':'Lima','6':'Enam','7':'Tujuh','8':'Delapan','9':'Sembilan','10':'Sepuluh',
  '11':'Sebelas','12':'Dua Belas','13':'Tiga Belas','14':'Empat Belas','15':'Lima Belas' };
function normalizeAngkaWilayah(str) {
  if (!str) return str;
  // "Woloan 1 Utara" → "Woloan Satu Utara", "Taratara 2" → "Taratara Dua"
  return str.replace(/\b(\d{1,2})\b/g, (m, num) => ANGKA_MAP[num] || m);
}

/* ── VALIDASI WILAYAH via DB wilayah_id ────────────────────── */
// Terima object dari Haiku extract, validasi & lengkapi dari DB
// Return: { valid: true, row: {kelurahan,kecamatan,kabupaten,provinsi}, missing: [] }
//    atau { valid: false, row: partial|null, missing: ['kelurahan'|'kecamatan'|'kabupaten'], candidates: [...] }
async function validateWilayahDB(lokasi) {
  if (!lokasi) return { valid: false, row: null, missing: ['kelurahan','kecamatan','kabupaten'] };
  // Normalisasi angka → huruf (1→Satu, 2→Dua, dst) karena DB pakai huruf
  const kel = normalizeAngkaWilayah((lokasi.kelurahan || '').trim());
  const kec = normalizeAngkaWilayah((lokasi.kecamatan || '').trim());
  const kab = (lokasi.kabupaten || '').trim(); // kabupaten jarang pakai angka

  // Case 1: ketiga field ada → cek exact match di DB
  if (kel && kec && kab) {
    const exact = await sbGet('wilayah_id',
      `?kelurahan=ilike.${encodeURIComponent(kel)}&kecamatan=ilike.${encodeURIComponent(kec)}&kabupaten=ilike.*${encodeURIComponent(kab)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=1`
    ).catch(() => []);
    if (exact.length) return { valid: true, row: exact[0], missing: [] };
    // Mungkin kelurahan typo → coba kec+kab aja, nanti tanya kelurahan
    const kecKab = await sbGet('wilayah_id',
      `?kecamatan=ilike.${encodeURIComponent(kec)}&kabupaten=ilike.*${encodeURIComponent(kab)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=20`
    ).catch(() => []);
    if (kecKab.length) {
      // kec+kab valid tapi kelurahan ga cocok
      const kelList = [...new Set(kecKab.map(r => r.kelurahan))];
      return { valid: false, row: { kecamatan: kecKab[0].kecamatan, kabupaten: kecKab[0].kabupaten, provinsi: kecKab[0].provinsi }, missing: ['kelurahan'], candidates: kelList };
    }
  }

  // Case 2: kecamatan + kabupaten ada, kelurahan kosong
  if (kec && kab) {
    const rows = await sbGet('wilayah_id',
      `?kecamatan=ilike.${encodeURIComponent(kec)}&kabupaten=ilike.*${encodeURIComponent(kab)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=20`
    ).catch(() => []);
    if (rows.length) {
      const kelList = [...new Set(rows.map(r => r.kelurahan))];
      return { valid: false, row: { kecamatan: rows[0].kecamatan, kabupaten: rows[0].kabupaten, provinsi: rows[0].provinsi }, missing: ['kelurahan'], candidates: kelList };
    }
  }

  // Case 3: kelurahan + kabupaten ada, kecamatan kosong → lookup
  if (kel && kab) {
    const rows = await sbGet('wilayah_id',
      `?kelurahan=ilike.${encodeURIComponent(kel)}&kabupaten=ilike.*${encodeURIComponent(kab)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=20`
    ).catch(() => []);
    const kecUnik = [...new Set(rows.map(r => r.kecamatan))];
    if (kecUnik.length === 1) return { valid: true, row: rows[0], missing: [] };
    if (kecUnik.length > 1) return { valid: false, row: { kelurahan: kel, kabupaten: rows[0].kabupaten, provinsi: rows[0].provinsi }, missing: ['kecamatan'], candidates: kecUnik };
  }

  // Case 4: kelurahan + kecamatan ada, kabupaten kosong → lookup
  if (kel && kec) {
    const rows = await sbGet('wilayah_id',
      `?kelurahan=ilike.${encodeURIComponent(kel)}&kecamatan=ilike.${encodeURIComponent(kec)}&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
    ).catch(() => []);
    if (rows.length === 1) return { valid: true, row: rows[0], missing: [] };
    if (rows.length > 1) {
      const kabList = [...new Set(rows.map(r => r.kabupaten))];
      return { valid: false, row: { kelurahan: kel, kecamatan: kec }, missing: ['kabupaten'], candidates: kabList };
    }
  }

  // Case 5: cuma kecamatan → cek berapa kabupaten
  if (kec) {
    const rows = await sbGet('wilayah_id',
      `?kecamatan=ilike.${encodeURIComponent(kec)}&select=kelurahan,kecamatan,kabupaten,provinsi&limit=50`
    ).catch(() => []);
    const kabUnik = [...new Set(rows.map(r => r.kabupaten))];
    if (kabUnik.length === 1) {
      const kelList = [...new Set(rows.map(r => r.kelurahan))];
      return { valid: false, row: { kecamatan: rows[0].kecamatan, kabupaten: rows[0].kabupaten, provinsi: rows[0].provinsi }, missing: ['kelurahan'], candidates: kelList };
    }
    if (kabUnik.length > 1) return { valid: false, row: { kecamatan: kec }, missing: ['kabupaten','kelurahan'], candidates: kabUnik };
  }

  // Case 6: cuma kelurahan → cek berapa kecamatan
  if (kel) {
    const rows = await sbGet('wilayah_id',
      `?kelurahan=ilike.${encodeURIComponent(kel)}&select=kelurahan,kecamatan,kabupaten,provinsi&limit=50`
    ).catch(() => []);
    const kecUnik = [...new Set(rows.map(r => `${r.kecamatan}||${r.kabupaten}`))];
    if (kecUnik.length === 1) return { valid: true, row: rows[0], missing: [] };
    if (kecUnik.length > 1) {
      const candidates = [...new Set(rows.map(r => `${r.kecamatan}, ${r.kabupaten}`))];
      return { valid: false, row: { kelurahan: kel }, missing: ['kecamatan','kabupaten'], candidates };
    }
  }

  // Case 7: cuma kabupaten atau ga ada sama sekali
  return { valid: false, row: kab ? { kabupaten: kab } : null, missing: ['kelurahan','kecamatan','kabupaten'] };
}

/* ── SEARCH WILAYAH LOKAL (tabel wilayah_id di Supabase) ─── */
const _wilayahCache = new Map();
async function cariWilayah(keyword, limit = 50) {
  const cacheKey = `${keyword}::${limit}`;
  if (_wilayahCache.has(cacheKey)) return _wilayahCache.get(cacheKey);
  try {
    const cleanPart = s => s.trim().toLowerCase()
      .replace(/\bkota\b/gi, '').replace(/\bkabupaten\b/gi, '').replace(/\bkab\b/gi, '')
      .replace(/\bprovinsi\b/gi, '').replace(/\bprov\b/gi, '').trim();

    // Kalau input comma-separated (misal: "Medan Timur, Medan" atau "Kranggan, Galur, Kulonprogo")
    const parts = keyword.split(',').map(cleanPart).filter(s => s.length >= 2);
    if (parts.length >= 2) {
      const [part1, part2, part3] = parts;

      // Coba: part1=kecamatan, part2=kabupaten
      const byKecKab = await sbGet('wilayah_id',
        `?kecamatan=ilike.*${encodeURIComponent(part1)}*&kabupaten=ilike.*${encodeURIComponent(part2)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
      ).catch(() => []);
      if (byKecKab.length > 0) { _wilayahCache.set(cacheKey, byKecKab); return byKecKab; }

      // Coba: part1=kelurahan, part2=kecamatan
      const byKelKec = await sbGet('wilayah_id',
        `?kelurahan=ilike.*${encodeURIComponent(part1)}*&kecamatan=ilike.*${encodeURIComponent(part2)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
      ).catch(() => []);
      if (byKelKec.length > 0) { _wilayahCache.set(cacheKey, byKelKec); return byKelKec; }

      // Coba dengan part3 kalau ada (kelurahan, kecamatan, kabupaten)
      if (part3) {
        const byAll = await sbGet('wilayah_id',
          `?kecamatan=ilike.*${encodeURIComponent(part2)}*&kabupaten=ilike.*${encodeURIComponent(part3)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`
        ).catch(() => []);
        if (byAll.length > 0) { _wilayahCache.set(cacheKey, byAll); return byAll; }
      }
    }

    const kw = cleanPart(keyword);
    if (kw.length < 2) return [];

    // Cari di semua level dengan limit tinggi untuk kabupaten/provinsi
    const [byKec, byKab, byKel, byProv] = await Promise.all([
      sbGet('wilayah_id', `?kecamatan=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`).catch(() => []),
      sbGet('wilayah_id', `?kabupaten=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=100`).catch(() => []), // limit tinggi untuk kab
      sbGet('wilayah_id', `?kelurahan=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=${limit}`).catch(() => []),
      sbGet('wilayah_id', `?provinsi=ilike.*${encodeURIComponent(kw)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=100`).catch(() => []), // limit tinggi untuk prov
    ]);

    // Gabung & deduplikasi berdasarkan kecamatan+kabupaten
    const seen = new Set();
    const merged = [];
    // Prioritas: kecamatan > kelurahan > kabupaten > provinsi (dari spesifik ke umum)
    for (const row of [...byKec, ...byKel, ...byKab, ...byProv]) {
      const key = `${row.kecamatan}||${row.kabupaten}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(row);
      }
    }
    _wilayahCache.set(cacheKey, merged);
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

// Format wilayah untuk query ke Mengantar — strip prefix Kabupaten/Kota agar Mengantar bisa match
function formatWilayahMengantar(row) {
  const stripKab = s => (s || '').replace(/^(kabupaten|kota|kab\.?)\s*/i, '').trim();
  return [row.kelurahan, row.kecamatan, stripKab(row.kabupaten), row.provinsi].filter(Boolean).join(', ');
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

// Bersihkan kata sopan/filler dari pesan sebelum search wilayah
// Contoh: "sewon kak" → "sewon", "pendowoharjo ya" → "pendowoharjo"
function cleanKelInput(msg) {
  return msg.trim().toLowerCase()
    .replace(/\b(kelurahannya|kelurahan|desanya|desa|kecamatannya|kecamatan|kabupatennya|kabupaten|kotanya|kota|provinsinya|provinsi|alamatnya|alamat|daerah|daerahnya|wilayah|wilayahnya|di\s+daerah|dari)\b/gi, '')
    .replace(/\b(kak|bang|pak|bu|mbak|mas|kang|mba|ya|iya|ok|oke|siap|dong|deh|lah|nih|sih|gan|bro|sis|sudah|sdh|udah|betul|bener|benar|yep|yup|boleh|lanjut|yoi|ini)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Deteksi apakah pesan customer adalah konfirmasi singkat
function isConfirmation(msg) {
  const lower = msg.toLowerCase().trim().replace(/[.!,]+$/, '');
  // Support variasi sapaan: kak, bu, pak, mas, mbak, bang, dll
  const sapaan = '(kak|bu|pak|mas|mbak|bang|mba|sis|bro|gan|ka)';
  const kata   = '(iya|ya|yakin|bener|betul|ok|oke|okey|yep|yup|iyah|bnar|benar|yes|confirm|bisa|boleh|lanjut|siap|yoi|iyaa|yaa|udah|sudah)';
  // "iya", "iya kak", "benar bu", "iya benar kak", "ya udah lanjut", dll
  return new RegExp(`^${kata}(\\s+${kata})?(\\s+${sapaan})?$`).test(lower);
}

// Cek apakah pesan MENGANDUNG kata konfirmasi (tidak harus seluruh pesan)
// Untuk kasus campuran seperti "Kel.Dr. Sutomo.Sby.ini sdh benar"
function containsConfirmation(msg) {
  const lower = msg.toLowerCase().replace(/[.,!?]+/g, ' ').trim();
  const konfirmasiWords = /\b(iya|ya|yakin|bener|betul|ok|oke|okey|yep|yup|iyah|benar|yes|confirm|bisa|boleh|lanjut|siap|yoi|udah|sudah|sdh)\b/;
  return konfirmasiWords.test(lower);
}

/* ── PEMBULATAN ke kelipatan terdekat ────────────────────── */
function bulatkan(nilai, kelipatan = 500) {
  const bawah = Math.floor(nilai / kelipatan) * kelipatan;
  const atas  = bawah + kelipatan;
  return (nilai - bawah) <= (atas - nilai) ? bawah : atas;
}

/* ── MENGANTAR PUBLIC API ─────────────────────────────────── */
const MENGANTAR_ORIGIN_ID = process.env.MENGANTAR_ORIGIN_ID || '5fc63315f8f44b34aa4c44c7';
const MENGANTAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
};

async function mengantarFetch(path, timeoutMs = 20000) {
  try {
    const res = await fetchWithTimeout(`https://app.mengantar.com/api/${path}`, { headers: MENGANTAR_HEADERS }, timeoutMs);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[mengantarFetch] HTTP ${res.status} — ${body.slice(0, 200)}`);
      return null;
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch(e) {
      console.error(`[mengantarFetch] JSON parse error — ${text.slice(0, 200)}`);
      return null;
    }
  } catch(e) {
    console.error(`[mengantarFetch] ${path.split('?')[0]} — ${e.message}`);
    return null;
  }
}

/* ── HITUNG ONGKIR via Mengantar public API ───────────────── */
// Terima object {kelurahan, kecamatan, kabupaten, provinsi} ATAU string (backward compat)
async function hitungOngkir(wilayahInput, product, qty = 1, userMngOriginId = null) {
  const stripKab = s => (s || '').replace(/^(kabupaten|kota|kab\.?)\s*/i, '').trim();
  let lokal = null;

  // ── Normalisasi input: object (preferred) vs string (legacy) ──
  if (typeof wilayahInput === 'object' && wilayahInput !== null && (wilayahInput.kecamatan || wilayahInput.kelurahan)) {
    // Object dari wilayah_data — sudah bersih, langsung pakai
    lokal = wilayahInput;
    console.log(`[hitungOngkir] START object: kel="${lokal.kelurahan}" kec="${lokal.kecamatan}" kab="${lokal.kabupaten}" qty=${qty}`);
  } else {
    // String legacy — strip prefix & cari di DB lokal
    let wilayah = String(wilayahInput || '');
    wilayah = wilayah.replace(/\b(kelurahannya|kelurahan|kel\.?|desanya|desa|ds\.?|kecamatannya|kecamatan|kec\.?|kabupatennya|kabupaten|kab\.?|kotanya|kota|provinsinya|provinsi|prov\.?|alamatnya|alamat|daerahnya|daerah|wilayahnya|wilayah)\b/gi, '').replace(/\s+/g, ' ').trim();
    console.log(`[hitungOngkir] START string="${wilayah}" qty=${qty} originId=${userMngOriginId || MENGANTAR_ORIGIN_ID}`);

    const lokalMatch = await cariWilayah(wilayah, 3);
    lokal = lokalMatch[0] || null;
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
  }

  try {
    // ── Bangun query Mengantar ──
    // Paling akurat: "kelurahan kecamatan" — 1 result tepat
    const queryFallbacks = lokal ? [
      lokal.kelurahan && lokal.kecamatan ? `${lokal.kelurahan} ${lokal.kecamatan}` : null,
      lokal.kelurahan,
      lokal.kecamatan,
      lokal.kecamatan && lokal.kabupaten ? `${lokal.kecamatan} ${stripKab(lokal.kabupaten)}` : null,
    ].filter(Boolean) : [String(wilayahInput || '')];

    let queryDisplay = lokal ? formatWilayah(lokal) : String(wilayahInput || '');
    if (lokal) console.log(`[hitungOngkir] lokal: "${lokal.kelurahan}, ${lokal.kecamatan}, ${lokal.kabupaten}" → queries: ${queryFallbacks.join(' | ')}`);

    // Kirim semua query fallback secara parallel
    const searchResults = await Promise.all(
      queryFallbacks.map(q =>
        mengantarFetch(`address/autofill?keyword=${encodeURIComponent(q)}`, 15000)
          .then(json => {
            const res = Array.isArray(json) ? json : (json?.data || []);
            console.log(`[hitungOngkir] search "${q}" → ${res.length} results`);
            return res;
          })
          .catch(() => [])
      )
    );
    const seenIds = new Set();
    const allAreas = searchResults.flat().filter(a => {
      const id = a._id || a.id;
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (!allAreas.length) {
      console.error(`[hitungOngkir] Semua search fallback gagal untuk "${queryDisplay}"`);
      return null;
    }

    // ── Pilih area terbaik — scoring ──
    const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aSubdistrict = a => a.SUBDISTRICT_NAME || a.subdistrict || '';
    const aDistrict    = a => a.DISTRICT_NAME    || a.district    || '';
    const aCity        = a => a.CITY_NAME        || a.city        || a.regency || '';
    const aProvince    = a => a.PROVINCE_NAME    || a.province    || '';

    let bestArea = allAreas[0], bestScore = -1;
    for (const a of allAreas) {
      let score = 0;
      if (lokal) {
        if (normStr(aSubdistrict(a)) === normStr(lokal.kelurahan)) score += 50;
        else if (lokal.kelurahan && aSubdistrict(a).toLowerCase().includes(lokal.kelurahan.toLowerCase())) score += 30;
        if (normStr(aDistrict(a)) === normStr(lokal.kecamatan)) score += 30;
        else if (lokal.kecamatan && aDistrict(a).toLowerCase().includes(lokal.kecamatan.toLowerCase())) score += 15;
        if (normStr(aCity(a)) === normStr(lokal.kabupaten)) score += 20;
        if (normStr(aProvince(a)) === normStr(lokal.provinsi)) score += 10;
      } else {
        const parts = String(wilayahInput || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        for (const part of parts) {
          if (normStr(aSubdistrict(a)) === normStr(part)) score += 50;
          else if (aSubdistrict(a).toLowerCase().includes(part)) score += 25;
          if (normStr(aDistrict(a)) === normStr(part)) score += 30;
          else if (aDistrict(a).toLowerCase().includes(part)) score += 15;
          if (normStr(aCity(a)) === normStr(part)) score += 20;
          else if (aCity(a).toLowerCase().includes(part)) score += 10;
          if (normStr(aProvince(a)) === normStr(part)) score += 10;
        }
      }
      if (score > bestScore) { bestScore = score; bestArea = a; }
    }
    const areas = allAreas;

    const areaId  = bestArea._id || bestArea.id;
    const areaNama = aSubdistrict(bestArea) || bestArea.name || wilayah;
    console.log(`[hitungOngkir] best area: "${areaNama}" id=${areaId} score=${bestScore}`);
    if (!areaId) { console.error('[hitungOngkir] areaId null'); return null; }

    // Step 3c: Ambil estimasi tarif
    const weight = ((product?.berat_gram || 1000) / 1000) * qty;
    const originId = userMngOriginId || MENGANTAR_ORIGIN_ID;
    const ratesJson = await mengantarFetch(
      `order/allEstimatePublic?origin_id=${originId}&destination_id=${areaId}&weight=${weight}`,
      30000
    );
    if (!ratesJson) { console.error(`[hitungOngkir] allEstimatePublic null`); return null; }
    console.log(`[hitungOngkir] rates success=${ratesJson.success}`);
    if (!ratesJson.success) {
      console.error(`[hitungOngkir] allEstimatePublic gagal: ${JSON.stringify(ratesJson).slice(0,200)}`);
      return null;
    }

    const rawData = ratesJson.data || {};
    let rates = Object.entries(rawData)
      .filter(([name, info]) => !name.toLowerCase().includes('cargo') && !info.unsupported && (info.price || 0) > 0)
      .map(([name, info]) => ({ courier_name: name, price: info.price, cod_supported: !info.unsupported_cod }));
    if (!rates.length) return null;

    // Step 4: Filter whitelist
    const whitelist = await sbGet('courier_whitelist',
      `?user_id=eq.${product?.user_id || ''}&aktif=eq.true`
    ).catch(() => []);
    console.log(`[hitungOngkir] whitelist=${whitelist.map(w=>w.nama).join(',')} rates=${rates.map(r=>`${r.courier_name}:${r.price}`).join(',')}`);
    if (whitelist.length) {
      const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const filtered = rates.filter(r => {
        const rn = norm(r.courier_name);
        return whitelist.some(w => { const wn = norm(w.nama); return rn === wn || rn.startsWith(wn) || wn.startsWith(rn); });
      });
      if (filtered.length) rates = filtered;
    }

    // Step 5: Pilih termurah
    rates.sort((a, b) => a.price - b.price);
    const best       = rates[0];
    const ekspedisi  = best.courier_name;
    const ongkirAsli = best.price;

    // Step 6: Promo ongkir — cek diskon per bundling dulu, fallback ke promo_ongkir global
    const promo    = product?.promo_ongkir;
    const provinsi = lokal?.provinsi || bestArea.province || '';
    const diskonQtyItem = Array.isArray(product?.diskon_ongkir_per_qty)
      ? product.diskon_ongkir_per_qty.find(d => d.qty === qty)
      : null;
    const diskonOngkirPct = diskonQtyItem?.diskon || 0;

    function applyDiskon(ongkirRaw) {
      if (diskonOngkirPct >= 100) return 0;
      if (diskonOngkirPct > 0) return Math.round(ongkirRaw * (1 - diskonOngkirPct / 100));
      // fallback ke promo_ongkir global
      if (promo?.tipe === 'gratis_penuh')        return 0;
      if (promo?.tipe === 'potong')              return Math.max(0, ongkirRaw - getPromoPotongan(promo, null, ongkirRaw));
      if (promo?.tipe === 'potong_wilayah')      return Math.max(0, ongkirRaw - getPromoPotongan(promo, provinsi, ongkirRaw));
      if (promo?.tipe === 'gratis_sd')           return Math.max(0, ongkirRaw - (promo.nilai || 0));
      return ongkirRaw;
    }

    let ongkirPromo = applyDiskon(ongkirAsli);

    const harga = resolveHargaBundling(product, qty);

    // Step 7: Hitung total
    const feeCOD             = Math.ceil((harga + ongkirPromo) * 0.03);
    const totalTransferBulat = bulatkan(harga + ongkirPromo);
    const totalCODBulat      = bulatkan(harga + ongkirPromo + feeCOD);
    const feeCODBulat        = totalCODBulat - harga - ongkirPromo;

    const allRates = rates.map(r => {
      const rPromo  = applyDiskon(r.price);
      const rFeeCOD = Math.ceil((harga + rPromo) * 0.03);
      return { nama: r.courier_name, ongkir: r.price, ongkirPromo: rPromo, totalTF: bulatkan(harga + rPromo), totalCOD: bulatkan(harga + rPromo + rFeeCOD), cod_supported: r.cod_supported };
    });

    // Cek apakah ada kurir yang support COD
    const codAvailable = allRates.some(r => r.cod_supported);

    return {
      ekspedisi, ongkirAsli, ongkirPromo,
      totalTransfer: totalTransferBulat,
      totalCOD: totalCODBulat,
      feeCOD: feeCODBulat,
      harga, allRates,
      cod_available: codAvailable,
      area: {
        kelurahan: lokal?.kelurahan || bestArea.SUBDISTRICT_NAME || bestArea.subdistrict || '',
        kecamatan: lokal?.kecamatan || bestArea.DISTRICT_NAME    || bestArea.district    || '',
        kota:      lokal?.kabupaten || bestArea.CITY_NAME        || bestArea.city        || bestArea.regency || '',
        provinsi:  lokal?.provinsi  || bestArea.PROVINCE_NAME    || bestArea.province    || '',
        kodePos:   bestArea.ZIP_CODE || bestArea.postal_code || bestArea.posCode || '',
      },
    };
  } catch(e) {
    console.error('[hitungOngkir] error:', e.message);
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
// Note: VPS Baileys sudah handle typing indicator + humanDelay built-in di sendMessage()
async function sendWA(sessionId, waNumber, message, isOutbound = false, imageUrl = null, caption = null) {
  if (!BAILEYS_URL) throw new Error('BAILEYS_URL belum diset');
  const res = await fetchWithTimeout(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      session_id: sessionId,
      wa_number: waNumber,
      message: imageUrl ? undefined : (message || ''),
      is_outbound: isOutbound,
      image_url: imageUrl || undefined,
      caption: caption || undefined,
    }),
  }, 30000); // 30 detik (text + gambar)
  if (!res.ok) throw new Error(`Baileys send error: ${await res.text()}`);
  return res.json();
}

/* ── CEK WILAYAH RISK dari kodepos_stats (Validasiorder) ─── */
async function cekWilayahRisk(kodepos) {
  if (!kodepos || !VALIDASI_URL || !VALIDASI_KEY) return null;
  try {
    const res = await fetch(
      `${VALIDASI_URL}/rest/v1/kodepos_stats?kodepos=eq.${encodeURIComponent(kodepos)}&limit=1`,
      { headers: { 'apikey': VALIDASI_KEY, 'Authorization': `Bearer ${VALIDASI_KEY}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const r = data[0];
    const pct   = r.pct ?? Math.round((r.retur / r.total) * 100);
    const level = pct >= 30 ? 'rawan' : pct >= 15 ? 'perhatian' : 'aman';
    const label = pct >= 30 ? `Rawan Tinggi (${pct}% RTS)` : pct >= 15 ? `Perlu Diperhatikan (${pct}% RTS)` : `Relatif Aman (${pct}% RTS)`;
    return { kodepos: String(kodepos), total: r.total, retur: r.retur, pct, level, label };
  } catch(e) {
    console.error('[cekWilayahRisk] error:', e.message);
    return null;
  }
}

/* ── BUILD INJEKSI ONGKIR untuk Claude ───────────────────── */
function buildOngkirInjeksi(hasil, product, konteks = '') {
  const fmt = (n) => `Rp ${n.toLocaleString('id-ID')}`;
  const ongkirAsli  = hasil.ongkirAsli;
  const ongkirPromo = hasil.ongkirPromo;
  const ongkirDisplay = ongkirAsli !== ongkirPromo
    ? `~${fmt(ongkirAsli)}~ ${fmt(ongkirPromo)}`
    : fmt(ongkirPromo);

  const areaFull = hasil.area
    ? [hasil.area.kecamatan, hasil.area.kota, hasil.area.provinsi].filter(Boolean).join(', ')
    : '';

  // Tabel semua kurir yang tersedia
  const tabelKurir = (hasil.allRates || []).map(r => {
    const potongan = r.ongkir !== r.ongkirPromo ? ` (hemat ${fmt(r.ongkir - r.ongkirPromo)})` : '';
    const codLabel = r.cod_supported ? '' : ' [COD ❌]';
    return `- ${r.nama}: ongkir ${fmt(r.ongkir)}${potongan} → TF total ${fmt(r.totalTF)}${r.cod_supported ? ` | COD total ${fmt(r.totalCOD)}` : ''}${codLabel}`;
  }).join('\n');

  const hasBundling = Array.isArray(product?.harga_bundling) && product.harga_bundling.length > 0;
  const paketPrioritas = hasBundling ? product.harga_bundling.find(p => p.prioritas) : null;

  let hargaSection;

  // Helper: hitung ongkir per qty (apply diskon_ongkir_per_qty kalau ada)
  const diskonOngkirPerQty = Array.isArray(product?.diskon_ongkir_per_qty) ? product.diskon_ongkir_per_qty : [];
  const promo = product?.promo_ongkir;
  function ongkirPerQty(qty) {
    const dok = diskonOngkirPerQty.find(d => d.qty === qty);
    if (dok) {
      if (dok.diskon >= 100) return 0;
      if (dok.diskon > 0) return Math.round(ongkirAsli * (1 - dok.diskon / 100));
    }
    // Fallback ke promo_ongkir global (sudah dihitung di ongkirPromo)
    return ongkirPromo;
  }

  const codOk = hasil.cod_available !== false; // default true kalau tidak ada info

  if (hasBundling) {
    const defaultPaket  = paketPrioritas || product.harga_bundling[0];
    const defaultHarga  = defaultPaket.harga;
    const defaultOngkir = ongkirPerQty(defaultPaket.qty);
    const defaultOngkirDisplay = ongkirAsli !== defaultOngkir
      ? `~${fmt(ongkirAsli)}~ ${fmt(defaultOngkir)} 🎉`
      : fmt(defaultOngkir);
    const defaultFeeCOD = Math.ceil((defaultHarga + defaultOngkir) * 0.03);
    const defaultTotalTF  = defaultHarga + defaultOngkir;
    const defaultTotalCOD = defaultHarga + defaultOngkir + defaultFeeCOD;

    // Tabel semua paket — tiap paket punya ongkir sendiri sesuai diskon qty-nya
    const tabelSemuaPaket = product.harga_bundling.map(p => {
      const hp     = p.harga;
      const pOngkir = ongkirPerQty(p.qty);
      const pOngkirInfo = ongkirAsli !== pOngkir ? ` (ongkir ${fmt(pOngkir)}, hemat ${fmt(ongkirAsli - pOngkir)})` : '';
      const fee    = Math.ceil((hp + pOngkir) * 0.03);
      const tTF    = hp + pOngkir;
      const tCOD   = hp + pOngkir + fee;
      return codOk
        ? `- Paket ${p.qty} box${p.bonus ? ` + bonus ${p.bonus}` : ''}${p.prioritas ? ' ⭐' : ''}${pOngkirInfo}: TF total ${fmt(tTF)} | COD total ${fmt(tCOD)}`
        : `- Paket ${p.qty} box${p.bonus ? ` + bonus ${p.bonus}` : ''}${p.prioritas ? ' ⭐' : ''}${pOngkirInfo}: Transfer total ${fmt(tTF)}`;
    }).join('\n');

    if (codOk) {
      hargaSection = `Tampilkan HANYA paket PRIORITAS ini ke customer (jangan ubah angka):

Paket ${defaultPaket.qty} box ${product?.nama || 'Produk'}:
💳 Transfer: ${fmt(defaultHarga)} + ongkir ${defaultOngkirDisplay} = TOTAL ${fmt(defaultTotalTF)}
📦 COD: ${fmt(defaultHarga)} + ongkir ${fmt(defaultOngkir + defaultFeeCOD)} = TOTAL ${fmt(defaultTotalCOD)}

Via ${hasil.ekspedisi} ya kak 🚗

Setelah tampilkan harga, tanya metode bayar: "Kakak enaknya COD atau Transfer? 😊"`;
    } else {
      hargaSection = `⚠️ COD TIDAK TERSEDIA untuk wilayah ini — semua kurir ke sana belum support COD.
Tampilkan HANYA opsi Transfer (jangan ubah angka):

Paket ${defaultPaket.qty} box ${product?.nama || 'Produk'}:
💳 Transfer: ${fmt(defaultHarga)} + ongkir ${defaultOngkirDisplay} = TOTAL ${fmt(defaultTotalTF)}

Via ${hasil.ekspedisi} ya kak 🚗

Sampaikan ke customer: "Untuk wilayah kak, pengiriman via Transfer ya kak 🙏 COD belum tersedia di sana."
Langsung lanjut minta data (nama, alamat) tanpa tanya COD/Transfer.`;
    }

    // Info harga satuan untuk kalau customer minta qty di luar bundling
    const satuanHarga = product?.harga || 0;
    const satuanOngkir = ongkirPerQty(1);
    const satuanFeeCOD = Math.ceil((satuanHarga + satuanOngkir) * 0.03);
    const satuanTotalTF = satuanHarga + satuanOngkir;
    const satuanTotalCOD = satuanHarga + satuanOngkir + satuanFeeCOD;

    hargaSection += `\n\nPAKET LAIN (jangan sebut ke customer kecuali customer nanya ada paket/harga lain):
${tabelSemuaPaket}

HARGA 1 BOX (kalau customer minta 1 saja):
${codOk
  ? `💳 Transfer: ${fmt(satuanHarga)} + ongkir ${fmt(satuanOngkir)} = TOTAL ${fmt(satuanTotalTF)}
📦 COD: ${fmt(satuanHarga)} + ongkir ${fmt(satuanOngkir + satuanFeeCOD)} = TOTAL ${fmt(satuanTotalCOD)}`
  : `💳 Transfer: ${fmt(satuanHarga)} + ongkir ${fmt(satuanOngkir)} = TOTAL ${fmt(satuanTotalTF)}`}
Kalau customer pilih 1 box: berikan harga di atas, lalu SEKALI rekomendasikan paket bundling lebih hemat. Kalau tetap pilih 1 → langsung proses, jangan paksa.`;

  } else {
    if (codOk) {
      // Produk tanpa bundling — tampilkan harga satuan normal
      hargaSection = `Tampilkan PERSIS ini ke customer (jangan ubah angka):

${product?.nama || 'Produk'} ${fmt(hasil.harga)}

💳 Transfer: ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(hasil.totalTransfer)}
📦 COD: ${fmt(hasil.harga)} + ongkir ${fmt((hasil.ongkirPromo || hasil.ongkirAsli || 0) + (hasil.feeCOD || 0))} = TOTAL ${fmt(hasil.totalCOD)}

Via ${hasil.ekspedisi} ya kak 🚗

SETELAH tampilkan harga di atas, tanya dengan santai: "Biasanya kakak lebih suka pakai kurir apa kak? Bisa aku cekkan juga 😊"`;
    } else {
      hargaSection = `⚠️ COD TIDAK TERSEDIA untuk wilayah ini — semua kurir ke sana belum support COD.
Tampilkan HANYA opsi Transfer (jangan ubah angka):

${product?.nama || 'Produk'} ${fmt(hasil.harga)}

💳 Transfer
${product?.nama || 'Produk'} ${fmt(hasil.harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(hasil.totalTransfer)}

Via ${hasil.ekspedisi} ya kak 🚗

Sampaikan ke customer: "Untuk wilayah kak, pengiriman via Transfer ya kak 🙏 COD belum tersedia di sana."
Langsung lanjut minta data (nama, alamat) tanpa tanya COD/Transfer.`;
    }
  }

  return `[SISTEM] ${konteks}Ongkir sudah dihitung. Rekomendasi termurah: ${hasil.ekspedisi}.
${areaFull ? `Area yang dicocokkan sistem: ${areaFull}. Sebutkan nama area ini ke customer saat konfirmasi, contoh: "Oke kak, ongkir ke ${areaFull} ya 😊"` : ''}

${hargaSection}

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

function buildCustomerConfirmMsg({ customer, alamat, area, qty, productNama, satuan, isCOD, ekspLabel, harga, ongkirAsli, ongkirPromo, feeCOD, rekening }) {
  const satuanLabel = satuan || 'pcs';
  const h  = harga       || 0;
  const op = ongkirPromo || 0;
  const oa = ongkirAsli  || op;
  const fc = isCOD ? (feeCOD || 0) : 0;
  const total = h + op + fc;
  // Untuk COD: gabungkan ongkir + fee COD jadi 1 angka "ongkir"
  const ongkirTampil = isCOD ? (op + fc) : op;
  const ongkirAsliTampil = isCOD ? (oa + fc) : oa;
  const adaDiskonOngkir = ongkirAsliTampil > 0 && ongkirAsliTampil > ongkirTampil;

  const ongkirStr = adaDiskonOngkir
    ? `~Rp ${ongkirAsliTampil.toLocaleString('id-ID')}~ Rp ${ongkirTampil.toLocaleString('id-ID')}`
    : `Rp ${ongkirTampil.toLocaleString('id-ID')}`;

  const fmt = (n) => `Rp ${n.toLocaleString('id-ID')}`;

  // Kalau Transfer, langsung tampilin rekening di konfirmasi
  const rekeningBlock = (!isCOD && rekening)
    ? `\n\nSilakan transfer ke:\n${rekening}\n\nKalau sudah transfer, kirim bukti TF-nya ya kak 🙏`
    : '';

  return `✅ *Konfirmasi Order ${productNama || 'Produk'}*

*Nama:* ${customer?.nama || '-'}
*No. HP:* ${customer?.wa_number || '-'}
*Alamat:* ${alamat || '-'}

*Kelurahan/Desa:* ${area?.kelurahan || '-'}
*Kecamatan:* ${area?.kecamatan || '-'}
*Kabupaten:* ${area?.kota || '-'}
*Provinsi:* ${area?.provinsi || '-'}
*Kode Pos:* ${area?.kodePos || '-'}

*Jumlah Pesanan:* ${qty} ${satuanLabel} ${productNama || '-'}
*Harga Produk:* ${fmt(h)}
*Ongkir:* ${ongkirStr}${adaDiskonOngkir ? ` 🎉` : ''}
*Pembayaran:* ${isCOD ? 'COD' : 'Transfer'} ${ekspLabel}
*Total Pembayaran:* ${fmt(total)}${rekeningBlock}

Sudah bener kak? 😊`;
}

/* ── MAIN HANDLER ─────────────────────────────────────────── */
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
    const msgId       = body.msg_id || null;  // WA message ID dari Baileys
    let message       = String(body.message || '').trim();
    const messageType = body.message_type || 'text';
    const mediaUrl    = body.media_url || null;
    const referral    = body.referral || null; // dari CTWA

    // ── Idempotency check: skip kalau msg_id sudah pernah diproses ──
    if (msgId) {
      const alreadyProcessed = await sbGet('conv_messages', `?wamid=eq.${encodeURIComponent(msgId)}&limit=1`);
      if (alreadyProcessed.length) {
        console.log(`[dedup] msg_id ${msgId} sudah diproses, skip`);
        return res.status(200).json({ ok: true, skipped: 'duplicate_msgid' });
      }
    }

    console.log(`wa_number="${wa_number}" reply_jid="${reply_jid}" message="${message}" type="${messageType}"`);
    if (!reply_jid || (!message && messageType === 'text')) {
      console.warn('wa_number atau message kosong');
      return res.status(200).json({ ok: false, reason: 'empty_message' });
    }

    console.log(`Pesan dari ${pushName} (${wa_number}): ${message.slice(0, 80)}`);

    // ── Resolve userId + product dari session_id ──────────────
    // Multi-WA: coba cari produk langsung via wa_session_id (1 WA = 1 produk)
    // Fallback: session_id = user_id (backward compat, produk pertama)
    const sessionId = body.session_id;
    if (!sessionId) {
      console.warn('session_id kosong');
      return res.status(200).json({ ok: false, reason: 'no_session_id' });
    }
    let userId, product, sumber;
    const prodBySession = await sbGet('products',
      `?wa_session_id=eq.${encodeURIComponent(sessionId)}&aktif=eq.true&limit=1`
    ).catch(() => []);
    if (prodBySession.length) {
      product = prodBySession[0];
      userId  = product.user_id;
      sumber  = 'inbound';
      // Deteksi CTWA
      if (referral?.ad_id || referral?.headline) {
        const identifier = referral.ad_id || referral.headline;
        const mapping = await sbGet('ad_mapping',
          `?user_id=eq.${userId}&identifier=eq.${encodeURIComponent(identifier)}&aktif=eq.true&limit=1`
        ).catch(() => []);
        if (mapping.length) sumber = 'ctwa';
      }
      console.log(`[multi-wa] produk "${product.nama}" via wa_session_id`);
    } else {
      // Fallback lama: session_id = user_id
      userId = sessionId;
      const resolved = await resolveProduct(userId, referral, message);
      product = resolved.product;
      sumber  = resolved.sumber;
    }

    // session WA yang dipakai untuk kirim balas — selalu pakai session yang nerima pesan
    // bukan lookup dari produk, karena 1 session = 1 WA = balas lewat sini
    const waSession = sessionId;

    // ── Pending Greeting: cek & kirim greeting form yang sudah lewat 3 menit ──
    // Skip kalau produk dalam Mode Pasif (warm up — bot hanya reply)
    const waMode = product?.wa_mode || 'active';
    if (waMode === 'passive') {
      console.log(`[greeting] Skip — produk "${product?.nama}" dalam Mode Pasif`);
    }
    // Dijalankan setiap ada webhook masuk (piggyback), non-blocking
    const GREETING_DELAY_MS = 3 * 60 * 1000;
    if (waMode !== 'passive') (async () => {
      try {
        const pendingConvs = await sbGet('conversations',
          `?user_id=eq.${userId}&status=in.(baru,diproses)&select=id,state`
        );
        for (const pc of pendingConvs) {
          const pg = pc.state?.pending_greeting;
          if (!pg?.created_at) continue;
          const elapsed = Date.now() - new Date(pg.created_at).getTime();
          if (elapsed < GREETING_DELAY_MS) continue;

          // Cek ada pesan customer belum (kalau ada = sudah redirect, skip)
          const custMsgs = await sbGet('conv_messages',
            `?conversation_id=eq.${pc.id}&role=eq.customer&limit=1`
          ).catch(() => []);
          if (custMsgs.length) {
            await updateConvState(pc.id, { pending_greeting: null }).catch(() => {});
            console.log(`[greeting] conv ${pc.id}: customer sudah chat duluan, skip`);
            continue;
          }

          // Kirim greeting
          console.log(`[greeting] Kirim ke ${pg.wa_number} (delay ${Math.round(elapsed/1000)}s)`);
          let greetOk = false;
          try {
            await sendWA(pg.wa_session, pg.wa_number, pg.message, true); // isOutbound = true
            await saveMessage(pc.id, 'ai', pg.message).catch(() => {});
            greetOk = true;
          } catch(sendErr) {
            await saveMessage(pc.id, 'cs', `⚠️ Gagal kirim greeting ke ${pg.wa_number}: ${sendErr.message}`).catch(() => {});
          }
          await updateConvState(pc.id, { pending_greeting: null }).catch(() => {});
        }
      } catch(e) {
        console.error('[greeting] Error:', e.message);
      }
    })(); // fire-and-forget, tidak blocking response

    // ── Ambil rekening dari users table ───────────────────────
    const userRows = await sbGet('users', `?id=eq.${userId}&select=rekening,anthropic_key,group_jid,qc_group_jid,ops_group_jid,mengantar_origin_id,mengantar_area_id,default_sumber&limit=1`).catch(() => []);
    const userRekening      = userRows[0]?.rekening            || null;
    const userAnthropicKey  = userRows[0]?.anthropic_key       || null;
    const ai = resolveAI(product, userAnthropicKey);
    const aiKey = ai.key;
    const aiBase = ai.base;
    const userGroupJid      = userRows[0]?.group_jid            || WA_GROUP_JID;
    const QC_GROUP_JID      = userRows[0]?.qc_group_jid || process.env.QC_GROUP_JID || userGroupJid;
    const OPS_GROUP_JID_USER = userRows[0]?.ops_group_jid || process.env.OPS_GROUP_JID || userGroupJid;
    const userMngOriginId   = userRows[0]?.mengantar_origin_id  || MENGANTAR_ORIGIN_ID; // warehouse ID (buat order)
    const userMngAreaId     = userRows[0]?.mengantar_area_id    || MENGANTAR_ORIGIN_ID; // address _id (cek ongkir)
    const userDefaultSumber = userRows[0]?.default_sumber       || null;
    console.log(`[user] warehouseId=${userMngOriginId} areaId=${userMngAreaId}`);
    console.log(`Produk: ${product?.nama || 'tidak diketahui'} (${sumber})`);

    // Model AI: jika user set default_sumber di settings → pakai model sesuai itu
    // (semua chat dianggap tipe yang dipilih user, override deteksi otomatis)
    const MODEL_SONNET = 'claude-sonnet-4-6';
    const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';
    const defaultModel = { ctwa: MODEL_HAIKU, form: MODEL_SONNET, inbound: MODEL_SONNET };
    const effectiveSumber = userDefaultSumber || sumber;
    const chatModel = defaultModel[effectiveSumber] || MODEL_SONNET;

    // ── Deteksi leads dari form web (pesan mengandung "isi form" + nama) ───
    let sumberFinal = sumber;
    const isFormLead = /isi form|sudah isi|formulir|form pemesanan|form order/i.test(message);
    let namaFromForm = null;
    if (isFormLead) {
      sumberFinal = 'form';
      // Extract nama: "atas nama X", "nama saya X", "nama: X"
      const namaMatch = message.match(/atas nama\s+([A-Za-z\s]+?)(?:[,.\n]|$)/i)
        || message.match(/nama saya\s+([A-Za-z\s]+?)(?:[,.\n]|$)/i)
        || message.match(/nama\s*[:=]\s*([A-Za-z\s]+?)(?:[,.\n]|$)/i);
      if (namaMatch) namaFromForm = namaMatch[1].trim();
      console.log(`[form lead] detected — nama: ${namaFromForm || '(tidak terdeteksi)'}`);
    }

    // ── Find/create customer & conversation ───────────────────
    const customer = await findOrCreateCustomer(userId, wa_number, namaFromForm || pushName, reply_jid);

    // Update nama dari form kalau lebih lengkap dari push_name
    if (namaFromForm && namaFromForm !== customer.nama) {
      await sbPatch('customers', `?id=eq.${customer.id}`, { nama: namaFromForm }).catch(() => {});
      customer.nama = namaFromForm;
      console.log(`[form lead] Update nama customer: ${namaFromForm}`);
    }

    // Simpan reply_jid (bisa berupa LID format seperti 224029940129807@lid)
    // supaya CS dari dashboard bisa kirim ke JID yang benar
    if (reply_jid && reply_jid !== customer.reply_jid) {
      await sbPatch('customers', `?id=eq.${customer.id}`, { reply_jid }).catch(() => {});
      customer.reply_jid = reply_jid;
    }

    const conversation = await findOrCreateConversation(userId, customer.id, sumberFinal, product?.id);

    // Update produk ke conversation jika baru ketemu
    if (product?.id && !conversation.product_id) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, { product_id: product.id });
    }

    // ── Customer chat duluan → hapus pending_greeting (redirect berhasil) ──
    const convStatePre = conversation.state || {};
    if (convStatePre.pending_greeting) {
      console.log(`[greeting] Customer ${wa_number} chat duluan — pending_greeting dihapus (redirect berhasil)`);
      await updateConvState(conversation.id, { pending_greeting: null });
      convStatePre.pending_greeting = null;
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

        const visionRes = await fetchWithTimeout(`${aiBase}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': aiKey,
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
    const savedMsg = await saveMessage(conversation.id, 'customer', msgText, msgId);
    // Kalau duplicate wamid (race condition) → pesan sudah diproses webhook lain, stop
    if (msgId && (!savedMsg || !savedMsg.length)) {
      console.log(`[webhook] Duplicate wamid ${msgId} — pesan sudah diproses, skip`);
      return res.status(200).json({ ok: true, skipped: 'duplicate_wamid' });
    }
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
      // Tetap update last_msg_at agar inbox sort benar
      await sbPatch('conversations', `?id=eq.${conversation.id}`, {
        last_msg_at: new Date().toISOString(),
      }).catch(() => {});
      return res.status(200).json({ ok: true, skipped: 'eskalasi' });
    }

    // ── State conversation ────────────────────────────────────
    const convState = conversation.state || {};

    // ── Auto-backfill closed_order_id untuk conversation lama yang sudah closing tapi belum punya ID ──
    if (!convState.closed_order_id) {
      const existingOrders = await sbGet('orders_new', `?conversation_id=eq.${conversation.id}&order=created_at.desc&limit=1`).catch(() => []);
      if (existingOrders.length) {
        convState.closed_order_id = existingOrders[0].id;
        await updateConvState(conversation.id, { closed_order_id: existingOrders[0].id }).catch(() => {});
        console.log(`[backfill] closed_order_id set untuk conv ${conversation.id} → order ${existingOrders[0].id}`);
      }
    }

    // ── Handle konfirmasi / koreksi order ─────────────────────
    // PENTING: Kalau customer kirim bukti TF (gambar) saat awaiting_order_confirm Transfer
    // → skip block konfirmasi, langsung treat sebagai bukti TF
    if ((convState.awaiting_order_confirm || convState.awaiting_order_correction)
        && imageAnalysis?.is_bukti_tf
        && (convState.order_snapshot?.metode || '').toLowerCase() === 'transfer') {
      console.log(`[awaiting-confirm] Customer kirim bukti TF saat awaiting_order_confirm → skip ke bukti TF handler`);
      // Set awaiting_bukti_tf agar handler di bawah bisa proses
      await updateConvState(conversation.id, { awaiting_order_confirm: false, awaiting_bukti_tf: true });
      convState.awaiting_order_confirm = false;
      convState.awaiting_bukti_tf = true;
      // Fall through ke bawah — imageAnalysis handler akan proses bukti TF
    }
    else if ((convState.awaiting_order_confirm || convState.awaiting_order_correction)
             && !convState.awaiting_bukti_tf && !convState.awaiting_qc_tf) {
      const msgLower = message.toLowerCase().trim();
      const snap     = convState.order_snapshot || {};
      const area     = snap.area || {};
      const isCOD    = (snap.metode || 'COD').toLowerCase() !== 'transfer';
      const ekspLabel= (snap.ekspedisi || 'KURIR').toUpperCase();
      const total    = isCOD
        ? (snap.harga || 0) + (snap.ongkirPromo || 0) + (snap.feeCOD || 0)
        : (snap.harga || 0) + (snap.ongkirPromo || 0);

      if (convState.awaiting_order_correction) {
        // ── Cek dulu: apakah ini pertanyaan atau koreksi order? ──
        const isQuestionInCorr = message.includes('?') || /^(apa|gimana|berapa|kapan|kenapa|bagaimana|apakah|udah|sudah|ada|bisa|boleh|kalau)/i.test(msgLower);
        const hasOrderCorrKeyword = /\b(nama|alamat|jalan|kecamatan|kota|provinsi|kodepos|kode pos|qty|jumlah|kurir|ekspedisi|ongkir|transfer|cod|ganti|ubah|koreksi|ralat|perbaiki|salah)\b/i.test(msgLower);

        if (isQuestionInCorr && !hasOrderCorrKeyword) {
          // Customer nanya hal lain, bukan koreksi order → jawab via Claude, state tetap awaiting_order_correction
          // Fall through ke Claude di bawah
        } else {
        // ── Customer kirim koreksi — extract via Claude Haiku ──
        try {
          const extractRes = await fetchWithTimeout(`${aiBase}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': aiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              messages: [{ role: 'user', content:
                `Dari pesan koreksi berikut, extract perubahan data pesanan. Jawab JSON saja, tanpa penjelasan.

Pesan customer: "${message}"

Data saat ini:
- Nama: ${customer?.nama || '-'}
- Alamat: ${snap.alamat || '-'}
- Kelurahan: ${area.kelurahan || '-'}
- Kecamatan: ${area.kecamatan || '-'}
- Kabupaten: ${area.kota || '-'}
- Provinsi: ${area.provinsi || '-'}
- Kode Pos: ${area.kodePos || '-'}
- Qty: ${snap.qty || 1}

Format JSON:
{"nama":null,"alamat":null,"kelurahan":null,"kecamatan":null,"kota":null,"provinsi":null,"kodePos":null,"qty":null}

Isi field yang berubah saja, sisanya null.` }],
            }),
          }, 15000);
          const extractData = await extractRes.json();
          const raw = extractData.content?.[0]?.text || '';
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const koreksi = JSON.parse(jsonMatch[0]);
            // Update order_snapshot
            if (koreksi.alamat)    snap.alamat          = koreksi.alamat;
            if (koreksi.qty)       snap.qty             = koreksi.qty;
            if (koreksi.kelurahan) area.kelurahan       = koreksi.kelurahan;
            if (koreksi.kecamatan) area.kecamatan       = koreksi.kecamatan;
            if (koreksi.kota)      area.kota            = koreksi.kota;
            if (koreksi.provinsi)  area.provinsi        = koreksi.provinsi;
            if (koreksi.kodePos)   area.kodePos         = koreksi.kodePos;
            if (koreksi.nama)      customer.nama        = koreksi.nama;
            snap.area = area;
          }
        } catch(e) {
          console.error('Koreksi extract error:', e.message);
        }

        // Kirim ulang konfirmasi dengan data yang sudah dikoreksi
        const confirmUlang = buildCustomerConfirmMsg({
          customer, alamat: snap.alamat, area, qty: snap.qty || 1,
          productNama: product?.nama,
          satuan: product?.satuan,
          isCOD, ekspLabel,
          harga:       snap.harga       || product?.harga || 0,
          ongkirAsli:  snap.ongkirAsli  || snap.ongkirPromo || 0,
          ongkirPromo: snap.ongkirPromo || 0,
          feeCOD:      snap.feeCOD      || 0,
          rekening:    !isCOD ? userRekening : null,
        });

        await updateConvState(conversation.id, {
          awaiting_order_confirm: true,
          awaiting_order_correction: false,
          order_confirmed_at: new Date().toISOString(),
          confirm_fu_stage: 0,
          order_snapshot: snap,
        });
        const { wamid: wamid_cu } = await sendWA(waSession, reply_jid, confirmUlang).catch(()=>({}));
        await saveMessage(conversation.id, 'ai', confirmUlang, wamid_cu);
        return res.status(200).json({ ok: true, action: 'confirm_resent' });

        } // end else (bukan pertanyaan biasa)
        // Kalau pertanyaan biasa → fall through ke Claude di bawah

      } else {
        // ── Awaiting confirm — cek jawaban customer ────────────
        // Normalize: repeated vowel "yaa"→"ya", repeated consonant akhir "sipp"→"sip", "sdh"→"sudah"
        const msgNorm = msgLower
          .replace(/([aeiou])\1+$/g, '$1').replace(/([aeiou])\1+\b/g, '$1')
          .replace(/([bcdfghjklmnpqrstvwxyz])\1+$/g, '$1').replace(/([bcdfghjklmnpqrstvwxyz])\1+\b/g, '$1');
        // Expand common abbreviations
        const msgExpand = msgNorm
          .replace(/\bsdh\b/g, 'sudah').replace(/\budh\b/g, 'udah').replace(/\bdah\b/g, 'udah')
          .replace(/\bbnr\b/g, 'benar').replace(/\bbner\b/g, 'bener')
          .replace(/\biy\b/g, 'iya').replace(/\biyah\b/g, 'iya').replace(/\byah\b/g, 'ya')
          .replace(/\blgsg\b/g, 'lanjut');
        const isConfirm = /^(iya|ya|oke|ok|bener|betul|beres|sudah|suda|udah|uda|siap|sip|fix|setuju|benar|yap|yep|yup|yoi|yes|yess|mantap|mantab|jadi|boleh|lanjut|lanjutkan|lanjutin|gas|gass|okey|baik|deal|acc|done|cus|cuss|amin)\b/i.test(msgExpand)
                       || (msgLower.length <= 20 && /\b(oke|ok|iya|ya|suda|sudah|sdh|udah|udh|dah|siap|baik|bener|benar|bnr|bner|betul|setuju|deal|fix|jadi|boleh|lanjut|mantap|sip|yoi|yup|yes|acc|done|cus|cuss|gas)\b/i.test(msgLower));
        // isDeny: nolak/cancel/minta ubah order
        const isDeny    = /\b(salah|ganti|ubah|bukan|koreksi|ralat|perbaiki|enggak|nggak|ngga|wrong|nope)\b/i.test(msgLower)
                       || /\b(tidak|belum)\s+(benar|bener|betul|sesuai|cocok|iya|ya|oke)\b/i.test(msgLower)
                       || /\b(tidak|tdk|ga|gak|gk|ngga|nggak|g)\s*(jadi|mau|usah|perlu)\b/i.test(msgLower)
                       || /\b(cancel|batal|batalkan)\b/i.test(msgLower);
        // Deteksi pertanyaan: kalau customer nanya hal lain → jangan paksa confirm/deny, teruskan ke Claude
        const isQuestion = message.includes('?') || /^(apa|gimana|berapa|kapan|kenapa|bagaimana|apakah|udah|sudah|ada|bisa|boleh|kalau)/i.test(msgLower);

        if (isQuestion && !isConfirm && !isDeny) {
          // Customer nanya hal lain (bukan konfirmasi/nolak) → teruskan ke Claude
          // Reset timer FU supaya 30 menit mulai dari interaksi terakhir, bukan dari konfirmasi awal
          await updateConvState(conversation.id, {
            order_confirmed_at: new Date().toISOString(),
            confirm_fu_stage: 0,
          });
          // Fall through ke Claude di bawah (sudah ada inject konteks awaiting_order_confirm di system prompt)
        } else if (isConfirm && !isDeny) {
          // ── Cek metode bayar: Transfer → jangan closing dulu, tunggu bukti TF ──
          const snapMetode = (convState.order_snapshot?.metode || convState.metode_bayar || 'cod').toLowerCase();
          if (snapMetode === 'transfer' || snapMetode === 'tf') {
            // Transfer: simpan order_snapshot tapi JANGAN closing — tunggu bukti TF + ACC finance
            await updateConvState(conversation.id, {
              awaiting_order_confirm: false,
              awaiting_bukti_tf: true,
              order_snapshot: convState.order_snapshot,
            });
            // Rekening sudah ada di pesan konfirmasi, cukup kasih pesan singkat
            const tfMsg = `Siap kak, pesanannya sudah kami catat! 📝 Ditunggu bukti TF-nya ya kak 🙏`;
            const { wamid: wamid_tf } = await sendWA(waSession, reply_jid, tfMsg).catch(()=>({}));
            await saveMessage(conversation.id, 'ai', tfMsg, wamid_tf);
            return res.status(200).json({ ok: true, action: 'awaiting_bukti_tf' });
          }

          // ✅ COD → langsung Closing!
          const nomorUrutClosing = await getOrderNumber(userId);
          await sbPatch('conversations', `?id=eq.${conversation.id}`, { status: 'selesai' });
          await updateConvState(conversation.id, { awaiting_order_confirm: false, order_placed: true });

          // Generate closing personal berdasarkan keluhan customer
          const keluhanSnap = convState.order_snapshot?.keluhan || convState.keluhan || '';
          const namaSnap    = customer?.nama || 'kak';
          const closingPrompt = `Buat pesan penutup WhatsApp yang hangat dan personal untuk customer yang baru saja order.
Nama customer: ${namaSnap}
Keluhan/kondisi customer: ${keluhanSnap || 'tidak diketahui'}

Isi pesan:
1. Konfirmasi pesanan sedang diproses
2. Doakan kesembuhan customer sesuai keluhannya (natural, tidak lebay)
3. Bilang akan dikabari kalau sudah dikirim
4. Ucapan terima kasih

Gaya: hangat, santai, WhatsApp, 3-4 kalimat. Gunakan "kak". Jangan pakai bullet point.`;

          let closingCustomer;
          try {
            closingCustomer = await callClaude(
              'Kamu CS herbal yang hangat dan peduli. Balas singkat, natural, gaya WA.',
              [{ role: 'user', content: closingPrompt }],
              'claude-haiku-4-5-20251001',
              aiKey, aiBase
            );
          } catch(e) {
            closingCustomer = null;
          }
          if (!closingCustomer) {
            closingCustomer = `Siap kak! Pesanan sedang kami proses 🚀\n\nNanti kami kabarin kalau barang udah dikirim ya kak.\nTerima kasih sudah belanja! 🙏`;
          }

          const { wamid: wamid_cl } = await sendWA(waSession, reply_jid, closingCustomer).catch(()=>({}));
          await saveMessage(conversation.id, 'ai', closingCustomer, wamid_cl);

          // ── Guard: cek dulu apakah order untuk conversation ini sudah ada (anti-double) ──
          const existingOrder = await sbGet('orders_new', `?conversation_id=eq.${conversation.id}&limit=1`).catch(() => []);
          if (existingOrder.length) {
            console.warn(`[closing] Order untuk conv ${conversation.id} sudah ada — skip insert & recap`);
            return res.status(200).json({ ok: true, skipped: 'order_already_exists' });
          }

          // ── Insert ke orders_new ──
          let insertedOrderId = null;
          try {
            const snap       = convState.order_snapshot || {};
            const ongkirSnap = convState.ongkir || {};
            const alamatSnap = {
              jalan:      snap.alamat       || convState.alamat              || '',
              kelurahan:  ongkirSnap.area?.kelurahan || customer.alamat?.kelurahan || '',
              kecamatan:  ongkirSnap.area?.kecamatan || customer.alamat?.kecamatan || '',
              kabupaten:  ongkirSnap.area?.kota      || customer.alamat?.kabupaten || '',
              provinsi:   ongkirSnap.area?.provinsi  || customer.alamat?.provinsi  || '',
              kodepos:    ongkirSnap.area?.kodePos   || customer.alamat?.kodepos   || '',
              ...(ongkirSnap.mengantar_dest_id ? { mengantar_dest_id: ongkirSnap.mengantar_dest_id } : {}),
            };
            const insertedRows = await sbPost('orders_new', {
              user_id:           userId,
              customer_id:       customer.id,
              conversation_id:   conversation.id,
              product_id:        product?.id || null,
              metode:            (snap.metode || convState.metode_bayar || 'cod').toLowerCase(),
              qty:               parseInt(snap.qty || convState.qty || 1),
              harga:             snap.harga        || product?.harga || 0,
              ongkir:            snap.ongkirAsli   || ongkirSnap.ongkirAsli   || 0,
              ongkir_after_promo: snap.ongkirPromo ?? ongkirSnap.ongkirPromo ?? 0,
              fee_cod:           snap.feeCOD       || ongkirSnap.feeCOD       || 0,
              total:             snap.total        || (() => {
                const h = snap.harga || product?.harga || 0;
                const op = snap.ongkirPromo ?? ongkirSnap.ongkirPromo ?? 0;
                const fc = snap.feeCOD || ongkirSnap.feeCOD || 0;
                const cod = (snap.metode || '').toLowerCase() !== 'transfer';
                return cod ? h + op + fc : h + op;
              })(),
              ekspedisi:         snap.ekspedisi    || ongkirSnap.ekspedisi    || '',
              alamat:            alamatSnap,
              keluhan:           snap.keluhan      || convState.keluhan        || '',
              status:            'pending',
              // Data flat untuk kemudahan tracking & Mengantar
              customer_nama:     customer.nama     || '',
              customer_phone:    (customer.wa_number || '').replace(/^62/, '0'),
              product_nama:      product?.nama     || '',
              berat_gram:        product?.berat_gram || 0,
            });
            insertedOrderId = insertedRows?.[0]?.id || null;
            console.log(`[closing] Insert orders_new OK — conv ${conversation.id}, order_id: ${insertedOrderId}`);
          } catch(e) {
            console.error('[closing] Gagal insert orders_new:', e.message);
          }

          // ── Tandai conversation sudah closing — permanen, tidak di-reset saat re-open ──
          if (insertedOrderId) {
            await updateConvState(conversation.id, { closed_order_id: insertedOrderId }).catch(() => {});
          }

          // ── Update total_order & last_order_at di customers ──
          await sbPatch('customers', `?id=eq.${customer.id}`, {
            total_order:   (customer.total_order || 0) + 1,
            last_order_at: new Date().toISOString(),
          }).catch(e => console.error('[closing] Gagal update total_order:', e.message));

          // ── Generate & simpan catatan customer ──
          try {
            const snap        = convState.order_snapshot || {};
            const keluhan     = snap.keluhan  || convState.keluhan  || '-';
            const metode      = snap.metode   || convState.metode_bayar || '-';
            const wilayah     = convState.wilayah || '-';
            const kurir       = snap.ekspedisi || convState.ongkir?.ekspedisi || '-';
            const catatanLama = customer.catatan || '';
            const orderKe     = (customer.total_order || 0) + 1;

            const catatanPrompt = `Buat catatan singkat (1-2 kalimat, max 150 karakter) untuk database CRM customer herbal.
Data order:
- Keluhan: ${keluhan}
- Metode bayar: ${metode}
- Kurir: ${kurir}
- Wilayah: ${wilayah}
- Order ke: ${orderKe}
${catatanLama ? `- Catatan sebelumnya: ${catatanLama}` : ''}

Format: langsung isinya saja, tanpa label/prefix. Fokus pada keluhan, preferensi kurir/bayar, dan info unik yang berguna untuk order berikutnya.`;

            const catatanBaru = await callClaude(
              'Kamu asisten CRM. Buat catatan singkat dan padat.',
              [{ role: 'user', content: catatanPrompt }],
              'claude-haiku-4-5-20251001',
              aiKey, aiBase
            );

            if (catatanBaru) {
              const catatanFinal = catatanLama
                ? `[Order ${orderKe}] ${catatanBaru.trim()}\n---\n${catatanLama}`
                : `[Order ${orderKe}] ${catatanBaru.trim()}`;

              await sbPatch('customers', `?id=eq.${customer.id}`, { catatan: catatanFinal })
                .catch(e => console.error('[closing] Gagal save catatan:', e.message));
            }
          } catch(e) {
            console.error('[closing] Generate catatan error:', e.message);
          }

          // ── Kirim recap ke grup WA setelah customer konfirmasi ──
          if (userGroupJid) {
            try {
              const snap      = convState.order_snapshot || {};
              const ongkirSnap = convState.ongkir || {};
              const csNama    = product?.persona_cs_nama || 'CS';
              const closingMsg = buildClosingMessage({
                nomorUrut: nomorUrutClosing, customer,
                alamat:  snap.alamat  || convState.alamat || '-',
                ongkir:  ongkirSnap,
                product,
                keluhan: snap.keluhan || convState.keluhan || '-',
                metode:  snap.metode  || convState.metode_bayar || 'COD',
                qty:     snap.qty     || 1,
                csNama,
              });
              await sendWA(waSession, userGroupJid, closingMsg, true);
              console.log(`Recap order #${nomorUrutClosing} terkirim ke grup (setelah customer konfirmasi)`);
            } catch(e) {
              console.error('Send recap ke grup error:', e.message);
            }
          }

          // ── Trigger validation agent (fire-and-forget) ──
          if (insertedOrderId) {
            const validateUrl = `https://${req.headers.host}/api/validate-order`;
            fetch(validateUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET || '' },
              body: JSON.stringify({ order_id: insertedOrderId }),
            }).catch(e => console.error('[validate-trigger] Fire-and-forget error:', e.message));
            console.log(`[validate-trigger] Triggered for order ${insertedOrderId}`);
          }

          console.log(`Order confirmed oleh customer ${wa_number} — percakapan ditutup`);
          return res.status(200).json({ ok: true, action: 'order_closed' });

        } else if (isDeny) {
          // Bedakan cancel (tidak jadi, batal) vs koreksi (salah, ganti, ubah)
          const isCancel = /\b(tidak|tdk|ga|gak|gk|ngga|nggak|g)\s*(jadi|mau|usah|perlu)\b/i.test(msgLower)
                        || /\b(cancel|batal|batalkan)\b/i.test(msgLower);
          if (isCancel) {
            // ❌ Customer batal — hapus awaiting, biarkan Claude tangani dengan natural
            await updateConvState(conversation.id, {
              awaiting_order_confirm: false,
              awaiting_order_correction: false,
              order_snapshot: null,
              cancel_count: (convState.cancel_count || 0) + 1,
            });
            console.log(`[confirm] Customer cancel order di awaiting_order_confirm`);
            // Fall through ke Claude di bawah — bot akan respon "baik kak, tidak apa-apa" dll
          } else {
            // ❌ Ada yang salah — minta koreksi
            await updateConvState(conversation.id, {
              awaiting_order_confirm: false,
              awaiting_order_correction: true,
            });
            const tanyaKoreksi = `Maaf kak! 🙏 Bagian mana yang perlu diperbaiki?\nSilakan sebutkan ya kak (misal: alamatnya, nama, jumlah pesanan, dll).`;
            const { wamid: wamid_tk } = await sendWA(waSession, reply_jid, tanyaKoreksi).catch(()=>({}));
            await saveMessage(conversation.id, 'ai', tanyaKoreksi, wamid_tk);
            return res.status(200).json({ ok: true, action: 'awaiting_correction' });
          }
        }
        // Kalau ambigu (tidak jelas iya/tidak) → reset timer FU, lanjut ke Claude biasa
          await updateConvState(conversation.id, {
            order_confirmed_at: new Date().toISOString(),
            confirm_fu_stage: 0,
          });
      }
    }

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
          const hasilGeo = await hitungOngkir(wilayahGeo, product, parseInt(convState.qty) || 1, userMngAreaId).catch(() => null);
          if (hasilGeo) {
            await updateConvState(conversation.id, { wilayah: wilayahGeo, ongkir: hasilGeo, alamat: alamatGeo });
            convState.ongkir  = hasilGeo;
            convState.wilayah = wilayahGeo;
            // Simpan ke customers.alamat
            if (customer?.id && hasilGeo.area?.kecamatan) {
              const alamatBaru = {
                ...(customer.alamat || {}),
                kelurahan: hasilGeo.area.kelurahan, kecamatan: hasilGeo.area.kecamatan,
                kabupaten: hasilGeo.area.kota, provinsi: hasilGeo.area.provinsi,
                kodepos: hasilGeo.area.kodePos, ekspedisi: hasilGeo.ekspedisi,
                ongkirAsli: hasilGeo.ongkirAsli, ongkirPromo: hasilGeo.ongkirPromo,
                feeCOD: hasilGeo.feeCOD, harga: hasilGeo.harga,
              };
              await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru })
                .catch(e => console.error('[GoogleMaps] Gagal save customer.alamat:', e.message));
              customer.alamat = alamatBaru;
            }
            message = `[SISTEM] Customer kirim lokasi Google Maps.\nHasil geocoding: ${alamatGeo}\n${buildOngkirInjeksi(hasilGeo, product, `Ongkir ke ${wilayahGeo} sudah dihitung. `)}\nKonfirmasi lokasi ke customer dan tampilkan total harga.`;
          } else {
            message = `[SISTEM] Customer kirim lokasi Google Maps → ${wilayahGeo}, tapi ongkir tidak ditemukan. Konfirmasi lokasi ke customer dan minta sebutkan nama kota/kabupatennya.`;
          }
        }
      }
    }

    // ── Auto-load wilayah: extract dari form_alamat / customer.alamat → validasi DB → simpan ──
    // TIDAK hitung ongkir di sini — cuma extract & simpan wilayah_data yang valid
    // Re-open conversation: TIDAK auto-load — customer mungkin ganti alamat
    const isReopenedConv = !!(convState.reopened_at && !convState.wilayah);
    let autoLoadedOngkir = null;
    if (!convState.wilayah_data && !convState.wilayah && !isReopenedConv && product) {

      let lokasi = null;
      let sumber = '';

      // Prioritas 1: form_alamat dari form lead — pakai Haiku AI extract
      const hasFormAlamat = convState.is_form_lead && convState.form_alamat;
      if (hasFormAlamat) {
        lokasi = await extractLokasiHaiku(convState.form_alamat, aiKey, aiBase).catch(() => null);
        console.log(`[auto-load] Haiku extract form_alamat: "${convState.form_alamat}" →`, lokasi);
        sumber = 'form_alamat';
      }

      // Prioritas 2: customer.alamat — hanya untuk inbound baru
      if (!lokasi && !convState.is_form_lead && customer?.alamat?.kecamatan && customer?.alamat?.kabupaten) {
        lokasi = { kelurahan: customer.alamat.kelurahan, kecamatan: customer.alamat.kecamatan, kabupaten: customer.alamat.kabupaten };
        sumber = 'customer.alamat';
      }

      if (lokasi) {
        const validasi = await validateWilayahDB(lokasi);
        console.log(`[auto-load] validateWilayahDB (${sumber}):`, JSON.stringify({ valid: validasi.valid, row: validasi.row, missing: validasi.missing }));

        if (validasi.valid) {
          // Semua field match DB → simpan wilayah_data, siap hitung ongkir nanti
          const wd = validasi.row;
          const wilayahStr = `${wd.kelurahan}, ${wd.kecamatan}, ${wd.kabupaten}, ${wd.provinsi}`;
          await updateConvState(conversation.id, {
            wilayah_data: wd,
            wilayah: wilayahStr,
            waiting_for_location: false,
            proposed_wilayah: null,
            pending_kecamatan: null,
          });
          convState.wilayah_data = wd;
          convState.wilayah = wilayahStr;
          convState.waiting_for_location = false;
          console.log(`[auto-load] ✅ Wilayah valid dari ${sumber}: ${wilayahStr}`);

          // Simpan ke customers.alamat juga
          if (customer?.id) {
            const alamatBaru = { ...(customer.alamat || {}), kelurahan: wd.kelurahan, kecamatan: wd.kecamatan, kabupaten: wd.kabupaten, provinsi: wd.provinsi };
            await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru }).catch(() => {});
            customer.alamat = alamatBaru;
          }
        } else {
          // Partial match → simpan apa yang ada + info field yang kurang
          const stateUpdate = {
            wilayah_data_partial: validasi.row || null,
            wilayah_missing: validasi.missing || [],
            wilayah_candidates: (validasi.candidates || []).slice(0, 10),
            waiting_for_location: true,
          };
          await updateConvState(conversation.id, stateUpdate);
          Object.assign(convState, stateUpdate);
          console.log(`[auto-load] ⚠️ Wilayah partial dari ${sumber}, missing: ${validasi.missing?.join(', ')}`);
        }
      }
    }

    // ── Auto hitung ongkir jika wilayah_data valid tapi ongkir belum ada ──
    if (convState.wilayah_data && !convState.ongkir && product) {
      try {
        const wd = convState.wilayah_data;
        const hasilAuto = await hitungOngkir(wd, product, parseInt(convState.qty) || 1, userMngAreaId);
        if (hasilAuto) {
          await updateConvState(conversation.id, { ongkir: hasilAuto, waiting_for_location: false });
          convState.ongkir = hasilAuto;
          convState.waiting_for_location = false;
          autoLoadedOngkir = hasilAuto;
          console.log(`[auto-load] ✅ Ongkir dihitung dari wilayah_data: ${wd.kelurahan}, ${wd.kecamatan}`);
        }
      } catch(e) { console.error('[auto-load] Ongkir gagal:', e.message); }
    }

    // ── Refresh ongkir jika wilayah sudah diketahui (ambil promo terbaru) ──
    // Skip kalau baru di-load oleh auto-load (tidak perlu hitung 2x)
    // Prefer wilayah_data (object) over wilayah (string)
    if ((convState.wilayah_data || convState.wilayah) && product && !autoLoadedOngkir) {
      try {
        const ongkirInput = convState.wilayah_data || convState.wilayah;
        const freshOngkir = await hitungOngkir(ongkirInput, product, parseInt(convState.qty) || 1, userMngAreaId);
        if (freshOngkir) {
          await updateConvState(conversation.id, { ongkir: freshOngkir, waiting_for_location: false });
          convState.ongkir = freshOngkir;
          convState.waiting_for_location = false;
          console.log(`Ongkir di-refresh: ${convState.wilayah} → asli ${freshOngkir.ongkirAsli} promo ${freshOngkir.ongkirPromo}`);
          // Update customers.alamat juga (biar selalu sinkron)
          if (customer?.id && freshOngkir.area?.kecamatan) {
            const alamatBaru = {
              ...(customer.alamat || {}),
              kelurahan: freshOngkir.area.kelurahan, kecamatan: freshOngkir.area.kecamatan,
              kabupaten: freshOngkir.area.kota, provinsi: freshOngkir.area.provinsi,
              kodepos: freshOngkir.area.kodePos, ekspedisi: freshOngkir.ekspedisi,
              ongkirAsli: freshOngkir.ongkirAsli, ongkirPromo: freshOngkir.ongkirPromo,
              feeCOD: freshOngkir.feeCOD, harga: freshOngkir.harga,
            };
            await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru })
              .catch(e => console.error('[Refresh] Gagal save customer.alamat:', e.message));
            customer.alamat = alamatBaru;
          }
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
      if (convState.wilayah_data) {
        const wd = convState.wilayah_data;
        ctx += `\n- Wilayah pengiriman: ${wd.kelurahan}, ${wd.kecamatan}, ${wd.kabupaten}, ${wd.provinsi} (SUDAH VALID & DIKETAHUI — JANGAN tanya kelurahan/kecamatan/kabupaten lagi)`;
      } else if (convState.wilayah_data_partial) {
        const wp = convState.wilayah_data_partial;
        const missing = convState.wilayah_missing || [];
        const candidates = convState.wilayah_candidates || [];
        ctx += `\n- Wilayah PARTIAL (belum lengkap):`;
        if (wp.kelurahan) ctx += `\n  • Kelurahan: ${wp.kelurahan} ✅`;
        if (wp.kecamatan) ctx += `\n  • Kecamatan: ${wp.kecamatan} ✅`;
        if (wp.kabupaten) ctx += `\n  • Kabupaten: ${wp.kabupaten} ✅`;
        if (wp.provinsi) ctx += `\n  • Provinsi: ${wp.provinsi} ✅`;
        ctx += `\n  • KURANG: ${missing.join(', ')} — TANYAKAN field ini SAJA ke customer, jangan tanya yang sudah ada.`;
        if (candidates.length > 0 && candidates.length <= 10) {
          ctx += `\n  • Pilihan yang tersedia: ${candidates.join(', ')}`;
          ctx += `\n  → Tawarkan pilihan ini ke customer, contoh: "Kelurahannya di ${candidates.slice(0,3).join(', ')}... yang mana ya kak?"`;
        }
      } else if (convState.wilayah) {
        ctx += `\n- Wilayah pengiriman: ${convState.wilayah} (SUDAH DIKETAHUI — jangan tanya alamat/wilayah lagi)`;
      }
      systemPrompt += ctx;
    }

    // Inject konteks form lead dari orderonline.id / Gmail
    if (convState.is_form_lead && (convState.form_produk || convState.form_alamat || convState.form_keluhan)) {
      let formCtx = '\n\n[SISTEM - FORM LEAD] Customer ini masuk lewat form order (OrderAdsy/orderonline.id). Data sudah diketahui dari form — jangan tanya ulang dari nol.';

      if (convState.form_produk) {
        formCtx += `\n- Produk: ${convState.form_produk} → SUDAH DIKETAHUI, jangan tanya mau beli apa.`;
      }

      if (convState.form_alamat) {
        formCtx += `\n- Alamat dari form: "${convState.form_alamat}"`;
        if (convState.wilayah_data) {
          formCtx += `\n  → Wilayah SUDAH VALID: ${convState.wilayah_data.kelurahan}, ${convState.wilayah_data.kecamatan}, ${convState.wilayah_data.kabupaten}`;
          formCtx += `\n  → JANGAN tanya kelurahan/kecamatan/kabupaten lagi. Konfirmasi alamat lalu lanjut ke ongkir/metode bayar.`;
          formCtx += `\n  → Contoh: "Siap kak! Alamat pengiriman ke 📍 ${convState.form_alamat} ya — sudah benar kak? 🙏"`;
        } else if (convState.wilayah_missing?.length) {
          const missing = convState.wilayah_missing;
          formCtx += `\n  → Alamat dari form KURANG: ${missing.join(', ')} belum valid.`;
          formCtx += `\n  → Tampilkan alamat form, lalu tanya HANYA field yang kurang: "${missing.join(' & ')}"`;
          formCtx += `\n  → JANGAN tanya ulang seluruh alamat.`;
        } else {
          formCtx += `\n  → Tampilkan alamat ini ke customer untuk dikonfirmasi.`;
          formCtx += `\n  → JANGAN tanya alamat dari awal lagi.`;
        }
      }

      if (!convState.form_alamat) {
        formCtx += `\n- Alamat: belum diisi di form → tanyakan alamat lengkap ke customer secara normal.`;
      }

      if (convState.form_keluhan) {
        formCtx += `\n- Keluhan dari form: "${convState.form_keluhan}" → SUDAH DIKETAHUI. Langsung edukasi/respon, jangan tanya ulang keluhannya apa.`;
      }

      formCtx += `\n\nALUR YANG BENAR untuk form lead:`;
      if (convState.form_alamat) {
        formCtx += `\n1. Konfirmasi alamat (tampilkan + minta koreksi/persetujuan)`;
      } else {
        formCtx += `\n1. Tanyakan alamat lengkap customer`;
      }
      formCtx += `\n2. Kalau alamat sudah oke → hitung ongkir → tanyakan metode bayar`;
      formCtx += `\n3. Proses order seperti biasa`;

      systemPrompt += formCtx;
    }

    // Inject konteks repeat order (re-open dari closing) — tampilkan alamat lama untuk dikonfirmasi
    if (convState.reopened_at && !convState.wilayah && convState.prev_wilayah) {
      const prevAlamatDisplay = customer?.alamat
        ? [customer.alamat.jalan, customer.alamat.kelurahan, customer.alamat.kecamatan, customer.alamat.kabupaten, customer.alamat.provinsi].filter(Boolean).join(', ')
        : convState.prev_wilayah;
      systemPrompt += `\n\n[SISTEM - REPEAT ORDER] Customer ini pernah order sebelumnya dan chat lagi.`
        + `\nAlamat order terakhir: "${prevAlamatDisplay}"`
        + `\nLangkah yang BENAR:`
        + `\n1. Sambut dengan hangat, tanyakan mau order lagi atau ada keperluan lain`
        + `\n2. Kalau mau order → tanyakan konfirmasi alamat: "Alamat pengirimannya masih sama ya kak di ${convState.prev_wilayah}? 😊"`
        + `\n3. Customer bilang iya/sama → langsung tulis [WILAYAH_OK:${convState.prev_wilayah}] → sistem hitung ongkir otomatis`
        + `\n4. Customer bilang ganti/beda → tanya alamat baru dari awal`
        + `\nJANGAN tanya alamat dari nol tanpa tunjukkan alamat lama dulu.`;
    }

    if (conversation.ringkasan) {
      systemPrompt += `\n\nKONTEKS PERCAKAPAN SEBELUMNYA (ringkasan otomatis)\n${conversation.ringkasan}\n\nLanjutkan percakapan dari konteks ini. Jangan ulangi salam dari awal.`;
    }

    // Inject konteks awaiting bukti TF — customer sudah confirm order transfer, tinggal kirim bukti
    if (convState.awaiting_bukti_tf && !convState.awaiting_qc_tf) {
      systemPrompt += `\n\n[SISTEM - PENTING] Customer sudah KONFIRMASI pesanan dengan metode TRANSFER. Sedang menunggu bukti transfer (foto struk/screenshot). JANGAN generate [ORDER_CONFIRMED]. Kalau customer kirim pesan teks (bukan gambar), ingatkan dengan sopan untuk kirim bukti TF-nya. Kalau customer tanya rekening lagi, kasih info rekening: ${userRekening || '(belum diisi)'}. JANGAN closing sebelum bukti TF valid.`;
    }

    // Inject konteks awaiting QC — bukti TF sudah dikirim, menunggu verifikasi finance
    if (convState.awaiting_qc_tf) {
      systemPrompt += `\n\n[SISTEM - PENTING] Bukti transfer customer sudah diterima dan sedang DICEK oleh tim finance kami. JANGAN generate [ORDER_CONFIRMED]. Kalau customer tanya status, bilang "Bukti transfernya sudah kami terima kak, sedang dalam proses pengecekan oleh tim finance kami ya 🙏". Kalau customer kirim bukti TF baru/ulang, terima saja dan bilang sudah diupdate.`;
    }

    // Inject konteks order sudah placed — cegah Claude kirim konfirmasi ulang
    if (convState.order_placed && !convState.awaiting_order_confirm) {
      systemPrompt += `\n\n[SISTEM - PENTING] Order customer ini SUDAH SELESAI DIPROSES sebelumnya. JANGAN generate marker [ORDER_CONFIRMED] atau kirim ringkasan order lagi. Baca konteks percakapan dan jawab pertanyaan customer secara natural sesuai apa yang mereka tanyakan.`;
    }

    // Conversation sudah pernah closing (closed_order_id ada) — bot cukup bales chat, jangan order lagi
    if (convState.closed_order_id) {
      systemPrompt += `\n\n[SISTEM - PENTING] Pesanan customer ini SUDAH SELESAI dan tercatat di sistem (Order ID: ${convState.closed_order_id}). DILARANG KERAS generate marker [ORDER_CONFIRMED] atau [ORDER_DATA] dalam conversation ini. Tugasmu sekarang hanya membalas chat customer secara natural — jawab pertanyaan, ucapkan terima kasih, bantu tanya status pengiriman, dll. JANGAN proses order baru di conversation ini.`;
    }

    // Customer sudah cancel — bot harus hormat keputusan, JANGAN paksa beli lagi
    if (convState.is_cancelled) {
      systemPrompt += `\n\n[SISTEM] Customer ini SUDAH MEMBATALKAN pesanannya. Hormat keputusannya — ucapkan terima kasih, bilang pintunya selalu terbuka kalau mau order lagi. JANGAN coba persuade, rayu, atau tanya alasan berkali-kali. Cukup 1x tanya "boleh tau kenapa kak?" lalu terima jawabannya.`;
    }

    // Inject data order (resi, status, ekspedisi) supaya bot bisa jawab kalau customer tanya
    if (convState.order_placed || convState.closed_order_id) {
      const recentOrders = await sbGet('orders_new', `?conversation_id=eq.${conversation.id}&order=created_at.desc&limit=5&select=no_resi,ekspedisi,status,status_tracking,tracking_lokasi,created_at`).catch(() => []);
      if (recentOrders.length) {
        let orderCtx = '\n\nDATA ORDER CUSTOMER (gunakan untuk menjawab pertanyaan seputar pesanan/resi/pengiriman):';
        recentOrders.forEach((o, i) => {
          const tgl = o.created_at ? new Date(o.created_at).toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' }) : '-';
          orderCtx += `\nOrder ${recentOrders.length > 1 ? (i+1) + ' ' : ''}(${tgl}):`;
          orderCtx += ` Resi: ${o.no_resi || 'belum ada'}`;
          orderCtx += ` | Kurir: ${o.ekspedisi || '-'}`;
          orderCtx += ` | Status: ${o.status || '-'}`;
          if (o.status_tracking) orderCtx += ` | Tracking: ${o.status_tracking}`;
          if (o.tracking_lokasi) orderCtx += ` (${o.tracking_lokasi})`;
        });
        orderCtx += '\n\nKalau customer tanya resi/nomor pengiriman, berikan langsung. Kalau resi "belum ada", sampaikan bahwa pesanan sedang diproses dan resi akan dikirimkan segera setelah barang dikirim.';
        systemPrompt += orderCtx;
      }
    }

    // Inject delivery issue context jika ada masalah pengiriman
    if (convState.delivery_issue) {
      const issueType = convState.delivery_issue_type === 'retur' ? 'RETUR (dikembalikan ke pengirim)' : 'BERMASALAH (kurir gagal antar)';
      const issueStatus = convState.delivery_issue_status || '';
      const issueResi = convState.delivery_issue_resi || '';
      systemPrompt += `\n\n[SISTEM - MASALAH PENGIRIMAN] Paket customer ini sedang ${issueType}.`
        + `\nStatus terakhir: ${issueStatus}`
        + `\nResi: ${issueResi}`
        + `\n\nTugasmu:`
        + `\n1. Kalau customer bales soal masalah ini → bantu cari solusi dengan empati (cek alamat, HP aktif, ada orang di rumah, dll)`
        + `\n2. Kalau customer tanya status → jelaskan situasinya dengan jujur tapi tetap positif`
        + `\n3. Jangan bilang "kami tidak bisa bantu" — selalu tawarkan solusi (koordinasi ulang pengiriman, cek alamat, dll)`
        + `\n4. Kalau retur: sampaikan bahwa tim sedang koordinasi dan akan dihubungi untuk pengiriman ulang`;
    }

    // Inject wilayah risk agar Claude ingat sepanjang conversation
    const wr = customer?.wilayah_risk;
    if (wr && convState.ongkir && !convState.order_placed) {
      if (wr.level === 'rawan') {
        systemPrompt += `\n\n[SISTEM - WILAYAH RAWAN] Area customer (kodepos ${wr.kodepos}) RTS ${wr.pct}% (${wr.label}). Sepanjang conversation ini: utamakan Transfer, kalau customer minta COD tanya ekspedisi yang biasa mereka pakai. Jangan sebut angka RTS ke customer secara blak-blakan, sampaikan dengan empati.`;
      } else if (wr.level === 'perhatian') {
        systemPrompt += `\n\n[SISTEM - WILAYAH PERHATIAN] Area customer RTS ${wr.pct}% — mention Transfer sebagai opsi lebih aman tapi tidak perlu dipaksakan.`;
      }
    }

    // Inject konteks awaiting_order_confirm agar Claude tidak trigger ORDER_CONFIRMED lagi
    if (convState.awaiting_order_confirm || convState.awaiting_order_correction) {
      systemPrompt += `\n\n[SISTEM - PENTING] Kamu sudah mengirim ringkasan pesanan ke customer dan sedang menunggu konfirmasi mereka. JANGAN generate marker [ORDER_CONFIRMED] lagi.
Jika customer bertanya hal lain (bukan soal order), jawab pertanyaannya dulu dengan ramah dan lengkap. Setelah menjawab, tambahkan 1 kalimat pengingat ringan di akhir seperti: "Oh iya kak, kalau data pesanannya sudah oke, langsung konfirmasi ya 😊" — tapi hanya kalau relevan dan tidak memotong konteks.
JANGAN langsung kirim ulang ringkasan pesanan kalau customer tidak minta.`;
    }

    // Inject ulang allRates setiap pesan agar Claude selalu bisa jawab pertanyaan kurir
    if (convState.ongkir?.allRates?.length) {
      const fmt = n => `Rp ${n.toLocaleString('id-ID')}`;
      const tabel = convState.ongkir.allRates.map(r => {
        const potongan = r.ongkir !== r.ongkirPromo ? ` (hemat ${fmt(r.ongkir - r.ongkirPromo)})` : '';
        return `- ${r.nama}: ongkir ${fmt(r.ongkir)}${potongan} → TF ${fmt(r.totalTF)} | COD ${fmt(r.totalCOD)}`;
      }).join('\n');
      const areaOngkir = convState.ongkir.area
        ? [convState.ongkir.area.kecamatan, convState.ongkir.area.kota, convState.ongkir.area.provinsi].filter(Boolean).join(', ')
        : convState.wilayah || '';
      systemPrompt += `\n\nDATA SEMUA KURIR TERSEDIA (selalu gunakan ini kalau customer tanya kurir lain — JANGAN bilang "ditentukan sistem"):\n${tabel}\nRekomendasi sistem: ${convState.ongkir.ekspedisi}${areaOngkir ? `\nWilayah tujuan: ${areaOngkir} (SUDAH DIKETAHUI — jangan tanya wilayah lagi)` : ''}`;
    }

    // ── Ambil pesan terakhir — kalau ada ringkasan, cukup 10 pesan; kalau belum, 20 ───
    const historyLimit = conversation.ringkasan ? 10 : 20;
    const history = await getContextMessages(conversation.id, null, historyLimit);

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
          hasilKTP = await hitungOngkir(wilayahKTP, product, parseInt(convState.qty) || 1, userMngAreaId).catch(() => null);
          if (hasilKTP) {
            stateKTP.wilayah = wilayahKTP;
            stateKTP.ongkir  = hasilKTP;
            convState.ongkir  = hasilKTP;
            convState.wilayah = wilayahKTP;
            // Simpan ke customers.alamat
            if (customer?.id && hasilKTP.area?.kecamatan) {
              const alamatBaru = {
                ...(customer.alamat || {}),
                kelurahan: hasilKTP.area.kelurahan, kecamatan: hasilKTP.area.kecamatan,
                kabupaten: hasilKTP.area.kota, provinsi: hasilKTP.area.provinsi,
                kodepos: hasilKTP.area.kodePos, ekspedisi: hasilKTP.ekspedisi,
                ongkirAsli: hasilKTP.ongkirAsli, ongkirPromo: hasilKTP.ongkirPromo,
                feeCOD: hasilKTP.feeCOD, harga: hasilKTP.harga,
              };
              await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru })
                .catch(e => console.error('[KTP] Gagal save customer.alamat:', e.message));
              customer.alamat = alamatBaru;
            }
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
Konfirmasi ke customer bahwa bukti TF sudah diterima dan sedang dicek oleh tim finance. Pesanan akan segera diproses setelah transfer dikonfirmasi.`;

        // ── QC Transfer: bukti TF valid → masuk antrian QC, JANGAN langsung closing ──
        if (convState.awaiting_bukti_tf || convState.order_snapshot) {
          try {
            // Upload bukti TF ke Supabase Storage
            let buktiUrl = null;
            if (mediaUrl && mediaUrl.startsWith('data:image')) {
              const imgMatch = mediaUrl.match(/^data:image\/([a-z0-9]+);base64,/i);
              const ext = imgMatch?.[1] || 'jpeg';
              const imgBuffer = Buffer.from(mediaUrl.replace(/^data:image\/[a-z0-9]+;base64,/i, ''), 'base64');
              const filename = `${conversation.id}_${Date.now()}.${ext}`;

              const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/bukti-tf/${filename}`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                  'Content-Type': `image/${ext}`,
                  'x-upsert': 'true',
                },
                body: imgBuffer,
              });
              if (uploadRes.ok) {
                buktiUrl = `${SUPABASE_URL}/storage/v1/object/public/bukti-tf/${filename}`;
                console.log(`[qc-tf] Bukti TF uploaded: ${buktiUrl}`);
              } else {
                console.error(`[qc-tf] Upload gagal: ${await uploadRes.text()}`);
              }
            }

            // Build order snapshot data
            const snap       = convState.order_snapshot || {};
            const ongkirSnap = convState.ongkir || {};
            const qtySnap    = parseInt(snap.qty || convState.qty || 1) || 1;
            const hargaSnap  = snap.harga || resolveHargaBundling(product, qtySnap) || product?.harga || 0;
            const ongkirPromoSnap = snap.ongkirPromo ?? ongkirSnap.ongkirPromo ?? 0;
            const totalSnap  = hargaSnap + ongkirPromoSnap; // Transfer = no feeCOD

            const qcData = {
              user_id:          userId,
              customer_id:      customer?.id || null,
              conversation_id:  conversation.id,
              product_id:       product?.id || null,
              bukti_url:        buktiUrl,
              nominal:          imageAnalysis.nominal || null,
              bank:             imageAnalysis.bank || null,
              tanggal_tf:       imageAnalysis.tanggal || null,
              rekening_tujuan:  imageAnalysis.no_rekening_tujuan || null,
              order_snapshot: {
                ...snap,
                ongkir:    ongkirSnap,
                alamat:    snap.alamat    || convState.alamat    || '',
                keluhan:   snap.keluhan   || convState.keluhan   || '',
                ekspedisi: snap.ekspedisi || ongkirSnap.ekspedisi || '',
                ongkirAsli:   snap.ongkirAsli   || ongkirSnap.ongkirAsli   || 0,
                ongkirPromo:  ongkirPromoSnap,
                harga:        hargaSnap,
                area:         ongkirSnap.area || null,
                mengantar_dest_id: ongkirSnap.mengantar_dest_id || null,
              },
              customer_nama:    customer?.nama || '',
              customer_phone:   (customer?.wa_number || '').replace(/^62/, '0'),
              product_nama:     product?.nama || '',
              qty:              qtySnap,
              total:            totalSnap,
            };

            // Cek apakah sudah ada pending QC untuk conversation ini → replace
            const existingQC = await sbGet('transfer_qc', `?conversation_id=eq.${conversation.id}&qc_status=eq.pending&limit=1`).catch(() => []);
            const isNewQC = !existingQC.length;

            if (existingQC.length) {
              await sbPatch('transfer_qc', `?id=eq.${existingQC[0].id}`, {
                ...qcData,
                created_at: new Date().toISOString(),
              });
              console.log(`[qc-tf] Updated existing QC ${existingQC[0].id}`);
            } else {
              await sbPost('transfer_qc', qcData);
              console.log(`[qc-tf] Insert transfer_qc OK — conv ${conversation.id}`);
            }

            // Update state: menunggu QC finance
            await updateConvState(conversation.id, { awaiting_qc_tf: true });

            // Kirim notif ke grup WA QC — HANYA kalau QC baru (bukan update ulang)
            if (QC_GROUP_JID && isNewQC) {
              const qcNotif = `📋 *Bukti TF Baru*\nNama: ${customer?.nama || '-'}\nProduk: ${product?.nama || '-'} x${qtySnap}\nNominal: ${imageAnalysis.nominal || '?'}\nBank: ${imageAnalysis.bank || '?'}\n\nCek & ACC di:\nhttps://csadsy.vercel.app/qc-transfer`;
              await sendWA(waSession, QC_GROUP_JID, qcNotif, true).catch(() => {});
              console.log(`[qc-tf] Notif QC terkirim ke grup QC`);
            } else if (existingQC.length) {
              console.log(`[qc-tf] QC sudah ada (${existingQC[0].id}), skip notif ulang ke grup`);
            }
          } catch(e) {
            console.error('[qc-tf] Error:', e.message);
          }
        }
      } else {
        // rekening_cocok === null artinya tidak bisa dibaca — jangan anggap valid
        notif = `[SISTEM] Customer kirim gambar yang terlihat seperti bukti transfer tapi rekening tujuan tidak bisa terbaca dengan jelas.
Bank: ${imageAnalysis.bank || '?'} | Nominal: ${imageAnalysis.nominal || '?'}
Minta customer konfirmasi apakah sudah transfer ke rekening yang benar: ${userRekening || '(belum diisi)'}.`;
      }
      history.push({ role: 'user', content: notif });
    }

    // ── Hint ke Claude jika auto-load ongkir baru berhasil → suruh tampilkan total ──
    if (autoLoadedOngkir) {
      history.push({ role: 'user', content:
        buildOngkirInjeksi(autoLoadedOngkir, product,
          `Wilayah customer sudah diketahui dari data sebelumnya: ${convState.wilayah}. `) +
        `\n\nLangsung tampilkan total harga COD & Transfer ke customer sekarang, lalu tanya metode bayar. JANGAN tanya alamat lagi.`
      });
    }

    // ── WEBHOOK-LEVEL: Auto-search wilayah via tabel lokal wilayah_id ──
    let pendingKecResolvedWilayah = null; // diset saat kelurahan berhasil ditemukan via pendingKec
    let precomputedOngkir = null; // ongkir yang sudah dihitung di blok pendingKec/single-kel
    let precomputedFirst  = null; // data wilayah untuk context buildOngkirInjeksi
    const lastAiMsg = history.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    const aiTanyaLokasi = /daerah|wilayah|provinsi|kota|kabupaten|kecamatan|kelurahan|desa|alamat|kirim ke|tinggal di|dari mana|lokasi/i.test(lastAiMsg);
    const kelurahanBelumTerisi = !convState.ongkir?.area?.kelurahan || convState.pending_kecamatan;
    // Kalau pending_kecamatan aktif, selalu coba search (tidak perlu aiTanyaLokasi)
    const perluSearchWilayah = (!convState.wilayah || kelurahanBelumTerisi) && (aiTanyaLokasi || convState.pending_kecamatan);
    // GUARD: kalau pesan hanya konfirmasi ("sudah", "iya", "betul", dll) → jangan search wilayah
    // Kasus nyata: customer jawab "Sudah" (= iya betul) → sistem salah detect kelurahan "Sudah" di Bojonegoro
    if (perluSearchWilayah && message.length >= 3 && message.length <= 80 && !isConfirmation(message)) {
      try {
        // ── Kalau bot sedang menunggu jawaban kelurahan (pending_kecamatan ada di state),
        //    cari kelurahan di kecamatan itu saja — jangan search global (bisa salah kecamatan)
        const pendingKec = convState.pending_kecamatan; // { kecamatan, kabupaten, provinsi }
        let hasil;

        if (pendingKec?.kecamatan) {
          const kwClean = cleanKelInput(message);

          // Helper search di kecamatan pending
          const searchDiKec = async (kw) => {
            if (!kw || kw.length < 2) return [];
            return sbGet('wilayah_id',
              `?kelurahan=ilike.*${encodeURIComponent(kw)}*&kecamatan=ilike.${encodeURIComponent(pendingKec.kecamatan)}&kabupaten=ilike.${encodeURIComponent(pendingKec.kabupaten)}&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
            ).catch(() => []);
          };

          // 1. Coba exact substring dari keyword bersih (misal "pendoharjo")
          let byKel = await searchDiKec(kwClean);

          // 2. Kalau gagal, coba prefix 5 karakter (menangkap typo/singkatan)
          //    "pendoharjo" → "pendo" → match "Pendowoharjo"
          if (!byKel.length && kwClean.length >= 5) {
            byKel = await searchDiKec(kwClean.slice(0, 5));
          }

          // 3. Kalau masih gagal, coba prefix 4 karakter
          if (!byKel.length && kwClean.length >= 4) {
            byKel = await searchDiKec(kwClean.slice(0, 4));
          }

          // 4. Fuzzy: match via subsequence — "pendoharjo" ⊆ "pendowoharjo"
          if (!byKel.length && kwClean.length >= 4) {
            const allKel = await getKelurahanByKecamatan(pendingKec.kecamatan, pendingKec.kabupaten);
            const inp = kwClean.replace(/[^a-z0-9]/g, '');
            const isSubseq = (needle, hay) => {
              let ni = 0;
              for (let hi = 0; hi < hay.length && ni < needle.length; hi++) {
                if (needle[ni] === hay[hi]) ni++;
              }
              return ni === needle.length;
            };
            const match = allKel.find(kel => {
              const k = kel.toLowerCase().replace(/[^a-z0-9]/g, '');
              return isSubseq(inp, k) || k.startsWith(inp.slice(0, 4));
            });
            if (match) {
              byKel = await sbGet('wilayah_id',
                `?kelurahan=ilike.${encodeURIComponent(match)}&kecamatan=ilike.${encodeURIComponent(pendingKec.kecamatan)}&kabupaten=ilike.${encodeURIComponent(pendingKec.kabupaten)}&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
              ).catch(() => []);
              console.log(`[pendingKec] Fuzzy match: "${kwClean}" → "${match}"`);
            }
          }

          // 5. AI Match (Sonnet) — analisis pesan customer langsung, handle typo/bahasa natural
          if (!byKel.length) {
            const allKel = byKel.length ? [] : await getKelurahanByKecamatan(pendingKec.kecamatan, pendingKec.kabupaten);
            if (allKel.length > 0) {
              const aiMatch = await aiMatchKelurahan(message, allKel, pendingKec.kecamatan, pendingKec.kabupaten, aiKey, aiBase);
              if (aiMatch) {
                byKel = await sbGet('wilayah_id',
                  `?kelurahan=ilike.${encodeURIComponent(aiMatch)}&kecamatan=ilike.${encodeURIComponent(pendingKec.kecamatan)}&kabupaten=ilike.${encodeURIComponent(pendingKec.kabupaten)}&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
                ).catch(() => []);
              }
            }
          }

          hasil = byKel;
          if (byKel.length > 0) {
            console.log(`[pendingKec] "${message}" (clean:"${kwClean}") → ${byKel.length} hasil di ${pendingKec.kecamatan}`);
          } else {
            // Masih tidak ketemu → fallback global
            hasil = await cariWilayah(kwClean || message, 5);
          }
        } else {
          // Bersihkan "kak", "ya", dll sebelum search global juga
          const kwGlobal = cleanKelInput(message);
          hasil = await cariWilayah(kwGlobal || message, 5);
        }

        if (hasil.length > 0) {
          const kecamatanUnik = [...new Set(hasil.map(r => `${r.kecamatan}||${r.kabupaten}`))];

          if (pendingKec?.kecamatan && hasil.length >= 1 && kecamatanUnik.length === 1) {
            const first = hasil[0];
            const wilayahKonfirm = `${first.kelurahan}, ${first.kecamatan}, ${first.kabupaten}, ${first.provinsi}`;

            // 1. Simpan area ke customers.alamat dulu
            if (customer?.id) {
              const alamatArea = {
                ...(customer.alamat || {}),
                kelurahan: first.kelurahan,
                kecamatan: first.kecamatan,
                kabupaten: first.kabupaten,
                provinsi:  first.provinsi,
              };
              await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatArea })
                .catch(e => console.error('[pendingKec] Gagal save area:', e.message));
              customer.alamat = alamatArea;
            }

            // 2. Hitung ongkir
            await updateConvState(conversation.id, { wilayah: wilayahKonfirm, pending_kecamatan: null, proposed_wilayah: null });
            convState.wilayah = wilayahKonfirm;
            convState.pending_kecamatan = null;

            const hasilOngkir = await hitungOngkir(wilayahKonfirm, product, parseInt(convState.qty) || 1, userMngAreaId).catch(() => null);
            if (hasilOngkir) {
              await updateConvState(conversation.id, { ongkir: hasilOngkir, waiting_for_location: false });
              convState.ongkir = hasilOngkir;
              convState.waiting_for_location = false;

              // 3. Update customers.alamat dengan data ongkir lengkap
              if (customer?.id) {
                const alamatLengkap = {
                  ...(customer.alamat || {}),
                  kodepos:     hasilOngkir.area?.kodePos || '',
                  ekspedisi:   hasilOngkir.ekspedisi,
                  ongkirAsli:  hasilOngkir.ongkirAsli,
                  ongkirPromo: hasilOngkir.ongkirPromo,
                  feeCOD:      hasilOngkir.feeCOD,
                  harga:       hasilOngkir.harga,
                };
                await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatLengkap })
                  .catch(e => console.error('[pendingKec] Gagal save ongkir:', e.message));
                customer.alamat = alamatLengkap;
              }

              // 4. Simpan untuk two-step Claude call (hindari consecutive user messages)
              precomputedOngkir = hasilOngkir;
              precomputedFirst  = first;
            } else {
              pendingKecResolvedWilayah = wilayahKonfirm; // fallback: append [WILAYAH_OK:] nanti
              history.push({ role: 'user', content:
                `[SISTEM] Kelurahan: ${wilayahKonfirm}. Konfirmasi ke customer dan tulis [WILAYAH_OK:${wilayahKonfirm}] di akhir pesan.`
              });
            }
            console.log(`[pendingKec] Kelurahan confirmed & saved: ${first.kelurahan}, ${first.kecamatan}`);

          } else if (kecamatanUnik.length === 1) {
            // Satu kecamatan teridentifikasi → cek apakah perlu tanya kelurahan
            const first = hasil[0];
            const kelurahanList = await getKelurahanByKecamatan(first.kecamatan, first.kabupaten);

            if (kelurahanList.length <= 1) {
              // Hanya 1 kelurahan → simpan & hitung ongkir langsung
              const wKonfirm = `${first.kelurahan}, ${formatWilayah(first)}`;
              if (customer?.id) {
                const alamatArea = { ...(customer.alamat||{}), kelurahan:first.kelurahan, kecamatan:first.kecamatan, kabupaten:first.kabupaten, provinsi:first.provinsi };
                await sbPatch('customers',`?id=eq.${customer.id}`,{alamat:alamatArea}).catch(()=>{});
                customer.alamat = alamatArea;
              }
              await updateConvState(conversation.id, { wilayah: wKonfirm, pending_kecamatan: null, proposed_wilayah: null });
              convState.wilayah = wKonfirm;
              convState.pending_kecamatan = null;
              const ho = await hitungOngkir(wKonfirm, product, parseInt(convState.qty) || 1, userMngAreaId).catch(()=>null);
              if (ho) {
                await updateConvState(conversation.id, { ongkir: ho });
                convState.ongkir = ho;
                if (customer?.id) {
                  const al = { ...(customer.alamat||{}), kodepos:ho.area?.kodePos||'', ekspedisi:ho.ekspedisi, ongkirAsli:ho.ongkirAsli, ongkirPromo:ho.ongkirPromo, feeCOD:ho.feeCOD, harga:ho.harga };
                  await sbPatch('customers',`?id=eq.${customer.id}`,{alamat:al}).catch(()=>{});
                  customer.alamat = al;
                }
                precomputedOngkir = ho;
                precomputedFirst  = first;
              } else {
                pendingKecResolvedWilayah = wKonfirm;
                history.push({ role:'user', content: `[SISTEM] Wilayah: ${wKonfirm}. Konfirmasi ke customer dan tulis [WILAYAH_OK:${wKonfirm}] di akhir pesan.` });
              }
            } else {
              // Banyak kelurahan → cek dulu apakah keyword customer cocok salah satu kelurahan
              const kwCleanGlobal = cleanKelInput(message);
              const autoMatchKel = kelurahanList.find(kel => {
                const kelN = kel.toLowerCase().replace(/[^a-z0-9]/g, '');
                const kwN  = kwCleanGlobal.replace(/[^a-z0-9]/g, '');
                return kelN === kwN || kelN.startsWith(kwN) || kwN.startsWith(kelN);
              });

              if (autoMatchKel) {
                // Nama kelurahan cocok dengan keyword → auto-confirm, tidak perlu tanya lagi
                const wKonfirm = `${autoMatchKel}, ${first.kecamatan}, ${first.kabupaten}, ${first.provinsi}`;
                console.log(`[autoMatchKel] keyword "${kwCleanGlobal}" → kelurahan "${autoMatchKel}" di Kec. ${first.kecamatan}`);
                if (customer?.id) {
                  const alamatArea = { ...(customer.alamat||{}), kelurahan:autoMatchKel, kecamatan:first.kecamatan, kabupaten:first.kabupaten, provinsi:first.provinsi };
                  await sbPatch('customers',`?id=eq.${customer.id}`,{alamat:alamatArea}).catch(()=>{});
                  customer.alamat = alamatArea;
                }
                await updateConvState(conversation.id, { wilayah: wKonfirm, pending_kecamatan: null, proposed_wilayah: null });
                convState.wilayah = wKonfirm;
                convState.pending_kecamatan = null;
                // Kasih hint ke Claude supaya langsung konfirmasi, tidak tanya kelurahan lagi
                history.push({ role: 'user', content:
                  `[SISTEM] Sistem mendeteksi otomatis: Kelurahan ${autoMatchKel}, Kec. ${first.kecamatan}, ${first.kabupaten}, ${first.provinsi}. Konfirmasi ke customer dengan natural dan tulis [WILAYAH_OK:${wKonfirm}] di akhir pesan. Jangan tanya kelurahan lagi.`
                });
                const ho = await hitungOngkir(wKonfirm, product, parseInt(convState.qty) || 1, userMngAreaId).catch(()=>null);
                if (ho) {
                  await updateConvState(conversation.id, { ongkir: ho });
                  convState.ongkir = ho;
                  if (customer?.id) {
                    const al = { ...(customer.alamat||{}), kodepos:ho.area?.kodePos||'', ekspedisi:ho.ekspedisi, ongkirAsli:ho.ongkirAsli, ongkirPromo:ho.ongkirPromo, feeCOD:ho.feeCOD, harga:ho.harga };
                    await sbPatch('customers',`?id=eq.${customer.id}`,{alamat:al}).catch(()=>{});
                    customer.alamat = al;
                  }
                  precomputedOngkir = ho;
                  precomputedFirst  = { ...first, kelurahan: autoMatchKel };
                } else {
                  pendingKecResolvedWilayah = wKonfirm;
                }
              } else {
                // Tidak ada kelurahan yang cocok → simpan pending dan tanya kelurahan
                await updateConvState(conversation.id, {
                  pending_kecamatan: { kecamatan: first.kecamatan, kabupaten: first.kabupaten, provinsi: first.provinsi },
                });
                const contohKel = kelurahanList.slice(0, 3).join(', ');
                const hint = `[SISTEM] Kecamatan "${first.kecamatan}", ${first.kabupaten}, ${first.provinsi} ditemukan.\n`
                  + `Semua kelurahan valid: ${kelurahanList.join(', ')}\n`
                  + `Tanyakan kelurahannya dengan NATURAL — sebut 2-3 contoh (misal: ${contohKel}). Gaya WA santai, 1-2 kalimat.\n`
                  + `Setelah customer sebut kelurahan yang valid, tulis [WILAYAH_OK:kelurahan, ${first.kecamatan}, ${first.kabupaten}, ${first.provinsi}].`;
                history.push({ role: 'user', content: hint });
                console.log(`Tawarkan ${kelurahanList.length} kelurahan di Kec. ${first.kecamatan}`);
              }
            }

          } else if (pendingKec?.kecamatan) {
            // Sedang nunggu kelurahan tapi tidak ketemu → minta ulang
            const kelAll = await getKelurahanByKecamatan(pendingKec.kecamatan, pendingKec.kabupaten);
            const contoh = kelAll.slice(0, 3).join(', ');
            const hint = `[SISTEM] Kelurahan "${message}" tidak ditemukan di Kecamatan ${pendingKec.kecamatan}.\n`
              + `Kelurahan valid di sana: ${kelAll.join(', ')}\n`
              + `Minta customer pilih kelurahan yang ada dengan ramah, contoh: ${contoh}. Jangan tulis [WILAYAH_OK] sampai customer sebut kelurahan yang valid.`;
            history.push({ role: 'user', content: hint });

          } else {
            // Banyak kecamatan berbeda → suggest beberapa opsi kecamatan secara natural
            const kecList = [...new Set(hasil.map(r => r.kecamatan))].slice(0, 4);
            const hint = `[SISTEM] Sistem menemukan beberapa kecamatan untuk "${message}": ${kecList.join(', ')}, dll.\n`
              + `Tanyakan kecamatannya dengan NATURAL — sebut 2-3 pilihan sebagai contoh (misal: "${kecList[0]}, ${kecList[1] || kecList[0]}, atau kecamatan lain?"). `
              + `Jangan kaku, gaya WA santai. Setelah dapat kecamatan, sistem akan bantu cari kelurahannya.`;
            history.push({ role: 'user', content: hint });
            console.log(`Multiple kecamatan untuk "${message}": ${kecList.join(' | ')}`);
          }
        }
      } catch(e) { console.error('Wilayah hint error:', e.message); }
    }

    // ── WEBHOOK-LEVEL: Auto-trigger ongkir jika customer konfirmasi wilayah ──
    // Cek apakah AI sebelumnya sedang tanya konfirmasi wilayah ("Sumba NTT ya kak?")
    // dan customer menjawab konfirmasi singkat ("iya", "yakin", "bener", dll)
    let autoOngkirResult = null;
    let proposedWilayah = convState.proposed_wilayah;

    // ── Deteksi lokasi dari pesan customer (hanya aktif kalau flag waiting_for_location nyala) ──
    // Flag di-set setelah AI nanya alamat/wilayah ke customer
    if (convState.waiting_for_location && !convState.ongkir && !convState.wilayah_data && !isConfirmation(message) && !(proposedWilayah && containsConfirmation(message))) {
      console.log(`[location] waiting_for_location aktif, extract dari: "${message.slice(0,80)}"`);
      const lokasi = await extractLokasiHaiku(message, aiKey, aiBase);
      console.log(`[location] Haiku extract:`, lokasi);

      if (lokasi?.kecamatan || lokasi?.kabupaten || lokasi?.kelurahan) {
        // Gabung dengan partial data yang sudah ada (kalau customer jawab field yang kurang)
        const partial = convState.wilayah_data_partial || {};
        const merged = {
          kelurahan: lokasi.kelurahan || partial.kelurahan || '',
          kecamatan: lokasi.kecamatan || partial.kecamatan || '',
          kabupaten: lokasi.kabupaten || partial.kabupaten || '',
        };

        const validasi = await validateWilayahDB(merged);
        console.log(`[location] validateWilayahDB:`, JSON.stringify({ valid: validasi.valid, row: validasi.row, missing: validasi.missing }));

        if (validasi.valid) {
          // Semua field valid → simpan wilayah_data + hitung ongkir
          const wd = validasi.row;
          const wilayahStr = `${wd.kelurahan}, ${wd.kecamatan}, ${wd.kabupaten}, ${wd.provinsi}`;
          const hasilOngkir = await hitungOngkir(wd, product, parseInt(convState.qty) || 1, userMngAreaId).catch(() => null);

          const stateUpdate = {
            wilayah_data: wd, wilayah: wilayahStr,
            proposed_wilayah: null, pending_kecamatan: null,
            waiting_for_location: false,
            wilayah_data_partial: null, wilayah_missing: null, wilayah_candidates: null,
          };
          if (hasilOngkir) stateUpdate.ongkir = hasilOngkir;
          await updateConvState(conversation.id, stateUpdate);
          Object.assign(convState, stateUpdate);
          proposedWilayah = null;
          if (hasilOngkir) {
            autoOngkirResult = { wilayah: wilayahStr, hasil: hasilOngkir, fromAddress: true };
          }
          console.log(`[location] ✅ Wilayah valid: ${wilayahStr}${hasilOngkir ? ' + ongkir OK' : ''}`);

          if (customer?.id) {
            const alamatBaru = { ...(customer.alamat || {}), kelurahan: wd.kelurahan, kecamatan: wd.kecamatan, kabupaten: wd.kabupaten, provinsi: wd.provinsi };
            await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru }).catch(() => {});
            customer.alamat = alamatBaru;
          }
        } else {
          // Partial → simpan progress, AI akan tanya field yang kurang
          const stateUpdate = {
            wilayah_data_partial: validasi.row || partial,
            wilayah_missing: validasi.missing || [],
            wilayah_candidates: (validasi.candidates || []).slice(0, 10),
            waiting_for_location: true,
          };
          await updateConvState(conversation.id, stateUpdate);
          Object.assign(convState, stateUpdate);
          console.log(`[location] ⚠️ Partial, missing: ${validasi.missing?.join(', ')}`);
        }
      } else {
        console.log(`[location] Tidak ada lokasi dalam pesan, waiting_for_location tetap aktif`);
      }
    }

    // pending_kecamatan tidak lagi memblokir — kalau proposed_wilayah sudah spesifik (ada kelurahan),
    // customer konfirmasi → langsung hitung ongkir. pending_kecamatan akan di-clear di bawah.
    // ── Auto-trigger ongkir: customer konfirmasi & wilayah_data sudah valid ──
    // Prioritas: pakai wilayah_data (object bersih) kalau ada
    if (convState.wilayah_data && !convState.ongkir && containsConfirmation(message)) {
      console.log(`[autoOngkir] wilayah_data ada, trigger ongkir dari object bersih`);
      const wd = convState.wilayah_data;
      const hasil = await hitungOngkir(wd, product, parseInt(convState.qty) || 1, userMngAreaId);
      if (hasil) {
        await updateConvState(conversation.id, { ongkir: hasil, proposed_wilayah: null, pending_kecamatan: null, waiting_for_location: false });
        convState.ongkir = hasil;
        convState.pending_kecamatan = null;
        convState.waiting_for_location = false;
        autoOngkirResult = { wilayah: `${wd.kelurahan}, ${wd.kecamatan}, ${wd.kabupaten}`, hasil };
        if (customer?.id) {
          const alamatBaru = { ...(customer.alamat || {}), kelurahan: wd.kelurahan, kecamatan: wd.kecamatan, kabupaten: wd.kabupaten, provinsi: wd.provinsi, ekspedisi: hasil.ekspedisi, ongkirAsli: hasil.ongkirAsli, ongkirPromo: hasil.ongkirPromo, feeCOD: hasil.feeCOD, harga: hasil.harga };
          await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru }).catch(() => {});
          customer.alamat = alamatBaru;
        }
      }
    }

    // Fallback: proposed_wilayah (legacy string) + konfirmasi
    if (!autoOngkirResult && proposedWilayah && containsConfirmation(message) && !convState.ongkir) {
      console.log(`Auto-trigger ongkir untuk wilayah: ${proposedWilayah}`);
      // Coba validasi proposed_wilayah dulu via DB
      const lokasiParsed = await extractLokasiHaiku(proposedWilayah, aiKey, aiBase).catch(() => null);
      const validasi = lokasiParsed ? await validateWilayahDB(lokasiParsed) : { valid: false };

      const ongkirInput = validasi.valid ? validasi.row : proposedWilayah;
      const hasil = await hitungOngkir(ongkirInput, product, parseInt(convState.qty) || 1, userMngAreaId);
      if (hasil) {
        const wilayahStr = validasi.valid ? `${validasi.row.kelurahan}, ${validasi.row.kecamatan}, ${validasi.row.kabupaten}, ${validasi.row.provinsi}` : proposedWilayah;
        const stateUpdate = { wilayah: wilayahStr, proposed_wilayah: null, pending_kecamatan: null, ongkir: hasil, waiting_for_location: false };
        if (validasi.valid) stateUpdate.wilayah_data = validasi.row;
        await updateConvState(conversation.id, stateUpdate);
        Object.assign(convState, stateUpdate);
        autoOngkirResult = { wilayah: wilayahStr, hasil };

        if (customer?.id) {
          const alamatBaru = {
            ...(customer.alamat || {}),
            ...(hasil.area?.kelurahan ? { kelurahan: hasil.area.kelurahan } : {}),
            ...(hasil.area?.kecamatan ? { kecamatan: hasil.area.kecamatan } : {}),
            ...(hasil.area?.kota      ? { kabupaten: hasil.area.kota }      : {}),
            ...(hasil.area?.provinsi  ? { provinsi:  hasil.area.provinsi }  : {}),
            ekspedisi: hasil.ekspedisi, ongkirAsli: hasil.ongkirAsli, ongkirPromo: hasil.ongkirPromo, feeCOD: hasil.feeCOD, harga: hasil.harga,
          };
          await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru }).catch(() => {});
          customer.alamat = alamatBaru;
        }
      } else {
        console.warn(`[autoOngkir] hitungOngkir gagal untuk "${proposedWilayah}", inject hint WILAYAH_OK ke Claude`);
        history.push({ role: 'user', content: `[SISTEM] Customer mengkonfirmasi wilayah "${proposedWilayah}". WAJIB tulis [WILAYAH_OK:${proposedWilayah}] di balasanmu sekarang agar sistem bisa hitung ongkir.` });
      }
    }

    // ── Fallback: customer konfirmasi tapi proposed_wilayah null → coba extract dari last AI message ──
    if (!autoOngkirResult && !proposedWilayah && !convState.ongkir && !convState.wilayah && !convState.wilayah_data && isConfirmation(message)) {
      const lastAiFallback = [...history].reverse().find(h => h.role === 'assistant');
      if (lastAiFallback?.content) {
        const extracted = extractProposedWilayah(lastAiFallback.content);
        if (extracted) {
          console.log(`[fallback-confirm] Extract wilayah dari last AI message: "${extracted}"`);
          history.push({ role: 'user', content: `[SISTEM] Customer mengkonfirmasi wilayah. Wilayah yang disebutkan sebelumnya: "${extracted}". WAJIB tulis [WILAYAH_OK:${extracted}] di balasanmu sekarang.` });
        }
      }
    }

    // ── HINT: Customer pilih metode bayar → inject total reminder ke Claude ──
    if (convState.ongkir && !autoOngkirResult) {
      const pilihCOD = /\bcod\b/i.test(message);
      const pilihTF  = /\btransfer\b|\btf\b|\bbank\b/i.test(message);
      if (pilihCOD || pilihTF) {
        const fmt = n => `Rp ${n.toLocaleString('id-ID')}`;
        const d = convState.ongkir;
        const ongkirDisplay = d.ongkirAsli !== d.ongkirPromo
          ? `~${fmt(d.ongkirAsli)}~ ${fmt(d.ongkirPromo)}`
          : fmt(d.ongkirPromo);
        const ekspLabel = d.ekspedisi || 'KURIR';

        // Cek apakah data sudah lengkap (nama + alamat sudah ada)
        const hasNama   = customer?.nama && customer.nama !== wa_number;
        const hasAlamat = !!(convState.alamat || convState.form_alamat);
        const dataLengkap = hasNama && hasAlamat;

        const alamatFinal = convState.alamat || convState.form_alamat || '';
        const namaFinal   = customer?.nama || '';
        const keluhanFinal = convState.keluhan || '-';
        const qtyFinal    = parseInt(convState.qty) || 1;
        const metode      = pilihCOD ? 'COD' : 'Transfer';

        let hint;
        if (dataLengkap) {
          // Data sudah lengkap → langsung closing tanpa tanya ulang
          if (pilihCOD) {
            hint = `[SISTEM] Customer memilih COD. Data sudah LENGKAP:\n`
              + `- Nama: ${namaFinal}\n- Alamat: ${alamatFinal}\n- HP: ${wa_number}\n\n`
              + `WAJIB lakukan SEKARANG dalam 1 pesan:\n`
              + `1. Tampilkan total:\n`
              + `📦 COD\n`
              + `${product?.nama || 'Produk'} ${fmt(d.harga)} + ongkir ${fmt((d.ongkirPromo || 0) + (d.feeCOD || 0))} = TOTAL ${fmt(d.totalCOD)}\n`
              + `Via ${ekspLabel} ya kak 🚗\n\n`
              + `2. Langsung tulis marker di AKHIR pesan (jangan tanya konfirmasi lagi):\n`
              + `[ORDER_CONFIRMED]\n`
              + `[ORDER_DATA:alamat="${alamatFinal}" keluhan="${keluhanFinal}" metode="COD" qty=${qtyFinal}]`;
          } else {
            hint = `[SISTEM] Customer memilih Transfer. Data sudah LENGKAP:\n`
              + `- Nama: ${namaFinal}\n- Alamat: ${alamatFinal}\n- HP: ${wa_number}\n\n`
              + `WAJIB lakukan SEKARANG dalam 1 pesan:\n`
              + `1. Tampilkan total:\n`
              + `💳 Transfer\n`
              + `${product?.nama || 'Produk'} ${fmt(d.harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(d.totalTransfer)}\n`
              + `Via ${ekspLabel} ya kak 🚗\n\n`
              + `2. Kasih info rekening: ${userRekening || '(rekening belum diisi)'}\n\n`
              + `3. Langsung tulis marker di AKHIR pesan (jangan tanya konfirmasi lagi):\n`
              + `[ORDER_CONFIRMED]\n`
              + `[ORDER_DATA:alamat="${alamatFinal}" keluhan="${keluhanFinal}" metode="Transfer" qty=${qtyFinal}]`;
          }
          console.log(`[metode-hint] ${metode} — data LENGKAP, inject direct closing`);
        } else {
          // Data belum lengkap → minta data yang kurang dulu
          if (pilihCOD) {
            hint = `[SISTEM] Customer memilih COD. WAJIB tampilkan ULANG total lengkap ke customer PERSIS seperti ini:\n\n`
              + `📦 COD\n`
              + `${product?.nama || 'Produk'} ${fmt(d.harga)} + ongkir ${fmt((d.ongkirPromo || 0) + (d.feeCOD || 0))} = TOTAL ${fmt(d.totalCOD)}\n`
              + `Via ${ekspLabel} ya kak 🚗\n\n`
              + `Setelah tampilkan total di atas, minta data yang BELUM ADA saja (nama, nomor HP, alamat lengkap). `
              + `Cek dulu dari data customer yang sudah diketahui — jangan tanya ulang yang sudah ada. JANGAN hanya bilang "Siap kak" tanpa total.`;
          } else {
            hint = `[SISTEM] Customer memilih Transfer. WAJIB tampilkan ULANG total lengkap ke customer PERSIS seperti ini:\n\n`
              + `💳 Transfer\n`
              + `${product?.nama || 'Produk'} ${fmt(d.harga)} + ongkir ${ongkirDisplay} = TOTAL ${fmt(d.totalTransfer)}\n`
              + `Via ${ekspLabel} ya kak 🚗\n\n`
              + `Setelah tampilkan total di atas, langsung kasih info rekening lalu minta data yang BELUM ADA saja (nama, nomor HP, alamat lengkap). JANGAN hanya bilang "Siap kak" tanpa total.`;
          }
          console.log(`[metode-hint] ${metode} — data BELUM lengkap (nama:${hasNama}, alamat:${hasAlamat}), inject reminder`);
        }
        history.push({ role: 'user', content: hint });
      }
    }

    // Safety: pastikan history tidak berakhir dengan assistant sebelum call Claude
    if (!history.length || history[history.length - 1].role === 'assistant') {
      history.push({ role: 'user', content: message || '[pesan customer]' });
    }

    let rawReply;

    if (autoOngkirResult) {
      // Inject hasil ongkir langsung ke Claude — skip nunggu marker
      const { wilayah, hasil, fromAddress } = autoOngkirResult;
      const prefix = fromAddress
        ? `Sistem berhasil detect wilayah dari alamat customer: ${wilayah}. Langsung tampilkan total harga — JANGAN konfirmasi wilayah dulu, JANGAN tanya "apakah alamatnya sudah benar". `
        : `Customer konfirmasi wilayah: ${wilayah}. `;
      const injeksi = buildOngkirInjeksi(hasil, product, prefix);

      const historyWithOngkir = [
        ...history,
        { role: 'user', content: injeksi },
      ];
      rawReply = await callClaude(systemPrompt, historyWithOngkir, chatModel, aiKey, aiBase);
    } else {
      rawReply = await callClaude(systemPrompt, history, chatModel, aiKey, aiBase);
    }

    if (!rawReply) return res.status(200).json({ ok: true, skipped: 'no_reply' });

    // ── Two-step: kelurahan resolved via pendingKec → call 1 konfirmasi, call 2 inject ongkir ──
    if (precomputedOngkir && !autoOngkirResult) {
      const histWithPrecomputed = [
        ...history,
        { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/g, '').trim() },
        { role: 'user', content: buildOngkirInjeksi(precomputedOngkir, product,
            `Lanjutkan balasan di atas dan langsung tampilkan total harga ke customer sekarang juga. Wilayah customer: ${precomputedFirst?.kelurahan}, ${precomputedFirst?.kecamatan}, ${precomputedFirst?.kabupaten}. `) },
      ];
      const ongkirReply = await callClaude(systemPrompt, histWithPrecomputed, chatModel, aiKey, aiBase);
      if (ongkirReply) rawReply = ongkirReply;
      // Strip [WILAYAH_OK:] dari rawReply supaya handler di bawah tidak proses ulang
      rawReply = rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/g, '').trim();
    }

    // ── Kalau Claude lupa nulis [WILAYAH_OK:] padahal kelurahan sudah resolved → append otomatis
    if (pendingKecResolvedWilayah && !rawReply.includes('[WILAYAH_OK:')) {
      rawReply += ` [WILAYAH_OK:${pendingKecResolvedWilayah}]`;
      console.log(`[pendingKec] Auto-append [WILAYAH_OK:${pendingKecResolvedWilayah}] karena Claude lupa`);
    }

    // ── Deteksi marker khusus ──────────────────────────────────
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
        const parsedQty = parseInt(qtyM?.[1] || '1');
        orderDataParsed = {
          alamat:  alamatM?.[1]  || '',
          keluhan: keluhanM?.[1] || '',
          metode:  metodeM?.[1]  || 'COD',
          qty:     parsedQty,
        };
        console.log('ORDER_DATA parsed:', JSON.stringify(orderDataParsed));
        // Simpan qty ke state supaya WILAYAH_OK & fallback bisa pakai nilai yang benar
        if (parsedQty > 1 || !convState.qty) {
          await updateConvState(conversation.id, { qty: parsedQty });
          convState.qty = parsedQty;
        }
      } catch(e) { console.error('ORDER_DATA parse error:', e.message); }
    }

    // ── Handle [WILAYAH_OK:] → cek spesifisitas dulu, baru hitung ongkir ────────
    // Skip kalau precomputedOngkir sudah handle (supaya tidak proses ulang & strip harga)
    if (wilayahOkMatch && !autoOngkirResult && !precomputedOngkir) {
      const wilayah = wilayahOkMatch[1].trim();
      console.log(`[WILAYAH_OK] detected: ${wilayah}`);

      // Guard: keyword terlalu pendek (< 5 karakter) → kemungkinan nama orang/kata umum, skip
      // Contoh: "Yayu" (4 huruf) bisa match "Nyayum" di Kalimantan via substring
      if (wilayah.length < 5 && !wilayah.includes(',')) {
        console.log(`[WILAYAH_OK] "${wilayah}" terlalu pendek (${wilayah.length} char) — skip, bukan nama wilayah valid`);
        // Jangan process — biarkan bot lanjut normal tanpa ongkir
      } else {

      // Cek apakah wilayah sudah spesifik (minimal kecamatan level)
      const lokalCek = await cariWilayah(wilayah, 100);
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
        rawReply = await callClaude(systemPrompt, histTanya, chatModel, aiKey, aiBase);

      } else if (lokalCek.length > 0 && kecamatanUnik.length === 1) {
        const first = lokalCek[0];
        // Cek apakah kelurahan sudah spesifik dari hasil pencarian
        const kelurahanUnik = [...new Set(lokalCek.map(r => r.kelurahan))];

        if (kelurahanUnik.length === 1) {
          // Sudah spesifik sampai kelurahan → langsung hitung ongkir, clear pending
          console.log(`[WILAYAH_OK] Kelurahan spesifik: ${first.kelurahan}, ${first.kecamatan} → hitung ongkir`);
          await updateConvState(conversation.id, { wilayah, proposed_wilayah: null, pending_kecamatan: null });
          convState.pending_kecamatan = null;

          // Step 1: Simpan area ke customers.alamat & conv state segera (sebelum hitung ongkir)
          if (customer?.id) {
            const alamatArea = {
              ...(customer.alamat || {}),
              kelurahan: first.kelurahan,
              kecamatan: first.kecamatan,
              kabupaten: first.kabupaten,
              provinsi:  first.provinsi,
            };
            console.log(`[WILAYAH_OK] Coba save customers.alamat, customer.id=${customer?.id}, alamat=`, JSON.stringify(alamatArea));
            const patchRes = await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatArea })
              .catch(e => { console.error('[WILAYAH_OK] Gagal save area awal:', e.message); return null; });
            console.log(`[WILAYAH_OK] Patch result:`, JSON.stringify(patchRes));
            customer.alamat = alamatArea;
          }
          if (!convState.alamat) {
            const alamatStr = [first.kelurahan, first.kecamatan, first.kabupaten, first.provinsi].filter(Boolean).join(', ');
            await updateConvState(conversation.id, { alamat: alamatStr });
            convState.alamat = alamatStr;
          }

          // Coba deteksi qty dari pesan AI (misal: "4 box", "2 pcs", "qty=4")
          let qtyFromReply = null;
          const qtyReplyMatch = rawReply.match(/\b(\d+)\s*(?:box|pcs|buah|paket)\b/i) || rawReply.match(/qty=(\d+)/i);
          if (qtyReplyMatch) qtyFromReply = parseInt(qtyReplyMatch[1]);
          const qtyState = qtyFromReply || parseInt(convState.qty) || 1;
          if (qtyFromReply && qtyFromReply !== parseInt(convState.qty)) {
            await updateConvState(conversation.id, { qty: qtyFromReply });
            convState.qty = qtyFromReply;
            console.log(`[WILAYAH_OK] qty deteksi dari reply: ${qtyFromReply}`);
          }
          const hasil = await hitungOngkir(wilayah, product, qtyState, userMngAreaId);
          if (hasil) {
            await updateConvState(conversation.id, { ongkir: hasil });
            convState.ongkir = hasil;

            // Step 2: Update customers.alamat dengan data ongkir (hanya overwrite field non-null dari API)
            if (customer?.id) {
              const alamatBaru = {
                ...(customer.alamat || {}),
                ...(hasil.area?.kelurahan ? { kelurahan: hasil.area.kelurahan } : {}),
                ...(hasil.area?.kecamatan ? { kecamatan: hasil.area.kecamatan } : {}),
                ...(hasil.area?.kota      ? { kabupaten: hasil.area.kota }      : {}),
                ...(hasil.area?.provinsi  ? { provinsi:  hasil.area.provinsi }  : {}),
                ...(hasil.area?.kodePos   ? { kodepos:   hasil.area.kodePos }   : {}),
                ekspedisi:   hasil.ekspedisi,
                ongkirAsli:  hasil.ongkirAsli,
                ongkirPromo: hasil.ongkirPromo,
                feeCOD:      hasil.feeCOD,
                harga:       hasil.harga,
              };
              await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru })
                .catch(e => console.error('[WILAYAH_OK] Gagal save customer.alamat:', e.message));
              customer.alamat = alamatBaru;
            }

            // ── Cek wilayah risk dari kodepos_stats ──────────────
            const kodepos = hasil.area?.kodePos;
            let wilayahRisk = customer?.wilayah_risk || null;

            // Cek cache di customers.wilayah_risk dulu
            if (!wilayahRisk && kodepos) {
              wilayahRisk = await cekWilayahRisk(kodepos);
              if (wilayahRisk && customer?.id) {
                await sbPatch('customers', `?id=eq.${customer.id}`, { wilayah_risk: wilayahRisk })
                  .catch(e => console.error('[wilayahRisk] Gagal save:', e.message));
                customer.wilayah_risk = wilayahRisk;
              }
            }

            // ── Build injeksi berdasarkan risk level ─────────────
            const ongkirInfo = buildOngkirInjeksi(hasil, product, '');
            let injeksi;

            if (wilayahRisk?.level === 'rawan') {
              // Area rawan: warning dulu, ongkir disimpan tapi tidak ditampilkan
              injeksi = `[SISTEM - PERINGATAN WILAYAH RAWAN COD]
Area customer (kodepos ${kodepos}) memiliki tingkat RTS ${wilayahRisk.pct}% — ${wilayahRisk.retur} dari ${wilayahRisk.total} orderan pernah retur.

JANGAN tampilkan total ongkir dulu. Sampaikan dengan santai dan empati bahwa area ini sering gagal COD, lalu sarankan Transfer. Contoh gaya: "Kak sebelumnya aku mau kasih info dulu nih, area [kecamatan] dari pengalaman kami agak susah COD, beberapa kali pengiriman balik lagi 😅 Lebih aman Transfer kak biar pesanannya pasti sampai 🙏 Kakak bisa Transfer?"

Kalau customer tetap minta COD → tanya: "Biasanya kakak pakai ekspedisi apa yang lancar COD ke sana? Nanti aku coba sesuaikan 😊"
Kalau customer kasih rekomendasi ekspedisi → boleh lanjut COD, tampilkan total.
Kalau customer setuju Transfer atau tidak punya rekomendasi → push Transfer, tampilkan total Transfer saja.

Data ongkir (simpan untuk ditampilkan setelah customer pilih metode bayar):
${ongkirInfo}`;

            } else if (wilayahRisk?.level === 'perhatian') {
              // Area perlu diperhatikan: mention ringan di akhir
              injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. Lanjutkan balasan di atas dan `)
                + `\n\nCatatan tambahan (sebut ringan setelah tampilkan harga): area kakak memiliki tingkat retur ${wilayahRisk.pct}%, sarankan Transfer tapi tidak perlu dipaksakan.`;

            } else if (!wilayahRisk && kodepos) {
              // Tidak ada data wilayah → tanya preferensi ekspedisi customer
              injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. Lanjutkan balasan di atas dan `)
                + `\n\nData pengalaman pengiriman ke area ini belum tersedia. Setelah tampilkan harga, tanya: "Oh iya kak, biasanya pengiriman ke sana pakai ekspedisi apa yang nyaman? 😊"`;

            } else {
              // Area aman: normal flow
              injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. Lanjutkan balasan di atas dan `);
            }

            const histWithOngkir = [
              ...history,
              { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
              { role: 'user', content: injeksi },
            ];
            rawReply = await callClaude(systemPrompt, histWithOngkir, chatModel, aiKey, aiBase);
          } else {
            console.warn(`[WILAYAH_OK] hitungOngkir gagal untuk "${wilayah}" (kelurahan spesifik)`);
            await updateConvState(conversation.id, { proposed_wilayah: wilayah });
            // Inject ke Claude supaya kasih tau customer, bukan diam
            const injeksiFail = `[SISTEM] Ongkir ke "${wilayah}" tidak bisa dihitung. Minta alamat lebih spesifik (kelurahan/desa + kecamatan). Contoh: "Kak, bisa info nama desa/kelurahan dan kecamatannya? Biar aku cek ongkirnya ke sana 😊" — JANGAN bilang error/sistem/maintenance, JANGAN bilang kurir belum cover, JANGAN estimasi ongkir sendiri.`;
            const histFail = [
              ...history,
              { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
              { role: 'user', content: injeksiFail },
            ];
            rawReply = await callClaude(systemPrompt, histFail, chatModel, aiKey, aiBase);
          }

        } else {
          // Kelurahan belum spesifik (hanya kecamatan) → tanya kelurahan dulu
          const kelurahanList = await getKelurahanByKecamatan(first.kecamatan, first.kabupaten);
          console.log(`[WILAYAH_OK] Kec. "${first.kecamatan}" punya ${kelurahanList.length} kelurahan → tanya dulu`);
          await updateConvState(conversation.id, {
            pending_kecamatan: { kecamatan: first.kecamatan, kabupaten: first.kabupaten, provinsi: first.provinsi },
          });

          // Step 1: Simpan kecamatan yang sudah diketahui ke customers.alamat & conv state
          if (customer?.id) {
            const alamatKec = {
              ...(customer.alamat || {}),
              kecamatan: first.kecamatan,
              kabupaten: first.kabupaten,
              provinsi:  first.provinsi,
            };
            await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatKec })
              .catch(e => console.error('[WILAYAH_OK pendingKel] Gagal save kecamatan:', e.message));
            customer.alamat = alamatKec;
          }
          if (!convState.alamat) {
            const alamatStr = [first.kecamatan, first.kabupaten, first.provinsi].filter(Boolean).join(', ');
            await updateConvState(conversation.id, { alamat: alamatStr });
            convState.alamat = alamatStr;
          }
          const contohKel = kelurahanList.slice(0, 3).join(', ');
          const injeksi = `[SISTEM] Kecamatan "${first.kecamatan}", ${first.kabupaten} ditemukan, tapi perlu kelurahan spesifik.\n`
            + `Semua kelurahan valid: ${kelurahanList.join(', ')}\n`
            + `Tanyakan kelurahannya dengan NATURAL — sebut 2-3 contoh kelurahan (misal: ${contohKel}) supaya customer lebih mudah jawab. Gaya WhatsApp santai, 1-2 kalimat.\n`
            + `Setelah customer sebut kelurahan yang valid, konfirmasi dan tulis [WILAYAH_OK:nama kelurahan, ${first.kecamatan}, ${first.kabupaten}, ${first.provinsi}].`;

          const histTanya = [
            ...history,
            { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
            { role: 'user', content: injeksi },
          ];
          rawReply = await callClaude(systemPrompt, histTanya, chatModel, aiKey, aiBase);
        }

      } else {
        // Tidak ditemukan di local DB — fallback ke Mengantar langsung
        // (seharusnya jarang terjadi karena cariWilayah sudah search dengan limit tinggi)
        console.log(`[WILAYAH_OK] "${wilayah}" tidak ditemukan di local DB — fallback Mengantar`);
        await updateConvState(conversation.id, { wilayah, proposed_wilayah: null, pending_kecamatan: null });
        convState.pending_kecamatan = null;
        const hasil = await hitungOngkir(wilayah, product, parseInt(convState.qty) || 1, userMngAreaId);
        if (hasil) {
          await updateConvState(conversation.id, { ongkir: hasil });
          convState.ongkir = hasil;

          // Simpan ke customers.alamat juga (hanya overwrite field non-null dari API)
          if (customer?.id) {
            const alamatBaru = {
              ...(customer.alamat || {}),
              ...(hasil.area?.kelurahan ? { kelurahan: hasil.area.kelurahan } : {}),
              ...(hasil.area?.kecamatan ? { kecamatan: hasil.area.kecamatan } : {}),
              ...(hasil.area?.kota      ? { kabupaten: hasil.area.kota }      : {}),
              ...(hasil.area?.provinsi  ? { provinsi:  hasil.area.provinsi }  : {}),
              ...(hasil.area?.kodePos   ? { kodepos:   hasil.area.kodePos }   : {}),
              ekspedisi:   hasil.ekspedisi,
              ongkirAsli:  hasil.ongkirAsli,
              ongkirPromo: hasil.ongkirPromo,
              feeCOD:      hasil.feeCOD,
              harga:       hasil.harga,
            };
            await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru })
              .catch(e => console.error('[WILAYAH_OK fallback] Gagal save customer.alamat:', e.message));
            customer.alamat = alamatBaru;
          }

          const injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. Lanjutkan balasan di atas dan `);
          const histWithOngkir = [
            ...history,
            { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
            { role: 'user', content: injeksi },
          ];
          rawReply = await callClaude(systemPrompt, histWithOngkir, chatModel, aiKey, aiBase);
        } else {
          console.warn(`[WILAYAH_OK fallback] hitungOngkir gagal untuk wilayah: ${wilayah}`);
          await updateConvState(conversation.id, { proposed_wilayah: wilayah });
          const injeksiFail = `[SISTEM] Ongkir ke "${wilayah}" tidak bisa dihitung. Minta alamat lebih spesifik (kelurahan/desa + kecamatan). Contoh: "Kak, bisa info nama desa/kelurahan dan kecamatannya? Biar aku cek ongkirnya ke sana 😊" — JANGAN bilang error/sistem/maintenance, JANGAN bilang kurir belum cover, JANGAN estimasi ongkir sendiri.`;
          const histFail = [
            ...history,
            { role: 'assistant', content: rawReply.replace(/\[WILAYAH_OK:[^\]]+\]/, '').trim() },
            { role: 'user', content: injeksiFail },
          ];
          rawReply = await callClaude(systemPrompt, histFail, chatModel, aiKey, aiBase);
        }
      }
      } // end else (wilayah.length >= 5)
    }

    // ── Handle cek ongkir (dari marker Claude — fallback) ─────
    if (cekOngkirMatch && !autoOngkirResult && !wilayahOkMatch) {
      const wilayah = cekOngkirMatch[1].trim();
      await updateConvState(conversation.id, { wilayah });
      const hasil = await hitungOngkir(wilayah, product, parseInt(convState.qty) || 1, userMngAreaId);
      if (hasil) {
        await updateConvState(conversation.id, { ongkir: hasil });
        convState.ongkir = hasil; // update local state

        // Simpan ke customers.alamat (hanya overwrite field non-null dari API)
        if (customer?.id) {
          const alamatBaru = {
            ...(customer.alamat || {}),
            ...(hasil.area?.kelurahan ? { kelurahan: hasil.area.kelurahan } : {}),
            ...(hasil.area?.kecamatan ? { kecamatan: hasil.area.kecamatan } : {}),
            ...(hasil.area?.kota      ? { kabupaten: hasil.area.kota }      : {}),
            ...(hasil.area?.provinsi  ? { provinsi:  hasil.area.provinsi }  : {}),
            ...(hasil.area?.kodePos   ? { kodepos:   hasil.area.kodePos }   : {}),
            ekspedisi:   hasil.ekspedisi,
            ongkirAsli:  hasil.ongkirAsli,
            ongkirPromo: hasil.ongkirPromo,
            feeCOD:      hasil.feeCOD,
            harga:       hasil.harga,
          };
          await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru })
            .catch(e => console.error('[CEK_ONGKIR] Gagal save customer.alamat:', e.message));
          customer.alamat = alamatBaru;
        }

        const injeksi = buildOngkirInjeksi(hasil, product, `Ongkir ke ${wilayah}. `);

        const historyWithOngkir = [
          ...history,
          { role: 'assistant', content: rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '').trim() },
          { role: 'user', content: injeksi },
        ];
        rawReply = await callClaude(systemPrompt, historyWithOngkir, chatModel, aiKey, aiBase);
      } else {
        rawReply = rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '').trim() ||
          'Maaf kak, aku belum bisa cek ongkir ke wilayah itu. Bisa sebutkan nama kota/kabupatennya lengkap? 🙏';
      }
    }

    // Auto-detection dihapus — andalkan [WILAYAH_OK:] marker dari AI saja

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
      // Simpan jalan ke customers.alamat (merge, tidak overwrite wilayah/ongkir)
      if (customer?.id) {
        const alamatBaru = {
          ...(customer.alamat || {}),
          jalan: alamatMatch[1].trim(),
        };
        await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatBaru })
          .catch(e => console.error('[ALAMAT_OK] Gagal save customer.alamat:', e.message));
        customer.alamat = alamatBaru;
      }
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
        const provGantiKurir = convState.ongkir?.area?.provinsi || '';
        let ongkirPromo = match.ongkir;
        if (promo?.tipe === 'gratis_penuh')        ongkirPromo = 0;
        else if (promo?.tipe === 'potong')         ongkirPromo = Math.max(0, match.ongkir - getPromoPotongan(promo, null, match.ongkir));
        else if (promo?.tipe === 'potong_wilayah') ongkirPromo = Math.max(0, match.ongkir - getPromoPotongan(promo, provGantiKurir, match.ongkir));
        else if (promo?.tipe === 'gratis_sd')      ongkirPromo = Math.max(0, match.ongkir - (promo.nilai || 0));

        const harga = product?.harga || 0;
        const totalTransferBulat = bulatkan(harga + ongkirPromo);
        const feeCODRaw = Math.ceil((harga + ongkirPromo) * 0.03);
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

        // Update ekspedisi + ongkir di customers.alamat
        if (customer?.id) {
          const alamatUpdate = {
            ...(customer.alamat || {}),
            ekspedisi:   match.nama,
            ongkirAsli:  match.ongkir,
            ongkirPromo: ongkirPromo,
            feeCOD:      feeCODBulat,
            harga:       harga,
          };
          await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: alamatUpdate })
            .catch(e => console.error('[GANTI_KURIR] Gagal save customer.alamat:', e.message));
          customer.alamat = alamatUpdate;
        }
      } else {
        console.warn(`[GANTI_KURIR] kurir "${requestedKurir}" tidak ditemukan di allRates`);
      }
    }

    // ── Bersihkan marker dari reply final (pakai /g agar semua instance terhapus) ──
    let reply = rawReply
      .replace(/\[ORDER_CONFIRMED\]/g, '')
      .replace(/\[ORDER_DATA:[^\]]+\]/g, '')
      .replace(/\[KELUHAN:[^\]]+\]/g, '')
      .replace(/\[ALAMAT_OK:[^\]]+\]/g, '')
      .replace(/\[CEK_ONGKIR:[^\]]+\]/g, '')
      .replace(/\[WILAYAH_OK:[^\]]+\]/g, '')
      .replace(/\[GANTI_KURIR:[^\]]+\]/g, '')
      .replace(/\[SISTEM[^\]]*\]/g, '')
      .trim();

    // (auto-eskalasi dihapus — CS manusia ambil alih manual dari dashboard)
    if (false) {
    }

    // ── Update state jika order confirmed → kirim recap grup + konfirmasi customer ──
    // (dijalankan SEBELUM cek reply kosong agar tidak terlewat meski Claude hanya tulis marker)
    if (orderConfirmed && convState.pending_kecamatan?.kecamatan) {
      // Guard: kelurahan belum resolved — block ORDER_CONFIRMED, paksa tanya kelurahan dulu
      const pendingKecGuard = convState.pending_kecamatan;
      const kelAll = await getKelurahanByKecamatan(pendingKecGuard.kecamatan, pendingKecGuard.kabupaten).catch(() => []);
      const contoh = kelAll.slice(0, 3).join(', ');
      const injeksi = `[SISTEM] ⚠️ ORDER BELUM BISA DIPROSES — kelurahan/desa belum dikonfirmasi.\n`
        + `Kecamatan yang diketahui: ${pendingKecGuard.kecamatan}, ${pendingKecGuard.kabupaten}.\n`
        + `Kelurahan valid di sana: ${kelAll.join(', ') || 'tidak ditemukan'}.\n`
        + `Tanyakan kelurahan customer dulu dengan ramah (contoh: ${contoh}). `
        + `Setelah customer sebut kelurahan, tulis [WILAYAH_OK:kelurahan, ${pendingKecGuard.kecamatan}, ${pendingKecGuard.kabupaten}, ${pendingKecGuard.provinsi}].`;
      const histGuard = [...history, { role: 'user', content: injeksi }];
      const replyGuard = await callClaude(systemPrompt, histGuard, chatModel, aiKey, aiBase);
      if (replyGuard) {
        const replyClean = replyGuard.replace(/\[ORDER_CONFIRMED\]/g, '').replace(/\[ORDER_DATA:[^\]]+\]/g, '').trim();
        const { wamid: wamid_rc } = await sendWA(waSession, reply_jid, replyClean).catch(()=>({}));
        await saveMessage(conversation.id, 'ai', replyClean, wamid_rc);
      }
      return res.status(200).json({ ok: true, action: 'blocked_pending_kecamatan' });
    }

    if (orderConfirmed && convState.order_placed && !convState.awaiting_order_confirm) {
      // Order sudah selesai diproses sebelumnya — skip ORDER_CONFIRMED agar tidak kirim konfirmasi ulang
      console.log(`[ORDER_CONFIRMED] Diabaikan — order sudah placed (conv ${conversation.id})`);
      return res.status(200).json({ ok: true, action: 'order_already_placed' });
    }

    // Guard: kalau sudah dalam flow bukti TF (nunggu bukti atau nunggu QC ACC), jangan proses ORDER_CONFIRMED
    if (orderConfirmed && (convState.awaiting_bukti_tf || convState.awaiting_qc_tf)) {
      console.log(`[ORDER_CONFIRMED] Diabaikan — sedang awaiting_bukti_tf=${!!convState.awaiting_bukti_tf} / awaiting_qc_tf=${!!convState.awaiting_qc_tf} (conv ${conversation.id})`);
      // Strip marker, kirim reply bersih
      reply = (reply || rawReply || '').replace(/\[ORDER_CONFIRMED\]/g, '').replace(/\[ORDER_DATA:[^\]]+\]/g, '').trim();
      if (reply) {
        const { wamid: wamid_skip } = await sendWA(waSession, reply_jid, reply).catch(() => ({}));
        await saveMessage(conversation.id, 'ai', reply, wamid_skip);
      }
      return res.status(200).json({ ok: true, action: 'blocked_awaiting_tf' });
    }

    // Hard block: conversation sudah pernah closing (closed_order_id ada) → jangan proses ORDER_CONFIRMED lagi
    if (orderConfirmed && convState.closed_order_id) {
      console.log(`[ORDER_CONFIRMED] Diabaikan — conversation sudah closing (order ${convState.closed_order_id}), conv ${conversation.id}`);
      // Strip marker, kirim reply bersih ke customer
      reply = (reply || rawReply || '').replace(/\[ORDER_CONFIRMED\]/g, '').replace(/\[ORDER_DATA:[^\]]+\]/g, '').trim();
      if (reply) {
        const { wamid: wamid_skip } = await sendWA(waSession, reply_jid, reply).catch(() => ({}));
        await saveMessage(conversation.id, 'ai', reply, wamid_skip);
      }
      return res.status(200).json({ ok: true, action: 'order_closed_permanent' });
    }

    if (orderConfirmed && !convState.order_placed) {
      // Ambil state terbaru
      const convFull    = await sbGet('conversations', `?id=eq.${conversation.id}&limit=1`);
      const latestState = convFull[0]?.state || {};
      let   ongkirData  = latestState.ongkir || convState.ongkir;
      const custAlamat  = customer?.alamat || {};

      // ── Konflik check: alamat ORDER_DATA vs wilayah tersimpan (repeat customer ganti alamat) ──
      // Contoh: customer pernah order dari Kalimantan Barat, sekarang order dari Jakarta
      // → auto-load pakai alamat lama, tapi alamat baru (Jakarta) ada di ORDER_DATA
      let conflictAlamat = false;
      if ((ongkirData?.area?.kota || custAlamat?.kabupaten) && orderDataParsed?.alamat) {
        const alamatLower = orderDataParsed.alamat.toLowerCase();
        const storedProv  = (ongkirData?.area?.provinsi || custAlamat?.provinsi || '')
          .toLowerCase().replace(/^(provinsi|daerah istimewa|dki)\s*/i, '').trim();
        const storedKab   = (ongkirData?.area?.kota || custAlamat?.kabupaten || '')
          .toLowerCase().replace(/^(kabupaten|kota)\s*/i, '').trim();
        // Cek 5-6 karakter pertama (cukup unique untuk nama kota/provinsi Indonesia)
        const provKey = storedProv.substring(0, 6);
        const kabKey  = storedKab.substring(0, 6);
        if (provKey && kabKey && !alamatLower.includes(provKey) && !alamatLower.includes(kabKey)) {
          conflictAlamat = true;
          console.log(`[ORDER_CONFIRMED] ⚠️ Konflik area: stored="${storedKab}, ${storedProv}" tidak ada di alamat ORDER_DATA "${orderDataParsed.alamat.substring(0, 60)}" → force re-detect`);
          ongkirData = null; // clear agar re-compute triggered
        }
      }

      // Fallback: kalau ongkirData kosong tapi wilayah ada di state → hitung ulang on-the-fly
      // PENTING: area lokal (wilayah_id) di-resolve TERPISAH dari hitungOngkir (Mengantar)
      // Jadi walau Mengantar down, breakdown kelurahan/kecamatan/kab/prov tetap terisi
      let localAreaFallback = null;
      // kalau conflictAlamat, paksa re-detect meski custAlamat masih punya kecamatan (alamat lama)
      if (!ongkirData?.area?.kecamatan && (!custAlamat?.kecamatan || conflictAlamat)) {
        // kalau conflict: set null dulu agar step-2 bisa detect dari orderDataParsed.alamat
        let wilayahFallback = conflictAlamat ? null : (latestState.wilayah || convState.wilayah);

        // 1. Resolve area lokal dari wilayah yang ada di state
        if (wilayahFallback) {
          const cek = await cariWilayah(wilayahFallback, 5).catch(() => []);
          if (cek.length > 0) localAreaFallback = cek[0];
        }

        // 2. Kalau belum ketemu, parse dari alamat ORDER_DATA (selalu dicoba, tidak di-gate state)
        if (!localAreaFallback && orderDataParsed.alamat) {
          const alamatParts = orderDataParsed.alamat.split(',').map(s => s.trim()).filter(Boolean);
          // 2a. Coba split koma dulu (alamat format: "Jl X, Kec Y, Kab Z")
          if (alamatParts.length >= 2) {
            for (let i = Math.max(0, alamatParts.length - 4); i < alamatParts.length; i++) {
              const combined = alamatParts.slice(i).join(', ');
              const cek = await cariWilayah(combined, 5).catch(() => []);
              if (cek.length > 0) {
                localAreaFallback = cek[0];
                if (!wilayahFallback) wilayahFallback = `${cek[0].kelurahan}, ${cek[0].kecamatan}, ${cek[0].kabupaten}`;
                console.log(`[ORDER_CONFIRMED] Area lokal dari alamat (split): "${combined}" → ${cek[0].kelurahan}, ${cek[0].kecamatan}`);
                break;
              }
            }
          }
          // 2b. Fallback AI: alamat tanpa koma / split gagal → pakai Haiku extract wilayah
          if (!localAreaFallback) {
            console.log(`[ORDER_CONFIRMED] Split koma gagal (${alamatParts.length} part), coba AI extract...`);
            const aiExtract = await extractLokasiHaiku(orderDataParsed.alamat, aiKey, aiBase).catch(() => null);
            if (aiExtract) {
              const searchKey = [aiExtract.kelurahan, aiExtract.kecamatan, aiExtract.kabupaten].filter(Boolean).join(', ');
              console.log(`[ORDER_CONFIRMED] AI extract: ${searchKey}`);
              const cek = await cariWilayah(searchKey, 5).catch(() => []);
              if (cek.length > 0) {
                localAreaFallback = cek[0];
                if (!wilayahFallback) wilayahFallback = searchKey;
                console.log(`[ORDER_CONFIRMED] Area lokal dari AI: ${cek[0].kelurahan}, ${cek[0].kecamatan}, ${cek[0].kabupaten}`);
              }
            }
          }
        }

        if (localAreaFallback) {
          console.log(`[ORDER_CONFIRMED] Area lokal terpakai: ${localAreaFallback.kelurahan}, ${localAreaFallback.kecamatan}, ${localAreaFallback.kabupaten}`);
        }

        // 3. Hitung ongkir (Mengantar) — kalau gagal, area lokal di atas tetap dipakai
        if (wilayahFallback && product) {
          console.log(`[ORDER_CONFIRMED] ongkir kosong, re-hitung dari wilayah: ${wilayahFallback}`);
          const qtyFallback = parseInt(latestState.qty || orderDataParsed?.qty || convState.qty || 1) || 1;
          const rekalkulasi = await hitungOngkir(wilayahFallback, product, qtyFallback, userMngAreaId).catch(() => null);
          if (rekalkulasi) {
            ongkirData = rekalkulasi;
            await updateConvState(conversation.id, { ongkir: rekalkulasi }).catch(() => {});
            if (customer?.id && rekalkulasi.area?.kecamatan) {
              const al = {
                ...(customer.alamat || {}),
                kelurahan:   rekalkulasi.area.kelurahan,
                kecamatan:   rekalkulasi.area.kecamatan,
                kabupaten:   rekalkulasi.area.kota,
                provinsi:    rekalkulasi.area.provinsi,
                kodepos:     rekalkulasi.area.kodePos,
                ekspedisi:   rekalkulasi.ekspedisi,
                ongkirAsli:  rekalkulasi.ongkirAsli,
                ongkirPromo: rekalkulasi.ongkirPromo,
                feeCOD:      rekalkulasi.feeCOD,
                harga:       rekalkulasi.harga,
              };
              await sbPatch('customers', `?id=eq.${customer.id}`, { alamat: al })
                .catch(e => console.error('[ORDER_CONFIRMED] Gagal save customer.alamat fallback:', e.message));
              customer.alamat = al;
            }
          } else {
            console.warn(`[ORDER_CONFIRMED] ⚠️ hitungOngkir gagal untuk "${wilayahFallback}" — area lokal dipakai, ongkir tetap 0`);
          }
        }
      }

      // Fallback area: ongkir state → customers.alamat (skip kalau conflict) → area lokal (wilayah_id) → parse wilayah string
      let area = ongkirData?.area?.kecamatan ? ongkirData.area
               : (!conflictAlamat && custAlamat?.kecamatan) ? {
                   kelurahan: custAlamat.kelurahan || '',
                   kecamatan: custAlamat.kecamatan || '',
                   kota:      custAlamat.kabupaten || '',
                   provinsi:  custAlamat.provinsi  || '',
                   kodePos:   custAlamat.kodepos   || '',
                 }
               : localAreaFallback ? {
                   kelurahan: localAreaFallback.kelurahan || '',
                   kecamatan: localAreaFallback.kecamatan || '',
                   kota:      localAreaFallback.kabupaten || '',
                   provinsi:  localAreaFallback.provinsi  || '',
                   kodePos:   '',
                 }
               : {};

      // Fallback terakhir: parse dari state.wilayah string (format: "kelurahan, kecamatan, kabupaten, provinsi")
      if (!area.kecamatan && (latestState.wilayah || convState.wilayah)) {
        const wStr = latestState.wilayah || convState.wilayah;
        const wParts = wStr.split(',').map(s => s.trim()).filter(Boolean);
        if (wParts.length >= 3) {
          // Cari match di DB lokal untuk data yang akurat
          const wMatch = await cariWilayah(wStr, 1).catch(() => []);
          if (wMatch.length) {
            area = { kelurahan: wMatch[0].kelurahan || '', kecamatan: wMatch[0].kecamatan || '', kota: wMatch[0].kabupaten || '', provinsi: wMatch[0].provinsi || '', kodePos: '' };
            console.log(`[ORDER_CONFIRMED] Area dari state.wilayah DB: ${wMatch[0].kecamatan}, ${wMatch[0].kabupaten}`);
          } else {
            // Fallback: parse langsung dari string
            area = { kelurahan: wParts[0] || '', kecamatan: wParts[1] || '', kota: wParts[2] || '', provinsi: wParts[3] || '', kodePos: '' };
            console.log(`[ORDER_CONFIRMED] Area dari state.wilayah string: ${wParts[1]}, ${wParts[2]}`);
          }
        }
      }

      const metode      = orderDataParsed.metode  || latestState.metode_bayar || 'COD';
      const qty         = orderDataParsed.qty     || latestState.qty          || 1;
      const alamat      = orderDataParsed.alamat  || latestState.alamat       || '-';
      const isCOD       = metode.toLowerCase() !== 'transfer';

      // Fallback ongkir detail dari customers.alamat kalau state kosong
      const ekspedisi   = ongkirData?.ekspedisi   || custAlamat?.ekspedisi   || 'KURIR';
      const ekspLabel   = ekspedisi.toUpperCase();
      // Resolve harga bundling sesuai qty yang confirmed (lebih akurat dari ongkirData.harga yg dihitung saat WILAYAH_OK)
      const harga       = resolveHargaBundling(product, qty) || ongkirData?.harga || custAlamat?.harga || product?.harga || 0;

      // ── Recalculate ongkir jika qty berubah (diskon ongkir per qty bisa beda) ──
      // Ongkir di state dihitung saat wilayah dikonfirmasi — qty saat itu mungkin berbeda
      const ongkirQtyLama = ongkirData?.harga || 0;
      if (ongkirData && product && harga !== ongkirQtyLama && (convState.wilayah_data || convState.wilayah || latestState.wilayah)) {
        try {
          const wilayahInput = latestState.wilayah_data || convState.wilayah_data || latestState.wilayah || convState.wilayah;
          const freshOngkir = await hitungOngkir(wilayahInput, product, qty, userMngAreaId);
          if (freshOngkir) {
            ongkirData = freshOngkir;
            console.log(`[ORDER_CONFIRMED] Ongkir re-calc qty=${qty}: asli ${freshOngkir.ongkirAsli} promo ${freshOngkir.ongkirPromo}`);
          }
        } catch(e) { console.error('[ORDER_CONFIRMED] Ongkir re-calc error:', e.message); }
      }

      const ongkirAsli  = ongkirData?.ongkirAsli  || custAlamat?.ongkirAsli  || 0;
      const ongkirPromo = ongkirData?.ongkirPromo || custAlamat?.ongkirPromo || 0;
      // Recalculate feeCOD pakai harga bundling yang benar — Transfer selalu 0
      const feeCODCalc  = isCOD ? Math.ceil((harga + ongkirPromo) * 0.03) : 0;
      const feeCOD      = isCOD ? (feeCODCalc || ongkirData?.feeCOD || custAlamat?.feeCOD || 0) : 0;

      // Simpan area & ekspedisi yang sudah confirmed ke ongkir state agar tersimpan permanen di Supabase
      const confirmedOngkir = { ...ongkirData, area, ekspedisi, harga, ongkirAsli, ongkirPromo, feeCOD };
      const totalOrder      = isCOD ? harga + ongkirPromo + feeCOD : harga + ongkirPromo;
      const orderSnapshot   = { alamat, area, qty, metode, ekspedisi, harga, ongkirAsli, ongkirPromo, feeCOD, total: totalOrder, keluhan: orderDataParsed.keluhan || latestState.keluhan || '' };
      await updateConvState(conversation.id, {
        awaiting_order_confirm: true,
        order_confirmed_at: new Date().toISOString(),
        confirm_fu_stage: 0,
        ongkir: confirmedOngkir,
        order_snapshot: orderSnapshot,
      });

      // ── Kirim konfirmasi ke customer (belum tutup — tunggu customer konfirmasi) ──
      try {
        const confirmMsg = buildCustomerConfirmMsg({
          customer, alamat, area, qty,
          productNama: product?.nama,
          satuan: product?.satuan,
          isCOD, ekspLabel,
          harga, ongkirAsli, ongkirPromo, feeCOD,
          rekening: !isCOD ? userRekening : null,
        });
        const { wamid: wamid_cm } = await sendWA(waSession, reply_jid, confirmMsg).catch(()=>({}));
        await saveMessage(conversation.id, 'ai', confirmMsg, wamid_cm);
        console.log(`Konfirmasi pesanan terkirim ke customer ${wa_number} — menunggu konfirmasi`);
      } catch(e) {
        console.error('Send konfirmasi ke customer error:', e.message);
      }

      // Jangan lanjut kirim reply Claude — pesan konfirmasi sudah cukup
      return res.status(200).json({ ok: true, action: 'order_confirm_sent' });
    }

    if (!reply) return res.status(200).json({ ok: true, skipped: 'empty_reply' });

    console.log(`Reply untuk ${wa_number}${orderConfirmed?' [ORDER]':''}: ${reply.slice(0, 80)}`);

    // ── Simpan & kirim balasan ─────────────────────────────────
    // ── Simpan & kirim — wamid dari Baileys untuk fitur edit/hapus ──
    // (sendWA dipanggil di bawah, setelah flag waiting_for_location)

    // ── Set flag waiting_for_location kalau AI baru nanya alamat/wilayah ──
    if (!convState.ongkir && !convState.waiting_for_location) {
      const aiNanyaLokasi = /\b(kota|kecamatan|kelurahan|alamat|wilayah|daerah|kirim ke|lokasi|tinggal di|domisili)\b/i.test(reply) && /\?/.test(reply);
      if (aiNanyaLokasi) {
        await updateConvState(conversation.id, { waiting_for_location: true });
        console.log(`[location] Flag waiting_for_location di-set`);
      }
    }

    // ── Auto-kirim gambar produk kalau customer tanya foto ────
    const tanyaFoto = /\b(foto\w*|gambar\w*|pic|photo\w*|tampilan\w*|bentuk\w*|wujud\w*|lihat produk|kirim dong|kirimnya|mana foto|mana gambar|belum terkirim|belum muncul|kirim ulang|kirim lagi)/i.test(message);
    const adaGambarProduk = product?.gambar_url;
    const sudahKirimFoto  = convState.foto_terkirim;

    if (tanyaFoto) console.log(`[FOTO] adaGambar=${!!adaGambarProduk} url=${adaGambarProduk||'null'}`);

    // Kirim teks reply dulu — capture wamid untuk fitur edit/hapus
    const { wamid: wamid_reply } = await sendWA(waSession, reply_jid, reply).catch(()=>({}));
    await saveMessage(conversation.id, 'ai', reply, wamid_reply);

    // Kalau customer tanya foto dan ada gambar produk → selalu kirim (tidak peduli sudah pernah)
    if (tanyaFoto && adaGambarProduk) {
      await new Promise(r => setTimeout(r, 800));
      try {
        const manfaat = (() => {
          // Prioritas 1: keluhan_cocok array
          if (Array.isArray(product.keluhan_cocok) && product.keluhan_cocok.length)
            return product.keluhan_cocok.slice(0, 3).join(' • ');
          // Prioritas 2: cari baris manfaat/kegunaan di product_knowledge
          if (product.product_knowledge) {
            const lines = product.product_knowledge.split('\n').map(l => l.trim()).filter(Boolean);
            // Cari section manfaat/kegunaan/khasiat
            let inManfaat = false;
            const bullets = [];
            for (const line of lines) {
              if (/manfaat|kegunaan|khasiat|fungsi|benefit/i.test(line)) { inManfaat = true; continue; }
              if (inManfaat && /^[-•✅*\d]/.test(line)) {
                bullets.push(line.replace(/^[-•✅*\d.)\s]+/, '').slice(0, 50));
                if (bullets.length >= 3) break;
              }
              if (inManfaat && line.length < 3) break; // baris kosong = section selesai
            }
            if (bullets.length) return bullets.join(' • ');
            // Fallback: ambil semua baris yang ada bullet
            const allBullets = lines
              .filter(l => /^[-•✅*]/.test(l))
              .map(l => l.replace(/^[-•✅*\s]+/, '').slice(0, 50))
              .slice(0, 3);
            if (allBullets.length) return allBullets.join(' • ');
          }
          return '';
        })();
        const caption = manfaat ? `${product.nama} bermanfaat untuk mengatasi:\n\n✅ ${manfaat}` : product.nama;
        console.log(`[FOTO] caption="${caption}"`);
        await sendWA(waSession, reply_jid, null, false, product.gambar_url, caption);
        await updateConvState(conversation.id, { foto_terkirim: true });
        console.log(`[FOTO] Gambar terkirim: ${product.gambar_url}`);
      } catch(e) {
        console.error(`[FOTO] Gagal kirim gambar:`, e.message);
      }
    }

    // ── Detect cancel ────
    const isCancelMsg = /\b(cancel|batal|tidak jadi|tdk jadi|ga jadi|gak jadi|gk jadi|ngga jadi|gk mau|ga mau|gak mau|tidak mau)\b/i.test(message);
    if (isCancelMsg && !convState.is_cancelled) {
      const prevCancelCount = (convState.cancel_count || 0) + 1;
      const isPostClosing = !!(convState.closed_order_id || convState.order_placed);

      if (isPostClosing) {
        // ── Cancel post-closing: langsung cancel order + notif grup ──
        await updateConvState(conversation.id, { is_cancelled: true, cancel_count: prevCancelCount, cancelled_at: new Date().toISOString() });
        console.log(`[CANCEL-POST] Conv ${conversation.id} cancelled post-closing`);

        // Update order di orders_new → cancelled
        if (convState.closed_order_id) {
          await sbPatch('orders_new', `?id=eq.${convState.closed_order_id}`, { status: 'cancelled' })
            .catch(e => console.error('[CANCEL-POST] Gagal update order:', e.message));
          console.log(`[CANCEL-POST] Order ${convState.closed_order_id} → cancelled`);
        }

        // Notif ke grup Operasional, fallback ke grup recap
        try {
          const opsGroupJid = OPS_GROUP_JID_USER;
          const custPhone = (customer?.wa_number || '').replace(/^62/, '0');
          const cancelNotif = `❌ *Pembatalan Order*\n\n👤 ${customer?.nama || '-'}\n📱 ${custPhone || '-'}\n🛒 ${product?.nama || '-'}\n💬 Alasan: "${message.slice(0, 100)}"\n\nOrder dibatalkan oleh customer setelah closing.`;
          if (opsGroupJid) {
            await sendWA(waSession, opsGroupJid, cancelNotif, true).catch(() => {});
            console.log(`[CANCEL-POST] Notif terkirim ke grup ${opsGroupJid}`);
          }
        } catch (e) {
          console.error('[CANCEL-POST] Notif error:', e.message);
        }
      } else if (prevCancelCount >= 2) {
        // Pre-closing: 2x batal baru label
        await updateConvState(conversation.id, { is_cancelled: true, cancel_count: prevCancelCount });
        console.log(`[CANCEL] Conv ${conversation.id} ditandai cancelled (customer bilang ${prevCancelCount}x)`);
      } else {
        // Pre-closing: pertama kali bilang cancel → bot masih coba retain
        await updateConvState(conversation.id, { cancel_count: prevCancelCount });
        console.log(`[CANCEL] Conv ${conversation.id} cancel_count=${prevCancelCount} (bot akan coba retain)`);
      }
    }

    // ── Auto-kirim foto testimoni ────
    // Trigger: customer minta ATAU bot reply menyebut testimoni/bukti
    const tanyaTestimoni = /\b(testimoni\w*|testi\w*|bukti\w*|review\w*|hasil\w*|nyata|beneran|real|ada yang sudah|yang udah pakai|yang sudah pakai|ada hasilnya|ada fotonya|foto hasilnya|foto buktinya|sebelum sesudah|before after|ada reviewnya|ada buktiny)/i.test(message);
    const botSebutTesti = /\b(testimoni\w*|testi\w*|bukti.*pakai|kirimkan.*testi|kirim.*testi|ini testimoni)/i.test(reply);
    const testiList = Array.isArray(product?.testimoni_urls) ? product.testimoni_urls.filter(Boolean) : [];
    const sudahKirimTesti = convState.testimoni_terkirim;

    if ((tanyaTestimoni || botSebutTesti) && testiList.length > 0 && !sudahKirimTesti) {
      await new Promise(r => setTimeout(r, 800));
      try {
        for (let i = 0; i < testiList.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 500));
          const caption = i === 0 ? `Ini testimoni dari customer kami kak 😊` : null;
          await sendWA(waSession, reply_jid, null, false, testiList[i], caption);
        }
        await updateConvState(conversation.id, { testimoni_terkirim: true });
        console.log(`[TESTI] ${testiList.length} foto testimoni terkirim`);
      } catch(e) {
        console.error(`[TESTI] Gagal kirim testimoni:`, e.message);
      }
    }

    // ── Forward feedback bermasalah ke grup OPS ──
    if (convState.delivery_issue && !convState.delivery_issue_forwarded) {
      try {
        const opsGroupJid = OPS_GROUP_JID_USER;
        if (opsGroupJid) {
          const issueResi = convState.delivery_issue_resi || '';
          const issueEkspedisi = (() => {
            // Cari ekspedisi dari order
            const snap = convState.order_snapshot || {};
            return snap.ekspedisi || '';
          })();
          const custPhone = (customer?.wa_number || '').replace(/^62/, '0');
          const custNama = customer?.nama || 'Customer';

          // Ambil semua chat (konfirmasi + bermasalah), limit 15, potong jadi max 10 biar gambar ga kebesaran
          const recentMsgs = await sbGet('conv_messages',
            `?conversation_id=eq.${conversation.id}&order=created_at.desc&limit=15&select=role,isi,created_at`
          ).catch(() => []);
          const chatMsgs = recentMsgs.reverse().slice(-10); // urut lama → baru, max 10

          // A: Generate screenshot chat
          try {
            const { generateChatImage } = require('./_chat-image');
            const pngBuffer = await generateChatImage(chatMsgs, custNama, custPhone, issueResi, issueEkspedisi);
            const base64Img = `data:image/png;base64,${pngBuffer.toString('base64')}`;
            const caption = `📦 *${issueResi}*\n👤 ${custNama} (${custPhone})\n💬 "${(message || '').slice(0, 100)}"`;
            await sendWA(waSession, opsGroupJid, null, true, base64Img, caption).catch(() => {});
            console.log(`[BERMASALAH-FWD] Screenshot + caption terkirim ke grup OPS`);
          } catch (imgErr) {
            console.error(`[BERMASALAH-FWD] Image error, fallback ke teks:`, imgErr.message);
            // B: Fallback teks kalau gambar gagal
            const txtNotif = `📦 *${issueResi}*\n👤 ${custNama} (${custPhone})\n🚚 ${issueEkspedisi}\n\n💬 Customer bilang:\n"${(message || '').slice(0, 200)}"\n\n📋 Bot reply:\n"${(reply || '').slice(0, 200)}"`;
            await sendWA(waSession, opsGroupJid, txtNotif, true).catch(() => {});
          }

          // Mark as forwarded biar ga kirim ulang tiap customer chat
          await updateConvState(conversation.id, { delivery_issue_forwarded: true });
        }
      } catch (e) {
        console.error('[BERMASALAH-FWD] Error:', e.message);
      }
    }

    // ── Update ringkasan berjalan (setiap 5 pesan) ──
    try {
      const allMsgs = await sbGet('conv_messages', `?conversation_id=eq.${conversation.id}&select=id`);
      if (allMsgs.length % 4 === 0) await updateRingkasan(conversation.id, aiKey, aiBase);
    } catch(e) {
      console.error('Ringkasan error:', e.message);
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err.message, err.stack);
    if (!res.headersSent) res.status(200).json({ ok: true, error: err.message });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};
