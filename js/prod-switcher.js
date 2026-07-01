/**
 * prod-switcher.js — Product switcher sidebar (compact dropdown)
 * Load SETELAH app.js supaya Auth sudah tersedia
 */
(function () {

  // ── CSS ──────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
.prod-switcher{padding:4px 10px 10px}
.prod-sw-trigger{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1.5px solid rgba(255,255,255,.1);cursor:pointer;transition:all .15s;background:rgba(255,255,255,.03);user-select:none}
.prod-sw-trigger:hover{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.06)}
.prod-sw-trigger.open{border-color:rgba(59,130,246,.5);background:rgba(59,130,246,.06)}
.prod-sw-av{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0;letter-spacing:-.5px}
.prod-sw-av.all{background:rgba(148,163,184,.2);font-size:14px}
.prod-sw-info{flex:1;min-width:0}
.prod-sw-name{font-size:12px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prod-sw-sub{font-size:10px;color:#64748b;margin-top:1px}
.prod-sw-arrow{font-size:10px;color:#64748b;transition:transform .15s;flex-shrink:0}
.prod-sw-trigger.open .prod-sw-arrow{transform:rotate(180deg)}

.prod-sw-dropdown{position:absolute;z-index:999;background:#1e293b;border:1.5px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.4);min-width:200px;max-width:240px;overflow:hidden;animation:swDrop .12s ease}
@keyframes swDrop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.prod-sw-opt{display:flex;align-items:center;gap:9px;padding:9px 12px;cursor:pointer;transition:background .1s}
.prod-sw-opt:hover{background:rgba(255,255,255,.06)}
.prod-sw-opt.active{background:rgba(34,197,94,.07)}
.prod-sw-opt-av{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0}
.prod-sw-opt-av.all{background:rgba(148,163,184,.2);font-size:14px}
.prod-sw-opt-info{flex:1;min-width:0}
.prod-sw-opt-name{font-size:12px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prod-sw-opt-sub{font-size:10px;color:#64748b;margin-top:1px}
.prod-sw-opt-check{font-size:11px;color:#22c55e;flex-shrink:0}
.prod-sw-divider{height:1px;background:rgba(255,255,255,.06);margin:3px 0}

body.light .prod-sw-trigger{border-color:rgba(0,0,0,.12);background:rgba(0,0,0,.02)}
body.light .prod-sw-trigger:hover{border-color:rgba(0,0,0,.2);background:rgba(0,0,0,.04)}
body.light .prod-sw-trigger.open{border-color:rgba(59,130,246,.4);background:rgba(59,130,246,.05)}
body.light .prod-sw-name{color:#0f172a}
body.light .prod-sw-sub{color:#94a3b8}
body.light .prod-sw-dropdown{background:#fff;border-color:rgba(0,0,0,.1);box-shadow:0 8px 24px rgba(0,0,0,.12)}
body.light .prod-sw-opt:hover{background:rgba(0,0,0,.04)}
body.light .prod-sw-opt.active{background:rgba(34,197,94,.06)}
body.light .prod-sw-opt-name{color:#0f172a}
body.light .prod-sw-opt-sub{color:#94a3b8}
body.light .prod-sw-divider{background:rgba(0,0,0,.07)}
  `;
  document.head.appendChild(style);

  // ── State ─────────────────────────────────────────────────
  const COLORS = ['#3b82f6','#8b5cf6','#f59e0b','#ef4444','#06b6d4','#10b981','#f97316','#ec4899'];
  let allUserProducts = [];
  let activeProductFilter = sessionStorage.getItem('ps_active') || null;
  if (activeProductFilter === 'null') activeProductFilter = null;
  let dropOpen = false;

  // ── Helpers ───────────────────────────────────────────────
  function initials(nama) {
    return (nama||'?').split(' ').filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
  }

  function getActiveProduct() {
    if (!activeProductFilter) return null;
    return allUserProducts.find(p => p.id === activeProductFilter) || null;
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

  // ── Render trigger (tombol utama) ─────────────────────────
  function render() {
    const el = document.getElementById('prod-sw-root');
    if (!el) return;
    if (!allUserProducts.length) { el.innerHTML = ''; return; }

    const active = getActiveProduct();
    const idx    = active ? allUserProducts.indexOf(active) : -1;
    const color  = idx >= 0 ? COLORS[idx % COLORS.length] : null;
    const showAll = allUserProducts.length > 1;

    const avHtml = active
      ? `<div class="prod-sw-av" style="background:${color}">${initials(active.nama)}</div>`
      : `<div class="prod-sw-av all">📋</div>`;

    const nameHtml = active ? active.nama : (showAll ? 'Semua Produk' : (allUserProducts[0]?.nama || 'Produk'));
    const subHtml  = active ? '<span style="color:#22c55e">● Agent aktif</span>' : (showAll ? `${allUserProducts.length} produk aktif` : 'Agent aktif');

    el.innerHTML = `
      <div class="prod-sw-trigger ${dropOpen?'open':''}" id="ps-trigger" onclick="window.__toggleProdDrop(event)">
        ${avHtml}
        <div class="prod-sw-info">
          <div class="prod-sw-name">${nameHtml}</div>
          <div class="prod-sw-sub">${subHtml}</div>
        </div>
        ${showAll ? '<div class="prod-sw-arrow">▼</div>' : ''}
      </div>
    `;
  }

  // ── Render dropdown ───────────────────────────────────────
  function renderDropdown() {
    removeDropdown();
    const trigger = document.getElementById('ps-trigger');
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const dd   = document.createElement('div');
    dd.className = 'prod-sw-dropdown';
    dd.id = 'ps-dropdown';
    dd.style.cssText = `top:${rect.bottom + 4 + window.scrollY}px;left:${rect.left}px;width:${Math.max(rect.width, 200)}px`;

    // Opsi "Semua Produk"
    const allActive = !activeProductFilter;
    dd.innerHTML += `
      <div class="prod-sw-opt ${allActive?'active':''}" onclick="window.__switchProd(null)">
        <div class="prod-sw-opt-av all">📋</div>
        <div class="prod-sw-opt-info">
          <div class="prod-sw-opt-name">Semua Produk</div>
          <div class="prod-sw-opt-sub">${allUserProducts.length} produk aktif</div>
        </div>
        ${allActive ? '<div class="prod-sw-opt-check">✓</div>' : ''}
      </div>
      <div class="prod-sw-divider"></div>
    `;

    allUserProducts.forEach((p, i) => {
      const color    = COLORS[i % COLORS.length];
      const isActive = activeProductFilter === p.id;
      dd.innerHTML += `
        <div class="prod-sw-opt ${isActive?'active':''}" onclick="window.__switchProd('${p.id}')">
          <div class="prod-sw-opt-av" style="background:${color}">${initials(p.nama)}</div>
          <div class="prod-sw-opt-info">
            <div class="prod-sw-opt-name">${p.nama}</div>
            <div class="prod-sw-opt-sub" style="color:#22c55e">● Agent aktif</div>
          </div>
          ${isActive ? '<div class="prod-sw-opt-check">✓</div>' : ''}
        </div>
      `;
    });

    document.body.appendChild(dd);
  }

  function removeDropdown() {
    const old = document.getElementById('ps-dropdown');
    if (old) old.remove();
  }

  // ── Toggle dropdown ───────────────────────────────────────
  window.__toggleProdDrop = function(e) {
    e.stopPropagation();
    if (allUserProducts.length <= 1) return; // 1 produk = tidak perlu dropdown
    dropOpen = !dropOpen;
    render();
    if (dropOpen) {
      renderDropdown();
      setTimeout(() => document.addEventListener('click', closeDrop, { once: true }), 0);
    } else {
      removeDropdown();
    }
  };

  function closeDrop() {
    if (!dropOpen) return;
    dropOpen = false;
    render();
    removeDropdown();
  }

  // ── Global switch handler ─────────────────────────────────
  window.__switchProd = function(productId) {
    activeProductFilter = productId;
    sessionStorage.setItem('ps_active', productId || 'null');
    dropOpen = false;
    removeDropdown();
    render();
    window.__activeProductFilter = productId;
    if (typeof window.renderInbox === 'function') window.renderInbox();
    window.dispatchEvent(new CustomEvent('productSwitch', { detail: { productId } }));
  };

  // Expose active filter ke halaman lain
  window.__activeProductFilter = activeProductFilter;

  // ── Load produk dari Supabase ─────────────────────────────
  async function loadProds() {
    const userId = (typeof Auth !== 'undefined' ? Auth : window.Auth)?.getUser?.()?.id;
    if (!userId) { console.log('[ProdSW] no userId'); return; }
    try {
      const r = await fetch(
        `${window.SUPABASE_URL}/rest/v1/products?user_id=eq.${userId}&aktif=eq.true&order=created_at.asc&select=id,nama`,
        { headers: { apikey: window.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + window.SUPABASE_ANON_KEY } }
      );
      if (r.ok) { allUserProducts = await r.json(); console.log('[ProdSW] loaded', allUserProducts.length, 'products'); }
      else { console.log('[ProdSW] fetch error', r.status, await r.text()); }
    } catch(e) { console.log('[ProdSW] fetch exception', e); }

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

  window.__loadProdSwitcher = loadProds;
  setTimeout(tryInit, 0);

})();
