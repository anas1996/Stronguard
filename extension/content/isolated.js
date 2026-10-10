// Stronguard isolated-world content script (document_start, all frames).
// The build wraps one copy per level, replacing __SG_FEATURES__.
//
//  1. Asks the background for this page's cosmetic configuration (the background
//     injects the CSS itself with origin USER so pages cannot override it).
//  2. Streams class/id tokens seen in the DOM to the background, which answers
//     by injecting the matching generic hiding rules.
//  3. Runs procedural filters (:has-text, :upward, :xpath, ...).
//  4. Runs level-dependent heuristics: overlay/ad-wall killer, scroll unlock,
//     invisible click-hijack layer removal, ad-sized iframes, sticky ad bars,
//     "Sponsored" label containers.

(function (F) {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  if (globalThis.__stronguardIsolated) return;
  globalThis.__stronguardIsolated = true;

  const send = (msg) => {
    try {
      return Promise.resolve(api.runtime.sendMessage(msg)).catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  };

  // --------------------------------------------------------------------------
  // Stats (batched)

  const pending = {};
  let statsTimer = 0;
  const bump = (kind, n = 1) => {
    pending[kind] = (pending[kind] || 0) + n;
    if (!statsTimer) {
      statsTimer = setTimeout(() => {
        statsTimer = 0;
        const s = { ...pending };
        for (const k of Object.keys(pending)) delete pending[k];
        send({ t: 'stats', stats: s });
      }, 800);
    }
  };

  document.addEventListener('sg-guard-event', (e) => {
    try {
      const d = JSON.parse(e.detail);
      if (d && d.kind) bump(d.kind);
    } catch (err) {
      /* ignore */
    }
  });

  // --------------------------------------------------------------------------
  // Hiding primitives

  const hide = (el) => {
    if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return false;
    if (el.style.getPropertyValue('display') === 'none' && el.style.getPropertyPriority('display') === 'important') return false;
    el.style.setProperty('display', 'none', 'important');
    return true;
  };

  const ready = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  // Single shared MutationObserver; subscribers are throttled individually.
  const subscribers = [];
  const subscribe = (fn, delay) => {
    let timer = 0;
    subscribers.push(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        try {
          fn();
        } catch (e) {
          /* ignore */
        }
      }, delay);
    });
  };
  const addedListeners = [];
  const observer = new MutationObserver((records) => {
    for (const fn of addedListeners) fn(records);
    for (const s of subscribers) s();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'style'] });

  // --------------------------------------------------------------------------
  // Generic cosmetic filtering: report class/id tokens to the background

  function startTokens() {
    const sent = new Set();
    let queue = [];
    let timer = 0;
    let first = true;
    const MAX = 30000;
    const flush = () => {
      timer = 0;
      if (!queue.length) return;
      const tokens = queue;
      queue = [];
      send({ t: 'tokens', tokens });
    };
    const add = (tok) => {
      if (sent.has(tok) || sent.size > MAX) return;
      sent.add(tok);
      queue.push(tok);
      if (!timer) timer = setTimeout(flush, first ? 0 : 60);
      first = false;
    };
    const collect = (el) => {
      if (el.id) add('#' + el.id);
      const cl = el.classList;
      if (cl) for (let i = 0; i < cl.length; i++) add('.' + cl[i]);
    };
    const scan = (root) => {
      if (root.nodeType !== 1) return;
      collect(root);
      const list = root.querySelectorAll('[id],[class]');
      for (let i = 0; i < list.length; i++) collect(list[i]);
    };
    if (document.documentElement) scan(document.documentElement);
    addedListeners.push((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          if (r.target.nodeType === 1) collect(r.target);
        } else {
          for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // Procedural filters

  const toRegex = (p) => {
    const m = /^\/(.+)\/([imsu]*)$/.exec(p);
    if (m) {
      try {
        return new RegExp(m[1], m[2]);
      } catch (e) {
        return null;
      }
    }
    return null;
  };

  const textTest = (pattern) => {
    const re = toRegex(pattern);
    return re ? (s) => re.test(s) : (s) => s.includes(pattern);
  };

  const cssTest = (arg) => {
    const m = /^([\w-]+)\s*:\s*(.+)$/.exec(arg.trim());
    if (!m) return () => false;
    const prop = m[1];
    const re = toRegex(m[2].trim());
    const want = m[2].trim();
    return (value) => (re ? re.test(value) : value === want || value.replace(/\s+/g, '') === want.replace(/\s+/g, ''));
  };

  const relQuery = (el, css) => {
    try {
      if (/^[+~]/.test(css)) {
        const parent = el.parentElement;
        if (!parent) return [];
        const idx = Array.prototype.indexOf.call(parent.children, el) + 1;
        return [...parent.querySelectorAll(`:scope > :nth-child(${idx}) ${css}`)];
      }
      return [...el.querySelectorAll(`:scope ${css}`)];
    } catch (e) {
      return [];
    }
  };

  function runSteps(steps, roots) {
    let els = roots;
    for (let i = 0; i < steps.length; i++) {
      const [op, arg] = steps[i];
      if (op === 'css') {
        try {
          els = [...document.querySelectorAll(arg)];
        } catch (e) {
          return [];
        }
        continue;
      }
      if (op === 'rel') {
        const base = els || [document.documentElement];
        const out = new Set();
        for (const el of base) for (const x of relQuery(el, arg)) out.add(x);
        els = [...out];
        continue;
      }
      if (op === 'xpath') {
        const out = new Set();
        const ctxs = els || [document];
        for (const ctx of ctxs) {
          try {
            const r = document.evaluate(arg, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let j = 0; j < r.snapshotLength; j++) {
              const n = r.snapshotItem(j);
              if (n.nodeType === 1) out.add(n);
            }
          } catch (e) {
            return [];
          }
        }
        els = [...out];
        continue;
      }
      if (els === null) els = roots ? roots.flatMap((r) => [...r.querySelectorAll('*')]) : [];
      switch (op) {
        case 'filter':
          els = els.filter((e) => {
            try {
              return e.matches(arg);
            } catch (err) {
              return false;
            }
          });
          break;
        case 'has':
          els = els.filter((e) => runSteps(arg, [e]).length > 0);
          break;
        case 'not':
          els = els.filter((e) => runSteps(arg, [e]).length === 0);
          break;
        case 'has-text': {
          const t = textTest(arg);
          els = els.filter((e) => t(e.textContent || ''));
          break;
        }
        case 'min-text-length':
          els = els.filter((e) => (e.textContent || '').length >= arg);
          break;
        case 'upward': {
          const out = new Set();
          for (const e of els) {
            let a = null;
            if (typeof arg === 'number') {
              a = e;
              for (let k = 0; k < arg && a; k++) a = a.parentElement;
            } else {
              try {
                a = e.parentElement && e.parentElement.closest(arg);
              } catch (err) {
                a = null;
              }
            }
            if (a) out.add(a);
          }
          els = [...out];
          break;
        }
        case 'matches-css':
        case 'matches-css-before':
        case 'matches-css-after': {
          let a = arg;
          let pseudo = op === 'matches-css-before' ? '::before' : op === 'matches-css-after' ? '::after' : null;
          const pm = /^(before|after),\s*(.+)$/.exec(a);
          if (pm) {
            pseudo = '::' + pm[1];
            a = pm[2];
          }
          const prop = (/^([\w-]+)/.exec(a) || [])[1];
          const test = cssTest(a);
          els = els.filter((e) => prop && test(getComputedStyle(e, pseudo).getPropertyValue(prop)));
          break;
        }
        case 'matches-attr': {
          const m = /^"?(.+?)"?(?:="?(.*?)"?)?$/.exec(arg);
          if (!m) return [];
          const nameRe = toRegex(m[1]);
          const valTest = m[2] === undefined ? () => true : textTest(m[2]);
          els = els.filter((e) => {
            for (const at of e.attributes) {
              if ((nameRe ? nameRe.test(at.name) : at.name === m[1]) && valTest(at.value)) return true;
            }
            return false;
          });
          break;
        }
        case 'matches-path':
          if (!textTest(arg)(location.pathname + location.search)) return [];
          break;
        case 'matches-media':
          try {
            if (!matchMedia(arg).matches) return [];
          } catch (e) {
            return [];
          }
          break;
        case 'noop':
          break;
        default:
          return [];
      }
    }
    return els || [];
  }

  const important = (decl) =>
    decl
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return i > 0 ? [d.slice(0, i).trim(), d.slice(i + 1).replace(/!important/i, '').trim()] : null;
      })
      .filter(Boolean);

  function applyAction(el, action) {
    switch (action.type) {
      case 'remove':
        el.remove();
        return true;
      case 'style':
        for (const [p, v] of important(action.style)) el.style.setProperty(p, v, 'important');
        return true;
      case 'remove-attr':
        for (const a of action.value.split('|')) el.removeAttribute(a.trim());
        return true;
      case 'remove-class':
        for (const c of action.value.split('|')) el.classList.remove(c.trim());
        return true;
      default:
        return hide(el);
    }
  }

  function startProcedural(rules) {
    if (!rules.length) return;
    const done = new WeakSet();
    const run = () => {
      let n = 0;
      for (const rule of rules) {
        for (const el of runSteps(rule.steps, null)) {
          if (rule.action.type !== 'style' && done.has(el)) continue;
          if (applyAction(el, rule.action)) n++;
          done.add(el);
        }
      }
      if (n) bump('hidden', n);
    };
    ready(run);
    window.addEventListener('load', run, { once: true });
    subscribe(run, 150);
  }

  // --------------------------------------------------------------------------
  // Heuristics

  const vw = () => Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  const vh = () => Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
  const SECOND_LEVEL = /^(co|com|net|org|gov|ac|edu|ne|or|go|gob|mil)$/;
  const site = (host) => {
    const p = String(host || '').toLowerCase().split('.');
    const n = p.length;
    if (n <= 2) return p.join('.');
    return p[n - 1].length === 2 && SECOND_LEVEL.test(p[n - 2]) ? p.slice(-3).join('.') : p.slice(-2).join('.');
  };
  const crossSite = (href) => {
    try {
      const u = new URL(href, location.href);
      return /^https?:$/.test(u.protocol) && site(u.hostname) !== site(location.hostname);
    } catch (e) {
      return false;
    }
  };

  const OVERLAY_WORDS = new RegExp(
    [
      'ad ?-?block', 'ad blocker', 'adblocker', 'disable (your )?ad', 'turn off (your )?ad', 'whitelist', 'allowlist',
      'allow ads', 'support us by', 'deactivate', 'subscribe', 'newsletter', 'sign up for', 'join our', "don't miss",
      'allow notifications', 'werbeblocker', 'bloqueur de pub', 'bloqueador de anuncios', 'bloqueador de anúncios',
      'blocco degli annunci', 'блокировщик рекламы', 'reklam engelleyici', 'مانع الإعلانات', 'حاجب الإعلانات', 'adblock',
    ].join('|'),
    'i',
  );

  const isPositioned = (cs) => cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky';

  const coverage = (rect) => {
    const w = Math.max(0, Math.min(rect.right, vw()) - Math.max(rect.left, 0));
    const h = Math.max(0, Math.min(rect.bottom, vh()) - Math.max(rect.top, 0));
    return (w * h) / (vw() * vh() || 1);
  };

  const hasPassword = (el) => !!el.querySelector('input[type=password]');

  const topAncestorOverlay = (el) => {
    // climb to the outermost fixed/absolute ancestor below body
    let cur = el;
    let best = null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      if (cs.position === 'fixed' || (cs.position === 'absolute' && coverage(cur.getBoundingClientRect()) > 0.6)) best = cur;
      cur = cur.parentElement;
    }
    return best;
  };

  function unlockScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        el.style.setProperty('overflow', 'auto', 'important');
        el.style.setProperty('overflow-y', 'auto', 'important');
      }
      if (el === document.body && cs.position === 'fixed') {
        const top = parseInt(el.style.top, 10) || 0;
        el.style.setProperty('position', 'static', 'important');
        if (top) window.scrollTo(0, -top);
      }
      for (const c of ['modal-open', 'no-scroll', 'noscroll', 'overflow-hidden', 'lock-scroll', 'scroll-lock', 'is-locked', 'tp-modal-open', 'has-modal', 'fixed']) {
        el.classList.remove(c);
      }
    }
    // Content blurred behind ad walls
    if (document.body) {
      for (const el of document.body.querySelectorAll(':scope > *, main, article, #content, .content')) {
        const f = getComputedStyle(el).filter;
        if (f && f.includes('blur')) el.style.setProperty('filter', 'none', 'important');
      }
    }
  }

  const loadedAt = { t: 0 };
  window.addEventListener('load', () => {
    loadedAt.t = performance.now();
  });

  function overlayKiller() {
    if (!document.body) return;
    const candidates = new Set();
    const pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]];
    for (const [x, y] of pts) {
      let stack = [];
      try {
        stack = document.elementsFromPoint(vw() * x, vh() * y);
      } catch (e) {
        stack = [];
      }
      for (const el of stack.slice(0, 3)) {
        const o = topAncestorOverlay(el);
        if (o) candidates.add(o);
      }
    }
    for (const el of document.body.children) {
      if (getComputedStyle(el).position === 'fixed') candidates.add(el);
    }
    let removed = 0;
    const bodyText = Math.max((document.body.innerText || '').length, 1);
    for (const el of candidates) {
      if (!el.isConnected) continue;
      const cs = getComputedStyle(el);
      if (!isPositioned(cs) || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const cov = coverage(el.getBoundingClientRect());
      if (cov < 0.5) continue;
      if (document.fullscreenElement && el.contains(document.fullscreenElement)) continue;
      const text = (el.innerText || '').slice(0, 4000);
      const backdrop = text.trim() === '' && !el.querySelector('img,video,canvas,iframe,svg,input,button') && cov > 0.85;
      const keyword = OVERLAY_WORDS.test(text) && text.length < 3000 && text.length < bodyText * 0.6;
      const generic =
        F.overlayKillerAny && cov > 0.85 && text.length < bodyText * 0.5 && !hasPassword(el) && !el.querySelector('main,article,video');
      if (keyword || generic || (backdrop && removed > 0) || (backdrop && F.overlayKillerAny)) {
        el.remove();
        removed++;
      }
    }
    if (removed) {
      unlockScroll();
      keepUnlockedUntil = performance.now() + 6000;
      bump('overlay', removed);
    }
  }

  // Pages often re-lock scrolling right after their wall is removed.
  let keepUnlockedUntil = 0;
  subscribe(() => {
    if (performance.now() < keepUnlockedUntil) unlockScroll();
  }, 30);

  // Invisible layers that swallow clicks and open ads.
  const isInvisible = (el, cs) => {
    if (parseFloat(cs.opacity) <= 0.05) return true;
    const bg = cs.backgroundColor;
    const transparentBg = bg === 'transparent' || /rgba\(.*,\s*0(\.0+)?\)$/.test(bg);
    if (!transparentBg || cs.backgroundImage !== 'none') return false;
    if ((el.innerText || '').trim() !== '') return false;
    for (const c of el.querySelectorAll('img,video,canvas,svg,iframe,picture,input,button,select,textarea')) {
      const r = c.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) return false;
    }
    return true;
  };

  function isClickjackLayer(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (/^(INPUT|BUTTON|SELECT|TEXTAREA|VIDEO|CANVAS|IFRAME|LABEL|OPTION|HTML|BODY)$/.test(el.tagName)) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    const cov = coverage(rect);
    let overMedia = false;
    if (cov < 0.3) {
      // Covering most of a video/player underneath also counts
      const below = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).find((x) => x !== el && !el.contains(x) && /^(VIDEO|IFRAME|CANVAS)$/.test(x.tagName));
      if (!below) return false;
      const br = below.getBoundingClientRect();
      overMedia = rect.width * rect.height >= 0.8 * br.width * br.height;
      if (!overMedia) return false;
    }
    if (!isInvisible(el, cs)) return false;
    // Invisible links: only cross-site ones are hijacks.
    const a = el.closest('a[href]');
    if (a) return crossSite(a.href);
    if (el.hasAttribute('onclick')) return true;
    // Empty, high z-index click catchers (player controls always have children).
    const z = parseInt(cs.zIndex, 10) || 0;
    return el.children.length === 0 && z >= 100 && cs.cursor === 'pointer';
  }

  function clickjackScan() {
    const pts = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3]];
    let n = 0;
    for (const [x, y] of pts) {
      let top = null;
      try {
        top = document.elementFromPoint(vw() * x, vh() * y);
      } catch (e) {
        top = null;
      }
      let cur = top;
      for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
        if (isClickjackLayer(cur)) {
          cur.remove();
          n++;
          break;
        }
      }
    }
    if (n) bump('clickjack', n);
  }

  function clickjackInterceptor() {
    const onDown = (ev) => {
      if (!ev.isTrusted) return;
      let cur = ev.target;
      for (let i = 0; cur && cur.nodeType === 1 && i < 4; i++, cur = cur.parentElement) {
        if (isClickjackLayer(cur)) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          cur.remove();
          bump('clickjack');
          return;
        }
      }
    };
    for (const t of ['pointerdown', 'mousedown', 'click', 'auxclick']) window.addEventListener(t, onDown, true);
  }

  const IAB = [[300, 250], [728, 90], [160, 600], [300, 600], [320, 50], [320, 100], [970, 90], [970, 250], [336, 280], [468, 60], [250, 250], [120, 600], [300, 50], [234, 60], [300, 100], [200, 200], [180, 150], [125, 125], [300, 1050], [320, 480]];
  let embedAllow = [];
  const isEmbedAllowed = (src) => {
    try {
      const h = new URL(src, location.href).hostname;
      return embedAllow.some((d) => h === d || h.endsWith('.' + d));
    } catch (e) {
      return false;
    }
  };

  function adSizedFrames() {
    let n = 0;
    for (const f of document.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!IAB.some(([w, h]) => Math.abs(r.width - w) <= 2 && Math.abs(r.height - h) <= 2)) continue;
      const src = f.getAttribute('src') || '';
      const foreign = src === '' || src.startsWith('about:') || src.startsWith('javascript:') || crossSite(src);
      if (!foreign || (src && isEmbedAllowed(src))) continue;
      if (hide(f)) n++;
    }
    if (n) bump('hidden', n);
  }

  const AD_MARKERS = 'ins.adsbygoogle,[id^="div-gpt-ad"],[id^="google_ads"],[data-ad-slot],[data-ad-unit],[class*="adsbygoogle"]';

  function stickyAdBars() {
    if (!document.body) return;
    let n = 0;
    for (const el of document.body.querySelectorAll('body > *, body > * > *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      const atEdge = r.top <= 5 || r.bottom >= vh() - 5;
      if (!atEdge || r.height > vh() * 0.3 || r.width < vw() * 0.5) continue;
      if ((el.innerText || '').length > 200) continue;
      const frames = [...el.querySelectorAll('iframe')].filter((f) => crossSite(f.src || '') || !f.src);
      if (frames.length || el.querySelector(AD_MARKERS)) {
        if (hide(el)) n++;
      }
    }
    if (n) bump('hidden', n);
  }

  const AD_LABEL = /^(advertisement|advertisements|sponsored|sponsored content|promoted|ad|ads|anzeige|werbung|publicité|publicidad|pubblicità|реклама|إعلان|اعلان|advertentie|reklama|reklam|広告|广告|광고|paid content|partner content)$/i;

  function adLabels() {
    if (!document.body) return;
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const labels = [];
    while (walker.nextNode() && labels.length < 200) {
      const t = walker.currentNode.nodeValue.trim();
      if (t.length <= 30 && AD_LABEL.test(t)) labels.push(walker.currentNode.parentElement);
    }
    for (const label of labels) {
      if (!label || label.closest('main > h1, article h1, nav, header')) continue;
      let cur = label.parentElement;
      for (let i = 0; cur && i < 6; i++, cur = cur.parentElement) {
        if (cur === document.body || /^(MAIN|ARTICLE|BODY)$/.test(cur.tagName)) break;
        const r = cur.getBoundingClientRect();
        if (r.height >= 40 && r.height <= 900 && r.width >= 120 && (cur.innerText || '').length < 600 && cur.querySelector('iframe,img,video,a[href]')) {
          if (hide(cur)) n++;
          break;
        }
      }
    }
    if (n) bump('hidden', n);
  }

  // Large first-party apps: generic heuristics (overlay/click-hijack/ad-size
  // guessing) could only misfire there; filter lists and service handling still run.
  const APPS = [
    'youtube.com', 'youtubekids.com', 'spotify.com', 'twitch.tv', 'netflix.com', 'primevideo.com', 'disneyplus.com',
    'hulu.com', 'max.com', 'google.com', 'gmail.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
    'reddit.com', 'linkedin.com', 'whatsapp.com', 'messenger.com', 'discord.com', 'slack.com', 'github.com',
    'microsoft.com', 'live.com', 'office.com', 'apple.com', 'icloud.com', 'amazon.com', 'figma.com', 'notion.so',
  ];
  const isApp = APPS.some((d) => location.hostname === d || location.hostname.endsWith(`.${d}`));

  function startHeuristics() {
    if (isApp) return;
    const tasks = [];
    if (F.overlayKiller) tasks.push(overlayKiller);
    if (F.clickjackKiller) {
      clickjackInterceptor();
      tasks.push(clickjackScan);
    }
    if (F.adSizedFrames) tasks.push(adSizedFrames);
    if (F.stickyAdBars) tasks.push(stickyAdBars);
    if (F.adLabelHeuristic) tasks.push(adLabels);
    if (!tasks.length) return;
    const runAll = () => {
      for (const t of tasks) {
        try {
          t();
        } catch (e) {
          /* ignore */
        }
      }
    };
    ready(() => {
      runAll();
      for (const d of [500, 1500, 3500, 7000, 15000]) setTimeout(runAll, d);
      subscribe(runAll, 400);
    });
  }

  // --------------------------------------------------------------------------
  // Boot

  send({ t: 'hello', url: location.href, top: window === window.top }).then((cfg) => {
    if (!cfg || !cfg.enabled) {
      observer.disconnect();
      return;
    }
    embedAllow = cfg.embedAllowlist || [];
    if (!cfg.generichide) startTokens();
    startProcedural(cfg.procedural || []);
    if (cfg.heuristics !== false) startHeuristics();
  });
})(__SG_FEATURES__);
