<#
.SYNOPSIS
  Installs the Stronguard network shield on Windows.

.DESCRIPTION
  Sets up every network layer of Stronguard on this PC:
    1. DNS sinkhole + filtering proxy + dashboard, as a background service
       (scheduled task running as SYSTEM, restarted automatically).
    2. All network adapters pointed at the local resolver (previous DNS backed up).
    3. Windows Firewall rules that stop apps from bypassing it (DoT, plain DNS
       to other servers, hard-coded DoH resolvers), depending on the level.
    4. Chrome / Edge / Brave / Firefox policies: native popup + intrusive-ad
       blocking, notification blocking, tracking prevention, built-in DoH off.
    5. System proxy auto-config (PAC) so browsers that use their own encrypted
       DNS are still filtered by hostname.
    6. Spotify desktop app: audio ads muted in the Windows volume mixer
       (per-user helper; music and podcasts are untouched).
    7. Optional: Windows' own ads and suggestions off, hosts-file fallback,
       and serving the whole home network.

  Run it again at any time to change options. Undo everything with uninstall.ps1.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File windows\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File windows\install.ps1 -Level 4 -WindowsAds -Hosts
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [ValidateRange(1, 5)] [int] $Level = 3,
  [switch] $NoDns,
  [switch] $NoFirewall,
  [switch] $NoBrowserPolicies,
  [switch] $NoProxy,
  [switch] $WindowsAds,
  [switch] $Hosts,
  [switch] $ServeLan,
  [switch] $NoSpotifyMuter,
  [switch] $NoOpen,
  [string] $DataDir = (Join-Path $env:ProgramData 'Stronguard')
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root 'network\bin\stronguard.js'
$TaskName = 'Stronguard'

function Write-Step([string] $Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok([string] $Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Note([string] $Text) { Write-Host "    $Text" -ForegroundColor Yellow }

# --- Node.js ----------------------------------------------------------------
Write-Step 'Checking Node.js'
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Node.js 20 or newer is required: install it from https://nodejs.org and run this script again.' }
$NodeExe = $nodeCmd.Source
$nodeVersion = [version]((& $NodeExe -v).Trim().TrimStart('v'))
if ($nodeVersion.Major -lt 20) { throw "Node.js 20 or newer is required (found $nodeVersion)." }
if (-not (Test-Path $Cli)) { throw "Cannot find $Cli. Run this script from the Stronguard folder." }
Write-Ok "Node.js $nodeVersion at $NodeExe"

function Invoke-Stronguard {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $CliArgs)
  $output = & $NodeExe $Cli @CliArgs --data $DataDir
  if ($LASTEXITCODE -ne 0) { throw "stronguard $($CliArgs -join ' ') failed:`n$output" }
  return $output
}

function Invoke-Generated {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $CliArgs)
  $script = (Invoke-Stronguard @CliArgs) -join "`n"
  Invoke-Expression $script
}

# --- Stop a previous instance -------------------------------------------------
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Step 'Stopping the previous Stronguard service'
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*stronguard.js*run*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

# --- Port 53 ------------------------------------------------------------------
Write-Step 'Checking that port 53 is free'
$busy = Get-NetUDPEndpoint -LocalPort 53 -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -in @('0.0.0.0', '127.0.0.1', '::', '::1') }
if ($busy) {
  $owners = ($busy | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Sort-Object -Unique) -join ', '
  Write-Note "Port 53 is already used by: $owners (often Internet Connection Sharing, Hyper-V or another DNS tool)."
  Write-Note 'Stronguard binds 127.0.0.1:53 specifically, which usually still works. If it fails, stop that service.'
} else {
  Write-Ok 'Port 53 is free'
}

# --- Router DNS for local names -------------------------------------------------
# Adapters that carry internet traffic (have a default gateway), physical or not.
$adapters = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
  Where-Object { ($_.IPv4DefaultGateway -or $_.IPv6DefaultGateway) -and $_.NetAdapter.Status -eq 'Up' } |
  ForEach-Object { $_.NetAdapter })
