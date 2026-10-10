// Neutered Google Analytics / gtag: keeps pages working (callbacks fire), sends nothing.
(function () {
  'use strict';
  const noop = function () {};
  const w = window;
  const Tracker = function () {};
  Tracker.prototype.get = noop;
  Tracker.prototype.set = noop;
  Tracker.prototype.send = noop;
  const name = w.GoogleAnalyticsObject || 'ga';
  const queued = w[name] && Array.isArray(w[name].q) ? w[name].q : [];
  const ga = function () {
    const n = arguments.length;
    if (n === 0) return;
    const last = arguments[n - 1];
    let cb = null;
    if (last && typeof last === 'object' && typeof last.hitCallback === 'function') cb = last.hitCallback;
    else if (typeof last === 'function') cb = () => last(ga.create());
    if (cb) {
      try {
        cb();
      } catch (e) {
        /* ignore */
      }
    }
  };
  ga.create = () => new Tracker();
  ga.getByName = () => new Tracker();
  ga.getAll = () => [new Tracker()];
  ga.remove = noop;
  ga.loaded = true;
  w[name] = ga;
  for (const args of queued) ga(...args);

  const dl = w.dataLayer;
  if (dl && typeof dl === 'object') {
    if (dl.hide && typeof dl.hide.end === 'function') {
      dl.hide.end();
      dl.hide.end = noop;
    }
    const fire = (item) => {
      if (item && typeof item === 'object' && typeof item.eventCallback === 'function') {
        setTimeout(item.eventCallback, 1);
        item.eventCallback = noop;
      }
    };
    if (typeof dl.push === 'function') {
      dl.push = new Proxy(dl.push, {
        apply(target, thisArg, args) {
          fire(args[0]);
          return Reflect.apply(target, thisArg, args);
        },
      });
    }
    if (Array.isArray(dl)) dl.forEach(fire);
  }
  if (typeof w.gtag !== 'function') w.gtag = noop;
})();
