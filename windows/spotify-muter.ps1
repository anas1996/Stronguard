<#
.SYNOPSIS
  Mutes audio ads in the Spotify desktop app on Windows, and unmutes when music resumes.

.DESCRIPTION
  Ads and music come from the same Spotify servers, so the app's audio ads cannot be
  blocked at DNS level without breaking playback. Instead this watches Spotify's window
  title, which reads "Artist - Song" while music or a podcast plays and changes to
  "Advertisement", "Spotify" or the advertiser's name during an ad, and mutes only
  Spotify in the Windows volume mixer while an ad plays. Spotify itself is not modified.

  install.ps1 registers this as a per-user logon task ("Stronguard Spotify ad muter").

.PARAMETER SelfTest
  Compile the Windows audio interop, run the title tests and exit (used by CI).

.PARAMETER Unmute
  Unmute Spotify once and exit (used by uninstall.ps1).
#>
[CmdletBinding()]
param(
  [switch] $SelfTest,
  [switch] $Unmute,
  [int] $IntervalMs = 400
)

$ErrorActionPreference = 'Stop'

if (-not ('Stronguard.SpotifyMuter' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Stronguard {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class SgMMDeviceEnumerator { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface SgIMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out SgIMMDeviceCollection devices);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface SgIMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out SgIMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface SgIMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface SgIAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out SgIAudioSessionEnumerator sessions);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface SgIAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out SgIAudioSessionControl2 session);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface SgIAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(IntPtr grouping, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface SgISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public static class SpotifyMuter {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    static HashSet<uint> Pids(string processName) {
      HashSet<uint> pids = new HashSet<uint>();
      foreach (Process p in Process.GetProcessesByName(processName)) pids.Add((uint)p.Id);
      return pids;
    }

    // Title of the app's main window, including when it is hidden in the tray. Null if not running.
    public static string GetTitle(string processName) {
      HashSet<uint> pids = Pids(processName);
      if (pids.Count == 0) return null;
      string found = null;
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (!pids.Contains(pid)) return true;
        StringBuilder cls = new StringBuilder(256);
        GetClassName(h, cls, cls.Capacity);
        if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return true;
        StringBuilder text = new StringBuilder(512);
        GetWindowText(h, text, text.Capacity);
        if (text.Length == 0) return true;
        found = text.ToString();
        return false;
      }, IntPtr.Zero);
      return found;
    }

    // Mutes or unmutes every audio session of the process on every active output device.
    // Returns the number of sessions changed, or -1 if the audio system is unavailable.
    public static int SetMute(string processName, bool mute) {
      HashSet<uint> pids = Pids(processName);
      if (pids.Count == 0) return 0;
      SgIMMDeviceEnumerator enumerator = (SgIMMDeviceEnumerator)(new SgMMDeviceEnumerator());
      SgIMMDeviceCollection devices;
      if (enumerator.EnumAudioEndpoints(0, 1, out devices) != 0) return -1;
      int count;
      devices.GetCount(out count);
      Guid iid = typeof(SgIAudioSessionManager2).GUID;
      int changed = 0;
      for (int i = 0; i < count; i++) {
        SgIMMDevice device;
        if (devices.Item(i, out device) != 0) continue;
        object activated;
        if (device.Activate(ref iid, 23, IntPtr.Zero, out activated) != 0) continue;
        SgIAudioSessionEnumerator sessions;
        if (((SgIAudioSessionManager2)activated).GetSessionEnumerator(out sessions) != 0) continue;
        int n;
        sessions.GetCount(out n);
        for (int j = 0; j < n; j++) {
          SgIAudioSessionControl2 session;
          if (sessions.GetSession(j, out session) != 0) continue;
          uint pid;
          if (session.GetProcessId(out pid) < 0 || !pids.Contains(pid)) continue;
          Guid context = Guid.Empty;
          if (((SgISimpleAudioVolume)session).SetMute(mute, ref context) == 0) changed++;
        }
      }
      return changed;
    }
  }
}
'@
}

# True when the Spotify window title indicates an ad (or nothing playing, where muting is harmless).
function Test-SpotifyAdTitle([string] $Title) {
  if ([string]::IsNullOrWhiteSpace($Title)) { return $false }
  $t = $Title.Trim()
  if ($t -match '^(?i)(spotify( free| premium)?|advertisement|spotify\s*[-\u2013\u2014]\s*advertisement)$') { return $true }
  # Music and podcasts are shown as "Artist - Song" / "Show - Episode".
  return -not $t.Contains(' - ')
}

if ($SelfTest) {
  $cases = @{
    'Daft Punk - One More Time' = $false
    'The Daily - A Big Week in Politics' = $false
    'Spotify' = $true
    'Spotify Free' = $true
    'Spotify Premium' = $true
    'Advertisement' = $true
    'Spotify - Advertisement' = $true
    'Volvo' = $true
    '' = $false
  }
  foreach ($c in $cases.GetEnumerator()) {
    $got = Test-SpotifyAdTitle $c.Key
    if ($got -ne $c.Value) { throw "Title '$($c.Key)': expected $($c.Value), got $got" }
  }
  $title = [Stronguard.SpotifyMuter]::GetTitle('StronguardNoSuchProcess')
  if ($null -ne $title) { throw 'GetTitle should return null for a missing process' }
  try {
    $n = [Stronguard.SpotifyMuter]::SetMute([Diagnostics.Process]::GetCurrentProcess().ProcessName, $false)
    Write-Host "Audio sessions reachable (changed: $n)"
  } catch {
    Write-Host "Audio system not available on this machine: $($_.Exception.Message)"
  }
  Write-Host 'Spotify muter self-test passed.'
  return
}

if ($Unmute) {
  [Stronguard.SpotifyMuter]::SetMute('Spotify', $false) | Out-Null
  return
}

$muted = $false
try {
  while ($true) {
    $title = [Stronguard.SpotifyMuter]::GetTitle('Spotify')
    if ($null -eq $title) {
      $muted = $false
    } else {
      $ad = Test-SpotifyAdTitle $title
      if ($ad -ne $muted) {
        try {
          # 0 = Spotify has no audio session yet: retry on the next tick
          if ([Stronguard.SpotifyMuter]::SetMute('Spotify', $ad) -gt 0) { $muted = $ad }
        } catch {
          Start-Sleep -Seconds 5
        }
      }
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
} finally {
  if ($muted) {
    try { [Stronguard.SpotifyMuter]::SetMute('Spotify', $false) | Out-Null } catch { }
  }
}
