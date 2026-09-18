$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repository = 'opentribe-dev/opencrew'
$Version = if ($env:OPENCREW_VERSION) { $env:OPENCREW_VERSION } else { 'latest' }
$InstallDir = if ($env:OPENCREW_INSTALL_DIR) { $env:OPENCREW_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'OpenCrew\bin' }
$Architecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()) {
  'x64' { 'amd64' }
  default { throw "Unsupported Windows architecture. OpenCrew currently publishes Windows x64 releases." }
}

Write-Host "`n  OpenCrew installer" -ForegroundColor White
Write-Host "  ------------------`n" -ForegroundColor DarkGray
Write-Host "  [ok] Detected windows / $Architecture" -ForegroundColor Green

$ReleaseUrl = if ($env:OPENCREW_RELEASE_BASE_URL) {
  $env:OPENCREW_RELEASE_BASE_URL.TrimEnd('/')
} elseif ($Version -eq 'latest') {
  "https://github.com/$Repository/releases/latest/download"
} else {
  "https://github.com/$Repository/releases/download/$Version"
}
$Asset = "opencrew_windows_$Architecture.zip"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("opencrew-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir | Out-Null

try {
  Write-Host "  -> Downloading OpenCrew $Version" -ForegroundColor Cyan
  Invoke-WebRequest "$ReleaseUrl/$Asset" -OutFile (Join-Path $TempDir $Asset)
  Invoke-WebRequest "$ReleaseUrl/checksums.txt" -OutFile (Join-Path $TempDir 'checksums.txt')
  $ChecksumLine = Get-Content (Join-Path $TempDir 'checksums.txt') | Where-Object { $_ -match ([regex]::Escape($Asset) + '$') } | Select-Object -First 1
  if (!$ChecksumLine) { throw 'Release checksum is missing.' }
  $Expected = ($ChecksumLine -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash (Join-Path $TempDir $Asset) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw 'Release checksum did not match.' }
  Write-Host '  [ok] Verified release checksum' -ForegroundColor Green

  Expand-Archive (Join-Path $TempDir $Asset) -DestinationPath $TempDir -Force
  foreach ($required in @('opencrew.exe', 'opencrew-server.exe', 'web\index.html')) {
    if (!(Test-Path -LiteralPath (Join-Path $TempDir $required))) { throw "Release is missing $required" }
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item (Join-Path $TempDir 'opencrew.exe') (Join-Path $InstallDir 'opencrew.exe') -Force
  Copy-Item (Join-Path $TempDir 'opencrew-server.exe') (Join-Path $InstallDir 'opencrew-server.exe') -Force
  $WebDir = Join-Path $InstallDir 'web'
  New-Item -ItemType Directory -Force -Path $WebDir | Out-Null
  Copy-Item (Join-Path $TempDir 'web\*') $WebDir -Recurse -Force

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (!$env:OPENCREW_NO_PATH -and ($UserPath -split ';') -notcontains $InstallDir) {
    $NewPath = if ($UserPath) { "${UserPath};${InstallDir}" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    $env:Path = "${env:Path};${InstallDir}"
    Write-Host '  [ok] Added OpenCrew to your user PATH (new terminals will inherit it)' -ForegroundColor Green
  }
  Write-Host '  [ok] Installed CLI, server, and app' -ForegroundColor Green

  if (!$env:OPENCREW_SKIP_INIT -and !$env:OPENCREW_SKIP_SETUP -and [Environment]::UserInteractive) {
    Write-Host "`n  Starting OpenCrew setup`n" -ForegroundColor White
    & (Join-Path $InstallDir 'opencrew.exe') init
    if ($LASTEXITCODE -ne 0) { throw "OpenCrew setup exited with code $LASTEXITCODE" }
  } else {
    Write-Host "`n  Next: opencrew init`n" -ForegroundColor White
  }
} finally {
  if (Test-Path -LiteralPath $TempDir) { Remove-Item -LiteralPath $TempDir -Recurse -Force }
}
