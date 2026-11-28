# Helpers to start/stop the INSTALLED CNSArch with the WebView2 DevTools port open.
$ErrorActionPreference = "Stop"

function Get-InstalledApp {
  $keys = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "CNSArch*" }
  $k = $keys | Select-Object -First 1
  if (-not $k) { return $null }
  $dir = $k.InstallLocation
  if (-not $dir) { $dir = Split-Path ($k.DisplayIcon -replace '"', '' -replace ',.*$', '') }
  $exe = Join-Path ($dir -replace '"', '') "CNSArch.exe"
  [pscustomobject]@{ Version = $k.DisplayVersion; Exe = $exe; FileVersion = (Get-Item $exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion }
}

function Test-DevTools {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect("127.0.0.1", 9222); $c.Close(); return $true } catch { return $false }
}

function Start-App {
  $app = Get-InstalledApp
  if (-not $app) { throw "CNSArch is not installed" }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
  Write-Host "Starting $($app.Exe) (registry version $($app.Version), file $($app.FileVersion))"
  Start-Process -FilePath $app.Exe | Out-Null
  for ($i = 0; $i -lt 60; $i++) { if (Test-DevTools) { Write-Host "DevTools ready"; return }; Start-Sleep 2 }
  Save-Diagnostics "start-failed"
  throw "DevTools port never opened"
}

function Stop-App {
  $p = Get-Process CNSArch -ErrorAction SilentlyContinue
  if (-not $p) { return }
  # Like the X button: the app runs its own close flow (automatic backup) and exits.
  $p | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }
  for ($i = 0; $i -lt 60; $i++) { if (-not (Get-Process CNSArch -ErrorAction SilentlyContinue)) { Write-Host "App closed"; return }; Start-Sleep 2 }
  Write-Host "App did not close in 120 s; stopping it"
  Get-Process CNSArch -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 3
}

function Save-Diagnostics($name) {
  $out = "C:\CNSTest\out"
  New-Item -ItemType Directory -Force $out | Out-Null
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save("$out\desktop-$name.png")
  } catch { Write-Host "desktop screenshot failed: $_" }
  $txt = @()
  $txt += Get-CimInstance Win32_Process | Where-Object { $_.Name -match "CNSArch|msedgewebview2|setup" } | ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.CommandLine)" }
  $txt += Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "window: $($_.ProcessName) '$($_.MainWindowTitle)'" }
  $txt += netstat -ano | Select-String "LISTENING" | ForEach-Object { $_.Line }
  $txt += "WebView2 runtime: " + ((Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue).pv)
  $txt | Set-Content "$out\diag-$name.txt"
  $txt | Select-Object -First 60 | ForEach-Object { Write-Host $_ }
}
