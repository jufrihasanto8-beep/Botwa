/**
 * Test endpoint — cek ongkir langsung dari server
 * GET /api/test-ongkir?wilayah=bantul&origin_id=xxx&weight=1
 */
const MNG_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
  'Referer': 'https://www.mengantar.com/',
};

async function mngFetch(path, timeoutMs = 20000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://app.mengantar.com/api/${path}`, {
      headers: MNG_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return { error: `HTTP ${res.status}`, body: await res.text().catch(() => '') };
    return await res.json();
  } catch(e) {
    clearTimeout(tid);
    return { error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { wilayah, origin_id, weight = 1 } = req.query || {};
  if (!wilayah || !origin_id) {
    return res.status(400).json({ error: 'wilayah dan origin_id wajib' });
  }

  const steps = [];

  // Step 1: Autofill — coba per bagian
  const parts = wilayah.split(',').map(s => s.trim()).filter(Boolean);
  steps.push({ step: 'keywords', parts });

  const searchResults = await Promise.all(parts.map(async q => {
    const t = Date.now();
    const json = await mngFetch(`address/autofill?keyword=${encodeURIComponent(q)}`);
    const arr = Array.isArray(json) ? json : (json?.data || []);
    return { q, ms: Date.now() - t, count: arr.length, areas: arr, error: json?.error };
  }));

  steps.push({ step: 'autofill', results: searchResults.map(r => ({ q: r.q, ms: r.ms, count: r.count, error: r.error, first: r.areas[0] || null })) });

  const bestResult = searchResults.find(r => r.count > 0);
  if (!bestResult) {
    return res.status(200).json({ ok: false, steps, error: 'Semua keyword tidak ditemukan' });
  }

  const area = bestResult.areas[0];
  const areaId = area._id || area.id;
  steps.push({ step: 'best_area', areaId, area });

  // Step 2: allEstimatePublic
  const t2 = Date.now();
  const rates = await mngFetch(`order/allEstimatePublic?origin_id=${origin_id}&destination_id=${areaId}&weight=${weight}`);
  const ms2 = Date.now() - t2;
  steps.push({ step: 'allEstimatePublic', ms: ms2, success: rates?.success, error: rates?.error });

  if (!rates?.success) {
    return res.status(200).json({ ok: false, steps, error: 'allEstimatePublic gagal', raw: rates });
  }

  const kurir = Object.entries(rates.data || {})
    .filter(([, info]) => !info.unsupported && (info.price || 0) > 0)
    .map(([name, info]) => ({ name, price: info.price, est: info.estimatedDate || '' }))
    .sort((a, b) => a.price - b.price);

  return res.status(200).json({ ok: true, steps, kurir, total: kurir.length });
};
