/**
 * prod-switcher.js — Product switcher sidebar (shared across all pages)
 * Load SETELAH app.js supaya Auth sudah tersedia
 */
(function () {

  // ── CSS ──────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
.prod-switcher{padding:4px 10px 8px}
.prod-switcher-label{font-size:9px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding:0 4px;margin-bottom:5px}
.prod-sw-card{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:10px;border:1.5px solid rgba(255,255,255,.07);cursor:pointer;transition:all .15s;margin-bottom:5px;background:rgba(255,255,255,.02)}
.prod-sw-card:hover{border-color:rgba(255,255,255,.15);background:rgba(255,255,255,.04)}
.prod-sw-card.active{border-color:#22c55e;background:rgba(34,197,94,.06)}
.prod-sw-av{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex-shrink:0;letter-spacing:-.5px}
.prod-sw-info{flex:1;min-width:0}
.prod-sw-name{font-size:12px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prod-sw-status{font-size:10px;color:#22c55e;margin-top:1px;display:flex;align-items:center;gap:3px}
.prod-sw-dot{width:5px;height:5px;background:#22c55e;border-radius:50%}
.prod-sw-all{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:8px;font-size:11px;font-weight:500;color:#94a3b8;cursor:pointer;transition:all .12s;margin-bottom:6px;border:1.5px solid transparent}
.prod-sw-all:hover{background:rgba(255,255,255,.04);color:#e2e8f0}
.prod-sw-all.active{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.3);color:#93c5fd}
body.light .prod-sw-card{border-color:rgba(0,0,0,.1);background:rgba(0,0,0,.02)}
body.light .prod-sw-card:hover{border-color:rgba(0,0,0,.2);background:rgba(0,0,0,.04)}
body.light .prod-sw-card.active{border-color:#22c55e;background:rgba(34,197,94,.06)}
body.light .prod-sw-name{color:#0f172a}
body.light .prod-sw-all{color:#64748b}
body.light .prod-sw-all.active{background:rgba(59,130,246,.08);color:#2563eb}
  `;
  document.head.appendChild(style);

  // ── State ─────────────────────────────────────────────────
  const COLORS = ['#3b82f6','#8b5cf6','#f59e0b','#ef4444','#06b6d4','#10b981','#f97316','#ec4899'];
  let allUserProducts = [];
  let activeProductFilter = sessionStorage.getItem('ps_active') || null;
  if (activeProductFilter === 'null') activeProductFilter = null;

  // ── Helpers ───────────────────────────────────────────────
  function initials(nama) {
    return (nama||'?').split(' ').filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
  }

  // ── Inject div setelah #sb-bot-status ────────────────────
  function injectEl() {
    if (document.getElementById('prod-sw-root')) return;
    const anchor = document.getElementById('sb-bot-status');
    if (!anchor) return;
    const el = document.createElement('div');
    el.id = 'prod-sw-root';
    el.className = 'prod-switcher';
    anchor.insertAdjacentElement('afterend', el);
  }

  // ── Render ────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('prod-sw-root');
    if (!el || !allUserProducts.length) return;

    let html = '<div class="prod-switcher-label">Produk Aktif</div>';

    if (allUserProducts.length > 1) {
      const allActive = !activeProductFilter;
      html += `<div class="prod-sw-all ${allActive ? 'active' : ''}" onclick="window.__switchProd(null)">
        <span style="width:34px;height:34px;border-radius:8px;background:rgba(148,163,184,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">📋</span>
        <span style="font-size:12px;font-weight:500">Semua Produk</span>
      </div>`;
    }

    allUserProducts.forEach((p, i) => {
      const color    = COLORS[i % COLORS.length];
      const isActive = allUserProducts.length === 1 || activeProductFilter === p.id;
      html += `<div class="prod-sw-card ${isActive ? 'active' : ''}" onclick="window.__switchProd('${p.id}')">
        <div class="prod-sw-av" style="background:${color}">${initials(p.nama)}</div>
        <div class="prod-sw-info">
          <div class="prod-sw-name">${p.nama}</div>
          <div class="prod-sw-status"><div class="prod-sw-dot"></div> Agent aktif</div>
        </div>
      </div>`;
    });

    el.innerHTML = html;
  }

  // ── Global switch handler ─────────────────────────────────
  window.__switchProd = function(productId) {
    activeProductFilter = productId;
    sessionStorage.setItem('ps_active', productId || 'null');
    render();
    window.__activeProductFilter = productId;
    if (typeof window.renderInbox === 'function') window.renderInbox();
    window.dispatchEvent(new CustomEvent('productSwitch', { detail: { productId } }));
  };

  // Expose active filter ke halaman lain
  window.__activeProductFilter = activeProductFilter;

  // ── Load produk dari Supabase ─────────────────────────────
  async function loadProds() {
    const userId = window.Auth?.getUser?.()?.id;
    if (!userId) return;
    try {
      const r = await fetch(
        `${window.SUPABASE_URL}/rest/v1/products?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=id,nama,wa_session_id`,
        { headers: { apikey: window.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + window.SUPABASE_ANON_KEY } }
      );
      if (r.ok) allUserProducts = await r.json();
    } catch(e) {}

    // Reset filter kalau produk yang dipilih sudah tidak ada
    if (activeProductFilter && !allUserProducts.find(p => p.id === activeProductFilter)) {
      activeProductFilter = null;
      sessionStorage.removeItem('ps_active');
      window.__activeProductFilter = null;
    }

    injectEl();
    render();
  }

  // ── Init: tunggu #sb-bot-status (support sidebar dinamis) ─
  function tryInit() {
    if (document.getElementById('sb-bot-status')) {
      injectEl();
      loadProds();
    } else {
      // Sidebar di-render dinamis (cases/contacts/aiinsights)
      const obs = new MutationObserver(() => {
        if (document.getElementById('sb-bot-status')) {
          obs.disconnect();
          injectEl();
          loadProds();
        }
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 5000);
    }
  }

  // Expose manual trigger buat halaman yang butuh
  window.__loadProdSwitcher = loadProds;

  // Jalankan setelah semua sync script selesai
  setTimeout(tryInit, 0);

})();
