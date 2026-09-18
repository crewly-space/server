$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repository = 'opentribe-dev/opencrew-server'
$CliRepository = 'opentribe-dev/opencrew-cli'
$Version = if ($env:OPENCREW_VERSION) { $env:OPENCREW_VERSION } else { 'latest' }
$InstallDir = if ($env:OPENCREW_INSTALL_DIR) { $env:OPENCREW_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'OpenCrew\bin' }
$Architecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()) {
  'x64' { 'amd64' }
  default { throw "Unsupported Windows architecture. OpenCrew currently publishes Windows x64 releases." }
}

Write-Host "`n  OpenCrew installer" -ForegroundColor White
Write-Host "  ------------------`n" -ForegroundColor DarkGray
Write-Host "  [ok] Detected windows / $Architecture" -ForegroundColor Green

# The server (with the bundled app) and the CLI ship from separate
# repositories now, so each asset resolves against its own release.
function Get-ReleaseUrl([string]$Repo) {
  if ($env:OPENCREW_RELEASE_BASE_URL) { return $env:OPENCREW_RELEASE_BASE_URL.TrimEnd('/') }
  if ($Version -eq 'latest') { return "https://github.com/$Repo/releases/latest/download" }
  return "https://github.com/$Repo/releases/download/$Version"
}
$ReleaseUrl = Get-ReleaseUrl $Repository
$CliReleaseUrl = Get-ReleaseUrl $CliRepository
$Asset = "opencrew-server_windows_$Architecture.zip"
$CliAsset = "opencrew-cli_windows_$Architecture.zip"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("opencrew-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir | Out-Null

try {
  function Get-VerifiedAsset([string]$BaseUrl, [string]$AssetName, [string]$Label) {
    Write-Host "  -> Downloading $Label" -ForegroundColor Cyan
    $ChecksumFile = Join-Path $TempDir "checksums.$Label.txt"
    Invoke-WebRequest "$BaseUrl/$AssetName" -OutFile (Join-Path $TempDir $AssetName)
    Invoke-WebRequest "$BaseUrl/checksums.txt" -OutFile $ChecksumFile
    $Line = Get-Content $ChecksumFile | Where-Object { $_ -match ([regex]::Escape($AssetName) + '$') } | Select-Object -First 1
    if (!$Line) { throw "Release checksum for $AssetName is missing." }
    $Expected = ($Line -split '\s+')[0].ToLowerInvariant()
    $Actual = (Get-FileHash (Join-Path $TempDir $AssetName) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Expected -ne $Actual) { throw "Release checksum for $AssetName did not match." }
    Expand-Archive (Join-Path $TempDir $AssetName) -DestinationPath $TempDir -Force
    Write-Host "  [ok] Verified $Label" -ForegroundColor Green
  }

  Get-VerifiedAsset $ReleaseUrl $Asset 'server'
  Get-VerifiedAsset $CliReleaseUrl $CliAsset 'CLI' 
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
