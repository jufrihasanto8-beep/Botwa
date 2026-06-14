/**
 * Customer Risk Detection
 * Cek RTS history + wilayah rawan retur dari Validasiorder DB
 */

const VALIDASI_URL = process.env.VALIDASI_SUPABASE_URL;
const VALIDASI_KEY = process.env.VALIDASI_SUPABASE_KEY;

function sbH() {
  return {
    'Content-Type': 'application/json',
    'apikey': VALIDASI_KEY,
    'Authorization': `Bearer ${VALIDASI_KEY}`,
  };
}

async function sbGet(path) {
  const res = await fetch(`${VALIDASI_URL}/rest/v1/${path}`, { headers: sbH() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function normalizeHP(hp) {
  let n = String(hp || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { wa_number, wilayah } = req.query;
  if (!wa_number) return res.status(400).json({ error: 'wa_number wajib' });

  const hp = normalizeHP(wa_number);
  const result = { hp, rts: null, wilayah: null };

  // ── 1. Cek RTS history by HP ──────────────────────────────
  try {
    const orders = await sbGet(
      `all_orderan?hp=eq.${hp}&select=status_akhir&limit=500`
    );
    const total = orders.length;
    const retur = orders.filter(r =>
      (r.status_akhir || '').toLowerCase().includes('retur')
    ).length;

    result.rts = {
      total,
      retur,
      pernah: retur > 0,
      label: retur === 0 ? 'Tidak pernah RTS'
           : retur === 1 ? '1x RTS'
           : `${retur}x RTS`,
      level: retur === 0 ? 'aman'
           : retur <= 2  ? 'hati'
           : 'tinggi',
    };
  } catch(e) {
    console.error('RTS check error:', e.message);
  }

  // ── 2. Cek wilayah rawan retur ────────────────────────────
  if (wilayah) {
    try {
      const parts  = wilayah.split(',').map(s => s.trim());
      const kecamatan = parts[0]; // misal: "Medan Perjuangan"
      const kota      = parts[1] || parts[0]; // misal: "Kota Medan"

      // Coba kecamatan dulu
      let orders = await sbGet(
        `all_orderan?kecamatan=ilike.*${encodeURIComponent(kecamatan)}*&select=status_akhir&limit=1000`
      );
      let namaLabel = kecamatan;

      // Kalau kurang dari 3 data → fallback ke kabupaten/kota
      if (orders.length < 3 && kota !== kecamatan) {
        orders = await sbGet(
          `all_orderan?kabupaten=ilike.*${encodeURIComponent(kota)}*&select=status_akhir&limit=1000`
        );
        namaLabel = kota;
      }

      const wTotal = orders.length;
      const wRetur = orders.filter(r =>
        (r.status_akhir || '').toLowerCase().includes('retur')
      ).length;

      if (wTotal >= 3) {
        const pct = Math.round((wRetur / wTotal) * 100);
        result.wilayah = {
          nama: namaLabel,
          total: wTotal,
          retur: wRetur,
          pct,
          label: pct === 0  ? 'Aman'
               : pct < 15   ? `Sedang (${pct}%)`
               : `Tinggi (${pct}%)`,
          level: pct === 0  ? 'aman'
               : pct < 15   ? 'sedang'
               : 'tinggi',
        };
      } else {
        result.wilayah = { nama: namaLabel, label: 'Data kurang', level: 'unknown', total: wTotal };
      }
    } catch(e) {
      console.error('Wilayah check error:', e.message);
    }
  }

  return res.status(200).json(result);
};
