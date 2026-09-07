(function () {
  'use strict';
  var mode;
  try { mode = localStorage.getItem('seosa_theme'); } catch (_) {}
  if (mode !== 'dark' && mode !== 'light') mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode;
})();
