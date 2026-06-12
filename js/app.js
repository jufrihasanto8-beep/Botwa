/* ── HerbalCare · Supabase + Shared Utilities ── */

/* ── SPA Router: swap .main-content tanpa reload sidebar ── */
const Router = {
  async go(href) {
    const mainEl = document.querySelector('.main-content');
    // Fallback ke full reload kalau tidak ada main-content (misal dashboard)
    if (!mainEl) { window.location.href = href; return; }

    // Fade out konten
    mainEl.style.transition = 'opacity .1s ease';
    mainEl.style.opacity = '0';

    try {
      const res  = await fetch(href);
      const text = await res.text();
      const doc  = new DOMParser().parseFromString(text, 'text/html');
      const newMain = doc.querySelector('.main-content');

      // Kalau halaman tujuan tidak pakai .main-content, full reload
      if (!newMain) { window.location.href = href; return; }

      // Ambil scripts sebelum dihapus dari DOM
      const scripts = [...newMain.querySelectorAll('script')].map(s => s.textContent);
      newMain.querySelectorAll('script').forEach(s => s.remove());

      // Inject style dari halaman baru (hapus style halaman sebelumnya dulu)
      document.querySelectorAll('style[data-page-style]').forEach(s => s.remove());
      doc.querySelectorAll('head style').forEach(s => {
        const el = document.createElement('style');
        el.setAttribute('data-page-style', '1');
        el.textContent = s.textContent;
        document.head.appendChild(el);
      });

      // Swap konten
      mainEl.innerHTML = newMain.innerHTML;
      requestAnimationFrame(() => { mainEl.style.opacity = '1'; });

      // Update title & URL
      const t = doc.querySelector('title');
      if (t) document.title = t.textContent;
      history.pushState({}, '', href);

      // Update active state sidebar
      document.querySelectorAll('.s-btn').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === href);
      });

      // Jalankan scripts halaman baru (skip baris sidebar/auth yang sudah ada)
      scripts.forEach(code => {
        const filtered = code.split('\n').filter(line =>
          !line.includes('Auth.guard()') &&
          !line.includes('Auth.requireLogin()') &&
          !line.includes('sidebar-container') &&
          !line.includes('renderSidebar(')
        ).join('\n');
        try {
          const el = document.createElement('script');
          el.textContent = filtered;
          document.body.appendChild(el);
          document.body.removeChild(el);
        } catch(e) { console.error('Script inject error:', e); }
      });

    } catch(e) {
      console.error('Router error:', e);
      window.location.href = href;
    }
  }
};

/* ── SUPABASE CONFIG ── Ganti dengan URL & Key project Anda */
const SUPABASE_URL = window.SUPABASE_URL || 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'YOUR_ANON_KEY';

