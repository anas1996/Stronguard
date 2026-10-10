// Stronguard protection levels.
//
// One number (1-5) drives every layer: the browser extension, the DNS sinkhole,
// the filtering proxy, the Windows firewall rules and the browser policies.
// Levels are cumulative: level N enables everything from levels 1..N.

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;
export const DEFAULT_LEVEL = 3;

export const LEVELS = [
  {
    level: 1,
    name: 'Relaxed',
    tagline: 'Classic ad and tracker blocking. Nothing should break.',
    adds: [
      'EasyList, EasyPrivacy and uBlock filter lists',
      'Element hiding and anti-adblock scriptlets',
      'YouTube ads stripped from the player (and skipped/muted if one slips through); Spotify and Twitch ads muted',
      'Popups opened without a click are blocked',
      'Known popup/malvertising networks blocked as pages, their tabs auto-closed',
      'DNS: core ad and tracker domains, CNAME-cloaked trackers unmasked',
    ],
  },
  {
    level: 2,
    name: 'Standard',
    tagline: 'Adds popup-network lists, notification spam and link tracking.',
    adds: [
      'Popup-ads lists (AdGuard Popups, HaGeZi pop-up ads)',
      'Only one popup per click',
      'Website notification prompts are silently denied',
      'Tracking parameters (utm_*, fbclid, gclid...) stripped from links',
      'Back-button hijacking blocked',
      'DNS: StevenBlack unified hosts, threat-intelligence feed',
    ],
  },
  {
    level: 3,
    name: 'Aggressive',
    tagline: 'Removes overlays, ad walls and click hijacks. Recommended.',
    adds: [
      'Annoyance lists (newsletter popups, "disable adblock" walls...)',
      'Fullscreen overlays and anti-adblock walls removed, scrolling restored',
      'Invisible click-hijacking layers over videos and pages removed',
      'Ad-server domains are blocked even when opened as a page',
      'DNS: HaGeZi Pro, Firefox/iCloud DNS-bypass canaries answered',
      'Firewall: DNS-over-TLS/QUIC (port 853) blocked; browsers forced onto system DNS',
    ],
  },
  {
    level: 4,
    name: 'Hardcore',
    tagline: 'Cookie banners, tab-unders and every trick in the book.',
    adds: [
      'Cookie-banner lists',
      'Cross-site popups only allowed from a real link or button click',
      'Tab-under redirects are reverted',
      '"Are you sure you want to leave?" traps and dialog spam blocked',
      'Ad-sized iframes and sticky ad bars hidden heuristically',
      'Tracker domains blocked as pages, third-party pings/beacons blocked',
      'DNS: HaGeZi Pro++, encrypted-DNS (DoH) bypass endpoints blocked',
      'Firewall: all DNS forced through Stronguard, public DoH resolvers blocked',
    ],
  },
  {
    level: 5,
    name: 'Nuclear',
    tagline: 'Maximum force. Expect some sites to break; allowlist them.',
    adds: [
      'All third-party iframes blocked (except common video/payment/captcha embeds)',
      'All cross-site popups blocked (except sign-in and payment providers)',
      'Any fullscreen overlay removed; "Sponsored/Advertisement" blocks hidden',
      'Social-media widget lists',
      'DNS: HaGeZi Ultimate, broader threat-intelligence feed',
    ],
  },
];

export function clampLevel(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_LEVEL;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, n));
}

export function levelInfo(level) {
  return LEVELS[clampLevel(level) - 1];
}

// Feature switches derived from the level. Every component reads its behaviour
// from here so that the slider means the same thing everywhere.
export function featuresFor(level) {
  const l = clampLevel(level);
  return {
    level: l,
    // --- browser: popups ---
    popupRequireGesture: l >= 1,
    closeBlockedPopupTabs: l >= 1,
    popupOnePerGesture: l >= 2,
    popupRequireLinkTarget: l >= 4,
    tabUnderRevert: l >= 4,
    popupBlockCrossSite: l >= 5,
    // --- browser: streaming services (YouTube, Spotify, Twitch...) ---
    mediaAdGuard: l >= 1,
    // --- browser: annoyances ---
    denyNotifications: l >= 2,
    blockHistoryHijack: l >= 2,
    overlayKiller: l >= 3,
    clickjackKiller: l >= 3,
    blockBeforeUnload: l >= 4,
    limitDialogs: l >= 4,
    adSizedFrames: l >= 4,
    stickyAdBars: l >= 4,
    overlayKillerAny: l >= 5,
    adLabelHeuristic: l >= 5,
    // --- network ---
    dnsCnameUncloak: true,
    dnsBlockBypassCanaries: l >= 3,
    dnsBlockDoH: l >= 4,
    dnsIncludeThirdPartyRules: l >= 5,
    firewallBlockDoT: l >= 3,
    firewallForceDns: l >= 4,
    firewallBlockDoHIPs: l >= 4,
  };
}
