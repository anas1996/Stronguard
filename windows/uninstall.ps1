<#
.SYNOPSIS
  Removes the Stronguard network shield and restores previous settings.

.DESCRIPTION
  Stops and removes the background service, restores each adapter's previous
  DNS servers, removes the firewall rules, restores browser/Windows policy
  values, the system proxy setting and the hosts file.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [switch] $KeepData,
  [string] $DataDir = (Join-Path $env:ProgramData 'Stronguard')
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root 'network\bin\stronguard.js'
$TaskName = 'Stronguard'
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source

function Write-Step([string] $Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok([string] $Text) { Write-Host "    $Text" -ForegroundColor Green }

function Invoke-Generated {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $CliArgs)
  if (-not $NodeExe) { Write-Warning 'Node.js not found; skipping generated cleanup.'; return }
  $script = (& $NodeExe $Cli @CliArgs --data $DataDir) -join "`n"
  Invoke-Expression $script
}

$failures = @()

# A large hosts block makes every DNS client reload slow, so remove it first.
Write-Step 'Cleaning the hosts file'
if ($NodeExe) {
  & $NodeExe $Cli hosts --uninstall --data $DataDir | ForEach-Object { Write-Ok $_ }
  if ($LASTEXITCODE -ne 0) { $failures += 'hosts file' }
}

# Restore DNS before stopping the service so the PC is never left without a resolver.
Write-Step 'Restoring DNS servers'
$backupFile = Join-Path $DataDir 'dns-backup.json'
$restored = @{}
if (Test-Path $backupFile) {
  foreach ($entry in @(Get-Content -Path $backupFile -Raw | ConvertFrom-Json)) {
    $servers = @($entry.v4) + @($entry.v6) | Where-Object { $_ -and $_ -notin @('127.0.0.1', '::1') }
    try {
      if ($servers.Count -gt 0) { Set-DnsClientServerAddress -InterfaceIndex $entry.ifIndex -ServerAddresses $servers }
      else { Set-DnsClientServerAddress -InterfaceIndex $entry.ifIndex -ResetServerAddresses }
      $restored[[string]$entry.ifIndex] = $true
      Write-Ok "$($entry.name): restored"
    } catch { }
  }
}
# Any adapter still pointing at Stronguard goes back to automatic (DHCP) DNS.
foreach ($a in Get-NetAdapter -ErrorAction SilentlyContinue) {
  $current = @((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue).ServerAddresses)
  if (($current -contains '127.0.0.1' -or $current -contains '::1') -and -not $restored.ContainsKey([string]$a.ifIndex)) {
    Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ResetServerAddresses
    Write-Ok "$($a.Name): reset to automatic"
  }
}
Clear-DnsClientCache

Write-Step 'Removing the background service'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*stronguard.js*run*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Ok 'Service removed'

Write-Step 'Removing firewall rules'
Get-NetFirewallRule -Group 'Stronguard' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Ok 'Firewall rules removed'

Write-Step 'Restoring browser and Windows policies'
Invoke-Generated policies --scope machine --remove
Invoke-Generated policies --scope user --remove

Write-Step 'Restoring proxy settings'
$inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$proxyBackup = Join-Path $DataDir 'proxy-backup.json'
$current = (Get-ItemProperty -Path $inet -Name AutoConfigURL -ErrorAction SilentlyContinue).AutoConfigURL
if ($current -eq 'http://127.0.0.1:8118/proxy.pac') {
  $prev = $null
  if (Test-Path $proxyBackup) { $prev = (Get-Content -Path $proxyBackup -Raw | ConvertFrom-Json).AutoConfigURL }
  if ($prev) { Set-ItemProperty -Path $inet -Name AutoConfigURL -Value $prev }
  else { Remove-ItemProperty -Path $inet -Name AutoConfigURL -ErrorAction SilentlyContinue }
}
Write-Ok 'Proxy settings restored'

if (-not $KeepData) {
  Write-Step 'Deleting Stronguard data'
  Remove-Item -Path $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok "$DataDir removed"
}

if ($failures.Count) {
  Write-Warning ("Stronguard was removed, but these steps need attention: " + ($failures -join ', '))
  exit 1
}
Write-Step 'Stronguard network shield removed. Restart your browsers.'
exit 0
