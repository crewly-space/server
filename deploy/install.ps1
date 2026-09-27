$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Installs only the crewly CLI. `crewly init` then asks how this device is
# used; the server and app are downloaded by the CLI only if the user picks a
# mode that hosts them, so a device that just connects to an existing server
# never carries them.

# Windows PowerShell 5.1 on older .NET defaults to TLS 1.0/1.1, which GitHub
# refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$CliRepository = 'crewly-space/cli'
$Version = if ($env:CREWLY_VERSION) { $env:CREWLY_VERSION } else { 'latest' }
$InstallDir = if ($env:CREWLY_INSTALL_DIR) { $env:CREWLY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Crewly\bin' }

# PowerShell 5.1-compatible architecture detection.
# Crewly currently publishes Windows x64 releases only.
$Architecture = if ([Environment]::Is64BitOperatingSystem) {
    'amd64'
} else {
    throw "Unsupported Windows architecture. Crewly currently publishes Windows x64 releases."
}

Write-Host "`n  Crewly installer" -ForegroundColor White
Write-Host "  ------------------`n" -ForegroundColor DarkGray
Write-Host "  [ok] Detected windows / $Architecture" -ForegroundColor Green

$CliReleaseUrl = if ($env:CREWLY_RELEASE_BASE_URL) {
    $env:CREWLY_RELEASE_BASE_URL.TrimEnd('/')
} elseif ($Version -eq 'latest') {
    "https://github.com/$CliRepository/releases/latest/download"
} else {
    "https://github.com/$CliRepository/releases/download/$Version"
}

$CliAsset = "crewly-cli_windows_$Architecture.zip"

$TempDir = Join-Path (
    [System.IO.Path]::GetTempPath()
) ("crewly-" + [Guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $TempDir | Out-Null

try {
    Write-Host "  -> Downloading the Crewly CLI" -ForegroundColor Cyan

    $ArchivePath = Join-Path $TempDir $CliAsset
    $ChecksumFile = Join-Path $TempDir 'checksums.txt'

    # -UseBasicParsing: without it, Windows PowerShell 5.1 needs Internet
    # Explorer's engine, which is missing on Server Core and fresh installs.
    Invoke-WebRequest `
        "$CliReleaseUrl/$CliAsset" `
        -OutFile $ArchivePath `
        -UseBasicParsing

    Invoke-WebRequest `
        "$CliReleaseUrl/checksums.txt" `
        -OutFile $ChecksumFile `
        -UseBasicParsing

    $Line = Get-Content $ChecksumFile |
        Where-Object {
            $_ -match ([regex]::Escape($CliAsset) + '$')
        } |
        Select-Object -First 1

    if (!$Line) {
        throw "Release checksum for $CliAsset is missing."
    }

    $Expected = ($Line -split '\s+')[0].ToLowerInvariant()
    $Actual = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()

    if ($Expected -ne $Actual) {
        throw "Release checksum for $CliAsset did not match."
    }

    Expand-Archive $ArchivePath -DestinationPath $TempDir -Force

    if (!(Test-Path -LiteralPath (Join-Path $TempDir 'crewly.exe'))) {
        throw "Release is missing crewly.exe"
    }

    Write-Host "  [ok] Verified the CLI" -ForegroundColor Green

    New-Item `
        -ItemType Directory `
        -Force `
        -Path $InstallDir |
        Out-Null

    Copy-Item `
        (Join-Path $TempDir 'crewly.exe') `
        (Join-Path $InstallDir 'crewly.exe') `
        -Force

    # Older installers put the server and app next to the CLI, where the CLI
    # still looks first. Left behind, that copy would never be updated again,
    # so drop it; the CLI downloads a current one the next time this device
    # starts a server. A running server holds its .exe open, so this is best
    # effort.
    foreach ($legacy in @('crewly-server.exe', 'web')) {
        $LegacyPath = Join-Path $InstallDir $legacy
        if (Test-Path -LiteralPath $LegacyPath) {
            try {
                Remove-Item -LiteralPath $LegacyPath -Recurse -Force
            } catch {
                Write-Host "  [!] Could not remove the old $LegacyPath; stop the Crewly server and delete it" -ForegroundColor Yellow
            }
        }
    }

    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')

    if (
        !$env:CREWLY_NO_PATH -and
        ($UserPath -split ';') -notcontains $InstallDir
    ) {
        $NewPath = if ($UserPath) {
            "${UserPath};${InstallDir}"
        } else {
            $InstallDir
        }

        [Environment]::SetEnvironmentVariable(
            'Path',
            $NewPath,
            'User'
        )

        $env:Path = "${env:Path};${InstallDir}"

        Write-Host `
            '  [ok] Added Crewly to your user PATH (new terminals will inherit it)' `
            -ForegroundColor Green
    }

    Write-Host `
        '  [ok] Installed the Crewly CLI' `
        -ForegroundColor Green

    if (
        !$env:CREWLY_SKIP_INIT -and
        !$env:CREWLY_SKIP_SETUP -and
        [Environment]::UserInteractive
    ) {
        Write-Host "`n  Starting Crewly setup`n" -ForegroundColor White

        & (Join-Path $InstallDir 'crewly.exe') init

        if ($LASTEXITCODE -ne 0) {
            throw "Crewly setup exited with code $LASTEXITCODE"
        }
    }
    else {
        Write-Host "`n  Next: crewly init`n" -ForegroundColor White
    }
}
finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item `
            -LiteralPath $TempDir `
            -Recurse `
            -Force
    }
}
