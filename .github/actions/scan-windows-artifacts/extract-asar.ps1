# Extracts every packed member of an Electron app.asar into a directory so an AV engine can scan
# each file on its own (engines generally do not parse asar; per-file verdicts and per-file hashes
# only appear when the files exist individually). Dependency-free: asar = uint32 4, uint32 headerSize,
# then a Chromium pickle (uint32 payloadSize, uint32 jsonLength, JSON), file data at 8 + headerSize.
param([Parameter(Mandatory)][string]$Asar, [Parameter(Mandatory)][string]$OutDir)
$ErrorActionPreference = 'Stop'
$fs = [IO.File]::OpenRead((Resolve-Path $Asar))
$br = New-Object IO.BinaryReader($fs)
[void]$br.ReadUInt32(); $headerSize = $br.ReadUInt32()
[void]$br.ReadUInt32(); $jsonLen = $br.ReadUInt32()
$json = [Text.Encoding]::UTF8.GetString($br.ReadBytes($jsonLen))
$tree = $json | ConvertFrom-Json -AsHashtable -Depth 1000
$base = 8 + [int64]$headerSize
$count = 0
function Walk($node, [string]$rel) {
  foreach ($k in $node.files.Keys) {
    $v = $node.files[$k]; $p = if ($rel) { "$rel/$k" } else { $k }
    if ($v.ContainsKey('files')) { Walk $v $p; continue }
    if ($v.unpacked -or $v.ContainsKey('link')) { continue }   # already on disk in app.asar.unpacked / symlink
    $dest = Join-Path $OutDir ($p -replace '/', '\')
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    $fs.Position = $base + [int64]$v.offset
    $out = [IO.File]::Create($dest); $left = [int64]$v.size; $buf = New-Object byte[] 1MB
    while ($left -gt 0) { $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $left)); if ($n -le 0) { throw "short read $p" }; $out.Write($buf, 0, $n); $left -= $n }
    $out.Close(); $script:count++
  }
}
New-Item -ItemType Directory -Force $OutDir | Out-Null
Walk $tree ''
$fs.Close()
Write-Host "extracted $count files from $Asar to $OutDir"
