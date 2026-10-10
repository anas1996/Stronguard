const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const COLORS = ['--l1', '--l2', '--l3', '--l4', '--l5'];

const send = (msg) => api.runtime.sendMessage(msg);
let tab = null;
let state = null;
let initialLevel = null;

function paintLevel(level) {
  const info = state.levels[level - 1];
  document.documentElement.style.setProperty('--level-color', `var(${COLORS[level - 1]})`);
  $('levelName').textContent = `${level} · ${info.name}`;
  $('tagline').textContent = info.tagline;
  const ul = $('adds');
  ul.textContent = '';
  for (const l of state.levels.slice(0, level).reverse()) {
    for (const item of l.adds) {
      const li = document.createElement('li');
      li.textContent = item;
      if (l.level !== level) li.className = 'inherited';
      ul.appendChild(li);
    }
  }
}

const sum = (o, keys) => keys.reduce((a, k) => a + (o[k] || 0), 0);
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));

function render() {
  document.body.classList.toggle('paused', !state.enabled);
  $('power').checked = state.enabled;
  $('logo').src = `../icons/${state.enabled ? 'on' : 'off'}-32.png`;
  $('host').textContent = state.hostname || 'Not a web page';
  $('siteToggle').checked = !state.siteAllowed;
  $('siteToggle').disabled = !state.hostname || !state.enabled;
  $('level').value = state.level;
  paintLevel(state.level);

  const tabStats = state.stats.tab || {};
  const total = state.stats.total || {};
  $('sReq').textContent = state.matched === null ? '–' : fmt(state.matched);
  $('sPop').textContent = fmt(sum(tabStats, ['popup', 'popupTabsClosed', 'tabUnders']));
  $('sHid').textContent = fmt(sum(tabStats, ['overlay', 'clickjack', 'hidden', 'picked']));
  $('sMedia').textContent = fmt(sum(tabStats, ['mediaAd']));
  const totalPop = sum(total, ['popup', 'popupTabsClosed', 'tabUnders']);
  const totalRemoved = sum(total, ['overlay', 'clickjack', 'hidden', 'picked']);
  const extra = sum(total, ['notification', 'dialog', 'beforeunload', 'history']);
  $('totals').textContent =
    `All time: ${total.requests ? `${fmt(total.requests)} requests, ` : ''}${fmt(totalPop)} popups, ${fmt(total.mediaAd || 0)} video/audio ads, ${fmt(totalRemoved)} elements, ${fmt(extra)} nags blocked`;

  const warnings = Object.values(state.warnings || {});
  $('warn').hidden = !warnings.length;
  $('warn').textContent = warnings.join(' · ');
}

async function refresh() {
  state = await send({ t: 'ui:state', tabId: tab ? tab.id : -1, url: tab ? tab.url : '' });
  if (initialLevel === null) initialLevel = state.level;
  render();
}

async function shield() {
  const s = await send({ t: 'shield:status' });
  const el = $('shield');
  if (s && s.online) {
    el.classList.add('online');
    const blocked = s.stats ? `${fmt(s.stats.blocked || 0)} of ${fmt(s.stats.queries || 0)} DNS queries blocked` : '';
    $('shieldText').textContent = `Network shield active · level ${s.level}${blocked ? ` · ${blocked}` : ''}`;
  } else {
    el.classList.remove('online');
    $('shieldText').textContent = 'Network shield (DNS/proxy) not detected on this PC';
  }
}

$('level').addEventListener('input', (e) => paintLevel(Number(e.target.value)));
$('level').addEventListener('change', async (e) => {
  await send({ t: 'ui:setLevel', level: Number(e.target.value) });
  await refresh();
  $('reload').hidden = state.level === initialLevel || !tab;
});
$('power').addEventListener('change', async (e) => {
  await send({ t: 'ui:setEnabled', enabled: e.target.checked });
  await refresh();
  $('reload').hidden = !tab;
});
$('siteToggle').addEventListener('change', async (e) => {
  await send({ t: 'ui:toggleSite', hostname: state.hostname, allowed: !e.target.checked });
  if (tab) api.tabs.reload(tab.id);
  window.close();
});
$('reload').addEventListener('click', () => {
  if (tab) api.tabs.reload(tab.id);
  window.close();
});
$('pick').addEventListener('click', async () => {
  if (!tab) return;
  await send({ t: 'ui:pick', tabId: tab.id });
  window.close();
});
$('options').addEventListener('click', () => {
  api.runtime.openOptionsPage();
  window.close();
});

(async () => {
  [tab] = await api.tabs.query({ active: true, currentWindow: true });
  await refresh();
  shield();
})();
