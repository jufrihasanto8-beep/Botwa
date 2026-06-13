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
  const namaToko   = 'Adsy Store';
  const namaProduk = product?.nama || 'produk kami';
  const harga      = product?.harga ? `Rp ${product.harga.toLocaleString('id-ID')}` : '(akan dikonfirmasi)';

  const sapaanCTWA = `Halo kak, dari iklan ${namaProduk} ya? 😊`;
  const sapaanForm = customer?.nama
    ? `Halo kak ${customer.nama}, makasih udah isi form buat ${namaProduk} 😊`
    : `Halo kak, makasih udah isi form buat ${namaProduk} 😊`;

  const sapaan = sumber === 'ctwa' ? sapaanCTWA : (sumber === 'form' ? sapaanForm : '');

  const pertanyaan = Array.isArray(product?.pertanyaan_diagnosa)
    ? product.pertanyaan_diagnosa.join(' | ')
    : (product?.pertanyaan_diagnosa || 'Sudah berapa lama? Sudah pernah coba obat apa?');

  const keluhan = Array.isArray(product?.keluhan_cocok)
    ? product.keluhan_cocok.join(', ')
    : (product?.keluhan_cocok || '');

  const promoOngkir = product?.promo_ongkir
    ? formatPromoOngkir(product.promo_ongkir)
    : 'belum ada promo ongkir';

  return `IDENTITAS
Kamu "${csNama}", CS toko ${namaToko} di WhatsApp.
Kamu BUKAN sales. Kamu konsultan yang kebetulan punya solusi.
${sapaan ? `Sapaan pembuka: "${sapaan}" lalu gali keluhan.` : 'Sapaan: sambut hangat sesuai konteks.'}
Jangan tanya ulang dari nol kalau konteks/data sudah tersedia.

PRINSIP UTAMA
- Produk dibeli karena KELUHAN, bukan impulsif.
- DENGAR keluhan dulu → pahami → baru bantu.
- Closing = AKIBAT konsultasi baik, BUKAN tujuan yang dikejar.
- JANGAN tawarkan beli sebelum paham masalah customer.
- Kalau customer buru-buru & langsung mau beli → layani.

DATA PRODUK (jangan ngarang di luar ini)
Produk    : ${namaProduk}
Harga     : ${harga}
Cocok untuk: ${keluhan}
Cara pakai: ${product?.cara_pakai || '(lihat kemasan)'}
Knowledge : ${product?.product_knowledge || ''}
Promo ongkir: ${promoOngkir}

ALUR KONSULTASI
1. SAMBUT hangat (sambung ke iklan/form), jangan langsung jualan
2. GALI keluhan — tanya SATU per SATU: ${pertanyaan}
3. DENGARKAN & tunjukkan ngerti ("oh berarti...")
4. EDUKASI ringan — kenapa keluhannya begitu
5. REKOMENDASI ${namaProduk} dengan alasan SPESIFIK ke keluhan
6. Baru kalau customer mantap → bantu order (minta WILAYAH dulu untuk cek ongkir)

ATURAN HARGA & ONGKIR
- Harga/klaim HANYA dari DATA PRODUK. JANGAN ngarang.
- Sebelum kasih TOTAL → WAJIB konfirmasi WILAYAH dulu.
- Setelah dapat wilayah → tulis [CEK_ONGKIR:wilayah] di akhir balasanmu (sistem akan replace).
- Wilayah parsial → tebak & konfirmasi: "Pringsewu, Lampung ya kak?"
- Fee COD 5% ke customer.
- Tanya: "Kakak enaknya COD atau transfer? 🙏"

ALUR CATAT ORDER
- Setelah pilih bayar, minta data yang BELUM ADA saja:
  nama → no HP → alamat lengkap (jalan, RT/RW, kelurahan, kecamatan, patokan)
- Tutup dengan KONFIRMASI ORDER (rincian+total), minta "oke".
- Setelah customer konfirmasi → tulis [ORDER_CONFIRMED] di akhir balasan.

GAYA NGOBROL
- Panggil "Kak"; kalimat PENDEK (1–2 kalimat/balasan)
- Hangat, sabar, peduli; emoji secukupnya 😊🙏, jangan lebay
- JANGAN paragraf panjang/kaku/formal/robot
- Tanya SATU hal per balasan
- DILARANG markdown: jangan **bold**, jangan ---, jangan > quote

ESKALASI KE MANUSIA
Mulai dengan [ESCALATE] lalu tulis pesan hangat, kalau:
- Customer kesel/emosi negatif
- Komplain berat / refund / sengketa
- Pertanyaan di luar knowledge yang tidak yakin
Contoh: "[ESCALATE] Saya paham kak, biar tim kami yang bantu langsung ya..."

REM ETIS
- JANGAN klaim medis berlebihan ("pasti sembuh").
- Keluhan serius → sarankan periksa dokter juga.

TUJUAN AKHIR
Customer merasa DIDENGAR & terbantu. Kalau cocok → order tercatat.`;
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
  const msgs = await sbGet('conv_messages',
    `?conversation_id=eq.${conversationId}&order=created_at.asc&limit=30`
  );
  return msgs.map(m => ({
    role: m.role === 'customer' ? 'user' : 'assistant',
    content: m.isi,
  }));
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

