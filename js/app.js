/* ── HerbalCare · Supabase + Shared Utilities ── */

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

  let sys = `Kamu adalah CS ${storeName} yang melayani pelanggan lewat WhatsApp. Balas seperti manusia, bukan robot.

CARA NGOBROL:
- Kalau pelanggan cerita keluhan atau masalah kesehatan → EMPATI dulu, jangan langsung kasih produk
- Tunjukkan kamu ngerti dan peduli dulu, baru setelah itu natural nyebut produk kalau memang relevan
- Boleh tanya balik untuk lebih ngerti kondisi pelanggan sebelum rekomendasiin sesuatu
- Jangan terkesan jualan — jadilah seperti teman yang kebetulan tahu solusinya
- Kalau pelanggan tanya langsung soal produk/harga → baru boleh langsung jawab

ATURAN FORMAT:
- JANGAN pakai markdown: tidak boleh **bold**, tidak boleh ---, tidak boleh > quote
- Jawab SINGKAT dan NATURAL, maksimal 5-6 baris
- Bahasa santai seperti ngobrol di WA, boleh pakai emoji tapi jangan lebay
- Jangan pakai label kaku "Manfaat:", "Kandungan:" — ceritakan dengan natural

ATURAN KONTEN:
- Hanya rekomendasikan produk yang ada di katalog
- Kalau tidak ada yang cocok, bilang jujur
- Untuk keluhan medis serius, sarankan konsultasi dokter juga
- Jangan sebut nama AI atau Claude`;

  // Info toko
  const infoLines = [];
  if (cfg.store_hours) infoLines.push(`Jam Operasional: ${cfg.store_hours}`);
  if (cfg.store_wa) infoLines.push(`No. WhatsApp: ${cfg.store_wa}`);
  if (cfg.store_address) infoLines.push(`Alamat: ${cfg.store_address}`);
  if (infoLines.length) sys += `\n\n== INFO TOKO ==\n${infoLines.join('\n')}`;
  if (cfg.store_policy) sys += `\n\n== KEBIJAKAN TOKO ==\n${cfg.store_policy}`;
  if (cfg.ai_extra) sys += `\n\nInstruksi Tambahan:\n${cfg.ai_extra}`;

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
  return `<div id="sidebar">
    <a class="s-logo" href="dashboard.html" title="HerbalCare">🌿</a>
    <a class="s-btn ${activePage==='dashboard'?'active':''}" href="dashboard.html" title="Inbox">💬<span class="s-badge" id="unread-badge">0</span></a>
    <a class="s-btn ${activePage==='contacts'?'active':''}" href="contacts.html" title="Kontak">👥</a>
    <a class="s-btn ${activePage==='knowledge'?'active':''}" href="knowledge.html" title="Knowledge Base">📚</a>
    <a class="s-btn ${activePage==='settings'?'active':''}" href="settings.html" title="Pengaturan">⚙️</a>
    <div class="s-divider"></div>
    <div class="s-avatar" onclick="Auth.logout()" title="Logout">${initials(user?.name||'?')}</div>
  </div>`;
}
