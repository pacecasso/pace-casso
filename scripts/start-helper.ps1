# Starts the Pacecasso helper (the worker behind pacecasso.com/draw) on this PC.
# Launched by the "Pacecasso Helper" icon on the desktop. Keep the window open
# while you use the site; close it to stop the helper.
#
# Only one helper may run at a time (two would race for the same uploads), so
# this refuses to start a second one.

$Host.UI.RawUI.WindowTitle = "Pacecasso Helper"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'worker\.ts' })
if ($running.Count -gt 0) {
  Write-Host ""
  Write-Host "  The Pacecasso helper is already running. Nothing to do." -ForegroundColor Yellow
  Write-Host "  (Look for the other 'Pacecasso Helper' window.)"
  Write-Host ""
  Write-Host "  This window closes in 10 seconds."
  Start-Sleep -Seconds 10
  exit 0
}

Write-Host ""
Write-Host "  Pacecasso helper is starting." -ForegroundColor Green
Write-Host "  Leave this window open while you use pacecasso.com."
Write-Host "  Close this window to stop the helper."
Write-Host ""

$env:SITE = "https://www.pacecasso.com"
npx tsx scripts/perceptual/worker.ts

Write-Host ""
Write-Host "  The helper stopped. Press Enter to close this window." -ForegroundColor Red
[void][Console]::ReadLine()
