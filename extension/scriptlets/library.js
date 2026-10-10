// Scriptlet implementations (page-world JavaScript run on specific sites).
//
// Filter lists reference these by name, e.g.  example.com##+js(aopr, adsbygoogle)
// The build serialises each function with Function.prototype.toString() into a
// self-contained file per scriptlet and level, so every function here must be a
// plain `function` declaration that only uses the helpers listed in HELPERS.

/* eslint-disable no-new-func */

// ----------------------------------------------------------------------------
// Helpers

function sgRegex(pattern, flags) {
  if (pattern === undefined || pattern === '' || pattern === '*') return /^/;
  const m = /^\/(.+)\/([dgimsuy]*)$/.exec(pattern);
  if (m) {
    try {
      return new RegExp(m[1], m[2] || flags || '');
    } catch (e) {
      /* fall through */
    }
  }
  return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags || '');
}

// "!pattern" negates. Returns a test function.
function sgMatcher(pattern) {
  let p = pattern === undefined ? '' : String(pattern);
  let not = false;
  if (p.startsWith('!')) {
    not = true;
    p = p.slice(1);
  }
  const re = sgRegex(p);
  return function (s) {
    return re.test(String(s)) !== not;
  };
}

function sgFnText(fn) {
  try {
    return typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn);
  } catch (e) {
    return '';
  }
}

