// ── Global Theme Toggle ──
// Reads / writes localStorage key 'cs_theme' ('light' | 'dark')
// Called right after body tag so class is set before first paint

(function () {
  if (localStorage.getItem('cs_theme') === 'light') {
    document.body.classList.add('light');
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = document.body.classList.contains('light') ? '☀️' : '🌙';
  });
})();

function toggleTheme() {
  var isLight = document.body.classList.toggle('light');
  localStorage.setItem('cs_theme', isLight ? 'light' : 'dark');
  var btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = isLight ? '☀️' : '🌙';
}