/* Supabase REST helper */
const SB = {
  headers: () => ({
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
  }),
  url: (table, query = '') => `${SUPABASE_URL}/rest/v1/${table}${query}`,

  get: async (table, query = '') => {
    const res = await fetch(SB.url(table, query), { headers: SB.headers() });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  post: async (table, body) => {
    const res = await fetch(SB.url(table), {
      method: 'POST',
      headers: { ...SB.headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  patch: async (table, query, body) => {
    const res = await fetch(SB.url(table, query), {
      method: 'PATCH',
      headers: { ...SB.headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  delete: async (table, query) => {
    const res = await fetch(SB.url(table, query), { method: 'DELETE', headers: SB.headers() });
    if (!res.ok) throw new Error(await res.text());
    return true;
  },

  upsert: async (table, body, onConflict = '') => {
    const q = onConflict ? `?on_conflict=${onConflict}` : '';
    const res = await fetch(SB.url(table, q), {
      method: 'POST',
      headers: { ...SB.headers(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};

/* ── SESSION (hanya untuk sesi login di browser) ── */
const Session = {
  get: () => { try { return JSON.parse(localStorage.getItem('hc_session')); } catch { return null; } },
  set: (u) => localStorage.setItem('hc_session', JSON.stringify(u)),
  clear: () => localStorage.removeItem('hc_session'),
};

/* ── AUTH ── */
const Auth = {
  isLoggedIn: () => !!Session.get(),
  getUser: () => Session.get(),

  login: async (email, password) => {
    const rows = await SB.get('users', `?email=eq.${encodeURIComponent(email)}&password=eq.${encodeURIComponent(password)}&select=id,name,email,store,role`);
    if (!rows.length) throw new Error('Email atau password salah');
    Session.set(rows[0]);
    return rows[0];
  },

  register: async (name, email, password, store) => {
    const existing = await SB.get('users', `?email=eq.${encodeURIComponent(email)}&select=id`);
    if (existing.length) throw new Error('Email sudah terdaftar');
    const rows = await SB.post('users', { name, email, password, store: store || 'HerbalCare' });
    return rows[0];
  },

  logout: () => { Session.clear(); window.location.href = 'login.html'; },
  guard: () => { if (!Auth.isLoggedIn()) window.location.href = 'login.html'; },
};

/* ── CONFIG (tersimpan di Supabase per user) ── */
const Config = {
  _cache: null,

  load: async () => {
    const uid = Auth.getUser()?.id;
    if (!uid) return {};
    try {
      const rows = await SB.get('configs', `?user_id=eq.${uid}`);
      Config._cache = rows[0] || {};
    } catch { Config._cache = {}; }
    return Config._cache;
  },

  get: () => Config._cache || {},
  getKey: (k) => (Config._cache || {})[k] || '',

  save: async (data) => {
    const uid = Auth.getUser()?.id;
    if (!uid) return;
    const payload = { user_id: uid, ...data, updated_at: new Date().toISOString() };
    const rows = await SB.upsert('configs', payload, 'user_id');
    Config._cache = rows[0] || payload;
    return Config._cache;
  },
};

/* ── CONTACTS ── */
const Contacts = {
  getAll: async () => {
    const uid = Auth.getUser()?.id;
    return SB.get('contacts', `?user_id=eq.${uid}&order=created_at.asc`);
  },
  add: async (data) => {
    const rows = await SB.post('contacts', { ...data, user_id: Auth.getUser()?.id });
    return rows[0];
  },
  update: async (id, data) => {
    const rows = await SB.patch('contacts', `?id=eq.${id}`, data);
    return rows[0];
  },
  delete: async (id) => {
    await SB.delete('messages', `?contact_id=eq.${id}`);
    return SB.delete('contacts', `?id=eq.${id}`);
  },
  find: async (id) => {
    const rows = await SB.get('contacts', `?id=eq.${id}`);
    return rows[0] || null;
  },
};

/* ── CHAT MESSAGES ── */
const ChatHistory = {
  get: async (contactId, limit = 50) => {
    const uid = Auth.getUser()?.id;
    return SB.get('messages', `?contact_id=eq.${contactId}&user_id=eq.${uid}&order=created_at.asc&limit=${limit}`);
  },
  add: async (contactId, role, content, sentToWa = false) => {
    const rows = await SB.post('messages', {
      contact_id: contactId,
      user_id: Auth.getUser()?.id,
      role, content, sent_to_wa: sentToWa,
    });
    return rows[0];
  },
  clear: async (contactId) => SB.delete('messages', `?contact_id=eq.${contactId}`),
};

/* ── FONNTE ── */
const Fonnte = {
  send: async (phone, message) => {
    const token = Config.getKey('fonnte_token');
    if (!token) return { ok: false, error: 'Token Fonnte belum diset di Pengaturan' };
    try {
      const res = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': token },
        body: new URLSearchParams({ target: phone, message, countryCode: '62' }),
      });
      const data = await res.json();
      return { ok: data.status === true || data.status === 'true', data };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  checkDevice: async () => {
    const token = Config.getKey('fonnte_token');
    if (!token) return { ok: false, error: 'Token belum diset' };
    try {
      const res = await fetch('https://api.fonnte.com/device', {
        method: 'POST', headers: { 'Authorization': token },
      });
      const data = await res.json();
      return { ok: data.status === true || data.status === 'true', data };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

/* ── CLAUDE API ── */
const Claude = {
  chat: async (messages, systemPrompt) => {
    const apiKey = Config.getKey('anthropic_key');
    if (!apiKey) throw new Error('Anthropic API key belum diset di Pengaturan');
    const maxTokens = parseInt(Config.getKey('ai_max_len') || '1000');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: systemPrompt, messages }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.find(b => b.type === 'text')?.text || '';
  },
};

/* ── PRODUCTS ── */
const Products = {
  getAll: async () => {
    const uid = Auth.getUser()?.id;
    return SB.get('products', `?user_id=eq.${uid}&order=created_at.asc`);
  },
  add: async (data) => {
    const rows = await SB.post('products', { ...data, user_id: Auth.getUser()?.id });
    return rows[0];
  },
  update: async (id, data) => {
    const rows = await SB.patch('products', `?id=eq.${id}`, data);
    return rows[0];
  },
  delete: async (id) => SB.delete('products', `?id=eq.${id}`),
  find: async (id) => {
    const rows = await SB.get('products', `?id=eq.${id}`);
    return rows[0] || null;
  },
};

/* ── CASES ── */
const Cases = {
  getAll: async (filters = {}) => {
    const uid = Auth.getUser()?.id;
    let q = `?user_id=eq.${uid}&order=created_at.desc`;
    if (filters.status && filters.status !== 'semua') q += `&status=eq.${filters.status}`;
    return SB.get('cases', q);
  },
  find: async (id) => {
    const rows = await SB.get('cases', `?id=eq.${id}`);
    return rows[0] || null;
  },
  getByContact: async (contactId) => {
    const uid = Auth.getUser()?.id;
    return SB.get('cases', `?contact_id=eq.${contactId}&user_id=eq.${uid}&status=neq.selesai&order=created_at.desc&limit=1`);
  },
  create: async (data) => {
    const rows = await SB.post('cases', { ...data, user_id: Auth.getUser()?.id });
    return rows[0];
  },
  update: async (id, data) => {
    const rows = await SB.patch('cases', `?id=eq.${id}`, { ...data, updated_at: new Date().toISOString() });
    return rows[0];
  },
};

/* ── ORDERS ── */
const Orders = {
  getAll: async (filters = {}) => {
    const uid = Auth.getUser()?.id;
    let q = `?user_id=eq.${uid}&order=created_at.desc`;
    if (filters.status && filters.status !== 'semua') q += `&status=eq.${filters.status}`;
    return SB.get('orders', q);
  },
  find: async (id) => {
    const rows = await SB.get('orders', `?id=eq.${id}`);
    return rows[0] || null;
  },
  create: async (data) => {
    const uid = Auth.getUser()?.id;
    const orderNumber = 'ORD-' + Date.now().toString().slice(-8);
    const rows = await SB.post('orders', { ...data, user_id: uid, order_number: orderNumber });
    return rows[0];
  },
  update: async (id, data) => {
    const rows = await SB.patch('orders', `?id=eq.${id}`, { ...data, updated_at: new Date().toISOString() });
    return rows[0];
  },
  delete: async (id) => SB.delete('orders', `?id=eq.${id}`),
};

/* ── BROADCASTS ── */
const Broadcasts = {
  getAll: async () => {
    const uid = Auth.getUser()?.id;
    return SB.get('broadcasts', `?user_id=eq.${uid}&order=created_at.desc`);
  },
  create: async (data) => {
    const rows = await SB.post('broadcasts', { ...data, user_id: Auth.getUser()?.id });
    return rows[0];
  },
  update: async (id, data) => {
    const rows = await SB.patch('broadcasts', `?id=eq.${id}`, data);
    return rows[0];
  },
  sendAll: async (broadcastId, contacts, message) => {
    const token = Config.getKey('fonnte_token');
    if (!token) throw new Error('Fonnte token belum diset di Pengaturan');
    let sent = 0;
    for (const c of contacts) {
      try {
        await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': token },
          body: new URLSearchParams({ target: c.phone, message, countryCode: '62' }),
        });
        sent++;
        await new Promise(r => setTimeout(r, 1200));
      } catch {}
    }
    await Broadcasts.update(broadcastId, { sent_count: sent, status: 'done' });
    return sent;
  },
};

/* ── FAQS ── */
const FAQs = {
  getAll: async () => {
    const uid = Auth.getUser()?.id;
    return SB.get('faqs', `?user_id=eq.${uid}&order=created_at.asc`);
  },
  add: async (data) => {
    const rows = await SB.post('faqs', { ...data, user_id: Auth.getUser()?.id });
    return rows[0];
  },
  update: async (id, data) => {
    const rows = await SB.patch('faqs', `?id=eq.${id}`, data);
    return rows[0];
  },
  delete: async (id) => SB.delete('faqs', `?id=eq.${id}`),
};

/* ── GLOBAL INSIGHTS ── */
const GlobalInsight = {
  generate: async () => {
    const apiKey = Config.getKey('anthropic_key');
    if (!apiKey) throw new Error('Anthropic API key belum diset di Pengaturan');

    const contacts = await Contacts.getAll();
    if (!contacts.length) throw new Error('Belum ada kontak/percakapan untuk dipelajari');

    let allChats = '';
    let contactCount = 0;

    for (const c of contacts) {
      try {
        const msgs = await ChatHistory.get(c.id, 12);
        if (msgs.length < 2) continue;
        contactCount++;
        allChats += `\n---\nPelanggan: ${c.name}${c.label ? ` [${c.label}]` : ''}\n`;
        msgs.forEach(m => {
          allChats += `${m.role === 'user' ? c.name : 'CS'}: ${m.content}\n`;
        });
      } catch {}
    }

    if (!allChats.trim()) throw new Error('Belum ada percakapan yang cukup untuk dipelajari');

    const prompt = `Kamu adalah analis percakapan customer service berpengalaman. Analisis percakapan CS WhatsApp berikut dan ekstrak pelajaran konkret yang bisa membuat AI CS lebih pintar melayani pelanggan baru.

KUMPULAN PERCAKAPAN:
${allChats}

Tulis pelajaran dalam format berikut. Singkat, padat, dan langsung actionable:

PERTANYAAN YANG SERING MUNCUL:
- [pertanyaan] → [cara jawab terbaik]

KEBERATAN UMUM & CARA HANDLE:
- [keberatan] → [cara handle yang efektif]

POLA KARAKTER PELANGGAN:
- [tipe pelanggan] → [pendekatan terbaik]

YANG TERBUKTI BERHASIL MEMBUAT PELANGGAN TERTARIK:
- [taktik spesifik]

YANG HARUS DIHINDARI:
- [hal yang membuat pelanggan pergi atau tidak nyaman]

Tulis dalam bahasa Indonesia. Fokus pada pola yang berulang dan paling berguna.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const insights = data.content?.[0]?.text;
    if (!insights) throw new Error('Gagal generate insights');

    await Config.save({
      ai_insights: insights,
      ai_insights_updated: new Date().toISOString(),
      ai_insights_count: contactCount.toString(),
    });

    return { insights, contactCount };
  },
};

/* ── FILE READER ── */
const FileReader2 = {
  excel: (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'binary' });
        let out = '';
        wb.SheetNames.forEach(n => { out += `[Sheet: ${n}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n]) + '\n\n'; });
        res(out);
      } catch (err) { rej(err); }
    };
    r.onerror = rej; r.readAsBinaryString(file);
  }),
  docx: (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => mammoth.extractRawText({ arrayBuffer: e.target.result }).then(x => res(x.value)).catch(rej);
    r.onerror = rej; r.readAsArrayBuffer(file);
  }),
  auto: async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'xlsx' || ext === 'xls') return FileReader2.excel(file);
    if (ext === 'docx') return FileReader2.docx(file);
    return file.text();
  },
};

/* ── HELPERS ── */
function showToast(msg, duration = 3000) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

function timeStr(ts) {
  return (ts ? new Date(ts) : new Date()).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

const COLORS = ['#fbbf24','#8b5cf6','#ef4444','#06b6d4','#10b981','#f97316','#ec4899','#6366f1'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < (seed||'').length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}
function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

async function buildSystemPrompt() {
  const cfg = Config.get();
  const storeName = cfg.store_name || Auth.getUser()?.store || 'Toko';

  let sys = `Kamu adalah CS ${storeName} yang chat lewat WhatsApp. Kamu harus terdengar seperti manusia sungguhan, bukan bot.

KEPRIBADIAN:
Kamu hangat, peduli, dan nyambung ngobrolnya. Seperti teman yang kerja di toko herbal — bukan sales yang lagi pitch produk.

CARA BALAS PESAN:

Kalau pelanggan cerita keluhan/masalah:
→ Empati dulu dengan tulus, TANPA langsung sebut produk
→ Boleh tanya satu pertanyaan lanjutan yang terasa natural
→ JANGAN tulis kenapa kamu nanya (jangan "nanya dulu biar...", "supaya saya bisa...", dsb)
→ Produk baru disebut setelah ada konteks yang cukup, dan disampaikan dengan natural

Kalau pelanggan tanya produk atau harga:
→ Langsung jawab dengan ramah dan informatif

Kalau pelanggan menolak atau bilang tidak mau:
→ JANGAN langsung menyerah dan bilang "oke gapapa"
→ Gali dulu kenapa — kemahalan? masih ragu? sudah coba produk lain?
→ Kalau kemahalan → tawarkan solusi (produk lain yang lebih murah, beli 1 dulu coba, dsb)
→ Kalau ragu → jawab keraguan mereka, ceritakan manfaat lebih lanjut
→ Kalau memang sudah yakin tidak mau → baru boleh tutup dengan ramah
→ Maksimal 2x follow up sebelum benar-benar lepas

CONTOH YANG SALAH (jangan seperti ini):
Pelanggan: "tidak mau lah kak"
AI: "Haha oke oke gapapa kak 😄 kalau minat lagi saya di sini ya!"

CONTOH YANG BENAR (seperti ini):
Pelanggan: "tidak mau lah kak"
AI: "Eh boleh tau kenapa kak? Kemahalan atau masih belum yakin sama produknya? 😊"

FORMAT PESAN:
- DILARANG pakai markdown: jangan **bold**, jangan ---, jangan > quote
- Singkat dan natural, 2-4 baris sudah cukup
- Bahasa casual, seperti orang asli chat WA
- Emoji boleh tapi seperlunya, jangan tiap kalimat

KONTEN:
- Rekomendasikan HANYA produk yang ada di katalog
- Kalau tidak ada yang cocok, jujur bilang tidak ada
- Jangan sebut nama AI atau Claude
- Untuk keluhan medis serius tetap sarankan konsul dokter, tapi jangan kaku`;

  // Info toko
  const infoLines = [];
  if (cfg.store_hours) infoLines.push(`Jam Operasional: ${cfg.store_hours}`);
  if (cfg.store_wa) infoLines.push(`No. WhatsApp: ${cfg.store_wa}`);
  if (cfg.store_address) infoLines.push(`Alamat: ${cfg.store_address}`);
  if (infoLines.length) sys += `\n\n== INFO TOKO ==\n${infoLines.join('\n')}`;
  if (cfg.store_policy) sys += `\n\n== KEBIJAKAN TOKO ==\n${cfg.store_policy}`;
  if (cfg.ai_extra) sys += `\n\nInstruksi Tambahan:\n${cfg.ai_extra}`;
  if (cfg.ai_insights) sys += `\n\n== PELAJARAN DARI PERCAKAPAN SEBELUMNYA ==\nGunakan pelajaran ini untuk melayani pelanggan baru dengan lebih baik:\n${cfg.ai_insights}\n== AKHIR PELAJARAN ==`;

  // Produk dari Supabase
  try {
    const products = await Products.getAll();
    if (products.length) {
      sys += '\n\n== KATALOG PRODUK ==';
      products.forEach(p => {
        sys += `\n\nPRODUK: ${p.name}`;
        if (p.code) sys += ` (Kode: ${p.code})`;
        if (p.price) sys += `\nHarga: Rp ${p.price}${p.unit ? ' / ' + p.unit : ''}`;
        if (p.stock) sys += `\nStok: ${p.stock}`;
        if (p.benefits) sys += `\nManfaat: ${p.benefits}`;
        if (p.ingredients) sys += `\nKandungan: ${p.ingredients}`;
        if (p.usage) sys += `\nCara Pakai: ${p.usage}`;
        if (p.suitable_for) sys += `\nCocok Untuk: ${p.suitable_for}`;
        if (p.contraindications) sys += `\nPerhatian: ${p.contraindications}`;
      });
      sys += '\n\n== AKHIR KATALOG ==';
    } else if (cfg.product_knowledge) {
      sys += `\n\n== KATALOG PRODUK ==\n${cfg.product_knowledge}\n== AKHIR KATALOG ==`;
    } else {
      sys += '\n\nKatalog produk belum diisi. Informasikan pelanggan bahwa Anda akan segera mengecek.';
    }
  } catch {
    if (cfg.product_knowledge) sys += `\n\n== KATALOG PRODUK ==\n${cfg.product_knowledge}\n== AKHIR KATALOG ==`;
  }

  // FAQ dari Supabase
  try {
    const faqs = await FAQs.getAll();
    if (faqs.length) {
      sys += '\n\n== FAQ ==';
      faqs.forEach(f => { sys += `\n\nQ: ${f.question}\nA: ${f.answer}`; });
      sys += '\n\n== AKHIR FAQ ==';
    }
  } catch {}

  return sys;
}

function renderSidebar(activePage) {
  const user = Auth.getUser();
  const nav = [
    { id:'dashboard', href:'dashboard.html', icon:'💬', label:'Inbox',       badge:true },
    { id:'cases',     href:'cases.html',     icon:'📋', label:'Cases' },
    { id:'analytics', href:'analytics.html', icon:'📊', label:'Analytics' },
    { id:'contacts',  href:'contacts.html',  icon:'👥', label:'Kontak' },
    { id:'orders',    href:'orders.html',    icon:'🛒', label:'Orders' },
    { id:'broadcast', href:'broadcast.html', icon:'📣', label:'Broadcast' },
  ];
  const nav2 = [
    { id:'products',        href:'products.html',        icon:'🏷️', label:'Produk' },
    { id:'shipping',        href:'shipping.html',         icon:'📦', label:'Pengiriman' },
    { id:'followup-engine', href:'followup-engine.html',  icon:'🔔', label:'Follow-up' },
    { id:'knowledge',       href:'knowledge.html',        icon:'📚', label:'Knowledge Base' },
    { id:'connect-wa',      href:'connect-wa.html',       icon:'📱', label:'Hubungkan WA' },
    { id:'settings',        href:'settings.html',         icon:'⚙️', label:'Pengaturan' },
  ];
  const navItem = (p) => `
    <a class="s-btn ${activePage===p.id?'active':''}" href="${p.href}"
       onclick="event.preventDefault();Router.go('${p.href}')">
      <span class="s-icon">${p.icon}</span>
      <span class="s-label">${p.label}</span>
      ${p.badge ? '<span class="s-badge" id="unread-badge" style="display:none">0</span>' : ''}
    </a>`;
  return `<div id="sidebar">
    <div class="s-brand">
      <div class="s-logo">CS</div>
      <span class="s-brand-name">Adsy CS</span>
    </div>
    <div class="s-nav-wrap">
      ${nav.map(navItem).join('')}
      <div class="s-divider"></div>
      ${nav2.map(navItem).join('')}
    </div>
    <div class="s-user">
      <div class="s-avatar">${initials(user?.name||'?')}</div>
      <div class="s-user-info">
        <div class="s-user-name">${user?.name||'Admin'}</div>
        <button class="s-logout" onclick="Auth.logout()">Logout</button>
      </div>
    </div>
  </div>`;
}
