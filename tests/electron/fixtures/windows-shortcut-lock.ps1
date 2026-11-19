param([string]$Directory, [uint32]$DesiredAccess, [uint32]$ShareMode)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShortcutSharing {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateFile(string p,uint access,uint share,IntPtr sa,uint create,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool DeleteFile(string p);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$file=Join-Path $Directory 'owned-shortcut.lnk'
[IO.File]::WriteAllText($file,'owned temporary shortcut sharing probe')
$handle=[ShortcutSharing]::CreateFile($file,0,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
if($handle -eq [IntPtr](-1)){throw 'Cannot open negative-control file'}
try {$queryOnlyDeleteSucceeded=[ShortcutSharing]::DeleteFile($file)}
finally {[ShortcutSharing]::CloseHandle($handle) | Out-Null}
if(!$queryOnlyDeleteSucceeded){throw 'Negative control could not delete the query-only handle file'}
[IO.File]::WriteAllText($file,'owned temporary shortcut sharing probe')
$handle=[ShortcutSharing]::CreateFile($file,$DesiredAccess,$ShareMode,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
if($handle -eq [IntPtr](-1)){throw 'Cannot open production-parameter file'}
try {
 $deleted=[ShortcutSharing]::DeleteFile($file)
 $lastWin32Error=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
 $blocked=(!$deleted -and [IO.File]::Exists($file))
} finally {[ShortcutSharing]::CloseHandle($handle) | Out-Null}
$afterClose=[ShortcutSharing]::DeleteFile($file)
@{queryOnlyDeleteSucceeded=$queryOnlyDeleteSucceeded;productionDeleteBlocked=$blocked;productionDeleteError=$lastWin32Error;deleteAfterCloseSucceeded=$afterClose} | ConvertTo-Json -Compress
