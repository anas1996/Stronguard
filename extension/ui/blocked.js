const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
let url = '';

(async () => {
  const info = await api.runtime.sendMessage({ t: 'blocked:info' });
  url = (info && info.url) || '';
  $('url').textContent = url || 'Unknown address';
  if (!/^https?:/.test(url)) {
    $('once').disabled = true;
    $('always').disabled = true;
  }
})();

$('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else window.close();
});
$('close').addEventListener('click', async () => {
  const tab = await api.tabs.getCurrent();
  if (tab) api.tabs.remove(tab.id);
  else window.close();
});
$('once').addEventListener('click', () => api.runtime.sendMessage({ t: 'blocked:proceed', url, mode: 'once' }));
$('always').addEventListener('click', () => api.runtime.sendMessage({ t: 'blocked:proceed', url, mode: 'always' }));