function sgValue(raw) {
  const tokens = {
    undefined: undefined,
    null: null,
    false: false,
    true: true,
    noopFunc: function () {},
    trueFunc: function () {
      return true;
    },
    falseFunc: function () {
      return false;
    },
    throwFunc: function () {
      throw new Error();
    },
    emptyArr: [],
    '[]': [],
    emptyObj: {},
    '{}': {},
    emptyStr: '',
    "''": '',
    '""': '',
    noopCallbackFunc: function () {
      return function () {};
    },
    noopPromiseResolve: function () {
      return Promise.resolve();
    },
    noopPromiseReject: function () {
      return Promise.reject();
    },
    yes: 'yes',
    no: 'no',
  };
  if (Object.prototype.hasOwnProperty.call(tokens, raw)) return { ok: true, v: tokens[raw] };
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { ok: true, v: Number(raw) };
  if (/^[[{"]/.test(raw)) {
    try {
      return { ok: true, v: JSON.parse(raw) };
    } catch (e) {
      /* ignore */
    }
  }
  if (/^'.*'$/.test(raw)) return { ok: true, v: raw.slice(1, -1) };
  return { ok: false };
}

// Walks a property chain ("a.b.c") and calls onLeaf(owner, prop) once the
// owner exists, trapping assignments of missing intermediate objects.
function sgTrapChain(owner, chain, onLeaf) {
  const dot = chain.indexOf('.');
  if (dot === -1) {
    onLeaf(owner, chain);
    return;
  }
  const prop = chain.slice(0, dot);
  const rest = chain.slice(dot + 1);
  let value;
  try {
    value = owner[prop];
  } catch (e) {
    return;
  }
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    sgTrapChain(value, rest, onLeaf);
    return;
  }
  const desc = Object.getOwnPropertyDescriptor(owner, prop);
  if (desc && desc.configurable === false) return;
  let current = value;
  try {
    Object.defineProperty(owner, prop, {
      configurable: true,
      enumerable: true,
      get: function () {
        return current;
      },
      set: function (v) {
        current = v;
        if (v !== null && (typeof v === 'object' || typeof v === 'function')) sgTrapChain(v, rest, onLeaf);
      },
    });
  } catch (e) {
    /* ignore */
  }
}

function sgOnReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

// Runs fn now, on DOM ready, and on DOM mutations (throttled).
function sgObserve(fn) {
  let pending = false;
  const run = function () {
    pending = false;
    try {
      fn();
    } catch (e) {
      /* ignore */
    }
  };
  run();
  sgOnReady(run);
  const obs = new MutationObserver(function () {
    if (pending) return;
    pending = true;
    setTimeout(run, 50);
  });
  const start = function () {
    obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
  };
  if (document.documentElement) start();
  else sgOnReady(start);
}

function sgMagic() {
  return 'sg' + Math.random().toString(36).slice(2);
}

const HELPERS = [sgRegex, sgMatcher, sgFnText, sgValue, sgTrapChain, sgOnReady, sgObserve, sgMagic];

// ----------------------------------------------------------------------------
// Scriptlets

function set(chain, raw) {
  if (!chain) return;
  const parsed = sgValue(raw === undefined ? 'undefined' : raw);
  if (!parsed.ok) return;
  const value = parsed.v;
  sgTrapChain(window, chain, function (owner, prop) {
    const desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) {
      try {
        owner[prop] = value;
      } catch (e) {
        /* ignore */
      }
      return;
    }
    try {
      Object.defineProperty(owner, prop, {
        configurable: false,
        enumerable: true,
        get: function () {
          return value;
        },
        set: function () {},
      });
    } catch (e) {
      /* ignore */
    }
  });
}

function aopr(chain) {
  if (!chain) return;
  const magic = sgMagic();
  sgTrapChain(window, chain, function (owner, prop) {
    try {
      Object.defineProperty(owner, prop, {
        configurable: false,
        get: function () {
          throw new ReferenceError(magic);
        },
        set: function () {},
      });
    } catch (e) {
      /* ignore */
    }
  });
  const onerror = window.onerror;
  window.onerror = function (msg) {
    if (typeof msg === 'string' && msg.includes(magic)) return true;
    return typeof onerror === 'function' ? onerror.apply(this, arguments) : false;
  };
}

function aopw(chain) {
  if (!chain) return;
  const magic = sgMagic();
  sgTrapChain(window, chain, function (owner, prop) {
    let value = owner[prop];
    try {
      Object.defineProperty(owner, prop, {
        configurable: false,
        get: function () {
          return value;
        },
        set: function () {
          throw new ReferenceError(magic);
        },
      });
    } catch (e) {
      /* ignore */
    }
    void value;
  });
  const onerror = window.onerror;
  window.onerror = function (msg) {
    if (typeof msg === 'string' && msg.includes(magic)) return true;
    return typeof onerror === 'function' ? onerror.apply(this, arguments) : false;
  };
}

function acs(chain, needle) {
  if (!chain) return;
  const magic = sgMagic();
  const test = sgMatcher(needle || '');
  const thisScript = document.currentScript;
  const check = function () {
    const s = document.currentScript;
    if (!(s instanceof HTMLScriptElement) || s === thisScript) return;
    const text = s.src ? s.src + '\n' + s.textContent : s.textContent;
    if (test(text)) throw new ReferenceError(magic);
  };
  sgTrapChain(window, chain, function (owner, prop) {
    const desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    let value = owner[prop];
    const getter = desc && desc.get;
    const setter = desc && desc.set;
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: function () {
          check();
          return getter ? getter.call(this) : value;
        },
        set: function (v) {
          check();
          if (setter) setter.call(this, v);
          else value = v;
        },
      });
    } catch (e) {
      /* ignore */
    }
  });
  const onerror = window.onerror;
  window.onerror = function (msg) {
    if (typeof msg === 'string' && msg.includes(magic)) return true;
    return typeof onerror === 'function' ? onerror.apply(this, arguments) : false;
  };
}

function aost(chain, needle) {
  if (!chain) return;
  const magic = sgMagic();
  let pattern = needle || '';
  if (pattern === 'inlineScript') pattern = location.href.split('#')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\d+:\\d+';
  const re = sgRegex(pattern.startsWith('/') ? pattern : pattern);
  const check = function () {
    const stack = new Error().stack || '';
    if (re.test(stack)) throw new ReferenceError(magic);
  };
  sgTrapChain(window, chain, function (owner, prop) {
    const desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    let value = owner[prop];
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: function () {
          check();
          return value;
        },
        set: function (v) {
          check();
          value = v;
        },
      });
    } catch (e) {
      /* ignore */
    }
  });
}

function aeld(type, pattern) {
  const typeTest = sgMatcher(type || '');
  const fnTest = sgMatcher(pattern || '');
  const proto = EventTarget.prototype;
  proto.addEventListener = new Proxy(proto.addEventListener, {
    apply: function (target, thisArg, args) {
      const t = String(args[0]);
      const h = args[1];
      const text = h && typeof h === 'object' && typeof h.handleEvent === 'function' ? sgFnText(h.handleEvent) : sgFnText(h);
      if (typeTest(t) && fnTest(text)) return undefined;
      return Reflect.apply(target, thisArg, args);
    },
  });
}

