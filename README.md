# Stronguard

**A multi-layer, aggressive ad and popup blocker for Windows, Chrome, Edge and Firefox. One 1–5 slider drives every layer.**

Stronguard blocks ads, popups and trackers in several independent layers. Each layer catches what the others can't:

```
                         ┌──────────────────────────────────────────────────────┐
  Browser extension      │ network rules (EasyList, uBlock, AdGuard lists)      │  in-page: popups, overlays,
  (Chrome/Edge/Firefox)  │ element hiding · scriptlets · popup guard · heuristics│  ads served by the site itself
                         ├──────────────────────────────────────────────────────┤
  Browser policies       │ native popup + intrusive-ad blocking, notifications  │  the browsers' own defences,
                         │ off, tracking prevention, built-in DoH off           │  locked on
                         ├──────────────────────────────────────────────────────┤
  Filtering proxy (PAC)  │ hostname filtering for HTTP + HTTPS (CONNECT)         │  catches browsers that bypass DNS
                         ├──────────────────────────────────────────────────────┤
  DNS sinkhole           │ ~0.5–1 million blocked domains, CNAME uncloaking,     │  every app and device,
                         │ DoH upstream, cache, LAN forwarding                   │  not just the browser
                         ├──────────────────────────────────────────────────────┤
  Windows Firewall       │ blocks DNS-over-TLS, plain DNS to other servers and   │  stops apps from going
                         │ hard-coded DNS-over-HTTPS resolvers                   │  around the sinkhole
                         ├──────────────────────────────────────────────────────┤
  Hosts file (optional)  │ capped fallback list                                  │  works even if the service stops
                         └──────────────────────────────────────────────────────┘
```

The browser extension works on its own. The network layers protect the whole PC, and optionally your whole home network. With the network shield installed, moving the level slider in the extension, the dashboard or the CLI updates every layer.

## YouTube, Spotify and other services

Big services serve ads from their own servers, mixed in with the content, so blocking ad domains isn't enough. Stronguard handles them in the browser and, for Spotify, on the Windows desktop:

| Service | In the browser (extension) | Desktop app / TV / phone (network layers) |
|---|---|---|
| **YouTube** (incl. Music, Kids, Shorts) | Ad slots are stripped from the player's data before it starts, using uBlock Origin's maintained rules, so fixes arrive with every list update. If an ad still starts, Stronguard mutes it, fast-forwards it to the end and presses Skip, then restores your volume and speed. Feed, search and banner ads are hidden, and the "ad blockers are not allowed" wall is removed. | Not possible. YouTube's apps get ads from the same servers as the videos, so no DNS blocker can remove them without blocking YouTube. |
| **Spotify** | Web player (open.spotify.com): audio ads are muted and sound returns when the music does. Banners are hidden. | **Desktop app on Windows**: a small helper mutes only Spotify in the volume mixer while an ad plays (installed by default). Ad trackers are blocked by DNS. Mobile app audio ads can't be removed by the network. |
| **Twitch** | Ads are muted while they play; ad trackers are blocked. | Ad trackers blocked. |
| **Facebook, Instagram, X, Reddit, LinkedIn** | Sponsored posts hidden by the AdGuard and uBlock lists. | Trackers blocked. |
| **Google Search, Amazon, news sites…** | Covered by the regular lists, cosmetic filtering and scriptlets. | Ad servers blocked. |

**Spotify on Windows, how it works:** while music plays, Spotify's window title is "Artist - Song". During an ad it changes to "Advertisement", "Spotify" or the advertiser's name. The helper watches the title and toggles mute for Spotify's audio session only, the same technique as the long-standing EZBlocker. Spotify itself is never modified.

For the best results with Spotify, use the web player at open.spotify.com with the extension, or the desktop app with the network shield installed.

## Video and audio ads on every other site

News sites, sports and TV streaming, video hosts, podcast and radio players: most of them load their ads the same few ways. Stronguard goes after each of them, starting at level 1:

