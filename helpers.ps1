# Helpers for w4-install.yml (dot-sourced).
function Test-Install([string]$v) {
  $dir = "$env:LOCALAPPDATA\Programs\postman"
  $manifest = Import-Csv "$env:WORK\manifest-$v.csv"
  $bad = @()
  foreach ($f in $manifest) {
    $p = Join-Path $dir $f.path
    if (-not (Test-Path -LiteralPath $p)) { $bad += "missing $($f.path)"; continue }
    if ((Get-FileHash -LiteralPath $p).Hash -ne $f.sha256) { $bad += "differs $($f.path)" }
  }
  $known = $manifest.path
  $extra = Get-ChildItem -Recurse -File $dir | % { $_.FullName.Substring($dir.Length + 1) } | ? { $_ -notin $known }
  "${v}: checked $($manifest.Count) payload files, $($bad.Count) problems; extra installed files: $($extra -join ', ')"
  if ($bad) { $bad | Select -First 30 | Write-Host; throw "$v install does not match the payload" }
}

function Test-FirstRun {
  # The installer may already have started the app (an --updated install relaunches it); a second instance would lose
  # Electron's single-instance lock and exit 1, so report and stop running instances first.
  $running = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
  "Postman processes already running before launch: $($running.Count) $(($running | % { $_.Path } | Select -Unique) -join ', ')"
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 5
  $log = "$env:RUNNER_TEMP\postman-run-$([guid]::NewGuid().ToString('n'))"
  $p = Start-Process "$env:LOCALAPPDATA\Programs\postman\Postman.exe" -ArgumentList '--enable-logging=stderr' -PassThru `
    -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
  Start-Sleep 20
  $alive = -not $p.HasExited
  Get-Process -Name Postman -ErrorAction SilentlyContinue | Stop-Process -Force
  "first run: alive after 20 s = $alive"
  if (-not $alive) {
    "--- Postman stdout ---"; Get-Content "$log.out" -Tail 40 -ErrorAction SilentlyContinue
    "--- Postman stderr ---"; Get-Content "$log.err" -Tail 80 -ErrorAction SilentlyContinue
    Get-ChildItem "$env:APPDATA\Postman" -ErrorAction SilentlyContinue | Select Name,Length,LastWriteTime | Format-Table | Out-String | Write-Host
    throw "Postman exited within 20 s (exit code $($p.ExitCode))"
  }
}