function sgTimerDefuser(name, needle, delay) {
  const test = sgMatcher(needle || '');
  let delayTest = function () {
    return true;
  };
  if (delay !== undefined && delay !== '') {
    const not = String(delay).startsWith('!');
    const n = Number(String(delay).replace('!', ''));
    delayTest = function (d) {
      return (Number(d) === n) !== not;
    };
  }
  window[name] = new Proxy(window[name], {
    apply: function (target, thisArg, args) {
      if (test(sgFnText(args[0])) && delayTest(args[1])) {
        return Reflect.apply(target, thisArg, [function () {}, args[1]]);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

function nostif(needle, delay) {
  sgTimerDefuser('setTimeout', needle, delay);
}

function nosiif(needle, delay) {
  sgTimerDefuser('setInterval', needle, delay);
}

function sgTimerBooster(name, needle, delay, boost) {
  const test = sgMatcher(needle || '');
  const d = delay === undefined || delay === '' ? 1000 : delay === '*' ? null : Number(delay);
  let b = boost === undefined || boost === '' ? 0.05 : Number(boost);
  if (!(b >= 0.001 && b <= 50)) b = 0.05;
  window[name] = new Proxy(window[name], {
    apply: function (target, thisArg, args) {
      if ((d === null || Number(args[1]) === d) && test(sgFnText(args[0]))) {
        args[1] = Number(args[1] || 0) * b;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

function nanoStb(needle, delay, boost) {
  sgTimerBooster('setTimeout', needle, delay, boost);
}

function nanoSib(needle, delay, boost) {
  sgTimerBooster('setInterval', needle, delay, boost);
}

function nowoif(pattern, delay) {
  const test = sgMatcher(pattern || '');
  void delay;
  window.open = new Proxy(window.open, {
    apply: function (target, thisArg, args) {
      const url = args[0] === undefined ? '' : String(args[0]);
      if (!test(url)) return Reflect.apply(target, thisArg, args);
      const fake = {
        closed: false,
        opener: window,
        close: function () {
          fake.closed = true;
        },
        focus: function () {},
        blur: function () {},
        postMessage: function () {},
        document: { write: function () {}, writeln: function () {}, open: function () {}, close: function () {} },
        location: { href: url, assign: function () {}, replace: function () {} },
      };
      return fake;
    },
  });
}

function sgEachMatch(selector, fn) {
  let nodes;
  try {
    nodes = document.querySelectorAll(selector);
  } catch (e) {
    return;
  }
  for (const n of nodes) fn(n);
}

function ra(attrs, selector) {
  if (!attrs) return;
  const names = attrs.split(/\s*\|\s*/).filter(Boolean);
  const sel = selector || names.map((a) => '[' + CSS.escape(a) + ']').join(',');
  sgObserve(function () {
    sgEachMatch(sel, function (el) {
      for (const a of names) el.removeAttribute(a);
    });
  });
}

function rc(classes, selector) {
  if (!classes) return;
  const names = classes.split(/\s*\|\s*/).filter(Boolean);
  const sel = selector || names.map((c) => '.' + CSS.escape(c)).join(',');
  sgObserve(function () {
    sgEachMatch(sel, function (el) {
      for (const c of names) el.classList.remove(c);
    });
  });
}

function setAttr(selector, attr, value) {
  if (!selector || !attr) return;
  const v = value === undefined ? '' : String(value);
  sgObserve(function () {
    sgEachMatch(selector, function (el) {
      let nv = v;
      const m = /^\[(.+)\]$/.exec(v);
      if (m) nv = el.getAttribute(m[1]) || '';
      if (el.getAttribute(attr) !== nv) el.setAttribute(attr, nv);
    });
  });
}

function rmnt(nodeName, pattern) {
  if (!nodeName) return;
  const name = nodeName.toUpperCase();
  const test = sgMatcher(pattern || '');
  const handle = function (node) {
    if (node.nodeName !== name) return;
    const text = node.textContent || '';
    if (!test(text)) return;
    if (node.nodeType === 3) node.textContent = '';
    else if (name === 'SCRIPT') node.textContent = '';
    else node.remove();
  };
  const obs = new MutationObserver(function (records) {
    for (const r of records) for (const n of r.addedNodes) handle(n);
  });
  obs.observe(document, { childList: true, subtree: true });
  sgOnReady(function () {
    const w = document.createTreeWalker(document.documentElement, name === '#TEXT' ? NodeFilter.SHOW_TEXT : NodeFilter.SHOW_ELEMENT);
    const list = [];
    while (w.nextNode()) list.push(w.currentNode);
    list.forEach(handle);
  });
}

function rpnt(nodeName, pattern, replacement) {
  if (!nodeName || !pattern) return;
  const name = nodeName.toUpperCase();
  const re = sgRegex(pattern, 'g');
  const rep = replacement === undefined ? '' : replacement;
  const handle = function (node) {
    if (node.nodeName !== name) return;
    const text = node.textContent || '';
    if (re.test(text)) {
      re.lastIndex = 0;
      node.textContent = text.replace(re, rep);
    }
    re.lastIndex = 0;
  };
  const obs = new MutationObserver(function (records) {
    for (const r of records) for (const n of r.addedNodes) handle(n);
  });
  obs.observe(document, { childList: true, subtree: true });
  sgOnReady(function () {
    obs.disconnect();
  });
}

function sgPropsMatcher(propsToMatch) {
  const conds = [];
  const text = propsToMatch || '';
  if (text === '' || text === '*') return function () {
    return true;
  };
  for (const part of text.split(/\s+/)) {
    const m = /^(\w+):(.*)$/.exec(part);
    if (m) conds.push([m[1], sgMatcher(m[2])]);
    else conds.push(['url', sgMatcher(part)]);
  }
  return function (props) {
    for (const [k, test] of conds) {
      if (!test(props[k] === undefined ? '' : props[k])) return false;
    }
    return true;
  };
}

function noFetchIf(propsToMatch, responseBody) {
  if (typeof fetch !== 'function') return;
  const match = sgPropsMatcher(propsToMatch);
  let body = '';
  if (responseBody === 'emptyObj') body = '{}';
  else if (responseBody === 'emptyArr') body = '[]';
  window.fetch = new Proxy(window.fetch, {
    apply: function (target, thisArg, args) {
      let props = {};
      try {
        const input = args[0];
        const init = args[1] || {};
        props = {
          url: input instanceof Request ? input.url : String(input),
          method: (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase(),
          body: init.body ? String(init.body) : '',
        };
      } catch (e) {
        return Reflect.apply(target, thisArg, args);
      }
      if (!match(props)) return Reflect.apply(target, thisArg, args);
      const res = new Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/plain' } });
      try {
        Object.defineProperty(res, 'url', { value: props.url });
      } catch (e) {
        /* ignore */
      }
      return Promise.resolve(res);
    },
  });
}

function noXhrIf(propsToMatch) {
  const match = sgPropsMatcher(propsToMatch);
  const proto = XMLHttpRequest.prototype;
  const state = new WeakMap();
  proto.open = new Proxy(proto.open, {
    apply: function (target, thisArg, args) {
      state.set(thisArg, { method: String(args[0] || 'GET').toUpperCase(), url: String(args[1]) });
      return Reflect.apply(target, thisArg, args);
    },
  });
  proto.send = new Proxy(proto.send, {
    apply: function (target, thisArg, args) {
      const props = state.get(thisArg);
      if (!props || !match(props)) return Reflect.apply(target, thisArg, args);
      const xhr = thisArg;
      Object.defineProperties(xhr, {
        readyState: { value: 4, configurable: true },
        status: { value: 200, configurable: true },
        statusText: { value: 'OK', configurable: true },
        responseText: { value: '', configurable: true },
        response: { value: xhr.responseType === 'json' ? null : '', configurable: true },
        responseURL: { value: props.url, configurable: true },
      });
      setTimeout(function () {
        for (const t of ['readystatechange', 'load', 'loadend']) {
          try {
            xhr.dispatchEvent(new Event(t));
          } catch (e) {
            /* ignore */
          }
        }
      }, 1);
      return undefined;
    },
  });
}

function sgPrunePaths(obj, paths) {
  let changed = false;
  const prune = function (o, parts) {
    if (o === null || typeof o !== 'object') return;
    const [head, ...rest] = parts;
    const keys = head === '[]' || head === '*' ? Object.keys(o) : [head];
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (rest.length === 0) {
        delete o[k];
        changed = true;
      } else prune(o[k], rest);
    }
  };
  for (const p of paths) prune(obj, p.split('.').flatMap((s) => (s.endsWith('[]') && s !== '[]' ? [s.slice(0, -2), '[]'] : [s])));
  return changed;
}

function sgHasPaths(obj, paths) {
  const has = function (o, parts) {
    if (parts.length === 0) return true;
    if (o === null || typeof o !== 'object') return false;
    const [head, ...rest] = parts;
    if (head === '[]' || head === '*') return Object.keys(o).some((k) => has(o[k], rest));
    return Object.prototype.hasOwnProperty.call(o, head) && has(o[head], rest);
  };
  return paths.every((p) => has(obj, p.split('.')));
}

function jsonPrune(propsToRemove, requiredProps) {
  if (!propsToRemove) return;
  const remove = propsToRemove.split(/\s+/).filter(Boolean);
  const required = (requiredProps || '').split(/\s+/).filter(Boolean);
  const apply = function (obj) {
    if (required.length && !sgHasPaths(obj, required)) return obj;
    sgPrunePaths(obj, remove);
    return obj;
  };
  JSON.parse = new Proxy(JSON.parse, {
    apply: function (target, thisArg, args) {
      return apply(Reflect.apply(target, thisArg, args));
    },
  });
  if (typeof Response !== 'undefined') {
    Response.prototype.json = new Proxy(Response.prototype.json, {
      apply: function (target, thisArg, args) {
        return Reflect.apply(target, thisArg, args).then(apply);
      },
    });
  }
}

function nowebrtc() {
  const Stub = function () {};
  Stub.prototype = {
    close: function () {},
    createDataChannel: function () {
      return { close: function () {}, send: function () {} };
    },
    createOffer: function () {
      return Promise.resolve({});
    },
    createAnswer: function () {
      return Promise.resolve({});
    },
    setLocalDescription: function () {
      return Promise.resolve();
    },
    setRemoteDescription: function () {
      return Promise.resolve();
    },
    addIceCandidate: function () {
      return Promise.resolve();
    },
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    if (window[name]) window[name] = Stub;
  }
}

function noeval() {
  window.eval = new Proxy(window.eval, {
    apply: function () {
      return undefined;
    },
  });
}

function noevalIf(needle) {
  const test = sgMatcher(needle || '');
  window.eval = new Proxy(window.eval, {
    apply: function (target, thisArg, args) {
      if (test(String(args[0]))) return undefined;
      return Reflect.apply(target, thisArg, args);
    },
  });
}

function nofab() {
  const Fab = function () {};
  Fab.prototype = {
    check: function () {
      return this;
    },
    clearEvent: function () {},
    emitEvent: function () {
      return this;
    },
    on: function (detected, fn) {
      if (!detected && typeof fn === 'function') fn();
      return this;
    },
    onDetected: function () {
      return this;
    },
    onNotDetected: function (fn) {
      if (typeof fn === 'function') fn();
      return this;
    },
    setOption: function () {
      return this;
    },
    options: { set: function () {}, get: function () {} },
  };
  const fab = new Fab();
  for (const n of ['FuckAdBlock', 'BlockAdBlock', 'SniffAdBlock']) {
    try {
      Object.defineProperty(window, n, { value: Fab, configurable: false, writable: false });
    } catch (e) {
      /* ignore */
    }
  }
  for (const n of ['fuckAdBlock', 'blockAdBlock', 'sniffAdBlock']) {
    try {
      Object.defineProperty(window, n, { value: fab, configurable: false, writable: false });
    } catch (e) {
      /* ignore */
    }
  }
}

function nobab() {
  const re = /babasbm|bab_elementid|blockadblock|\.bab_/i;
  window.setTimeout = new Proxy(window.setTimeout, {
    apply: function (target, thisArg, args) {
      if (re.test(sgFnText(args[0]))) return Reflect.apply(target, thisArg, [function () {}, args[1]]);
      return Reflect.apply(target, thisArg, args);
    },
  });
}

function popadsDummy() {
  try {
    delete window.PopAds;
    delete window.popns;
    Object.defineProperties(window, { PopAds: { value: {} }, popns: { value: {} } });
  } catch (e) {
    /* ignore */
  }
}

function hrefSanitizer(selector, source) {
  if (!selector) return;
  const src = source || 'text';
  sgObserve(function () {
    sgEachMatch(selector, function (a) {
      if (a.dataset.sgSanitized) return;
      let url = '';
      if (src === 'text') url = (a.textContent || '').trim();
      else if (/^\[.+\]$/.test(src)) url = a.getAttribute(src.slice(1, -1)) || '';
      else if (src.startsWith('?')) {
        try {
          url = new URL(a.href).searchParams.get(src.slice(1)) || '';
        } catch (e) {
          url = '';
        }
      }
      if (!/^https?:\/\//.test(url)) return;
      a.setAttribute('href', url);
      a.dataset.sgSanitized = '1';
    });
  });
}

function sgSetCookie(name, value, path) {
  let p = '; path=/';
  if (path === 'none') p = '';
  else if (path && path !== '/') p = '; path=' + path;
  document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value) + p + '; max-age=31536000; SameSite=Lax';
}

function sgGetCookie(name) {
  const enc = encodeURIComponent(name) + '=';
  for (const c of document.cookie.split(/;\s*/)) if (c.startsWith(enc)) return decodeURIComponent(c.slice(enc.length));
  return null;
}

function setCookie(name, value, path) {
  if (!name || value === undefined) return;
  if (String(value).length > 2048) return;
  if (sgGetCookie(name) === value) return;
  sgSetCookie(name, value, path);
}

function setCookieReload(name, value, path) {
  if (!name || value === undefined) return;
  const before = sgGetCookie(name);
  if (before === value) return;
  sgSetCookie(name, value, path);
  if (sgGetCookie(name) === value && !sessionStorage.getItem('sg-reloaded-' + name)) {
    sessionStorage.setItem('sg-reloaded-' + name, '1');
    location.reload();
  }
}

function cookieRemover(needle) {
  const test = sgMatcher(needle || '');
  const remove = function () {
    for (const c of document.cookie.split(/;\s*/)) {
      const name = decodeURIComponent(c.split('=')[0]);
      if (!name || !test(name)) continue;
      const host = location.hostname;
      const parts = host.split('.');
      const domains = [''];
      for (let i = 0; i < parts.length - 1; i++) domains.push('; domain=.' + parts.slice(i).join('.'));
      for (const d of domains) {
        document.cookie = encodeURIComponent(name) + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d;
        document.cookie = encodeURIComponent(name) + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT' + d;
      }
    }
  };
  remove();
  window.addEventListener('beforeunload', remove);
  document.addEventListener('visibilitychange', remove);
}

function sgStorageItem(storage, key, value) {
  if (!key) return;
  let s;
  try {
    s = window[storage];
  } catch (e) {
    return;
  }
  if (!s) return;
  if (value === '$remove$') {
    const test = key.startsWith('/') ? sgRegex(key) : null;
    if (!test) s.removeItem(key);
    else for (const k of Object.keys(s)) if (test.test(k)) s.removeItem(k);
    return;
  }
  const map = { emptyObj: '{}', emptyArr: '[]', emptyStr: '', undefined: 'undefined', null: 'null' };
  const v = Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value === undefined ? '' : String(value);
  try {
    s.setItem(key, v);
  } catch (e) {
    /* ignore */
  }
}

function setLocalStorageItem(key, value) {
  sgStorageItem('localStorage', key, value);
}

function setSessionStorageItem(key, value) {
  sgStorageItem('sessionStorage', key, value);
}

function sgQueryDeep(selector) {
  const parts = selector.split(/\s*>>>\s*/);
  let roots = [document];
  for (let i = 0; i < parts.length; i++) {
    const found = [];
    for (const r of roots) {
      try {
        const el = r.querySelector(parts[i]);
        if (el) found.push(i < parts.length - 1 ? el.shadowRoot : el);
      } catch (e) {
        return null;
      }
    }
    roots = found.filter(Boolean);
    if (!roots.length) return null;
  }
  return roots[0] || null;
}

function clickElement(selectors, extraMatch, delay) {
  if (!selectors) return;
  void extraMatch;
  const list = selectors.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
  const wait = Math.min(Math.max(Number(delay) || 0, 0), 10000);
  const deadline = Date.now() + 10000;
  let i = 0;
  const step = function () {
    if (i >= list.length || Date.now() > deadline) {
      obs.disconnect();
      return;
    }
    const el = sgQueryDeep(list[i]);
    if (!el) return;
    i++;
    setTimeout(function () {
      try {
        el.click();
      } catch (e) {
        /* ignore */
      }
      step();
    }, wait);
  };
  const obs = new MutationObserver(step);
  sgOnReady(function () {
    obs.observe(document.documentElement, { childList: true, subtree: true });
    step();
  });
  setTimeout(function () {
    obs.disconnect();
  }, 10000);
}

function disableNewtabLinks() {
  document.addEventListener('click', function (ev) {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[target]') : null;
    if (a && /^_?(blank|new)$/i.test(a.getAttribute('target') || '')) a.setAttribute('target', '_self');
  }, true);
}

function closeWindow(pattern) {
  const test = sgMatcher(pattern || '');
  if (test(location.pathname + location.search)) {
    try {
      window.close();
    } catch (e) {
      /* ignore */
    }
  }
}

function preventRefresh(delay) {
  sgOnReady(function () {
    const meta = document.querySelector('meta[http-equiv="refresh" i][content]');
    if (!meta) return;
    let s = Number(delay);
    if (!(s >= 0)) s = parseInt(meta.getAttribute('content'), 10) || 0;
    setTimeout(function () {
      window.stop();
    }, Math.max(s * 1000 - 50, 0));
  });
}

function preventDialog(needle) {
  const test = sgMatcher(needle || '');
  for (const name of ['alert', 'confirm', 'prompt']) {
    window[name] = new Proxy(window[name], {
      apply: function (target, thisArg, args) {
        if (test(String(args[0] === undefined ? '' : args[0]))) return name === 'confirm' ? false : name === 'prompt' ? null : undefined;
        return Reflect.apply(target, thisArg, args);
      },
    });
  }
}

// Shared helpers needed by some scriptlets in addition to HELPERS.
const EXTRA_HELPERS = {
  sgTimerDefuser,
  sgTimerBooster,
  sgEachMatch,
  sgPropsMatcher,
  sgPrunePaths,
  sgHasPaths,
  sgSetCookie,
  sgGetCookie,
  sgStorageItem,
  sgQueryDeep,
};

// Canonical scriptlet name -> implementation
export const SCRIPTLETS = {
  set,
  aopr,
  aopw,
  acs,
  aost,
  aeld,
  nostif,
  nosiif,
  'nano-stb': nanoStb,
  'nano-sib': nanoSib,
  nowoif,
  ra,
  rc,
  'set-attr': setAttr,
  rmnt,
  rpnt,
  'no-fetch-if': noFetchIf,
  'no-xhr-if': noXhrIf,
  'json-prune': jsonPrune,
  nowebrtc,
  noeval,
  'noeval-if': noevalIf,
  nofab,
  nobab,
  'popads-dummy': popadsDummy,
  'href-sanitizer': hrefSanitizer,
  'set-cookie': setCookie,
  'set-cookie-reload': setCookieReload,
  'cookie-remover': cookieRemover,
  'set-local-storage-item': setLocalStorageItem,
  'set-session-storage-item': setSessionStorageItem,
  'click-element': clickElement,
  'disable-newtab-links': disableNewtabLinks,
  'close-window': closeWindow,
  'prevent-refresh': preventRefresh,
  'prevent-dialog': preventDialog,
};

export function helperSource() {
  return [...HELPERS, ...Object.values(EXTRA_HELPERS)].map((fn) => Function.prototype.toString.call(fn)).join('\n');
}
