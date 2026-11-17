param([ValidateSet('capture', 'restore')][string]$Mode, [long]$Handle, [int]$ProcessId, [int]$OwnerId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AilyBrowserWindow {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  public static uint Pid(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }
  public static IntPtr[] Windows() {
    var windows = new List<IntPtr>();
    EnumWindows((window, data) => { windows.Add(window); return true; }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
function Is-Browser([IntPtr]$window) {
  if (-not [AilyBrowserWindow]::IsWindowVisible($window)) { return $false }
  try {
    $name = (Get-Process -Id ([AilyBrowserWindow]::Pid($window))).ProcessName
    return $name -in @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'zen')
  } catch { return $false }
}
if ($Mode -eq 'capture') {
  $windows = @([AilyBrowserWindow]::GetForegroundWindow()) + [AilyBrowserWindow]::Windows()
  foreach ($window in $windows) {
    if (Is-Browser $window) {
      @{handle=$window.ToInt64().ToString();pid=[int][AilyBrowserWindow]::Pid($window)} | ConvertTo-Json -Compress
      exit
    }
  }
  'null'
} else {
  $window = [IntPtr]::new($Handle)
  $foreground = [AilyBrowserWindow]::Pid([AilyBrowserWindow]::GetForegroundWindow())
  if ($foreground -eq $ProcessId) { 'true'; exit }
  if ($foreground -ne $OwnerId -or [AilyBrowserWindow]::Pid($window) -ne $ProcessId -or -not (Is-Browser $window)) { 'false'; exit }
  if ([AilyBrowserWindow]::IsIconic($window)) { [void][AilyBrowserWindow]::ShowWindowAsync($window, 9) }
  [AilyBrowserWindow]::SetForegroundWindow($window) | ConvertTo-Json -Compress
}