| Where the ad comes from | What Stronguard does |
|---|---|
| **Google's IMA ad SDK** (used by many video players: Video.js, JW Player, Brightcove, Bitmovin, Kaltura, custom ones) | The SDK is swapped for a built-in stand-in. The player asks it for ads, gets "no ad available" and starts the video straight away. This works even on sites that need the SDK to exist and break if it is merely blocked. |
| **VAST / VMAP ad requests** (the standard ad-tag format: Google Ad Manager, FreeWheel, SpotX…) | Answered with an empty ad response, so the player moves on as if no ad was booked. |
| **Ad servers and video-ad trackers** | Blocked by the filter lists and, with the network shield, by DNS for every app. |
| **An ad that still plays** in any `<video>` or `<audio>` player | Detected from the player's own ad mode (Video.js, JW Player, IMA ad containers) or an on-screen "Ad · 0:15" / "Advertisement" label. A short ad is muted, fast-forwarded to the end and its Skip button pressed. If the only clue is a label, or the clip is longer than 3 minutes, it is only muted, so real content is never skipped. Your volume and speed come back when the ad ends. |
| **Ads stitched into the stream** (server-side insertion in HLS `.m3u8` playlists) | From level 3, for on-demand videos, the segments between the stream's ad markers (`#EXT-X-CUE-OUT` … `#EXT-X-CUE-IN`) are cut out of the playlist before the player sees it. HLS interstitial ads are dropped from live and on-demand streams alike. |

The popup counts these as "video & audio ads skipped or muted".

**Limits.** Ads stitched into a *live* stream are inseparable from the broadcast: they are muted when the player shows they are ads, not removed. Streams the browser plays with its built-in HLS support, or whose playlists are fetched from a worker (Twitch), can't be rewritten, so their ads are muted instead. DASH (`.mpd`) streams aren't rewritten yet. As everywhere, a site can still change how its player works faster than any list updates.

## Protection levels

| Level | Name | What it adds |
|---|---|---|
| 1 | **Relaxed** | EasyList, EasyPrivacy, uBlock lists · element hiding + anti-adblock scriptlets · YouTube ad stripping/skipping, Spotify & Twitch ad muting · video ads on any site: IMA SDK stand-in, empty VAST/VMAP answers, ads in any player muted and skipped · popups without a click blocked · known popup/malvertising networks blocked as pages and their tabs auto-closed · DNS core lists + CNAME uncloaking · browser popup/intrusive-ad policies |
| 2 | **Standard** | Popup-ad lists (AdGuard Popups, HaGeZi pop-up ads) · one popup per click · notification prompts denied · tracking parameters (`utm_*`, `fbclid`, `gclid`…) stripped · back-button hijacking blocked · DNS: StevenBlack + threat intelligence |
| 3 | **Aggressive** *(default)* | Annoyance lists · fullscreen overlays and "disable your adblocker" walls removed, scrolling restored · invisible click-hijacking layers removed · ad breaks cut from on-demand HLS streams · ad-server domains blocked even as pages · DNS: HaGeZi Pro, Firefox/iCloud bypass canaries · firewall blocks DNS-over-TLS · browsers forced onto system DNS |
| 4 | **Hardcore** | Cookie-banner lists · cross-site popups only from a real link/button · tab-unders reverted · "leave site?" traps and dialog loops blocked · ad-sized iframes and sticky ad bars hidden · tracker domains blocked as pages, third-party beacons blocked · DNS: HaGeZi Pro++, DoH bypass endpoints · firewall forces all DNS through Stronguard and blocks public DoH resolvers · notifications blocked by policy |
| 5 | **Nuclear** | All third-party iframes blocked (video, payment, captcha and sign-in embeds excepted) · all cross-site popups blocked (sign-in/payment providers excepted) · any fullscreen overlay removed · "Sponsored/Advertisement" blocks hidden · social widgets · DNS: HaGeZi Ultimate + broader threat feed |

