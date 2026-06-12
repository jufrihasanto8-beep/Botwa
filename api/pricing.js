/**
 * Pricing Engine — Blueprint §4
 * POST /api/pricing
 * Body: { product_id, wilayah, user_id }
 * Returns: { harga, ongkir, ongkir_after_promo, fee_cod, total_transfer, total_cod, ekspedisi, flag_risiko }
 */

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MENGANTAR_KEY        = process.env.MENGANTAR_KEY;

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

/* ── Terapkan promo ongkir ──────────────────────────────── */
function applyPromoOngkir(ongkirAsli, promo) {
  if (!promo || promo.tipe === 'none') return ongkirAsli;
  if (promo.tipe === 'gratis_penuh') return 0;
  if (promo.tipe === 'potong')    return Math.max(0, ongkirAsli - (promo.nilai || 0));
  if (promo.tipe === 'gratis_sd') return Math.max(0, ongkirAsli - (promo.nilai || 0));
  return ongkirAsli;
}

/* ── Bulatkan ke kelipatan 500 terdekat ─────────────────── */
function bulatkan(angka) {
  return Math.round(angka / 500) * 500;
}

/* ── Cek ongkir via Mengantar API ───────────────────────── */
async function getMengantar(wilayah, weight = 500) {
  if (!MENGANTAR_KEY) return null;
  try {
    const search = await fetch(
      `https://api.mengantar.com/v1/areas?search=${encodeURIComponent(wilayah)}&limit=5`,
      { headers: { 'Authorization': `Bearer ${MENGANTAR_KEY}` } }
    );
    const areas = await search.json();
    if (!areas?.data?.length) return null;

    const areaId = areas.data[0].id;
    const areaName = areas.data[0].name;

    const rates = await fetch(
      `https://api.mengantar.com/v1/rates?destination_id=${areaId}&weight=${weight}`,
      { headers: { 'Authorization': `Bearer ${MENGANTAR_KEY}` } }
    );
    const rateData = await rates.json();
    return { area: areaName, rates: rateData?.data || [] };
  } catch (e) {
    console.error('Mengantar error:', e.message);
    return null;
  }
}

/* ── Filter & pilih kurir terbaik ────────────────────────── */
async function piliKurir(userId, wilayah, rates) {
  if (!rates?.length) return null;

  // Ambil whitelist grade dari Supabase
  const wilayahLower = wilayah.toLowerCase();
  const grades = await sbGet('couriers_grade',
    `?user_id=eq.${userId}&boleh_dipakai=eq.true`
  );

  // Map: ekspedisi → grade
  const gradeMap = {};
  grades.forEach(g => {
    const key = g.ekspedisi.toLowerCase();
    // Cocokkan wilayah (simple: contains)
    if (wilayahLower.includes(g.daerah.toLowerCase()) ||
        g.daerah.toLowerCase().includes(wilayahLower)) {
      gradeMap[key] = g.grade;
    }
  });

  // Filter kurir: grade A/B saja, atau semua jika tidak ada grade data
  const hasGradeData = Object.keys(gradeMap).length > 0;
  let filtered = rates.filter(r => {
    if (!hasGradeData) return true;
    const g = gradeMap[r.courier_name?.toLowerCase()] || 'C';
    return ['A', 'B'].includes(g);
  });

  if (!filtered.length) filtered = rates; // fallback semua kurir

  // Urutkan: grade bagus dulu, lalu harga
  filtered.sort((a, b) => {
    const ga = gradeMap[a.courier_name?.toLowerCase()] || 'C';
    const gb = gradeMap[b.courier_name?.toLowerCase()] || 'C';
    if (ga !== gb) return ga.localeCompare(gb);
    return (a.price || 0) - (b.price || 0);
  });

  return filtered[0];
}

/* ── FLAG RISIKO ─────────────────────────────────────────── */
function cekRisiko(kurir, gradeMap, wilayah) {
  if (!kurir) return { flag: false, alasan: null };
  const grade = gradeMap[kurir.courier_name?.toLowerCase()] || 'C';
  if (['D', 'E'].includes(grade)) {
    return { flag: true, alasan: `Grade kurir ${kurir.courier_name} di ${wilayah}: ${grade}` };
  }
  return { flag: false, alasan: null };
}

/* ── MAIN HANDLER ─────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'pricing' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { product_id, wilayah, user_id } = req.body;
    if (!product_id || !wilayah || !user_id) {
      return res.status(400).json({ error: 'product_id, wilayah, user_id wajib diisi' });
    }

    // Ambil data produk
    const products = await sbGet('products', `?id=eq.${product_id}&aktif=eq.true&limit=1`);
    if (!products.length) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    const product = products[0];

    const harga  = product.harga;
    const weight = 500; // default, bisa per produk nanti

    // Cek ongkir via Mengantar
    const mengantar = await getMengantar(wilayah, weight);
    if (!mengantar) {
      return res.status(200).json({
        ok: true,
        harga,
        ongkir: null,
        wilayah,
        error_ongkir: 'Wilayah tidak ditemukan atau Mengantar API tidak tersedia',
        kurir_options: [],
      });
    }

    // Pilih kurir terbaik
    const grades = await sbGet('couriers_grade', `?user_id=eq.${user_id}&boleh_dipakai=eq.true`);
    const gradeMap = {};
    grades.forEach(g => { gradeMap[g.ekspedisi.toLowerCase()] = g.grade; });

    const kurirTerbaik = await piliKurir(user_id, wilayah, mengantar.rates);
    if (!kurirTerbaik) {
      return res.status(200).json({ ok: true, harga, wilayah, error_ongkir: 'Tidak ada kurir tersedia', kurir_options: [] });
    }

    const ongkirAsli   = kurirTerbaik.price || 0;
    const ongkirPromo  = applyPromoOngkir(ongkirAsli, product.promo_ongkir);

    // Hitung total
    const totalTransfer = bulatkan(harga + ongkirPromo);
    const feeCOD        = bulatkan((harga + ongkirPromo) * 0.05);
    const totalCOD      = bulatkan(harga + ongkirPromo + feeCOD);

    // Cek risiko
    const risiko = cekRisiko(kurirTerbaik, gradeMap, wilayah);

    // 3 opsi kurir teratas untuk ditampilkan
    const kurirOptions = mengantar.rates.slice(0, 5).map(r => ({
      nama: r.courier_name,
      layanan: r.service_name,
      harga: r.price,
      harga_promo: applyPromoOngkir(r.price, product.promo_ongkir),
      grade: gradeMap[r.courier_name?.toLowerCase()] || '-',
    }));

    return res.status(200).json({
      ok: true,
      produk: product.nama,
      harga,
      wilayah: mengantar.area,
      ekspedisi: kurirTerbaik.courier_name,
      layanan: kurirTerbaik.service_name,
      ongkir: ongkirAsli,
      ongkir_after_promo: ongkirPromo,
      fee_cod: feeCOD,
      total_transfer: totalTransfer,
      total_cod: totalCOD,
      promo_ongkir: product.promo_ongkir,
      flag_risiko: risiko.flag,
      alasan_flag: risiko.alasan,
      kurir_options: kurirOptions,
    });

  } catch (err) {
    console.error('Pricing error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