if ($adapters.Count -eq 0) { $adapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up') }
$router = $null
foreach ($a in $adapters) {
  $servers = (Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
  foreach ($s in $servers) {
    if ($s -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') { $router = $s; break }
  }
  if ($router) { break }
}

# --- Configuration -------------------------------------------------------------
Write-Step "Writing configuration (level $Level)"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$initArgs = @('init', '--level', "$Level")
if ($ServeLan) { $initArgs += '--serve-lan' }
if ($router) { $initArgs += @('--local-forward', "udp://${router}:53") }
if ($NoProxy) { $initArgs += '--no-proxy' }
if (-not $NoFirewall) { $initArgs += '--windows-firewall' }
if (-not $NoBrowserPolicies) { $initArgs += '--windows-policies' }
if ($WindowsAds) { $initArgs += '--windows-ads' }
if ($NoDns) { $initArgs += '--no-dns-adapters' }
Invoke-Stronguard @initArgs | ForEach-Object { Write-Ok $_ }
if ($router) { Write-Ok "Local names (*.lan, printers, router) will be answered by your router at $router" }

Write-Step 'Downloading filter lists'
try {
  Invoke-Stronguard update | ForEach-Object { Write-Host "    $_" }
} catch {
  Write-Note 'Could not download every list now; the service will retry automatically.'
}

# --- Background service --------------------------------------------------------
Write-Step 'Installing the background service'
$logFile = Join-Path $DataDir 'stronguard.log'
$arguments = "`"$Cli`" run --data `"$DataDir`" --log `"$logFile`""
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument $arguments -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Stronguard network shield: DNS sinkhole, filtering proxy and dashboard.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    Resolve-DnsName -Name 'example.com' -Server 127.0.0.1 -DnsOnly -QuickTimeout -ErrorAction Stop | Out-Null
    $ready = $true
    break
  } catch { Start-Sleep -Milliseconds 750 }
}
if (-not $ready) { throw "The Stronguard service did not answer DNS on 127.0.0.1. See $logFile" }
$probe = Resolve-DnsName -Name 'doubleclick.net' -Server 127.0.0.1 -DnsOnly -Type A -ErrorAction SilentlyContinue
if ($probe -and ($probe | Where-Object { $_.IPAddress -eq '0.0.0.0' })) { Write-Ok 'Service running; doubleclick.net is sinkholed' }
else { Write-Note 'Service running, but the blocklist probe did not return 0.0.0.0 yet (lists may still be loading).' }

# --- Point adapters at Stronguard ---------------------------------------------
if (-not $NoDns) {
  Write-Step 'Pointing network adapters at Stronguard'
  $backupFile = Join-Path $DataDir 'dns-backup.json'
  if (-not (Test-Path $backupFile)) {
    $backup = foreach ($a in Get-NetAdapter -ErrorAction SilentlyContinue) {
      [pscustomobject]@{
        ifIndex = $a.ifIndex
        name    = $a.Name
        v4      = @((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses)
        v6      = @((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue).ServerAddresses)
      }
    }
    ConvertTo-Json -InputObject @($backup) -Depth 4 | Set-Content -Path $backupFile -Encoding UTF8
  }
  foreach ($a in $adapters) {
    Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses @('127.0.0.1', '::1')
    Write-Ok "$($a.Name): DNS -> 127.0.0.1, ::1"
  }
  Clear-DnsClientCache
}

# --- Firewall ------------------------------------------------------------------
if (-not $NoFirewall) {
  Write-Step 'Applying Windows Firewall anti-bypass rules'
  $fwArgs = @('firewall')
  if ($ServeLan) { $fwArgs += '--serve-lan' }
  Invoke-Generated @fwArgs
}

# --- Browser and Windows policies ------------------------------------------------
if (-not $NoBrowserPolicies) {
  Write-Step 'Hardening Chrome, Edge, Brave and Firefox'
  $polArgs = @('policies', '--scope', 'machine')
  if ($NoDns) { $polArgs += '--no-dns' }
  if ($WindowsAds) { $polArgs += '--windows-ads' }
  Invoke-Generated @polArgs
}
if ($WindowsAds) {
  Write-Step "Turning off Windows' own ads and suggestions"
  Invoke-Generated policies --scope user --windows-ads
}

# --- System proxy (PAC) --------------------------------------------------------
if (-not $NoProxy) {
  Write-Step 'Configuring automatic proxy (PAC)'
  $inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $proxyBackup = Join-Path $DataDir 'proxy-backup.json'
  if (-not (Test-Path $proxyBackup)) {
    $prev = (Get-ItemProperty -Path $inet -Name AutoConfigURL -ErrorAction SilentlyContinue).AutoConfigURL
    ConvertTo-Json -InputObject @{ AutoConfigURL = $prev } | Set-Content -Path $proxyBackup -Encoding UTF8
  }
  Set-ItemProperty -Path $inet -Name AutoConfigURL -Value 'http://127.0.0.1:8118/proxy.pac'
  Write-Ok 'Browsers and apps using system proxy settings now go through the Stronguard filter'
}

# --- Spotify desktop ad muter ----------------------------------------------------
if (-not $NoSpotifyMuter) {
  Write-Step 'Installing the Spotify desktop ad muter'
  $muterTask = 'Stronguard Spotify ad muter'
  $muter = Join-Path $PSScriptRoot 'spotify-muter.ps1'
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $muterAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$muter`""
  $muterTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $muterSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
  $muterPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $muterTask -Action $muterAction -Trigger $muterTrigger -Settings $muterSettings `
    -Principal $muterPrincipal -Description 'Mutes audio ads in the Spotify desktop app.' -Force | Out-Null
  try { Start-ScheduledTask -TaskName $muterTask } catch { }
  Write-Ok "Runs at logon for $user; mutes Spotify only while an ad plays"
}

# --- Hosts file ----------------------------------------------------------------
if ($Hosts) {
  Write-Step 'Writing hosts-file fallback'
  Invoke-Stronguard hosts --install --max 20000 | ForEach-Object { Write-Ok $_ }
}

# --- Done ----------------------------------------------------------------------
Write-Step 'Stronguard network shield is active'
Write-Host '    Dashboard:   http://127.0.0.1:8080  (protection level slider, live log, allow/block)'
Write-Host "    CLI:         windows\stronguard.cmd status | level <1-5> | check <domain>"
Write-Host "    Logs:        $logFile"
Write-Host ''
Write-Host '    Browser extension (the in-page layer for popups, overlays and cosmetic filtering):'
Write-Host '      Chrome/Edge/Brave: open chrome://extensions or edge://extensions, enable Developer mode,'
Write-Host "                         click 'Load unpacked' and choose $Root\dist\chrome"
Write-Host '      Firefox:           see README (signed build or about:debugging)'
Write-Host '    (Build it first with: npm run build)'
Write-Host ''
Write-Host '    Restart your browsers so the new policies take effect.'
if (-not $NoOpen) { Start-Process 'http://127.0.0.1:8080' -ErrorAction SilentlyContinue }
