const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (msg) => api.runtime.sendMessage(msg);
const COLORS = ['--l1', '--l2', '--l3', '--l4', '--l5'];
let data = null;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function paintLevel(level) {
  document.documentElement.style.setProperty('--level-color', `var(${COLORS[level - 1]})`);
  $('levelName').textContent = `${level} · ${data.levels[level - 1].name}`;
  const box = $('levelTable');
  box.textContent = '';
  for (const l of data.levels) {
    const div = document.createElement('div');
    div.className = `lvl${l.level <= level ? ' on' : ''}`;
    div.style.setProperty('--c', `var(${COLORS[l.level - 1]})`);
    const b = document.createElement('b');
    b.textContent = `${l.level} · ${l.name}`;
    const ul = document.createElement('ul');
    for (const a of l.adds) {
      const li = document.createElement('li');
      li.textContent = a;
      ul.appendChild(li);
    }
    div.append(b, ul);
    box.appendChild(div);
  }
}

function renderFilterStats(s) {
  $('filterStats').textContent = s ? `${s.rules} network rules active${s.dropped ? `, ${s.dropped} over browser limit` : ''}` : '';
}

function renderExtra() {
  const ul = $('extraStatus');
  ul.textContent = '';
  for (const [url, st] of Object.entries(data.extraLists || {})) {
    const li = document.createElement('li');
    const when = st.fetchedAt ? new Date(st.fetchedAt).toLocaleString() : 'never';
    li.textContent = `${st.ok ? '✓' : '✗'} ${url} — ${st.ok ? `${Math.round(st.size / 1024)} KB, updated ${when}` : st.error || 'not fetched'}`;
    ul.appendChild(li);
  }
}

function renderLists() {
  const table = $('lists');
  table.textContent = '';
  const head = table.insertRow();
  for (const h of ['List', 'Level', 'Category', 'Status']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  for (const l of data.build.lists || []) {
    const tr = table.insertRow();
    tr.insertCell().textContent = l.title;
    tr.insertCell().textContent = `${l.level}+`;
    tr.insertCell().textContent = l.category;
    const st = tr.insertCell();
    st.textContent = l.ok ? `${l.filters.toLocaleString()} filters` : 'not available at build time';
    st.className = l.ok ? 'ok' : 'bad';
  }
}

function renderStats() {
  const t = data.stats.total || {};
  const items = [
    ['Requests blocked', t.requests],
    ['Popups blocked', (t.popup || 0) + (t.popupTabsClosed || 0)],
    ['Tab-unders reverted', t.tabUnders],
    ['Overlays removed', t.overlay],
    ['Click hijacks removed', t.clickjack],
    ['Elements hidden', (t.hidden || 0) + (t.picked || 0)],
    ['Notification prompts denied', t.notification],
    ['Leave-page traps / dialogs', (t.beforeunload || 0) + (t.dialog || 0) + (t.history || 0)],
  ];
  const box = $('stats');
  box.textContent = '';
  for (const [label, v] of items) {
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = v === undefined ? '0' : Number(v).toLocaleString();
    d.append(b, document.createTextNode(label));
    box.appendChild(d);
  }
}

function render() {
  const s = data.settings;
  $('buildLine').textContent = `Version ${api.runtime.getManifest().version} · rules built ${new Date(data.build.builtAt).toLocaleString()}`;
  $('enabled').checked = s.enabled;
  $('level').value = s.level;
  paintLevel(s.level);
  $('allowlist').value = s.allowlist.join('\n');
  $('customFilters').value = s.customFilters;
  $('extraLists').value = s.extraLists.join('\n');
  $('shieldUrl').value = s.shieldUrl;
  $('shieldSync').checked = s.shieldSync;
  $('badge').checked = s.badge;
  const warnings = Object.values(data.warnings || {});
  $('warn').hidden = !warnings.length;
  $('warn').textContent = warnings.join(' · ');
  renderFilterStats(data.userFilterStats);
  renderExtra();
  renderLists();
  renderStats();
}

async function load() {
  data = await send({ t: 'opt:get' });
  render();
  const sh = await send({ t: 'shield:status' });
  $('shieldState').textContent = sh && sh.online ? `● connected (level ${sh.level})` : '○ not running';
}

async function save(patch, message) {
  const r = await send({ t: 'opt:save', patch });
  if (r && r.error) return toast(r.error);
  data.settings = r.settings;
  data.userFilterStats = r.userFilterStats;
  renderFilterStats(r.userFilterStats);
  toast(message || 'Saved');
}

const lines = (id) => $(id).value.split('\n').map((l) => l.trim()).filter(Boolean);

$('level').addEventListener('input', (e) => paintLevel(Number(e.target.value)));
$('level').addEventListener('change', (e) => save({ level: Number(e.target.value) }, 'Level updated — reload open tabs to apply'));
$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }, e.target.checked ? 'Protection on' : 'Protection paused'));

document.querySelectorAll('[data-save]').forEach((b) =>
  b.addEventListener('click', async () => {
    const which = b.dataset.save;
    if (which === 'allowlist') await save({ allowlist: lines('allowlist') });
    if (which === 'customFilters') await save({ customFilters: $('customFilters').value }, 'Filters applied');
    if (which === 'extraLists') {
      await save({ extraLists: lines('extraLists') }, 'Lists saved and downloaded');
      data = await send({ t: 'opt:get' });
      renderExtra();
    }
    if (which === 'network') await save({ shieldUrl: $('shieldUrl').value.trim(), shieldSync: $('shieldSync').checked, badge: $('badge').checked });
  }),
);

$('updateLists').addEventListener('click', async () => {
  const r = await send({ t: 'opt:updateLists' });
  data.extraLists = r.extraLists;
  renderExtra();
  renderFilterStats(r.userFilterStats);
  toast('Lists updated');
});

$('resetStats').addEventListener('click', async () => {
  await send({ t: 'opt:resetStats' });
  data = await send({ t: 'opt:get' });
  renderStats();
  toast('Statistics reset');
});

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ stronguard: 1, settings: data.settings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'stronguard-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('import').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const s = json.settings || {};
    const patch = {};
    for (const k of ['enabled', 'level', 'allowlist', 'customFilters', 'extraLists', 'shieldUrl', 'shieldSync', 'badge']) if (k in s) patch[k] = s[k];
    await save(patch, 'Settings imported');
    await load();
  } catch {
    toast('Invalid settings file');
  }
});

load();
