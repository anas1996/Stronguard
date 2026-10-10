// Browser and Windows hardening via policies (PowerShell registry script).
//
// Uses each browser's own built-in protections as an extra layer: native popup
// blocking, intrusive-ads blocking, notification blocking, tracking prevention,
// sponsored content off, and built-in DNS-over-HTTPS off (so browsers cannot
// bypass the Stronguard resolver). Optionally turns off Windows' own ads.
//
// Every value written is backed up first; re-running restores the backup
// before applying, so lowering the level or uninstalling is clean.

const CHROMIUM = {
  chrome: 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome',
  edge: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge',
  brave: 'HKLM:\\SOFTWARE\\Policies\\BraveSoftware\\Brave',
};
const FIREFOX = 'HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox';
const CDM = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager';

const dw = (path, name, value, minLevel = 1, extra = {}) => ({ path, name, type: 'DWord', value, minLevel, ...extra });
const sz = (path, name, value, minLevel = 1, extra = {}) => ({ path, name, type: 'String', value, minLevel, ...extra });

export function policyEntries(level, { dns = true, windowsAds = false } = {}) {
  const e = [];
  for (const [browser, p] of Object.entries(CHROMIUM)) {
    e.push(dw(p, 'DefaultPopupsSetting', 2, 1));
    e.push(dw(p, 'AbusiveExperienceInterventionEnforce', 1, 1));
    e.push(dw(p, 'AdsSettingForIntrusiveAdsSites', 2, 1));
    e.push(sz(p, 'DnsOverHttpsMode', 'off', 3, { needsDns: true }));
    e.push(dw(p, 'DefaultNotificationsSetting', 2, 4));
    e.push(dw(p, 'BlockThirdPartyCookies', 1, 4));
    if (browser === 'chrome') {
      for (const n of ['PrivacySandboxAdTopicsEnabled', 'PrivacySandboxSiteEnabledAdsEnabled', 'PrivacySandboxAdMeasurementEnabled', 'PrivacySandboxPromptEnabled']) {
        e.push(dw(p, n, 0, 2));
      }
    }
    if (browser === 'edge') {
      e.push(dw(p, 'TrackingPrevention', level >= 3 ? 3 : 2, 1));
      for (const n of ['EdgeShoppingAssistantEnabled', 'ShowRecommendationsEnabled', 'PromotionalTabsEnabled',
        'SpotlightExperiencesAndRecommendationsEnabled', 'PersonalizationReportingEnabled', 'ShowMicrosoftRewards']) {
        e.push(dw(p, n, 0, 2));
      }
      e.push(dw(p, 'NewTabPageContentEnabled', 0, 3));
      e.push(dw(p, 'NewTabPageHideDefaultTopSites', 1, 3));
    }
  }

  e.push(dw(`${FIREFOX}\\PopupBlocking`, 'Default', 1, 1));
  e.push(dw(`${FIREFOX}\\PopupBlocking`, 'Locked', 1, 1));
  for (const n of ['Value', 'Cryptomining', 'Fingerprinting', 'EmailTracking']) e.push(dw(`${FIREFOX}\\EnableTrackingProtection`, n, 1, 1));
  for (const n of ['SponsoredTopSites', 'SponsoredPocket']) e.push(dw(`${FIREFOX}\\FirefoxHome`, n, 0, 1));
  e.push(dw(`${FIREFOX}\\FirefoxSuggest`, 'SponsoredSuggestions', 0, 1));
  for (const n of ['ExtensionRecommendations', 'FeatureRecommendations', 'MoreFromMozilla']) e.push(dw(`${FIREFOX}\\UserMessaging`, n, 0, 2));
  e.push(dw(FIREFOX, 'DisableFirefoxStudies', 1, 2));
  e.push(dw(FIREFOX, 'DisableTelemetry', 1, 2));
  e.push(dw(`${FIREFOX}\\DNSOverHTTPS`, 'Enabled', 0, 3, { needsDns: true }));
  e.push(dw(`${FIREFOX}\\DNSOverHTTPS`, 'Locked', 1, 3, { needsDns: true }));
  e.push(sz(`${FIREFOX}\\Cookies`, 'Behavior', 'reject-tracker-and-partition-foreign', 3));
  e.push(dw(`${FIREFOX}\\Permissions\\Notifications`, 'BlockNewRequests', 1, 4));

  if (windowsAds) {
    e.push(dw('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\AdvertisingInfo', 'DisabledByGroupPolicy', 1, 1));
    for (const n of ['DisableWindowsConsumerFeatures', 'DisableSoftLanding', 'DisableCloudOptimizedContent', 'DisableConsumerAccountStateContent']) {
      e.push(dw('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent', n, 1, 1));
    }
    for (const n of ['SubscribedContent-338388Enabled', 'SubscribedContent-338389Enabled', 'SubscribedContent-338393Enabled',
      'SubscribedContent-353694Enabled', 'SubscribedContent-353696Enabled', 'SubscribedContent-310093Enabled',
      'SystemPaneSuggestionsEnabled', 'SilentInstalledAppsEnabled', 'SoftLandingEnabled', 'RotatingLockScreenOverlayEnabled',
      'PreInstalledAppsEnabled', 'OemPreInstalledAppsEnabled']) {
      e.push(dw(CDM, n, 0, 1));
    }
    e.push(dw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'ShowSyncProviderNotifications', 0, 1));
    e.push(dw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'Start_IrisRecommendations', 0, 1));
    e.push(dw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\UserProfileEngagement', 'ScoobeSystemSettingEnabled', 0, 1));
    e.push(dw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Privacy', 'TailoredExperiencesWithDiagnosticDataEnabled', 0, 1));
    e.push(dw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', 'Enabled', 0, 1));
  }
  return e.filter((x) => x.minLevel <= level && (dns || !x.needsDns));
}

const PS_HELPERS = String.raw`

function Read-SgBackup {
  $h = @{}
  if (Test-Path $BackupFile) {
    $obj = Get-Content -Path $BackupFile -Raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
  }
  return $h
}

function Save-SgBackup($h) {
  New-Item -ItemType Directory -Force -Path (Split-Path $BackupFile) | Out-Null
  if ($h.Count -eq 0) { Remove-Item -Path $BackupFile -ErrorAction SilentlyContinue; return }
  ConvertTo-Json -InputObject $h -Depth 5 | Set-Content -Path $BackupFile -Encoding UTF8
}

function Restore-SgValues {
  $b = Read-SgBackup
  foreach ($entry in $b.Values) {
    try {
      if ($entry.existed) {
        if (-not (Test-Path $entry.path)) { New-Item -Path $entry.path -Force | Out-Null }
        New-ItemProperty -Path $entry.path -Name $entry.name -Value $entry.value -PropertyType $entry.type -Force | Out-Null
      } elseif (Test-Path $entry.path) {
        Remove-ItemProperty -Path $entry.path -Name $entry.name -ErrorAction SilentlyContinue
      }
    } catch { Write-Warning ("Could not restore " + $entry.path + "\" + $entry.name + ": " + $_) }
  }
  Save-SgBackup @{}
}

function Set-SgValue([string]$Path, [string]$Name, $Value, [string]$Type) {
  $key = $Path + '|' + $Name
  if (-not $script:SgBackup.ContainsKey($key)) {
    $existed = $false; $prev = $null; $prevType = $null
    if (Test-Path $Path) {
      $item = Get-Item -Path $Path
      if ($item.GetValueNames() -contains $Name) {
        $existed = $true
        $prev = $item.GetValue($Name)
        $prevType = $item.GetValueKind($Name).ToString()
      }
    }
    $script:SgBackup[$key] = @{ path = $Path; name = $Name; existed = $existed; value = $prev; type = $prevType }
  }
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}
`;

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// scope 'machine' = HKLM values (backup in %ProgramData%), 'user' = HKCU values
// (backup in %LOCALAPPDATA%, so each user's hive is restored by that user).
export function policiesScript(level, opts = {}, { remove = false, scope = 'machine' } = {}) {
  const backup = scope === 'user'
    ? "$BackupFile = Join-Path $env:LOCALAPPDATA 'Stronguard\\registry-backup-user.json'"
    : "$BackupFile = Join-Path $env:ProgramData 'Stronguard\\registry-backup-machine.json'";
  const lines = [
    `# Generated by Stronguard - browser and Windows hardening policies (${scope} scope)`,
    `# Level ${level}. Previous values are backed up before anything is changed.`,
    "$ErrorActionPreference = 'Stop'",
    backup,
    PS_HELPERS,
    'Restore-SgValues',
  ];
  if (remove) {
    lines.push(`Write-Host 'Stronguard ${scope} policies removed and previous values restored.'`);
    return `${lines.join('\r\n')}\r\n`;
  }
  const prefix = scope === 'user' ? 'HKCU:' : 'HKLM:';
  const entries = policyEntries(level, opts).filter((e) => e.path.startsWith(prefix));
  lines.push('$script:SgBackup = Read-SgBackup');
  for (const e of entries) {
    const value = e.type === 'DWord' ? String(e.value) : psQuote(e.value);
    lines.push(`Set-SgValue ${psQuote(e.path)} ${psQuote(e.name)} ${value} '${e.type}'`);
  }
  lines.push('Save-SgBackup $script:SgBackup');
  lines.push(`Write-Host 'Stronguard ${scope} policies applied: ${entries.length} settings (restart browsers to take effect).'`);
  return `${lines.join('\r\n')}\r\n`;
}
