/**
 * Vercel Serverless — Save settings (service key, bypass RLS)
 * Handles: users.rekening PATCH + courier_whitelist CRUD
 */
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbH = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Prefer': 'return=representation',
};

async function sbReq(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: sbH,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return method === 'DELETE' ? null : res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: baca courier_whitelist pakai service key (bypass RLS) ──
  if (req.method === 'GET') {
    const { userId, user_id, action, key } = req.query || {};

    // Autofill area: wilayah_id (kabupaten/provinsi) + Mengantar (kodepos)
    if (action === 'area-autofill') {
      const kel = (req.query.kel || '').trim();
      const kec = (req.query.kec || '').trim();
      if (!kel && !kec) return res.status(400).json({ error: 'kel atau kec wajib' });
      try {
        // Cari dengan kombinasi kelurahan + kecamatan (paling akurat)
        let sbData = [];
        if (kel && kec) {
          sbData = await sbReq('GET',
            `wilayah_id?kelurahan=ilike.*${encodeURIComponent(kel)}*&kecamatan=ilike.*${encodeURIComponent(kec)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
          );
        }
        // Fallback: hanya kecamatan kalau kombinasi tidak ketemu
        if (!sbData.length && kec) {
          sbData = await sbReq('GET',
            `wilayah_id?kecamatan=ilike.*${encodeURIComponent(kec)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
          );
        }
        // Fallback: hanya kelurahan
        if (!sbData.length && kel) {
          sbData = await sbReq('GET',
            `wilayah_id?kelurahan=ilike.*${encodeURIComponent(kel)}*&select=kelurahan,kecamatan,kabupaten,provinsi&limit=5`
          );
        }

        // Ambil kodepos dari Mengantar pakai query kombinasi (sebagai fallback jika wilayah_id tidak punya)
        const mngQ = [kel, kec].filter(Boolean).join(', ');
        const mngRes = await fetch(`https://app.mengantar.com/api/address/autofill?keyword=${encodeURIComponent(mngQ)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.mengantar.com/' }
        }).then(r => r.json()).catch(() => null);

        const mngList = mngRes?.data || (Array.isArray(mngRes) ? mngRes : []);
        const mngItem = mngList[0] || {};
        // Coba semua kemungkinan field name kodepos dari Mengantar
        const kodeposMng = mngItem.ZIP_CODE || mngItem.posCode || '';

        const mengantar_dest_id = mngItem._id || null;
        const data = sbData.map(r => ({ ...r, kodepos: r.kodepos || kodeposMng, mengantar_dest_id }));
        return res.status(200).json({ ok: true, data });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Proxy: fetch Mengantar origin addresses (bypass CORS)
    if (action === 'mengantar-origins') {
      if (!key) return res.status(400).json({ error: 'key wajib' });
      try {
        const BASE = `https://app.mengantar.com/api/public/${key}`;
        const CANDIDATES = ['address', 'warehouse', 'pickup', 'origin', 'sender'];
        let found = null;
        for (const slug of CANDIDATES) {
          const mRes = await fetch(`${BASE}/${slug}`, { headers: { 'Accept': 'application/json' } });
          const mText = await mRes.text();
          if (mRes.ok) {
            let json; try { json = JSON.parse(mText); } catch { json = mText; }
            found = { slug, json };
            break;
          }
          // 404 → coba berikutnya; error lain → stop
          if (mRes.status !== 404) {
            return res.status(200).json({ ok: false, status: mRes.status, slug, raw: mText });
          }
        }
        if (!found) return res.status(200).json({ ok: false, error: 'Tidak ada endpoint yang cocok', tried: CANDIDATES });
        return res.status(200).json({ ok: true, slug: found.slug, data: found.json });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Cari origin_id dari alamat toko
    if (action === 'cari-origin') {
      const { keyword } = req.query;
      if (!keyword) return res.status(400).json({ error: 'keyword wajib' });
      try {
        const r = await fetch(`https://app.mengantar.com/api/address/autofill?keyword=${encodeURIComponent(keyword)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.mengantar.com/' }
        });
        const json = await r.json();
        const arr = Array.isArray(json) ? json : (json?.data || []);
        return res.status(200).json({ ok: true, results: arr.slice(0, 10) });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // Test ongkir (tidak perlu userId)
    if (action === 'test-ongkir') {
      const { origin_id, wilayah, weight = 1 } = req.query;
      if (!origin_id || !wilayah) return res.status(400).json({ error: 'origin_id dan wilayah wajib' });
      const MNG_H = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.mengantar.com/' };
      const mngGet = async (path, ms = 20000) => {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), ms);
        try {
          const r = await fetch(`https://app.mengantar.com/api/${path}`, { headers: MNG_H, signal: ctrl.signal });
          clearTimeout(tid);
          if (!r.ok) return { error: `HTTP ${r.status}` };
          return r.json();
        } catch(e) { clearTimeout(tid); return { error: e.message }; }
      };

      // Cari semua keyword secara paralel, kumpulkan semua hasil
      const parts = wilayah.split(',').map(s => s.trim()).filter(Boolean);
      const searches = await Promise.all(parts.map(async q => {
        const t = Date.now();
        const json = await mngGet(`address/autofill?keyword=${encodeURIComponent(q)}`);
        const arr = Array.isArray(json) ? json : (json?.data || []);
        return { q, ms: Date.now()-t, count: arr.length, first: arr[0]||null, error: json?.error, areas: arr };
      }));

      // Gabungkan semua hasil unik dari semua keyword
      const seenIds = new Set();
      const allAreas = searches.flatMap(s => s.areas || []).filter(a => {
        const id = a._id || a.id;
        if (!id || seenIds.has(id)) return false;
        seenIds.add(id); return true;
      });
      if (!allAreas.length) return res.status(200).json({ ok: false, searches: searches.map(s => ({ q: s.q, ms: s.ms, count: s.count, first: s.first, error: s.error })), error: 'Semua keyword tidak ditemukan' });

      // Scoring — cocokkan semua field area vs bagian wilayah
      const partsLower = parts.map(s => s.toLowerCase().replace(/^(kabupaten|kota|kab\.?)\s*/i, ''));
      const [wKel='', wKec='', wKab='', wProv=''] = partsLower;
      const score = a => {
        const sub  = (a.SUBDISTRICT_NAME || '').toLowerCase();
        const dist = (a.DISTRICT_NAME    || '').toLowerCase();
        const city = (a.CITY_NAME        || '').toLowerCase().replace(/^(kabupaten|kota|kab\.?)\s*/i, '');
        const prov = (a.PROVINCE_NAME    || '').toLowerCase();
        let s = 0;
        if (wKel && sub.includes(wKel))  s += 4;
        if (wKec && dist.includes(wKec)) s += 3;
        if (wKab && city.includes(wKab)) s += 2;
        if (wProv && prov.includes(wProv)) s += 1;
        return s;
      };
      allAreas.sort((a, b) => score(b) - score(a));
      const bestArea = allAreas[0];
      const areaId = bestArea._id || bestArea.id;

      const t2 = Date.now();
      const rates = await mngGet(`order/allEstimatePublic?origin_id=${origin_id}&destination_id=${areaId}&weight=${weight}`, 30000);
      const ms2 = Date.now()-t2;
      if (!rates?.success) return res.status(200).json({ ok: false, searches: searches.map(s => ({ q: s.q, ms: s.ms, count: s.count, first: s.first, error: s.error })), areaId, bestAreaLabel: [bestArea.SUBDISTRICT_NAME, bestArea.DISTRICT_NAME, bestArea.CITY_NAME, bestArea.PROVINCE_NAME].filter(Boolean).join(', '), allEstimateMs: ms2, error: 'allEstimatePublic gagal', raw: rates });
      const kurir = Object.entries(rates.data||{})
        .filter(([,i]) => !i.unsupported && (i.price||0) > 0)
        .map(([name,i]) => ({ name, price: i.price, est: i.estimatedDate||'' }))
        .sort((a,b) => a.price - b.price);
      return res.status(200).json({ ok: true, searches: searches.map(s => ({ q: s.q, ms: s.ms, count: s.count, first: s.first, error: s.error })), areaId, bestAreaLabel: [bestArea.SUBDISTRICT_NAME, bestArea.DISTRICT_NAME, bestArea.CITY_NAME, bestArea.PROVINCE_NAME].filter(Boolean).join(', '), allEstimateMs: ms2, kurir });
    }

    const uid = userId || user_id;
    if (!uid) return res.status(400).json({ error: 'userId wajib' });
    try {
      const data = await sbReq('GET', `courier_whitelist?user_id=eq.${uid}&order=nama.asc`);
      return res.status(200).json({ ok: true, data });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};

  // ── Legacy: update kolom users (rekening / anthropic_key / default_sumber) ──
  if (body.user_id && ('rekening' in body || 'anthropic_key' in body || 'group_jid' in body || 'mengantar_key' in body || 'mengantar_origin_id' in body || 'mengantar_area_id' in body || 'default_sumber' in body)) {
    try {
      const patch = {};
      if ('rekening' in body)            patch.rekening            = body.rekening;
      if ('anthropic_key' in body)       patch.anthropic_key       = body.anthropic_key;
      if ('group_jid' in body)           patch.group_jid           = body.group_jid;
      if ('mengantar_key' in body)       patch.mengantar_key       = body.mengantar_key;
      if ('mengantar_origin_id' in body) patch.mengantar_origin_id = body.mengantar_origin_id;
      if ('mengantar_area_id' in body)   patch.mengantar_area_id   = body.mengantar_area_id;
      if ('default_sumber' in body) {
        const ALLOWED_SUMBER = ['ctwa', 'form', 'inbound'];
        if (!ALLOWED_SUMBER.includes(body.default_sumber)) return res.status(400).json({ error: 'default_sumber tidak valid' });
        patch.default_sumber = body.default_sumber;
      }
      await sbReq('PATCH', `users?id=eq.${body.user_id}`, patch);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Template notif ──
  // ── Simpan model AI config per tipe percakapan ──
  if (body.userId && body.table === 'ai_model_config' && body.payload) {
    const { ctwa, form, inbound } = body.payload;
    const allowed = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    const config = {};
    if (ctwa    && allowed.includes(ctwa))    config.ctwa    = ctwa;
    if (form    && allowed.includes(form))    config.form    = form;
    if (inbound && allowed.includes(inbound)) config.inbound = inbound;
    try {
      await sbReq('PATCH', `users?id=eq.${body.userId}`, { ai_model_config: config });
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (body.userId && body.table === 'users_template' && body.payload) {
    const allowed = ['template_resi_dikirim', 'template_tiba_kota', 'template_out_for_delivery', 'template_delivered', 'template_bermasalah', 'template_retur', 'template_form_lead'];
    const patch = {};
    for (const key of allowed) {
      if (key in body.payload) patch[key] = body.payload[key];
    }
    try {
      await sbReq('PATCH', `users?id=eq.${body.userId}`, patch);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Hitung ongkir Mengantar untuk closing manual ──
  if (body.action === 'hitung-ongkir') {
    const { userId, dest_id, product_id, qty = 1 } = body;
    if (!userId || !dest_id || !product_id) return res.status(400).json({ error: 'userId, dest_id, product_id wajib' });
    try {
      // Ambil origin_id dari user + data produk sekaligus
      const [userRows, prodRows] = await Promise.all([
        sbReq('GET', `users?id=eq.${userId}&select=mengantar_area_id,mengantar_key`),
        sbReq('GET', `products?id=eq.${product_id}&select=harga,harga_bundling,berat_gram,promo_ongkir`),
      ]);
      const user = userRows[0] || {};
      const prod = prodRows[0] || {};
      const originId = user.mengantar_area_id || process.env.MENGANTAR_ORIGIN_ID;
      if (!originId) return res.status(400).json({ error: 'origin_id belum diset' });

      const beratKg = ((prod.berat_gram || 1000) / 1000) * qty;
      const MNG_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.mengantar.com/' };

      const ratesRes = await fetch(
        `https://app.mengantar.com/api/order/allEstimatePublic?origin_id=${originId}&destination_id=${dest_id}&weight=${beratKg}`,
        { headers: MNG_HEADERS }
      ).then(r => r.json()).catch(() => null);

      if (!ratesRes?.success || !ratesRes.data) return res.status(200).json({ ok: false, error: 'Ongkir tidak tersedia untuk area ini' });

      // Pilih kurir terbaik dari whitelist user
      const whitelist = await sbReq('GET', `courier_whitelist?user_id=eq.${userId}&aktif=eq.true`).catch(() => []);
      const namaSet = new Set(whitelist.map(w => (w.nama || '').toLowerCase()));
      const rawData = ratesRes.data || {};
      let rates = Object.entries(rawData)
        .filter(([name, info]) => !name.toLowerCase().includes('cargo') && !info.unsupported && (info.price || 0) > 0)
        .map(([name, info]) => ({ name, price: info.price || 0 }))
        .sort((a, b) => a.price - b.price);

      // Prioritaskan kurir yang ada di whitelist
      const whitelisted = rates.filter(r => namaSet.size === 0 || namaSet.has(r.name.toLowerCase()));
      const best = (whitelisted.length ? whitelisted : rates)[0];
      if (!best) return res.status(200).json({ ok: false, error: 'Tidak ada kurir tersedia' });

      // Hitung promo ongkir
      let promo = prod.promo_ongkir || {};
      if (typeof promo === 'string') try { promo = JSON.parse(promo); } catch { promo = {}; }
      let ongkirPromo = best.price;
      if (promo.tipe === 'gratis_penuh') ongkirPromo = 0;
      else if (promo.tipe === 'potong' || promo.tipe === 'gratis_sd') ongkirPromo = Math.max(0, best.price - (promo.nilai || 0));

      // Resolve harga bundling
      let bundling = prod.harga_bundling || [];
      if (typeof bundling === 'string') try { bundling = JSON.parse(bundling); } catch { bundling = []; }
      let harga = (prod.harga || 0) * qty;
      const exact = bundling.find(b => b.qty == qty);
      if (exact) harga = exact.harga;
      else {
        const lower = bundling.filter(b => b.qty < qty).sort((a, b) => b.qty - a.qty)[0];
        if (lower) harga = lower.harga + (prod.harga || 0) * (qty - lower.qty);
      }

      const feeCOD = Math.ceil((harga + ongkirPromo) * 0.05);
      return res.status(200).json({
        ok: true,
        kurir: best.name,
        ongkir: best.price,
        ongkir_promo: ongkirPromo,
        fee_cod: feeCOD,
        total_transfer: harga + ongkirPromo,
        total_cod: harga + ongkirPromo + feeCOD,
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Generic CRUD: table + action ──
  const { userId, table, action, id, payload, convId, convPatch } = body;
  const ALLOWED = ['courier_whitelist', 'orders_new'];
  if (!userId || !table || !ALLOWED.includes(table)) {
    return res.status(400).json({ error: 'Parameter tidak valid' });
  }

  try {
    let data;
    if (action === 'insert') {
      data = await sbReq('POST', table, payload);
      // Kalau ada convPatch sekaligus (closing manual), patch conversations juga
      if (convId && convPatch) {
        await sbReq('PATCH', `conversations?id=eq.${convId}`, convPatch);
      }
    } else if (action === 'update') {
      if (!id) return res.status(400).json({ error: 'id wajib untuk update' });
      data = await sbReq('PATCH', `${table}?id=eq.${id}&user_id=eq.${userId}`, payload);
    } else if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id wajib untuk delete' });
      await sbReq('DELETE', `${table}?id=eq.${id}&user_id=eq.${userId}`);
      data = null;
    } else {
      return res.status(400).json({ error: 'action tidak valid' });
    }
    return res.status(200).json({ ok: true, data });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
