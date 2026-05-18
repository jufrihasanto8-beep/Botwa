/* ── HerbalCare Shared Utilities ── */

/* Storage helpers */
const Store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem('hc_' + k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem('hc_' + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem('hc_' + k),
};

/* Auth */
const Auth = {
  isLoggedIn: () => !!Store.get('user'),
  getUser: () => Store.get('user'),
  login: (user) => Store.set('user', user),
  logout: () => { Store.del('user'); window.location.href = 'login.html'; },
  guard: () => {
    if (!Auth.isLoggedIn()) window.location.href = 'login.html';
  },
};

/* Config (API keys) */
const Config = {
  get: () => Store.get('config') || {},
  set: (c) => Store.set('config', c),
  getKey: (k) => (Store.get('config') || {})[k] || '',
};

/* Toast */
function showToast(msg, duration = 3000) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

/* Sidebar active state */
function setSidebarActive(page) {
  document.querySelectorAll('.s-btn[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
}

/* Fonnte API */
const Fonnte = {
  send: async (phone, message) => {
    const token = Config.getKey('fonnteToken');
    if (!token) return { ok: false, error: 'Token belum diset' };
    try {
      const res = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': token },
        body: new URLSearchParams({ target: phone, message, countryCode: '62' }),
      });
      const data = await res.json();
      return { ok: data.status === true || data.status === 'true', data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  checkDevice: async () => {
    const token = Config.getKey('fonnteToken');
    if (!token) return { ok: false, error: 'Token belum diset' };
    try {
      const res = await fetch('https://api.fonnte.com/device', {
        method: 'POST',
        headers: { 'Authorization': token },
      });
      const data = await res.json();
      return { ok: data.status === true || data.status === 'true', data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};

/* Claude API */
const Claude = {
  chat: async (messages, systemPrompt) => {
    const apiKey = Config.getKey('anthropicKey');
    if (!apiKey) throw new Error('Anthropic API key belum diset');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.find(b => b.type === 'text')?.text || '';
  },
};

/* File reader helpers */
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
    r.onerror = rej;
    r.readAsBinaryString(file);
  }),
  docx: (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => mammoth.extractRawText({ arrayBuffer: e.target.result }).then(x => res(x.value)).catch(rej);
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  }),
  pdf: (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => {
      const bytes = new Uint8Array(e.target.result);
      let str = '';
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        if (c >= 32 && c < 127) str += String.fromCharCode(c);
        else if (c === 10 || c === 13) str += '\n';
      }
      const lines = str.split('\n').map(l => l.trim()).filter(l => l.length > 3 && !/^[\W_]+$/.test(l));
      res(lines.join('\n'));
    };
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  }),
  text: (file) => file.text(),
  auto: async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'xlsx' || ext === 'xls') return FileReader2.excel(file);
    if (ext === 'docx') return FileReader2.docx(file);
    if (ext === 'pdf') return FileReader2.pdf(file);
    return FileReader2.text(file);
  },
};

/* Contacts DB (localStorage) */
const Contacts = {
  getAll: () => Store.get('contacts') || [],
  save: (list) => Store.set('contacts', list),
  add: (contact) => {
    const list = Contacts.getAll();
    contact.id = Date.now().toString();
    contact.createdAt = new Date().toISOString();
    list.push(contact);
    Contacts.save(list);
    return contact;
  },
  update: (id, data) => {
    const list = Contacts.getAll().map(c => c.id === id ? { ...c, ...data } : c);
    Contacts.save(list);
  },
  delete: (id) => Contacts.save(Contacts.getAll().filter(c => c.id !== id)),
  find: (id) => Contacts.getAll().find(c => c.id === id),
};

/* Chat history per contact */
const ChatHistory = {
  get: (contactId) => Store.get('chat_' + contactId) || [],
  add: (contactId, role, content) => {
    const hist = ChatHistory.get(contactId);
    hist.push({ role, content, ts: Date.now() });
    Store.set('chat_' + contactId, hist.slice(-100));
  },
  clear: (contactId) => Store.del('chat_' + contactId),
};

/* Time helper */
function timeStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

/* Random avatar color */
const COLORS = ['#fbbf24','#8b5cf6','#ef4444','#06b6d4','#10b981','#f97316','#ec4899','#6366f1'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}
function initials(name) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

/* Sidebar HTML generator */
function renderSidebar(activePage) {
  return `
  <div id="sidebar">
    <a class="s-logo" href="dashboard.html" title="HerbalCare">🌿</a>
    <a class="s-btn ${activePage==='dashboard'?'active':''}" href="dashboard.html" data-page="dashboard" title="Inbox">
      💬<span class="s-badge" id="unread-badge">0</span>
    </a>
    <a class="s-btn ${activePage==='contacts'?'active':''}" href="contacts.html" data-page="contacts" title="Kontak">👥</a>
    <a class="s-btn ${activePage==='broadcast'?'active':''}" href="broadcast.html" data-page="broadcast" title="Broadcast">📢</a>
    <a class="s-btn ${activePage==='settings'?'active':''}" href="settings.html" data-page="settings" title="Pengaturan">⚙️</a>
    <div class="s-divider"></div>
    <div class="s-avatar" onclick="Auth.logout()" title="Logout">${initials(Auth.getUser()?.name||'?')}</div>
  </div>`;
}
