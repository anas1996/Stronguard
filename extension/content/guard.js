// Stronguard page-world guard. Runs in the MAIN world at document_start, before
// any page script, in every frame. The build wraps one copy per protection
// level, replacing __SG_FEATURES__ with that level's feature switches.
//
// Defends against: popups/popunders (window.open, synthetic link clicks, fresh
// iframe windows), notification-permission spam, back-button hijacking,
// "leave site?" traps and dialog loops.

(function (F) {
  'use strict';

  const win = window;
  const EVENT = 'sg-guard-event';
  const apply = Reflect.apply;
  const perf = performance;

  const report = (kind, info) => {
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ kind, info: info || '' }) }));
    } catch (e) {
      /* ignore */
    }
  };

  // --------------------------------------------------------------------------
  // User gesture tracking (capture phase, registered before page listeners)

  let gesture = { time: -1e9, target: null, opened: 0 };
  const startGesture = (ev) => {
    if (!ev.isTrusted) return;
    gesture = { time: perf.now(), target: ev.target, opened: 0 };
  };
  const continueGesture = (ev) => {
    if (!ev.isTrusted) return;
    if (perf.now() - gesture.time > 2000) gesture = { time: perf.now(), target: ev.target, opened: 0 };
    else gesture.target = ev.target;
    // A trusted click on a target=_blank link opens a window natively: count it.
    if (ev.type === 'click') {
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (a && isNewWindowTarget(a)) gesture.opened++;
    }
  };
  for (const t of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) win.addEventListener(t, startGesture, true);
  for (const t of ['pointerup', 'mouseup', 'touchend', 'click', 'keyup']) win.addEventListener(t, continueGesture, true);

  const hasActivation = () => {
    const ua = navigator.userActivation;
    if (ua && typeof ua.isActive === 'boolean') return ua.isActive;
    return perf.now() - gesture.time < 1000;
  };

  // --------------------------------------------------------------------------
  // Popup decision

  const SECOND_LEVEL = /^(co|com|net|org|gov|ac|edu|ne|or|go|gob|mil)$/;
  const site = (host) => {
    const p = String(host || '').toLowerCase().split('.');
    if (p.length <= 2) return p.join('.');
    const n = p.length;
    return p[n - 1].length === 2 && SECOND_LEVEL.test(p[n - 2]) ? p.slice(-3).join('.') : p.slice(-2).join('.');
  };

  // Sign-in and payment providers that legitimately open cross-site popups.
  const POPUP_ALLOW = [
    'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'github.com',
    'gitlab.com', 'facebook.com', 'twitter.com', 'x.com', 'discord.com', 'slack.com', 'paypal.com',
    'stripe.com', 'auth0.com', 'okta.com', 'login.yahoo.com', 'linkedin.com', 'amazon.com', 'steamcommunity.com',
    'twitch.tv', 'zoom.us', 'dropbox.com', 'box.com', 'atlassian.com', 'salesforce.com', 'klarna.com',
  ];
  const isAllowedPopupHost = (host) => POPUP_ALLOW.some((d) => host === d || host.endsWith('.' + d));

  const CONTROL_SEL = 'a[href],button,input[type=button],input[type=submit],input[type=image],[role=button],[role=link],[role=menuitem],summary,select,label';

  function isNewWindowTarget(a) {
    const t = (a.getAttribute('target') || '').toLowerCase();
    return t !== '' && t !== '_self' && t !== '_top' && t !== '_parent';
  }

  function decide(rawUrl) {
    let u = null;
    try {
      u = new URL(rawUrl === undefined || rawUrl === null || rawUrl === '' ? 'about:blank' : String(rawUrl), location.href);
    } catch (e) {
      u = null;
    }
    const blank = !u || u.protocol === 'about:' || u.protocol === 'javascript:';
    const sameSite = !blank && (u.origin === location.origin || site(u.hostname) === site(location.hostname));

    if (F.popupRequireGesture && !hasActivation()) return 'no-gesture';
    if (F.popupOnePerGesture && gesture.opened >= 1) return 'multiple';
    if (sameSite) return null;
    if (!blank && isAllowedPopupHost(u.hostname)) return null;

    const t = gesture.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    const control = el && el.closest ? el.closest(CONTROL_SEL) : null;

    if (F.popupBlockCrossSite) return blank && control && control.tagName !== 'A' ? null : 'cross-site';

    if (F.popupRequireLinkTarget) {
      if (!control) return 'no-control';
      if (control.tagName === 'A' && !blank) {
        try {
          const href = new URL(control.href, location.href);
          if (site(href.hostname) !== site(u.hostname)) return 'hijacked-link';
        } catch (e) {
          return 'hijacked-link';
        }
      }
    }
    return null;
  }

  function fakeWindow(url) {
    const fake = {
      closed: false,
      opener: win,
      name: '',
      length: 0,
      close() {
        fake.closed = true;
      },
      focus() {},
      blur() {},
      postMessage() {},
      addEventListener() {},
      removeEventListener() {},
      document: { write() {}, writeln() {}, open() {}, close() {}, body: null },
      location: { href: String(url || ''), assign() {}, replace() {}, reload() {} },
    };
    fake.window = fake;
    fake.self = fake;
    return fake;
  }

  const guardOpen = (orig) =>
    new Proxy(orig, {
      apply(target, thisArg, args) {
        const reason = decide(args[0]);
        if (reason) {
          report('popup', reason + ' ' + String(args[0] || '').slice(0, 200));
          return fakeWindow(args[0]);
        }
        gesture.opened++;
        return apply(target, thisArg, args);
      },
    });

  win.open = guardOpen(win.open);

  // Fresh iframe windows carry a pristine window.open: patch them on access.
  const patched = new WeakSet();
  const patchChild = (w) => {
    try {
      if (!w || patched.has(w)) return;
      patched.add(w);
      if (w.open && w.open !== win.open) w.open = guardOpen(w.open);
    } catch (e) {
      /* cross-origin: unreachable for the page as well */
    }
  };
  for (const [ctor, prop] of [
    [win.HTMLIFrameElement, 'contentWindow'],
    [win.HTMLFrameElement, 'contentWindow'],
    [win.HTMLObjectElement, 'contentWindow'],
    [win.HTMLIFrameElement, 'contentDocument'],
  ]) {
    if (!ctor) continue;
    const desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    if (!desc || !desc.get) continue;
    Object.defineProperty(ctor.prototype, prop, {
      ...desc,
      get: new Proxy(desc.get, {
        apply(target, thisArg, args) {
          const v = apply(target, thisArg, args);
          if (v) patchChild(prop === 'contentDocument' ? v.defaultView : v);
          return v;
        },
      }),
    });
  }

  // Synthetic clicks on target=_blank links (a.click() / dispatchEvent).
  const checkAnchor = (a) => {
    if (!(a instanceof HTMLAnchorElement) || !isNewWindowTarget(a)) return true;
    const reason = decide(a.href);
    if (reason) {
      report('popup', reason + ' ' + a.href.slice(0, 200));
      return false;
    }
    gesture.opened++;
    return true;
  };
  HTMLElement.prototype.click = new Proxy(HTMLElement.prototype.click, {
    apply(target, thisArg, args) {
      if (!checkAnchor(thisArg)) return undefined;
      return apply(target, thisArg, args);
    },
  });
  EventTarget.prototype.dispatchEvent = new Proxy(EventTarget.prototype.dispatchEvent, {
    apply(target, thisArg, args) {
      const ev = args[0];
      if (ev && ev.type === 'click' && thisArg instanceof HTMLAnchorElement && !checkAnchor(thisArg)) return false;
      return apply(target, thisArg, args);
    },
  });

  // --------------------------------------------------------------------------
  // Notification spam: answer "denied" while the user has not decided yet.

  if (F.denyNotifications && win.Notification && Notification.permission === 'default') {
    try {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' });
      Notification.requestPermission = new Proxy(Notification.requestPermission, {
        apply(target, thisArg, args) {
          report('notification');
          const cb = args[0];
          if (typeof cb === 'function') setTimeout(() => cb('denied'), 0);
          return Promise.resolve('denied');
        },
      });
    } catch (e) {
      /* ignore */
    }
    if (navigator.permissions && navigator.permissions.query) {
      const perms = navigator.permissions;
      perms.query = new Proxy(perms.query, {
        apply(target, thisArg, args) {
          const d = args[0];
          if (d && (d.name === 'notifications' || d.name === 'push')) {
            return Promise.resolve({ name: d.name, state: 'denied', status: 'denied', onchange: null, addEventListener() {}, removeEventListener() {} });
          }
          return apply(target, thisArg, args);
        },
      });
    }
    if (win.PushManager) {
      PushManager.prototype.subscribe = new Proxy(PushManager.prototype.subscribe, {
        apply() {
          report('notification');
          return Promise.reject(new DOMException('Registration failed - permission denied', 'NotAllowedError'));
        },
      });
    }
  }

  // --------------------------------------------------------------------------
  // Back-button hijacking: history entries pushed without any user action.

  if (F.blockHistoryHijack && win.history) {
    let silentPushes = 0;
    history.pushState = new Proxy(history.pushState, {
      apply(target, thisArg, args) {
        if (!hasActivation()) {
          let dest = location.href;
          try {
            if (args[2] !== undefined && args[2] !== null) dest = new URL(String(args[2]), location.href).href;
          } catch (e) {
            /* ignore */
          }
          silentPushes++;
          if (dest === location.href || (F.blockBeforeUnload && silentPushes > 3)) {
            report('history');
            return undefined;
          }
        }
        return apply(target, thisArg, args);
      },
    });
  }

  // --------------------------------------------------------------------------
  // "Are you sure you want to leave?" traps

  if (F.blockBeforeUnload) {
    EventTarget.prototype.addEventListener = new Proxy(EventTarget.prototype.addEventListener, {
      apply(target, thisArg, args) {
        if (thisArg === win && String(args[0]).toLowerCase() === 'beforeunload') {
          report('beforeunload');
          return undefined;
        }
        return apply(target, thisArg, args);
      },
    });
    try {
      Object.defineProperty(win, 'onbeforeunload', {
        configurable: true,
        get: () => null,
        set: () => report('beforeunload'),
      });
    } catch (e) {
      /* ignore */
    }
  }

  // --------------------------------------------------------------------------
  // Dialog loops (alert/confirm/prompt spam used by scam pages)

  if (F.limitDialogs) {
    const times = [];
    for (const name of ['alert', 'confirm', 'prompt']) {
      if (typeof win[name] !== 'function') continue;
      win[name] = new Proxy(win[name], {
        apply(target, thisArg, args) {
          const now = Date.now();
          while (times.length && now - times[0] > 10000) times.shift();
          if (times.length >= 2 || document.visibilityState === 'hidden') {
            report('dialog');
            return name === 'confirm' ? false : name === 'prompt' ? null : undefined;
          }
          times.push(now);
          return apply(target, thisArg, args);
        },
      });
    }
  }
  // --------------------------------------------------------------------------
  // Media ad guard: when a video/audio ad still plays (the lists, the IMA
  // stand-in and HLS pruning missed it), mute it and, when the signal is
  // unambiguous, fast-forward or skip it. Everything is restored afterwards.
  //
  // Service adapters cover sites with their own players (YouTube, Spotify,
  // Twitch); the generic adapter recognises the ad mode of common players
  // (Video.js/Brightcove, JW Player, Google IMA, embedded YouTube) and on-screen
  // ad labels on any other site.

  const onHost = (domains) => domains.some((d) => location.hostname === d || location.hostname.endsWith('.' + d));
  const anyMatch = (selectors) => {
    for (const sel of selectors) {
      try {
        if (document.querySelector(sel)) return true;
      } catch (e) {
        /* invalid selector */
      }
    }
    return false;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden';
  };
  const MAX_AD_SECONDS = 180; // never fast-forward anything longer: it is content

  const SKIP_LABEL = /^\s*(skip|skip ads?|skip this ad|skip advertisement|skip ad now|passer( la pub(licité)?)?|werbung überspringen|überspringen|saltar( anuncio)?|pular( anúncio)?|salta( annuncio)?|пропустить( рекламу)?|تخطي( الإعلان)?|reklamı geç)\s*[›»>▶]*\s*$/i;
  function skipButtons(roots) {
    const out = new Set();
    for (const root of roots) {
      for (const el of root.querySelectorAll('button, [role="button"], a, [class*="skip" i]')) {
        const label = ((el.innerText || '') || el.getAttribute('aria-label') || '').trim();
        if (label && label.length < 40 && SKIP_LABEL.test(label) && visible(el)) out.add(el);
      }
    }
    return out;
  }

  const AD_LABEL = new RegExp(
    [
      '\\bad\\s*\\d+\\s*(of|/)\\s*\\d+',
      '\\bad\\s*[·•:|-]?\\s*\\d{1,2}:\\d{2}\\b',
      '(^|\\n)\\s*(advertisement|sponsored|werbung|anzeige|publicité|publicidad|pubblicità|reklama|реклама|إعلان)\\s*($|\\n)',
      'your video will (begin|play|start|resume)',
      'video will (play|start|resume) after (the )?ad',
      '(ad|advertisement) (will )?ends? in',
    ].join('|'),
    'i',
  );

  const PLAYER_AD_MODE = '.vjs-ad-playing, .jw-flag-ads, .html5-video-player.ad-showing, .html5-video-player.ad-interrupting';
  const AD_CONTAINERS = '.ima-ad-container, .videoAdUi, .ad-container, .ads-container, .video-ads, .video-ad-container, [class*="AdContainer"]';
  // Ids must contain "ad container" as words: "video-ad-container", "videoAdContainer", never "head-container" or "threadContainer".
  const AD_CONTAINER_ID = /(^|[^a-zA-Z])[aA]ds?[-_]?[cC]ontainer|[a-z\d]Ads?Container/;
  const adContainers = () => [
    ...document.querySelectorAll(AD_CONTAINERS),
    ...[...document.querySelectorAll('[id*="container" i]')].filter((el) => AD_CONTAINER_ID.test(el.id)),
  ];

  const ADAPTERS = [
    {
      name: 'youtube',
      domains: ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com'],
      scan() {
        const players = document.querySelectorAll('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
        if (!players.length) return null;
        const media = new Set();
        for (const p of players) for (const v of p.querySelectorAll('video')) media.add(v);
        const skip = new Set();
        for (const sel of ['.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-slot button', '.ytp-ad-overlay-close-button']) {
          for (const b of document.querySelectorAll(sel)) skip.add(b);
        }
        // The ad plays in the same <video> as the content: seek it to the end.
        return { mute: media, fastForward: media, skip, anyLength: true };
      },
      cleanup() {
        // "Ad blockers are not allowed on YouTube" wall
        const wall = document.querySelector('ytd-enforcement-message-view-model');
        if (!wall) return;
        (wall.closest('tp-yt-paper-dialog') || wall).remove();
        for (const b of document.querySelectorAll('tp-yt-iron-overlay-backdrop')) b.remove();
        const v = document.querySelector('video.html5-main-video');
        if (v && v.paused) v.play().catch(() => {});
        report('overlay', 'youtube-enforcement');
      },
    },
    {
      name: 'spotify',
      domains: ['open.spotify.com'],
      scan(media) {
        const title = (document.title || '').trim();
        // Tracks are titled "Song • Artist"; ads are titled "Advertisement" or the advertiser.
        let ad = /^(spotify\s*[-–—]\s*)?advertisement$/i.test(title) ||
          anyMatch(['[data-testid="context-item-info-ad-subtitle"]', '[data-testid="ad-type-label"]', '[data-testid="now-playing-widget"] a[href*="/ad/"]']);
        if (!ad) {
          const widget = document.querySelector('[data-testid="now-playing-widget"]');
          ad = !!widget && /\badvertisement\b/i.test(widget.getAttribute('aria-label') || '');
        }
        return ad ? { mute: new Set(media) } : null;
      },
    },
    {
      name: 'twitch',
      domains: ['twitch.tv'],
      scan(media) {
        const ad = anyMatch(['[data-a-target="video-ad-label"]', '[data-a-target="video-ad-countdown"]', '[data-test-selector="ad-banner-default-text"]']);
        return ad ? { mute: new Set(media) } : null;
      },
    },
  ];

  const GENERIC = {
    name: 'generic',
    scan(media) {
      const mute = new Set();
      const fastForward = new Set();
      const roots = [];
      // 1. A player framework says it is playing an ad (strong signal). Only the playing
      // element is sped up: the paused content video often sits in the same player.
      for (const root of document.querySelectorAll(PLAYER_AD_MODE)) {
        roots.push(root);
        for (const v of root.querySelectorAll('video, audio')) {
          mute.add(v);
          if (!v.paused) fastForward.add(v);
        }
      }
      // 2. An ad container is showing a playing video (strong signal).
      for (const c of adContainers()) {
        for (const v of c.querySelectorAll('video, audio')) {
          if (v.paused || !visible(c)) continue;
          roots.push(c);
          mute.add(v);
          fastForward.add(v);
        }
      }
      // 3. An ad label/countdown next to a playing video (weak signal: mute only, and the
      // user can unmute if it is wrong).
      const weak = new Set();
      for (const v of media) {
        if (v.paused || !v.isConnected || mute.has(v)) continue;
        let p = v.parentElement;
        for (let i = 0; p && i < 3; i++, p = p.parentElement) {
          const text = p.innerText || '';
          if (text.length > 600) break;
          if (AD_LABEL.test(text)) {
            roots.push(p);
            mute.add(v);
            weak.add(v);
            break;
          }
        }
      }
      if (!mute.size) return null;
      return { mute, fastForward, skip: skipButtons(roots), weak };
    },
  };

  if (F.mediaAdGuard) {
    const adapter = ADAPTERS.find((a) => onHost(a.domains)) || GENERIC;
    const media = new Set(); // includes elements never attached to the DOM (e.g. Spotify)
    const saved = new Map(); // element -> state before we touched it
    const forced = new Set(); // elements we muted during this ad
    const unmutedByUser = new Set(); // ...and that were unmuted again since
    let adOn = false;
    let timer = 0;

    const tick = () => {
      for (const el of document.querySelectorAll('video, audio')) media.add(el);
      for (const el of media) if (!el.isConnected && el.paused && !saved.has(el)) media.delete(el);
      let found = null;
      try {
        found = adapter.scan(media);
      } catch (e) {
        found = null;
      }
      for (const el of forced) if (!el.muted) unmutedByUser.add(el);
      if (found) {
        if (!adOn) {
          adOn = true;
          report('mediaAd', adapter.name);
        }
        for (const el of found.mute) {
          if (found.weak && found.weak.has(el) && unmutedByUser.has(el)) continue;
          if (!saved.has(el)) saved.set(el, { muted: el.muted, rate: el.playbackRate });
          el.muted = true;
          forced.add(el);
        }
        for (const el of found.fastForward || []) {
          const d = el.duration;
          const known = Number.isFinite(d) && d > 0;
          // Service adapters know the element is an ad; elsewhere only short, known-length clips are sped up.
          if (!found.anyLength && (!known || d > MAX_AD_SECONDS)) continue;
          try {
            if (!saved.has(el)) saved.set(el, { muted: el.muted, rate: el.playbackRate });
            el.playbackRate = 16;
            if (known && el.currentTime < d - 0.3) el.currentTime = d - 0.1;
          } catch (e) {
            /* not seekable */
          }
        }
        for (const b of found.skip || []) b.click();
      } else if (adOn) {
        adOn = false;
        for (const [el, st] of saved) {
          try {
            el.muted = st.muted;
            el.playbackRate = st.rate;
          } catch (e) {
            /* element gone */
          }
        }
        saved.clear();
        forced.clear();
        unmutedByUser.clear();
      }
      if (adapter.cleanup) {
        try {
          adapter.cleanup();
        } catch (e) {
          /* ignore */
        }
      }
    };
    const start = () => {
      if (!timer) timer = setInterval(tick, 300);
    };

    // Service sites are watched from the start; anywhere else only once media plays.
    if (adapter !== GENERIC) start();
    HTMLMediaElement.prototype.play = new Proxy(HTMLMediaElement.prototype.play, {
      apply(target, el, args) {
        media.add(el);
        start();
        if (adOn) {
          if (!saved.has(el)) saved.set(el, { muted: el.muted, rate: el.playbackRate });
          el.muted = true;
        }
        return apply(target, el, args);
      },
    });
    document.addEventListener('playing', (e) => {
      if (e.target instanceof HTMLMediaElement) {
        media.add(e.target);
        start();
      }
    }, true);
  }
})(__SG_FEATURES__);
