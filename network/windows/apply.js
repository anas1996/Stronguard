// Re-applies the level-dependent Windows layers (firewall rules, machine-wide
// browser policies) from the running service, so one slider drives everything.
// The service runs as SYSTEM, so it has the rights to do this.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firewallScript } from './firewall.js';
import { policiesScript } from './policies.js';

export async function runPowerShell(script) {
  const file = path.join(os.tmpdir(), `stronguard-${process.pid}-${Date.now()}.ps1`);
  // UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII text correctly.
  await fs.writeFile(file, `﻿${script}`, 'utf8');
  try {
    return await new Promise((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
      let out = '';
      ps.stdout.on('data', (d) => (out += d));
      ps.stderr.on('data', (d) => (out += d));
      ps.on('error', (err) => resolve({ code: -1, output: err.message }));
      ps.on('close', (code) => resolve({ code, output: out.trim() }));
    });
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function applyWindowsLayers(config, log = () => {}) {
  if (process.platform !== 'win32' || !config.windows) return;
  const w = config.windows;
  if (w.firewall) {
    const r = await runPowerShell(firewallScript(config, config.level, { serveLan: w.serveLan }));
    log(r.code === 0 ? `Firewall: ${r.output.split('\n').pop()}` : `Firewall update failed: ${r.output}`);
  }
  if (w.policies) {
    const opts = { dns: config.dns.enabled && w.dnsAdapters !== false, windowsAds: !!w.windowsAds };
    const r = await runPowerShell(policiesScript(config.level, opts, { scope: 'machine' }));
    log(r.code === 0 ? `Policies: ${r.output.split('\n').pop()}` : `Policy update failed: ${r.output}`);
  }
}
