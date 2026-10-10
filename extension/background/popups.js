// Tab-level popup defence:
//  - remembers which tabs were opened by pages (window.open / target=_blank)
//  - closes such popup tabs when they land on the Stronguard blocked page
//  - reverts "tab-under" tricks: page opens a new tab and redirects itself to an ad
//  - remembers the original URL of blocked navigations for the blocked page

import { featuresFor } from '../core/levels.js';
import { registrableDomain } from '../core/domains.js';
import { BLOCKED_PAGE } from '../core/dnr.js';
import { api, getSettings, addStats, resetTabStats } from './settings.js';

const popups = new Map(); // popup tabId -> { sourceTabId, created, sourceUrl }
const BLOCKED_URL = api.runtime.getURL(BLOCKED_PAGE);

const siteOf = (url) => {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return '';
  }
};

const USER_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'reload', 'generated', 'keyword', 'keyword_generated', 'start_page', 'manual_subframe']);

async function rememberAttempt(tabId, url) {
  if (!api.storage.session || url.startsWith(BLOCKED_URL)) return;
  await api.storage.session.set({ [`attempt:${tabId}`]: url }).catch(() => {});
}

export async function blockedInfo(tabId) {
  if (!api.storage.session) return { url: '' };
  const key = `attempt:${tabId}`;
  const url = (await api.storage.session.get(key))[key] || '';
  return { url };
}

export function initPopups() {
  const nav = api.webNavigation;

  nav.onCreatedNavigationTarget.addListener(async (d) => {
    let sourceUrl = '';
    try {
      sourceUrl = (await api.tabs.get(d.sourceTabId)).url || '';
    } catch {
      /* source closed */
    }
    popups.set(d.tabId, { sourceTabId: d.sourceTabId, created: Date.now(), sourceUrl });
    setTimeout(() => popups.delete(d.tabId), 30000);
  });

  nav.onBeforeNavigate.addListener((d) => {
    if (d.frameId === 0) rememberAttempt(d.tabId, d.url);
  });

  nav.onCommitted.addListener(async (d) => {
    if (d.frameId !== 0) return;
    const settings = await getSettings();
    if (!settings.enabled) return;
    const F = featuresFor(settings.level);

    if (d.url.startsWith(BLOCKED_URL)) {
      const p = popups.get(d.tabId);
      if (p && Date.now() - p.created < 30000 && F.closeBlockedPopupTabs) {
        popups.delete(d.tabId);
        await api.tabs.remove(d.tabId).catch(() => {});
        addStats({ popupTabsClosed: 1 }, p.sourceTabId);
        return;
      }
    }
    // Keep per-tab stats scoped to the current page.
    if (d.transitionType !== 'auto_subframe' && d.transitionType !== 'manual_subframe' && !(d.transitionQualifiers || []).includes('client_redirect')) {
      resetTabStats(d.tabId);
    }

    // Tab-under: this tab opened a popup moments ago and is now being sent elsewhere.
    if (!F.tabUnderRevert) return;
    const qualifiers = d.transitionQualifiers || [];
    if (USER_TRANSITIONS.has(d.transitionType) || qualifiers.includes('forward_back') || qualifiers.includes('from_address_bar')) return;
    for (const [popupId, p] of popups) {
      if (p.sourceTabId !== d.tabId || Date.now() - p.created > 3000 || !p.sourceUrl) continue;
      const fromSite = siteOf(p.sourceUrl);
      const toSite = d.url.startsWith(BLOCKED_URL) ? '__blocked__' : siteOf(d.url);
      if (!fromSite || fromSite === toSite) continue;
      popups.delete(popupId);
      try {
        if (api.tabs.goBack) await api.tabs.goBack(d.tabId);
        else await api.tabs.update(d.tabId, { url: p.sourceUrl });
      } catch {
        await api.tabs.update(d.tabId, { url: p.sourceUrl }).catch(() => {});
      }
      addStats({ tabUnders: 1 }, d.tabId);
      break;
    }
  });

  api.tabs.onRemoved.addListener((tabId) => {
    popups.delete(tabId);
    if (api.storage.session) api.storage.session.remove([`tab:${tabId}`, `attempt:${tabId}`]).catch(() => {});
  });
}
