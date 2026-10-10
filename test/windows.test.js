import { test } from 'node:test';
import assert from 'node:assert/strict';

import { complementRanges, firewallScript, serviceAddresses } from '../network/windows/firewall.js';
import { policyEntries, policiesScript } from '../network/windows/policies.js';
import { mergeHosts, stripBlock, BEGIN, END } from '../network/windows/hosts.js';
import { pacScript } from '../network/proxy/server.js';
import { normalizeConfig } from '../network/config.js';

test('complement ranges exclude loopback and the given addresses', () => {
  assert.deepEqual(complementRanges([], 4), ['0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255']);
  assert.deepEqual(complementRanges(['192.168.1.1'], 4), [
    '0.0.0.0-126.255.255.255', '128.0.0.0-192.168.1.0', '192.168.1.2-255.255.255.255',
  ]);
  assert.deepEqual(complementRanges([], 6), ['0:0:0:0:0:0:0:2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']);
  assert.ok(complementRanges(['10.0.0.1', '10.0.0.3'], 4).includes('10.0.0.2'), 'single-address gaps are emitted as plain addresses');
});

test('firewall rules follow the level and spare Stronguard upstreams', () => {
  const config = normalizeConfig({ dns: { localForward: { upstream: 'udp://192.168.1.1:53' } } });
  assert.deepEqual(serviceAddresses(config).doh.sort(), ['1.1.1.1', '149.112.112.112', '9.9.9.9']);
  assert.deepEqual(serviceAddresses(config).plain, ['192.168.1.1']);

  const l2 = firewallScript(config, 2);
  assert.ok(!l2.includes('New-NetFirewallRule'));
  const l3 = firewallScript(config, 3);
  assert.ok(l3.includes('RemotePort 853'));
  assert.ok(!l3.includes('RemotePort 53 '));
  const l4 = firewallScript(config, 4, { serveLan: true });
  assert.ok(l4.includes('RemotePort 53 -RemoteAddress $dnsTargets'));
  assert.ok(l4.includes("'128.0.0.0-192.168.1.0','192.168.1.2-255.255.255.255'"), 'router must be exempt from the DNS lockdown');
  const doh = /\$dohTargets = @\(([^)]*)\)/.exec(l4)[1];
  assert.ok(doh.includes("'8.8.8.8'"));
  assert.ok(!doh.includes("'9.9.9.9'") && !doh.includes("'1.1.1.1'"), 'own DoH upstreams must stay reachable');
  assert.ok(l4.includes('-Direction Inbound -Action Allow'));
  assert.ok(firewallScript(config, 4, { remove: true }).includes('Remove-NetFirewallRule'));
});

test('policies scale with the level and split machine/user scope', () => {
  const l1 = policyEntries(1);
  assert.ok(l1.some((e) => e.name === 'DefaultPopupsSetting' && e.value === 2));
  assert.ok(!l1.some((e) => e.name === 'DnsOverHttpsMode'));
  const l3 = policyEntries(3);
  assert.ok(l3.some((e) => e.name === 'DnsOverHttpsMode' && e.value === 'off'));
  assert.ok(!policyEntries(3, { dns: false }).some((e) => e.name === 'DnsOverHttpsMode'));
  assert.ok(policyEntries(4).some((e) => e.name === 'DefaultNotificationsSetting'));
  assert.equal(policyEntries(1).find((e) => e.name === 'TrackingPrevention').value, 2);
  assert.equal(policyEntries(5).find((e) => e.name === 'TrackingPrevention').value, 3);

  const machine = policiesScript(4, { windowsAds: true }, { scope: 'machine' });
  const user = policiesScript(4, { windowsAds: true }, { scope: 'user' });
  assert.ok(machine.includes("'HKLM:") && !machine.includes("'HKCU:"));
  assert.ok(user.includes("'HKCU:") && !user.includes("'HKLM:"));
  assert.ok(machine.includes('registry-backup-machine.json') && user.includes('LOCALAPPDATA'));
  assert.ok(machine.indexOf('Restore-SgValues\r\n') < machine.indexOf('Set-SgValue '), 'restore before applying');
});

test('hosts block is inserted, replaced and removed cleanly', () => {
  const original = '127.0.0.1 localhost\n10.0.0.5 nas\n';
  const once = mergeHosts(original, ['ads.a.com', 'b.net']);
  assert.ok(once.includes('0.0.0.0 ads.a.com') && once.includes(BEGIN) && once.includes(END));
  const twice = mergeHosts(once, ['c.org']);
  assert.equal(twice.split(BEGIN).length, 2, 'only one managed block');
  assert.ok(!twice.includes('ads.a.com') && twice.includes('0.0.0.0 c.org'));
  const removed = stripBlock(twice);
  assert.ok(removed.includes('10.0.0.5 nas') && !removed.includes(BEGIN));
});

test('PAC sends web traffic to the proxy with DIRECT fallback', () => {
  const pac = pacScript('127.0.0.1', 8118);
  const FindProxyForURL = new Function(
    'isPlainHostName', 'shExpMatch',
    `${pac}; return FindProxyForURL;`,
  )((h) => !h.includes('.'), (s, p) => new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(s));
  assert.equal(FindProxyForURL('https://ads.example.com/x', 'ads.example.com'), 'PROXY 127.0.0.1:8118; DIRECT');
  assert.equal(FindProxyForURL('http://router.lan/', 'router.lan'), 'DIRECT');
  assert.equal(FindProxyForURL('http://192.168.1.1/', '192.168.1.1'), 'DIRECT');
  assert.equal(FindProxyForURL('http://intranet/', 'intranet'), 'DIRECT');
});
