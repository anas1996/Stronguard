// Filter list catalog shared by the extension build and the network service.
//
// level      - lowest protection level at which the list is active
// targets    - 'extension' (browser rules) and/or 'dns' (network sinkhole)
// category   - drives extra behaviour: hostnames from 'popups'/'malware' lists are
//              also blocked as top-level pages from the list's level, 'ads' from
//              level 3 and 'privacy' from level 4
// supersedes - lists made redundant when this one is active (avoids double downloads)
// urls       - tried in order; mirrors keep updates working when a CDN is down

const UBO = (f) => [
  `https://ublockorigin.github.io/uAssets/filters/${f}.txt`,
  `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/${f}.txt`,
  `https://ublockorigin.pages.dev/filters/${f}.txt`,
];
const ADG = (n) => [
  `https://filters.adtidy.org/extension/ublock/filters/${n}.txt`,
  `https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/platforms/extension/ublock/filters/${n}.txt`,
];
const HAGEZI = (f) => [
  `https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/${f}.txt`,
  `https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/${f}.txt`,
  `https://gitlab.com/hagezi/mirror/-/raw/main/dns-blocklists/adblock/${f}.txt`,
];

export const CATALOG = [
  // ---- Stronguard's own lists (shipped in /filters, always available offline) ----
  { id: 'stronguard-ads', title: 'Stronguard Ads', level: 1, category: 'ads', targets: ['extension', 'dns'], builtin: 'filters/stronguard-ads.txt' },
  { id: 'stronguard-popups', title: 'Stronguard Popups', level: 1, category: 'popups', targets: ['extension', 'dns'], builtin: 'filters/stronguard-popups.txt' },
  { id: 'stronguard-privacy', title: 'Stronguard Privacy', level: 2, category: 'privacy', targets: ['extension'], builtin: 'filters/stronguard-privacy.txt' },
  { id: 'stronguard-annoyances', title: 'Stronguard Annoyances', level: 3, category: 'annoyances', targets: ['extension'], builtin: 'filters/stronguard-annoyances.txt' },

  // ---- Browser lists ----
  { id: 'easylist', title: 'EasyList', level: 1, category: 'ads', targets: ['extension'],
    urls: ['https://easylist.to/easylist/easylist.txt', 'https://raw.githubusercontent.com/easylist/easylist/gh-pages/easylist.txt', 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/thirdparties/easylist/easylist.txt'] },
  { id: 'easyprivacy', title: 'EasyPrivacy', level: 1, category: 'privacy', targets: ['extension'],
    urls: ['https://easylist.to/easylist/easyprivacy.txt', 'https://raw.githubusercontent.com/easylist/easylist/gh-pages/easyprivacy.txt', 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/thirdparties/easylist/easyprivacy.txt'] },
  { id: 'ubo-filters', title: 'uBlock filters', level: 1, category: 'ads', targets: ['extension'], urls: UBO('filters') },
  { id: 'ubo-badware', title: 'uBlock filters - Badware risks', level: 1, category: 'malware', targets: ['extension', 'dns'], urls: UBO('badware') },
  { id: 'ubo-quick-fixes', title: 'uBlock filters - Quick fixes', level: 1, category: 'ads', targets: ['extension'], urls: UBO('quick-fixes') },
  { id: 'ubo-unbreak', title: 'uBlock filters - Unbreak', level: 1, category: 'unbreak', targets: ['extension'], urls: UBO('unbreak') },
  { id: 'ubo-privacy', title: 'uBlock filters - Privacy', level: 2, category: 'privacy', targets: ['extension'], urls: UBO('privacy') },
  { id: 'adguard-popups', title: 'AdGuard Popups', level: 2, category: 'popups', targets: ['extension'], urls: ADG(19) },
  { id: 'adguard-url-tracking', title: 'AdGuard URL Tracking Protection', level: 2, category: 'privacy', targets: ['extension'], urls: ADG(17) },
  { id: 'ubo-annoyances', title: 'uBlock filters - Other annoyances', level: 3, category: 'annoyances', targets: ['extension'], urls: UBO('annoyances-others') },
  { id: 'adguard-annoyances', title: 'AdGuard Other Annoyances', level: 3, category: 'annoyances', targets: ['extension'], urls: ADG(21) },
  { id: 'ubo-cookies', title: 'uBlock filters - Cookie notices', level: 4, category: 'cookies', targets: ['extension'], urls: UBO('annoyances-cookies') },
  { id: 'adguard-cookies', title: 'AdGuard Cookie Notices', level: 4, category: 'cookies', targets: ['extension'], urls: ADG(18) },
  { id: 'adguard-mobile', title: 'AdGuard Mobile Ads', level: 4, category: 'ads', targets: ['extension'], urls: ADG(11) },
  { id: 'adguard-social', title: 'AdGuard Social Media', level: 5, category: 'social', targets: ['extension'], urls: ADG(4) },
  { id: 'adguard-widgets', title: 'AdGuard Widgets', level: 5, category: 'social', targets: ['extension'], urls: ADG(22) },

  // ---- Lists used by both layers ----
  { id: 'hagezi-popupads', title: 'HaGeZi Pop-Up Ads', level: 2, category: 'popups', targets: ['extension', 'dns'], urls: HAGEZI('popupads') },

  // ---- DNS lists ----
  { id: 'adguard-dns', title: 'AdGuard DNS filter', level: 1, category: 'ads', targets: ['dns'],
    urls: ['https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', 'https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/gh-pages/Filters/filter.txt'] },
  { id: 'peter-lowe', title: "Peter Lowe's Ad and tracking server list", level: 1, category: 'ads', targets: ['dns'],
    urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext'] },
  { id: 'stevenblack', title: 'StevenBlack Unified hosts', level: 2, category: 'ads', targets: ['dns'],
    urls: ['https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts'] },
  { id: 'hagezi-tif-mini', title: 'HaGeZi Threat Intelligence (mini)', level: 2, category: 'malware', targets: ['dns'], urls: HAGEZI('tif.mini') },
  { id: 'hagezi-pro', title: 'HaGeZi Multi PRO', level: 3, category: 'ads', targets: ['dns'], urls: HAGEZI('pro') },
  { id: 'oisd-big', title: 'OISD Big', level: 3, category: 'ads', targets: ['dns'], urls: ['https://big.oisd.nl/'] },
  { id: 'hagezi-pro-plus', title: 'HaGeZi Multi PRO++', level: 4, category: 'ads', targets: ['dns'], urls: HAGEZI('pro.plus'), supersedes: ['hagezi-pro'] },
  { id: 'hagezi-doh', title: 'HaGeZi Encrypted DNS/VPN/Proxy bypass', level: 4, category: 'bypass', targets: ['dns'], urls: HAGEZI('doh') },
  { id: 'hagezi-ultimate', title: 'HaGeZi Multi ULTIMATE', level: 5, category: 'ads', targets: ['dns'], urls: HAGEZI('ultimate'), supersedes: ['hagezi-pro', 'hagezi-pro-plus'] },
  { id: 'hagezi-tif-medium', title: 'HaGeZi Threat Intelligence (medium)', level: 5, category: 'malware', targets: ['dns'], urls: HAGEZI('tif.medium'), supersedes: ['hagezi-tif-mini'] },
];

// Level from which a list's plain hostname blocks also apply to top-level pages.
export function documentLevelFor(entry) {
  switch (entry.category) {
    case 'popups':
    case 'malware':
      return entry.level;
    case 'ads':
      return Math.max(entry.level, 3);
    case 'privacy':
      return Math.max(entry.level, 4);
    default:
      return null;
  }
}

// Lists active for a target at a given level, after removing superseded ones.
export function listsFor(target, level, catalog = CATALOG) {
  const active = catalog.filter((l) => l.targets.includes(target) && l.level <= level);
  const superseded = new Set(active.flatMap((l) => l.supersedes || []));
  return active.filter((l) => !superseded.has(l.id));
}

export function catalogEntry(id, catalog = CATALOG) {
  return catalog.find((l) => l.id === id);
}
