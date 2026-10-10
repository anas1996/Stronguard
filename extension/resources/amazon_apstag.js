(function () {
  'use strict';
  const noop = function () {};
  window.apstag = {
    fetchBids(cfg, cb) {
      if (typeof cb === 'function') setTimeout(() => cb([]), 1);
    },
    init: noop,
    setDisplayBids: noop,
    targetingKeys() {
      return [];
    },
  };
})();
