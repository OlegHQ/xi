$ErrorActionPreference = 'Stop'

try {
    $repo = if ($env:XI_REPO) { $env:XI_REPO } else { 'OlegHQ/xi' }
    $releaseUrl = if ($env:XI_RELEASE_URL) { $env:XI_RELEASE_URL.TrimEnd('/') } else { "https://github.com/$repo/releases" }
    $installDir = if ($env:XI_INSTALL_DIR) { $env:XI_INSTALL_DIR } else { Join-Path $HOME '.local/bin' }

    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    if ($architecture -notin @('x64', 'arm64')) {
        throw "Xi supports Windows x64 and ARM64; detected $architecture."
    }

    $tag = $env:XI_VERSION
    if (-not $tag) {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'Xi-installer' }
        $tag = $release.tag_name
    }
    if (-not $tag -or $tag -notmatch '^v?[A-Za-z0-9._+-]+$') { throw "Invalid or missing Xi release version: $tag" }
    $version = $tag -replace '^v', ''
    $archive = "xi-$version-win32-$architecture.zip"
    $releaseUrl = "$releaseUrl/download/$tag"

    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("xi-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        Invoke-WebRequest -Uri "$releaseUrl/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
        Invoke-WebRequest -Uri "$releaseUrl/$archive" -OutFile (Join-Path $work $archive)
        $sumLine = Get-Content -LiteralPath (Join-Path $work 'SHA256SUMS') |
            Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s+\*?" + [regex]::Escape($archive) + '$') } |
            Select-Object -First 1
        if (-not $sumLine) { throw "SHA256SUMS does not contain $archive" }
        $expectedHash = ($sumLine -split '\s+')[0].ToLowerInvariant()
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work $archive)).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) { throw "Checksum verification failed for $archive" }

        $unpacked = Join-Path $work 'unpacked'
        Expand-Archive -LiteralPath (Join-Path $work $archive) -DestinationPath $unpacked
        $executable = Join-Path $unpacked 'xi.exe'
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Xi executable is missing from the release archive.' }
        $reportedVersion = (& $executable --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $reportedVersion -notmatch [regex]::Escape($version)) {
            throw "Downloaded Xi executable failed its version check: $reportedVersion"
        }

        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        $destination = Join-Path $installDir 'xi.exe'
        $candidate = Join-Path $installDir ('.xi-' + [guid]::NewGuid().ToString('N') + '.exe')
        $support = Join-Path $installDir 'xi-support'
        $supportCandidate = Join-Path $installDir ('.xi-support-' + [guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Path $supportCandidate | Out-Null
            Copy-Item -LiteralPath (Join-Path $unpacked 'licenses') -Destination (Join-Path $supportCandidate 'licenses') -Recurse
            foreach ($notice in @('THIRD-PARTY-NOTICES.md', 'THEMES-LICENSE', 'CATPPUCCIN-LICENSE')) {
                Copy-Item -LiteralPath (Join-Path $unpacked $notice) -Destination $supportCandidate
            }
            if (Test-Path -LiteralPath $support) { Remove-Item -LiteralPath $support -Recurse -Force }
            Move-Item -LiteralPath $supportCandidate -Destination $support
            Copy-Item -LiteralPath $executable -Destination $candidate
            Move-Item -LiteralPath $candidate -Destination $destination -Force
        }
        finally {
            Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $supportCandidate -Recurse -Force -ErrorAction SilentlyContinue
        }

        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $pathEntries = @($userPath -split ';' | Where-Object { $_ })
        if (-not ($pathEntries | Where-Object { $_.TrimEnd('\') -ieq $installDir.TrimEnd('\') })) {
            $newUserPath = (@($pathEntries) + $installDir) -join ';'
            [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
            $env:Path = "$installDir;$env:Path"
        }
        Write-Output "Installed Xi $tag to $destination"
        Write-Output 'Open a new terminal if the xi command is not yet on PATH.'
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
catch {
    [Console]::Error.WriteLine("Xi installer: $($_.Exception.Message)")
    exit 1
}
