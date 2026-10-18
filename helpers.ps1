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
  $p = Start-Process "$env:LOCALAPPDATA\Programs\postman\Postman.exe" -PassThru
  Start-Sleep 20
  $alive = -not $p.HasExited
  Get-Process -Name Postman -ErrorAction SilentlyContinue | Stop-Process -Force
  "first run: alive after 20 s = $alive"
  if (-not $alive) { throw "Postman exited within 20 s (exit code $($p.ExitCode))" }
}