Higher levels *will* break some sites. Use the per-site switch in the extension popup, or Allow in the dashboard, rather than lowering the level for everything.

---

## Install on Windows

You need **Windows 10/11**, **[Node.js 20+](https://nodejs.org)** and **Git** (or download the ZIP).

```powershell
# 1. Put Stronguard somewhere permanent (the service runs from this folder)
git clone https://github.com/anas1996/stronguard C:\Stronguard
cd C:\Stronguard

# 2. Build the browser extension (downloads ~30 MB of filter lists)
npm run build

# 3. Install the network shield: run PowerShell **as Administrator**
powershell -ExecutionPolicy Bypass -File windows\install.ps1
```

The installer asks for nothing. It prints what it does and opens the dashboard at **http://127.0.0.1:8080** when done.

| Installer option | Effect |
|---|---|
| `-Level 1..5` | Starting level (default 3) |
| `-WindowsAds` | Also turn off Windows' own ads: Start/lock-screen suggestions, advertising ID, Explorer promos, consumer "experiences" |
| `-Hosts` | Also write a capped hosts-file fallback (20k highest-priority domains; Windows slows down with bigger hosts files) |
| `-ServeLan` | Let phones, TVs and other devices use this PC as their DNS (see below) |
| `-NoSpotifyMuter` | Don't install the Spotify desktop ad muter |
| `-NoDns` / `-NoFirewall` / `-NoBrowserPolicies` / `-NoProxy` | Skip a layer |

Run the installer again at any time to change options. **To remove everything** and restore your previous DNS, firewall, policy, proxy and hosts settings:

```powershell
powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1
```

### Load the browser extension

The build writes `dist\chrome` (Chrome, Edge, Brave, Opera, Vivaldi) and `dist\firefox`.

- **Chrome / Edge / Brave**: open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and select `C:\Stronguard\dist\chrome`. Pin the shield icon.
- **Firefox (128+)**: release Firefox only installs signed extensions permanently.
  - *Quick try*: `about:debugging` → This Firefox → **Load Temporary Add-on** → select `dist\firefox\manifest.json` (stays until Firefox restarts).
  - *Permanent*: sign it for free as an unlisted add-on with [`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign) using your AMO API key, then install the `.xpi`. Firefox Developer Edition and Nightly can also run it unsigned with `xpinstall.signatures.required = false`.

`npm run package` also produces zip files in `dist\`.

### Protect the whole home network

Install with `-ServeLan`, then set your **router's DHCP DNS server** to this PC's IP address. Phones, TVs and consoles are then filtered by the DNS layer, but only while this PC is on. Leave the router's secondary DNS empty, otherwise devices will fall back to it.

---

## Everyday use

**Extension popup**: an on/off switch for the current site, the level slider, a per-page count of blocked requests, popups and removed elements, network-shield status, and **Pick element to hide** (also <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> or the right-click menu).

**Extension settings**: allowlist, your own filters (Adblock Plus / uBlock syntax), extra list URLs (updated daily), the built-in list inventory, network-shield sync, statistics, and import/export.

**Dashboard** (`http://127.0.0.1:8080`): the level slider, pause for 5 minutes or 1 hour, live query log with one-click Allow/Block, a domain checker, top blocked domains and clients, a 24-hour chart, and list status with an "Update now" button.

**CLI** (`windows\stronguard.cmd`, or `node network\bin\stronguard.js` anywhere):

```text
stronguard status                 show the running service
stronguard level [1-5]            show or set the level (all layers follow)
stronguard check ads.example.com  is it blocked, and by which list?
stronguard allow | block <domain> your own overrides (unallow / unblock to undo)
stronguard update                 refresh filter lists now
stronguard firewall | policies | hosts | pac   print what Stronguard generates
```

---

## How each layer works

### Browser extension (Manifest V3, Chrome 121+ / Firefox 128+)

- **Network rules**: filter lists are compiled at build time into `declarativeNetRequest` rulesets, one set per level, switched on and off by the slider. Hostname rules are merged into large `requestDomains` rules, so about 263k domains fit in about 28k rules, under Chrome's guaranteed 30k. Supported: `$third-party`, `$domain`, `$to`, `$denyallow`, `$method`, `$important`, `$redirect` (to bundled neutered resources such as GPT/adsbygoogle/GA stubs and empty VAST), `$removeparam`, `$csp`, `$popup`, `$document`, `$badfilter`, `$generichide` and more.
- **Top-level blocking**: known popup and malvertising domains (all ad domains from level 3, trackers from level 4) redirect to a Stronguard *blocked* page. If such a page opened as a popup, the tab is closed automatically. The page offers "Allow once" and "Always allow".
- **Cosmetic filtering**: generic rules are matched against the class and id names present in the DOM, so only relevant CSS is injected. Site-specific rules are loaded from a sharded database. CSS is injected with *user* origin, so pages can't override it. Procedural filters (`:has-text`, `:upward`, `:xpath`, `:matches-css`, `:remove()`, `:style()`…) run in the page.
- **Scriptlets**: 42 anti-adblock, anti-popup and response-rewriting scriptlets (`set`, `aopr`, `acs`, `nowoif`, `json-prune`, `json-prune-fetch-response`, `trusted-replace-xhr-response`, `hls-prune`, `no-fetch-if`, cookie-banner `click-element`, etc.), compiled per site and level and registered only on the sites that need them.
- **Popup guard** (runs before any page script): blocks `window.open` without a user gesture; allows one popup per click; requires a real link or button for cross-site popups (level 4) or blocks them all except sign-in and payment providers (level 5). It also covers synthetic link clicks and fresh iframe windows, denies notification permission prompts, and blocks back-button hijacks, `beforeunload` traps and dialog loops.
- **Tab-under reversal**: if a page opens a new tab and immediately sends the original tab to another site, the original tab is sent back.
- **Media ad guard**: watches every `<video>` and `<audio>` element. On YouTube, the Spotify web player and Twitch it uses each service's own ad markers; on any other site it recognises a player in ad mode or an on-screen ad label. It mutes the ad, fast-forwards and skips it when that is safe, then restores your settings. Google's IMA ad SDK is replaced by a stand-in that reports "no ad", and `hls-prune` cuts ad breaks out of on-demand HLS playlists (level 3).
- **Heuristics** (skipped on large first-party apps such as YouTube, Google and social networks): removes overlay and ad-block walls and restores scrolling. Intercepts and removes invisible click-hijacking layers. Hides ad-sized cross-site iframes and sticky ad bars, and at level 5 "Sponsored"/"Advertisement" blocks.
- **Your filters, extra lists and the element picker** compile at runtime into dynamic rules, using the same engine.

### DNS sinkhole

- Answers blocked names with `0.0.0.0` / `::`, plus an RFC 8914 *Extended DNS Error* naming the list; the response type is configurable (`null`, `nxdomain`, `refused`). Parent-domain rules block all subdomains.
- **CNAME uncloaking**: a first-party name that aliases a tracker (`metrics.news.com → x.tracker.net`) is blocked as well.
- **Anti-bypass**: answers the Firefox (`use-application-dns.net`) and iCloud Private Relay canaries with NXDOMAIN, and blocks public DoH endpoints by name from level 4.
- **Private upstream**: forwards to Quad9 and Cloudflare over **DNS-over-HTTPS** (HTTP/2, IP-literal so no bootstrap is needed), with failover and caching. LAN names (`*.lan`, `*.home.arpa`, private reverse lookups) go to your router and never leave the network.
- Never blocks OS connectivity checks (Windows NCSI, captive-portal probes).
- Lists are refreshed every 24 h with mirrors and conditional requests. Level 5 holds about 930k domains in about 200 MB.

### Filtering proxy + PAC

`http://127.0.0.1:8118/proxy.pac` sends web traffic through a local proxy that refuses blocked hostnames for HTTP and HTTPS (CONNECT). This also catches browsers that use their own encrypted DNS. HTTPS is **not decrypted**: no certificate is installed and banking apps keep working. The PAC falls back to `DIRECT` if the service stops.

### Windows Firewall (group "Stronguard")

- **Level 3**: blocks DNS-over-TLS/QUIC (port 853).
- **Level 4**: blocks plain DNS to anything except Stronguard and its own upstreams or router, and blocks 76 public DoH resolver addresses and ranges. Stronguard's own DoH upstreams stay reachable.
- If you use a corporate VPN, add its DNS servers to `firewall.allowDnsServers` in `%ProgramData%\Stronguard\config.json`.

### Browser and Windows policies

Writes registry policies for Chrome, Edge, Brave and Firefox: native popup blocker locked on, intrusive-ads blocking, Privacy Sandbox ad APIs off, Edge shopping/promotions off and Strict tracking prevention, Firefox Enhanced Tracking Protection and no sponsored tiles. Built-in DoH is turned off from level 3, and notifications are blocked from level 4. Every previous value is backed up and restored on uninstall or when you lower the level. Browsers will show "managed by your organization"; that is these policies.

---

## Good to know

- **Your browser extension and the DNS shield are complementary.** DNS can't block ads served from the site's own domain, such as YouTube or Facebook feed ads, or remove empty boxes and popups. The extension can't protect other apps or devices.
- **YouTube is an arms race.** Stronguard runs uBlock Origin's maintained YouTube rules and has its own skip-and-mute fallback, but YouTube changes often. Rebuild the extension (`npm run build`) to pick up the latest rules. Ads in YouTube's TV and phone apps can't be blocked by any network filter.
- **If the service stops, DNS stops.** That is the price of not letting traffic bypass it. The scheduled task restarts it within a minute. If you ever need to, run `windows\uninstall.ps1`, or set your adapter's DNS back to automatic.
- **Port 53 in use?** Internet Connection Sharing or Hyper-V can hold it. The installer reports which process owns it.
- **Filter list licences**: lists are downloaded from their authors at build or run time (EasyList, uBlock Origin, AdGuard, HaGeZi, StevenBlack, OISD, Peter Lowe), mostly under GPLv3 or CC BY-SA. Keep that in mind if you redistribute a built extension.

---

## Development

```bash
npm test               # unit + network tests (parser, compilers, DNS server, proxy, dashboard, Windows generators)
npm run build          # build dist/chrome and dist/firefox   (--offline: cached lists only, --refresh: re-download)
npm run test:e2e       # loads dist/chrome into Chromium via Playwright and checks every protection
npm start              # run the network shield in the foreground (use: init --dns-port 5353 for an unprivileged port)
```

No runtime dependencies: everything is plain Node.js and browser JavaScript. The same filter engine (`core/`) runs in the build, in the extension's service worker and in the network service.

```
core/                 shared filter engine: parser, domain matcher, DNR + cosmetic + procedural compilers, levels, list catalog
extension/            MV3 extension source: background/, content/ (guard, isolated, picker), scriptlets/, ui/, resources/
filters/              Stronguard's own lists (always available offline)
network/              network shield: dns/, proxy/, dashboard/, windows/ generators, engine, CLI (bin/stronguard.js)
windows/              install.ps1, uninstall.ps1, spotify-muter.ps1, stronguard.cmd
scripts/build.js      extension build (lists → rulesets, cosmetic shards, scriptlet bundles, icons, manifests, zips)
test/                 node:test suites + e2e/extension.e2e.js
```

CI runs the tests, builds and end-to-end-tests the extension on Linux, and performs a real **install → verify → level change → uninstall** cycle on a Windows runner.
