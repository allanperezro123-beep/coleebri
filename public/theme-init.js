/* Runs before first paint (blocking, external: the CSP forbids inline scripts).
   Applies the saved theme, or the OS preference when the visitor never chose one. */
(function () {
  try {
    var stored = localStorage.getItem('coleebri:theme');
    var dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    /* storage blocked: fall back to the light theme */
  }
})();