/* ── CEK ONGKIR via Mengantar API ─────────────────────────── */
async function cekOngkir(wilayah, productId) {
  if (!MENGANTAR_KEY) return null;
  try {
    // Mengantar: cari kota
    const searchRes = await fetch(`https://api.mengantar.com/v1/areas?search=${encodeURIComponent(wilayah)}`, {
      headers: { 'Authorization': `Bearer ${MENGANTAR_KEY}` },
    });
    const areas = await searchRes.json();
    if (!areas?.data?.length) return null;

    const areaId = areas.data[0].id;

    // Ambil data produk untuk harga
    const products = productId
      ? await sbGet('products', `?id=eq.${productId}&limit=1`)
      : [];
    const weight = 500; // gram default, bisa per produk
    const price  = products[0]?.harga || 0;

    const ongkirRes = await fetch(`https://api.mengantar.com/v1/rates?destination_id=${areaId}&weight=${weight}`, {
      headers: { 'Authorization': `Bearer ${MENGANTAR_KEY}` },
    });
    const rates = await ongkirRes.json();
    return rates?.data || null;
  } catch (e) {
    console.error('Cek ongkir error:', e.message);
    return null;
  }
}

/* ── KIRIM WA via Baileys server ──────────────────────────── */
async function sendWA(waNumber, message, isOutbound = false) {
  if (!BAILEYS_URL) throw new Error('BAILEYS_URL belum diset');
  const res = await fetch(`${BAILEYS_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
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

  // Selalu jawab 200 cepat ke Baileys server
  res.status(200).json({ ok: true });

  try {
    const body = req.body || {};

    // Verifikasi secret
    console.log(`Secret check: body="${body.secret}" env="${WEBHOOK_SECRET}"`);
    if (body.secret !== WEBHOOK_SECRET) {
      console.warn('Secret tidak valid — tidak cocok');
      return;
    }

    const wa_number   = normalizeWA(body.wa_number || '');
    const pushName    = body.push_name || wa_number;
    const message     = String(body.message || '').trim();
    const messageType = body.message_type || 'text';
    const mediaUrl    = body.media_url || null;
    const referral    = body.referral || null; // dari CTWA

    console.log(`wa_number="${wa_number}" message="${message}" type="${messageType}"`);
    if (!wa_number || (!message && messageType === 'text')) { console.warn('wa_number atau message kosong'); return; }

    console.log(`Pesan dari ${pushName} (${wa_number}): ${message.slice(0, 80)}`);

    // ── Ambil userId dari session_id (= user UUID dari dashboard) ──
    const userId = body.session_id;
    if (!userId) { console.warn('session_id kosong'); return; }

    // ── Routing: cari produk dari referral/isi chat ────────────
    const { product, sumber } = await resolveProduct(userId, referral, message);
    console.log(`Produk: ${product?.nama || 'tidak diketahui'} (${sumber})`);

    // ── Find/create customer & conversation ───────────────────
    const customer     = await findOrCreateCustomer(userId, wa_number, pushName);
    const conversation = await findOrCreateConversation(userId, customer.id, sumber, product?.id);

    // Update produk ke conversation jika baru ketemu
    if (product?.id && !conversation.product_id) {
      await sbPatch('conversations', `?id=eq.${conversation.id}`, { product_id: product.id });
    }

    // ── Simpan pesan masuk ─────────────────────────────────────
    await saveMessage(conversation.id, 'customer', message || `[${messageType}]`);

    // ── Build system prompt ────────────────────────────────────
    const systemPrompt = buildTemplatePrompt(product, customer, conversation, sumber);

    // ── Ambil history & panggil Claude ────────────────────────
    const history = await getContextMessages(conversation.id);
    let rawReply  = await callClaude(systemPrompt, history);
    if (!rawReply) return;

    // ── Deteksi marker khusus ──────────────────────────────────
    const isEscalated      = rawReply.includes('[ESCALATE]');
    const orderConfirmed   = rawReply.includes('[ORDER_CONFIRMED]');
    const cekOngkirMatch   = rawReply.match(/\[CEK_ONGKIR:([^\]]+)\]/);

    // ── Handle cek ongkir ──────────────────────────────────────
    if (cekOngkirMatch) {
      const wilayah = cekOngkirMatch[1].trim();
      await updateConvState(conversation.id, { wilayah });
      const rates = await cekOngkir(wilayah, product?.id);
      if (rates) {
        // Inject info ongkir ke prompt & panggil Claude lagi
        const ongkirInfo = rates.slice(0, 3).map(r =>
          `${r.courier_name}: Rp ${r.price?.toLocaleString('id-ID')}`
        ).join(', ');
        const historyWithOngkir = [
          ...history,
          { role: 'assistant', content: rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '') },
          { role: 'user', content: `[SISTEM] Hasil cek ongkir ke ${wilayah}: ${ongkirInfo}. Tampilkan format harga yang benar ke customer.` },
        ];
        rawReply = await callClaude(systemPrompt, historyWithOngkir);
      } else {
        rawReply = rawReply.replace(/\[CEK_ONGKIR:[^\]]+\]/, '');
      }
    }

    // ── Bersihkan marker dari reply final ─────────────────────
    let reply = rawReply
      .replace('[ESCALATE]', '')
      .replace('[ORDER_CONFIRMED]', '')
      .replace(/\[CEK_ONGKIR:[^\]]+\]/, '')
      .trim();

    if (!reply) return;

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
    await sendWA(wa_number, reply);

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
};
