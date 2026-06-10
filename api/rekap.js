// ══════════════════════════════════════════════
//  Rekap Harian Otomatis — Vercel Cron Job
//  Dipanggil setiap hari jam 21:00 WIB (14:00 UTC)
//  Kirim laporan harian ke nomor WA yang dikonfigurasi
// ══════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbH() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
}

async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbH() });
  if (!res.ok) throw new Error(`sbGet ${table}: ${await res.text()}`);
  return res.json();
}

async function sendWA(token, phone, message) {
  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: { 'Authorization': token },
    body: new URLSearchParams({ target: phone, message, countryCode: '62' }),
  });
  return res.json();
}

function formatRupiah(n) {
  return 'Rp ' + (n || 0).toLocaleString('id-ID');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  console.log('Rekap harian started:', new Date().toISOString());

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const dateStr = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  try {
    const configs = await sbGet('configs', `?limit=50`);

    for (const config of configs) {
      const userId = config.user_id;
      const rekapWa = config.rekap_wa;
      const fonnte = config.fonnte_token;
      const storeName = config.store_name || 'Toko';

      if (!fonnte || !rekapWa) continue;

      // Kumpulkan data hari ini
      const [todayMsgs, todayCases, todayOrders, contacts] = await Promise.all([
        sbGet('messages', `?user_id=eq.${userId}&created_at=gte.${todayISO}`),
        sbGet('cases', `?user_id=eq.${userId}&created_at=gte.${todayISO}`).catch(() => []),
        sbGet('orders', `?user_id=eq.${userId}&created_at=gte.${todayISO}`).catch(() => []),
        sbGet('contacts', `?user_id=eq.${userId}&created_at=gte.${todayISO}`).catch(() => []),
      ]);

      const totalPesan = todayMsgs.length;
      const pesanMasuk = todayMsgs.filter(m => m.role === 'user').length;
      const pesanAI = todayMsgs.filter(m => m.role === 'assistant').length;
      const aiRate = pesanMasuk > 0 ? Math.round((pesanAI / pesanMasuk) * 100) : 0;

      const kasesSelesai = todayCases.filter(c => c.status === 'selesai').length;
      const kasesEskalasi = todayCases.filter(c => c.status === 'eskalasi').length;

      const ordersPaid = todayOrders.filter(o => o.payment_status === 'paid');
      const totalRevenue = ordersPaid.reduce((sum, o) => sum + (o.total || 0), 0);
      const ordersTotal = todayOrders.length;

      const newContacts = contacts.length;

      // Format pesan rekap
      const rekap = `📊 *REKAP HARIAN ${storeName.toUpperCase()}*
${dateStr}
━━━━━━━━━━━━━━━━━━━━━

💬 *PERCAKAPAN*
• Pesan masuk: ${pesanMasuk}
• Dibalas AI: ${pesanAI} (${aiRate}%)
• Kontak baru: ${newContacts}

📋 *CASES*
• Total case hari ini: ${todayCases.length}
• Selesai: ${kasesSelesai} ✅
• Eskalasi: ${kasesEskalasi} ${kasesEskalasi > 0 ? '🚨' : ''}

🛒 *ORDERS*
• Total order: ${ordersTotal}
• Lunas: ${ordersPaid.length}
• Revenue: ${formatRupiah(totalRevenue)}

━━━━━━━━━━━━━━━━━━━━━
🤖 _Laporan otomatis dari Adsy CS_`;

      const sent = await sendWA(fonnte, rekapWa, rekap);
      console.log(`Rekap terkirim ke ${rekapWa}:`, sent.status);
    }

    return res.status(200).json({ ok: true, date: dateStr });

  } catch(err) {
    console.error('Rekap job error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
