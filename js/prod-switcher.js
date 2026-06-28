/**
 * prod-switcher.js — Product switcher sidebar (shared across all pages)
 * Inject otomatis setelah #sb-bot-status, load produk dari Supabase
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

  // ── Inject placeholder HTML setelah bot-status ───────────
  function injectPlaceholder() {
    const botStatus = document.getElementById('sb-bot-status');
    if (!botStatus || document.getElementById('prod-switcher-shared')) return;
    const div = document.createElement('div');
    div.id = 'prod-switcher-shared';
    div.className = 'prod-switcher';
    botStatus.insertAdjacentElement('afterend', div);
  }

  // ── Helpers ───────────────────────────────────────────────
  const COLORS = ['#3b82f6','#8b5cf6','#f59e0b','#ef4444','#06b6d4','#10b981','#f97316','#ec4899'];
  function prodInitials(nama) {
    return (nama||'?').split(' ').filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
  }

  // State global — disimpan di sessionStorage biar persist antar halaman
  let activeProductFilter = sessionStorage.getItem('active_product_filter') || null;
  let allUserProducts = [];

  // ── Render switcher ───────────────────────────────────────
  function renderProdSwitcher() {
    const el = document.getElementById('prod-switcher-shared');
    if (!el || !allUserProducts.length) { if (el) el.innerHTML = ''; return; }

    let html = `<div class="prod-switcher-label">Produk Aktif</div>`;

    if (allUserProducts.length > 1) {
      html += `<div class="prod-sw-all ${activeProductFilter === null || activeProductFilter === 'null' ? 'active' : ''}" onclick="window.__switchProduct(null)">
        <span style="width:34px;height:34px;border-radius:8px;background:rgba(148,163,184,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">📋</span>
        <span style="font-size:12px;font-weight:500">Semua Produk</span>
      </div>`;
    }

    allUserProducts.forEach((p, i) => {
      const color   = COLORS[i % COLORS.length];
      const inits   = prodInitials(p.nama);
      const isActive = allUserProducts.length === 1 || activeProductFilter === p.id;
      html += `<div class="prod-sw-card ${isActive ? 'active' : ''}" onclick="window.__switchProduct('${p.id}')">
        <div class="prod-sw-av" style="background:${color}">${inits}</div>
        <div class="prod-sw-info">
          <div class="prod-sw-name">${p.nama}</div>
          <div class="prod-sw-status"><div class="prod-sw-dot"></div> Agent aktif</div>
        </div>
      </div>`;
    });

    el.innerHTML = html;
  }

  // ── Switch handler (global, bisa dipanggil dari HTML) ─────
  window.__switchProduct = function(productId) {
    activeProductFilter = productId;
    sessionStorage.setItem('active_product_filter', productId || 'null');
    renderProdSwitcher();

    // Kalau halaman punya renderInbox (dashboard), panggil filter-nya
    if (typeof window.renderInbox === 'function') {
      window.__activeProductFilter = productId;
      window.renderInbox();
    }

    // Event buat halaman lain yang mau listen
    window.dispatchEvent(new CustomEvent('productSwitch', { detail: { productId } }));
  };

  // Expose activeProductFilter ke halaman lain
  Object.defineProperty(window, '__activeProductFilter', {
    get: () => activeProductFilter,
    set: v => { activeProductFilter = v; },
    configurable: true,
  });

  // ── Load dari Supabase ────────────────────────────────────
  async function loadProdSwitcher() {
    const userId = window.Auth?.getUser?.()?.id;
    if (!userId || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return;

    try {
      const r = await fetch(
        `${window.SUPABASE_URL}/rest/v1/products?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=id,nama,wa_session_id`,
        { headers: { 'apikey': window.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + window.SUPABASE_ANON_KEY } }
      );
      if (r.ok) allUserProducts = await r.json();
    } catch(e) {}

    // Kalau filter tersimpan tidak ada di produk list, reset ke null
    if (activeProductFilter && activeProductFilter !== 'null') {
      if (!allUserProducts.find(p => p.id === activeProductFilter)) {
        activeProductFilter = null;
        sessionStorage.removeItem('active_product_filter');
      }
    } else if (activeProductFilter === 'null') {
      activeProductFilter = null;
    }

    renderProdSwitcher();
  }

  // ── Init saat DOM siap ────────────────────────────────────
  function init() {
    injectPlaceholder();
    loadProdSwitcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Kalau DOM sudah ready (script di bawah), tunggu sebentar biar bot-status ter-render
    setTimeout(init, 0);
  }
})();
