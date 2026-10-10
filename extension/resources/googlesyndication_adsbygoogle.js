// Neutered adsbygoogle: accepts pushes, never renders ads.
(function () {
  'use strict';
  const queue = window.adsbygoogle;
  window.adsbygoogle = { loaded: true, push() {} };
  if (Array.isArray(queue)) queue.length = 0;
  for (const ins of document.querySelectorAll('ins.adsbygoogle')) {
    ins.setAttribute('data-adsbygoogle-status', 'done');
    ins.style.setProperty('display', 'none', 'important');
  }
})();
