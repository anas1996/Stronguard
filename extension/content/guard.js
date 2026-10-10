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
  // Streaming services: when an ad still plays (lists missed it), mute it and,
  // where the service allows, fast-forward / skip it. State is restored after.

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

  const SERVICES = [
    {
      name: 'youtube',
      domains: ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com'],
      adActive: () => anyMatch(['.html5-video-player.ad-showing', '.html5-video-player.ad-interrupting']),
      // The ad plays in the same <video> as the content: seek it to the end.
      fastForward: (el) => !!(el.closest && el.closest('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting')),
      skip: ['.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-slot button', '.ytp-ad-overlay-close-button'],
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
      adActive() {
        const title = (document.title || '').trim();
        // Tracks are titled "Song • Artist"; ads are titled "Advertisement" or the advertiser.
        if (/^(spotify\s*[-–—]\s*)?advertisement$/i.test(title)) return true;
        if (anyMatch(['[data-testid="context-item-info-ad-subtitle"]', '[data-testid="ad-type-label"]', '[data-testid="now-playing-widget"] a[href*="/ad/"]'])) return true;
        const widget = document.querySelector('[data-testid="now-playing-widget"]');
        const label = widget ? `${widget.getAttribute('aria-label') || ''}` : '';
        return /\badvertisement\b/i.test(label);
      },
    },
    {
      name: 'twitch',
      domains: ['twitch.tv'],
      adActive: () => anyMatch(['[data-a-target="video-ad-label"]', '[data-a-target="video-ad-countdown"]', '[data-test-selector="ad-banner-default-text"]']),
    },
  ];

  const service = F.mediaAdGuard ? SERVICES.find((s) => onHost(s.domains)) : null;
  if (service) {
    const media = new Set();
    const saved = new Map(); // element -> state before we touched it
    let adOn = false;
    const mute = (el) => {
      if (!saved.has(el)) saved.set(el, { muted: el.muted, rate: el.playbackRate });
      el.muted = true;
    };
    // Media elements created by script and never attached to the DOM (Spotify) are caught on play().
    HTMLMediaElement.prototype.play = new Proxy(HTMLMediaElement.prototype.play, {
      apply(target, el, args) {
        media.add(el);
        if (adOn) mute(el);
        return apply(target, el, args);
      },
    });
    const tick = () => {
      for (const el of document.querySelectorAll('video, audio')) media.add(el);
      let active = false;
      try {
        active = service.adActive();
      } catch (e) {
        active = false;
      }
      if (active) {
        if (!adOn) {
          adOn = true;
          report('mediaAd', service.name);
        }
        for (const el of media) {
          mute(el);
          if (service.fastForward && service.fastForward(el)) {
            try {
              el.playbackRate = 16;
              if (Number.isFinite(el.duration) && el.duration > 0 && el.currentTime < el.duration - 0.3) el.currentTime = el.duration - 0.1;
            } catch (e) {
              /* not seekable */
            }
          }
        }
        for (const sel of service.skip || []) for (const b of document.querySelectorAll(sel)) b.click();
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
      }
      if (service.cleanup) {
        try {
          service.cleanup();
        } catch (e) {
          /* ignore */
        }
      }
    };
    setInterval(tick, 250);
  }
})(__SG_FEATURES__);
