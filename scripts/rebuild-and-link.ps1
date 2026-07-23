#Requires -Version 5.1
# rebuild-and-link.ps1
# Rebuilds commander-ui, the main project, copies UI assets, and links globally.
# Runnable from any working directory; uses $PSScriptRoot to locate the repository.
# PowerShell 5.1+ compatible.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot   # scripts\.. = repo root
$UiDir    = Join-Path $RepoRoot 'src\commander-ui'
$UiDist   = Join-Path $UiDir 'dist'
$DestDir  = Join-Path $RepoRoot 'dist\commander-ui'

$exitCode = 0

function Invoke-Step {
    param(
        [int]    $Number,
        [string] $Description,
        [scriptblock] $Action,
        [switch] $Fatal,          # $true = abort on failure; $false = warn and continue
        [switch] $WarnOnly        # warn but do not alter exit code
    )

    Write-Host ""
    Write-Host "[$Number] $Description" -ForegroundColor Cyan
    Write-Host ("-" * 60)

    try {
        & $Action
    }
    catch {
        if ($Fatal) {
            Write-Host "FATAL: Step $Number failed - $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
        elseif ($WarnOnly) {
            Write-Host "WARNING: Step $Number failed - $($_.Exception.Message)" -ForegroundColor Yellow
        }
        else {
            Write-Host "WARNING: Step $Number failed - $($_.Exception.Message)" -ForegroundColor Yellow
            $script:exitCode = 1
        }
    }
}

# ---- Helper: Invoke-NativeCommand ----
# Runs a native command via .NET Process, capturing stdout and stderr separately.
# Avoids PowerShell's 2>&1 which in PS 5.1 wraps stderr as ErrorRecord objects
# that can terminate the fallback path under StrictMode / ErrorActionPreference Stop.
# Returns a hashtable: Success, ExitCode, StdOut, StdErr.
function Invoke-NativeCommand {
    param(
        [string]$FilePath,
        [string]$Arguments = ''
    )

    $result = @{
        Success  = $false
        ExitCode = -1
        StdOut   = ''
        StdErr   = ''
    }

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName               = $FilePath
        $psi.Arguments              = $Arguments
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        $psi.UseShellExecute        = $false
        $psi.CreateNoWindow         = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $result.StdOut   = $proc.StandardOutput.ReadToEnd()
        $result.StdErr   = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        $result.ExitCode = $proc.ExitCode
        $result.Success  = ($proc.ExitCode -eq 0)
        $proc.Dispose()
    }
    catch {
        $result.ExitCode = -1
        $result.StdErr   = "Invocation failed: $($_.Exception.Message)"
    }

    return $result
}

# ---- Helper: Test-GlobalCliHealth ----
# Runs the exact executable with --help and returns a result hashtable.
# Uses Invoke-NativeCommand (.NET Process) to capture stdout/stderr safely.
function Test-GlobalCliHealth {
    param([string]$ExePath)

    if (-not (Get-Item -Force -LiteralPath $ExePath -ErrorAction SilentlyContinue)) {
        return @{
            Success  = $false
            ExitCode = -1
            StdOut   = ''
            StdErr   = "Executable not found: $ExePath"
        }
    }

    return Invoke-NativeCommand -FilePath $ExePath -Arguments '--help'
}

# ---- Helper: Resolve-CanonicalPath ----
# Normalizes a path for case-insensitive comparison.
# Strips object-manager prefixes (\\?\, \??\), resolves to absolute via
# [IO.Path]::GetFullPath, normalizes forward slashes, removes trailing separators.
# When -RelativeTo is provided, relative paths are resolved against that base
# instead of the current working directory.
function Resolve-CanonicalPath {
    param(
        [string]$Path,
        [string]$RelativeTo
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }

    # Strip extended-length (\\?\) and NT object-path (\??\) prefixes
    $p = $Path
    if ($p.StartsWith('\\?\'))     { $p = $p.Substring(4) }
    elseif ($p.StartsWith('\??\')) { $p = $p.Substring(4) }

    # Normalize forward slashes to backslashes
    $p = $p.Replace('/', '\')

    # Resolve relative paths to absolute
    if (-not [System.IO.Path]::IsPathRooted($p)) {
        $base = if ($RelativeTo) { $RelativeTo } else { (Get-Location).Path }
        $p = Join-Path $base $p
    }

    # Get canonical full path (resolves .. and . segments)
    try { $p = [System.IO.Path]::GetFullPath($p) }
    catch { }

    # Remove trailing separator for uniform comparison
    $p = $p.TrimEnd('\')

    return $p
}

# ---- Helper: Test-JunctionToTarget ----
# Returns $true if Path is a reparse point whose target matches ExpectedTarget
# (case-insensitive canonical comparison). Uses Get-Item -Force -LiteralPath so
# dangling links are still discovered. Target may be a string or an array.
# Relative link targets are resolved against the junction's parent directory.
function Test-JunctionToTarget {
    param(
        [string]$Path,
        [string]$ExpectedTarget
    )

    $item = Get-Item -Force -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item) { return $false }

    $isReparse = $item.Attributes -band [System.IO.FileAttributes]::ReparsePoint
    if (-not $isReparse) { return $false }

    # Target can be a string or an array of strings
    $targets = @($item.Target | Where-Object { $_ })
    if ($targets.Count -eq 0) { return $false }

    # Resolve relative targets against the junction parent, not CWD
    $junctionParent    = Split-Path $Path -Parent
    $normalizedExpected = Resolve-CanonicalPath $ExpectedTarget

    foreach ($target in $targets) {
        $normalizedTarget = Resolve-CanonicalPath $target -RelativeTo $junctionParent
        if ([string]::Equals($normalizedTarget, $normalizedExpected, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

# ---- Helper: Get-BunGlobalPkgDir ----
# Resolves the Bun global package ROOT directory (not node_modules) with precedence:
#   1. BUN_INSTALL_GLOBAL_DIR environment variable
#   2. User-level bunfig.toml ($HOME/.bunfig.toml) install.globalDir setting
#   3. $BUN_INSTALL/install/global
#   4. $HOME/.bun/install/global
# The caller appends 'node_modules\<package>' to form the package path.
# Supports both [install] section syntax and dotted-key syntax (install.globalDir).
# Throws if bunfig.toml exists but cannot be read, or if any globalDir assignment
# is detected but cannot be safely parsed/resolved.
function Get-BunGlobalPkgDir {
    # 1. Explicit environment variable (highest priority)
    if ($env:BUN_INSTALL_GLOBAL_DIR) {
        return $env:BUN_INSTALL_GLOBAL_DIR
    }

    # 2. User-level bunfig.toml install.globalDir
    $bunConfigPath = Join-Path $env:USERPROFILE '.bunfig.toml'

    if (Get-Item -Force -LiteralPath $bunConfigPath -ErrorAction SilentlyContinue) {
        $content = $null
        try {
            $content = Get-Content -Path $bunConfigPath -Raw -ErrorAction Stop
        }
        catch {
            throw ("Cannot read bunfig.toml at ${bunConfigPath}: $($_.Exception.Message). " +
                   "Fix the file or set BUN_INSTALL_GLOBAL_DIR to skip config resolution.")
        }

        if ($content) {
            $lines = $content -split "`n"
            $globalDirDetected = $false

            # Pass 1: dotted-key syntax (install.globalDir = "...")
            foreach ($line in $lines) {
                if ($line -match '^\s*install\.globalDir\s*=\s*"([^"]+)"') {
                    return $Matches[1]
                }
                if ($line -match "^\s*install\.globalDir\s*=\s*'([^']+)'") {
                    return $Matches[1]
                }
                if ($line -match '^\s*install\.globalDir\s*=') {
                    $globalDirDetected = $true
                }
            }

            # Pass 2: section syntax ([install] + globalDir = "...")
            $inInstall = $false
            foreach ($line in $lines) {
                if ($line -match '^\s*\[install\]') { $inInstall = $true;  continue }
                if ($line -match '^\s*\[')          { $inInstall = $false; continue }
                if ($inInstall) {
                    if ($line -match '^\s*globalDir\s*=\s*"([^"]+)"') {
                        return $Matches[1]
                    }
                    if ($line -match "^\s*globalDir\s*=\s*'([^']+)'") {
                        return $Matches[1]
                    }
                    if ($line -match '^\s*globalDir\s*=') {
                        $globalDirDetected = $true
                    }
                }
            }

            # If any globalDir assignment was detected but none could be parsed, refuse
            if ($globalDirDetected) {
                throw ("bunfig.toml at ${bunConfigPath} contains a globalDir assignment " +
                       "that cannot be safely parsed. Ensure the value is quoted " +
                       '(e.g., install.globalDir = "/path/to/dir"). ' +
                       "Fix the file or set BUN_INSTALL_GLOBAL_DIR to skip config resolution.")
            }
            # No globalDir found -- fall through to defaults
        }
    }

    # 3. BUN_INSTALL default (global root, not node_modules)
    if ($env:BUN_INSTALL) {
        return Join-Path $env:BUN_INSTALL 'install\global'
    }

    # 4. HOME default (global root, not node_modules)
    return Join-Path $env:USERPROFILE '.bun\install\global'
}

# ---- Helper: Remove-JunctionSafely ----
# Removes a junction/symlink entry without recursing into or deleting the target.
# Uses cmd /c rmdir which only removes the link entry on Windows.
# Uses Get-Item -Force for discovery (handles dangling reparse points).
# Verifies the link disappears; throws on failure with an actionable message.
function Remove-JunctionSafely {
    param([string]$Path)

    $item = Get-Item -Force -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item) { return }   # already gone

    $isReparse = $item.Attributes -band [System.IO.FileAttributes]::ReparsePoint
    if (-not $isReparse) {
        throw "Path is not a junction/symlink: $Path. Refusing to delete a real directory."
    }

    Write-Host "  Removing reparse point at $Path" -ForegroundColor Yellow

    # cmd /c rmdir removes only the link entry, never the target
    & cmd /c rmdir $Path
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to remove junction at $Path (cmd /c rmdir exited with code $LASTEXITCODE). Remove it manually and re-run."
    }

    # Verify removal succeeded (Get-Item -Force handles dangling reparse points)
    if (Get-Item -Force -LiteralPath $Path -ErrorAction SilentlyContinue) {
        throw "Junction still exists after removal attempt: $Path. Remove it manually and re-run."
    }
}

# ---- Step 1: bun install in commander-ui ----
Invoke-Step -Number 1 -Description "Run 'bun install' in src\commander-ui" -Fatal {
    Push-Location $UiDir
    try {
        & bun install
        if ($LASTEXITCODE -ne 0) { throw "bun install exited with code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

# ---- Step 2: bun run build in commander-ui ----
Invoke-Step -Number 2 -Description "Run 'bun run build' in src\commander-ui" -Fatal {
    Push-Location $UiDir
    try {
        & bun run build
        if ($LASTEXITCODE -ne 0) { throw "bun run build (commander-ui) exited with code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

# ---- Step 3: bun run build in repo root ----
# NOTE: build.ts ends with a Unix `cp -r` call that crashes on Windows (no cp binary).
# The actual build (Bun.build + tsc) completes before that line, so dist/index.js
# and dist/index.d.ts are produced. Step 4 handles the UI copy with PowerShell.
$indexJsPath  = Join-Path $RepoRoot 'dist\index.js'
$indexDtsPath = Join-Path $RepoRoot 'dist\index.d.ts'

# Capture pre-build artifact state for freshness verification
$preBuildIndexJs  = if (Test-Path $indexJsPath)  { (Get-Item $indexJsPath).LastWriteTime }  else { $null }
$preBuildIndexDts = if (Test-Path $indexDtsPath) { (Get-Item $indexDtsPath).LastWriteTime } else { $null }

Invoke-Step -Number 3 -Description "Run 'bun run build' in repository root" -Fatal {
    Push-Location $RepoRoot
    try {
        & bun run build
        if ($LASTEXITCODE -ne 0) {
            # Build command failed. Verify that both core artifacts were freshly generated
            # (the cp -r at the end of build.ts crashes on Windows, but Bun.build + tsc
            # already succeeded by that point).
            $jsExists  = Test-Path $script:indexJsPath
            $dtsExists = Test-Path $script:indexDtsPath
            $jsFresh  = $jsExists  -and ($null -eq $script:preBuildIndexJs  -or (Get-Item $script:indexJsPath).LastWriteTime  -gt $script:preBuildIndexJs)
            $dtsFresh = $dtsExists -and ($null -eq $script:preBuildIndexDts -or (Get-Item $script:indexDtsPath).LastWriteTime -gt $script:preBuildIndexDts)

            if ($jsFresh -and $dtsFresh) {
                Write-Host "  Core artifacts present and freshly generated; failure was in 'cp -r' copy step (expected on Windows)." -ForegroundColor Yellow
                Write-Host "  The PowerShell copy in step 4 handles this." -ForegroundColor Yellow
            }
            else {
                $missing = @()
                if (-not $jsExists)       { $missing += 'dist\index.js' }
                elseif (-not $jsFresh)    { $missing += 'dist\index.js (stale)' }
                if (-not $dtsExists)      { $missing += 'dist\index.d.ts' }
                elseif (-not $dtsFresh)   { $missing += 'dist\index.d.ts (stale)' }
                throw "Root build failed and artifacts are missing or stale: $($missing -join ', ')"
            }
        }
    }
    finally { Pop-Location }
}

# ---- Step 4: Copy commander-ui dist into dist\commander-ui ----
# Uses PowerShell to replace the Unix `cp -r` from build.ts
Invoke-Step -Number 4 -Description "Copy UI assets from src\commander-ui\dist to dist\commander-ui" -WarnOnly {
    if (-not (Test-Path $UiDist)) {
        throw "Source directory not found: $UiDist"
    }

    # Remove stale destination to avoid nested/stale content
    # Inspect with Get-Item -Force to detect reparse points (junctions/symlinks).
    # Never use Remove-Item -Recurse on a reparse point -- it would follow the link
    # and delete the target contents. Use safe link-only removal for reparse points;
    # recurse only for ordinary directories.
    if (Get-Item -Force -LiteralPath $DestDir -ErrorAction SilentlyContinue) {
        $destItem = Get-Item -Force -LiteralPath $DestDir
        $destIsReparse = $destItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint
        if ($destIsReparse) {
            # Safe link-only removal (same method as Remove-JunctionSafely)
            Write-Host "  Removing reparse point at $DestDir" -ForegroundColor Yellow
            & cmd /c rmdir $DestDir
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to remove reparse point at $DestDir (cmd /c rmdir exited with code $LASTEXITCODE). Remove it manually and re-run."
            }
            if (Get-Item -Force -LiteralPath $DestDir -ErrorAction SilentlyContinue) {
                throw "Reparse point still exists after removal attempt: $DestDir. Remove it manually and re-run."
            }
        }
        else {
            # Ordinary directory -- safe to recurse
            Remove-Item -Recurse -Force $DestDir
        }
        Write-Host "  Removed stale destination: $DestDir"
    }

    # Copy fresh contents
    Copy-Item -Path $UiDist -Destination $DestDir -Recurse -Force
    Write-Host "  Copied UI assets to $DestDir"
}

# ---- Step 5: bun link ----
Invoke-Step -Number 5 -Description "Run 'bun link' in repository root" -WarnOnly {
    Push-Location $RepoRoot
    try {
        & bun link
        if ($LASTEXITCODE -ne 0) { throw "bun link exited with code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

# ---- Step 6: bun link -g opencode-usage (health-gated) ----
# Bun 1.3.14 on Windows can silently fail to create the global link entry.
# We health-gate: if the global exe already works, skip; otherwise try bun link -g,
# then fall back to a directory junction. Final health check determines exit code.
#
# Global package directory precedence (documented in Get-BunGlobalPkgDir):
#   1. BUN_INSTALL_GLOBAL_DIR   2. $HOME/.bunfig.toml install.globalDir
#   3. BUN_INSTALL default       4. HOME/.bun default
Invoke-Step -Number 6 -Description "Link opencode-usage globally (health-gated)" -Fatal {

    # ---- Validate bun pm bin -g ----
    $binResult = Invoke-NativeCommand -FilePath 'bun' -Arguments 'pm bin -g'
    if (-not $binResult.Success -or [string]::IsNullOrWhiteSpace($binResult.StdOut)) {
        throw ("Cannot determine global bin directory: 'bun pm bin -g' exited with code $($binResult.ExitCode) " +
               "stdout='$($binResult.StdOut.Trim())' stderr='$($binResult.StdErr.Trim())'. " +
               "Verify Bun is installed and on PATH.")
    }
    $globalBin = $binResult.StdOut.Trim()
    if (-not (Get-Item -Force -LiteralPath $globalBin -ErrorAction SilentlyContinue)) {
        throw "Global bin directory does not exist on disk: $globalBin (from 'bun pm bin -g')"
    }
    $exePath = Join-Path $globalBin 'opencode-usage.exe'

    # ---- Resolve global package directory ----
    # Get-BunGlobalPkgDir returns the uniform global root; append node_modules\<package>
    $globalPkgPath = Join-Path (Get-BunGlobalPkgDir) 'node_modules\opencode-usage'

    # Capture diagnostics across attempts for final error reporting
    $lastLinkResult  = $null
    $lastHealthCheck = $null

    # ---- Path A: existing junction to this repo -> skip bun link -g ----
    # Use Get-Item -Force to detect dangling reparse points (Test-Path returns $false for them)
    $existingItem = Get-Item -Force -LiteralPath $globalPkgPath -ErrorAction SilentlyContinue
    if ($existingItem) {
        $isReparse = $existingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint
        if ($isReparse -and (Test-JunctionToTarget -Path $globalPkgPath -ExpectedTarget $RepoRoot)) {
            Write-Host "  Existing junction points to repo; verifying health..." -ForegroundColor Yellow
            $lastHealthCheck = Test-GlobalCliHealth -ExePath $exePath
            if ($lastHealthCheck.Success) {
                Write-Host "  Global CLI healthy; skipping bun link -g." -ForegroundColor Green
                return
            }
            Write-Host "  Health check failed despite junction; re-linking..." -ForegroundColor Yellow
        }
    }

    # ---- Path B: run bun link -g, then health-check and verify junction identity ----
    Write-Host "  Running 'bun link -g opencode-usage'..." -ForegroundColor Yellow
    $lastLinkResult = Invoke-NativeCommand -FilePath 'bun' -Arguments 'link -g opencode-usage'

    Write-Host "  Health-checking global executable..." -ForegroundColor Yellow
    $lastHealthCheck = Test-GlobalCliHealth -ExePath $exePath
    if ($lastHealthCheck.Success) {
        # Health check passed, but also verify the global package entry is a junction to this repo.
        # A stale ordinary global package (e.g. from bun install -g) must not be reported as success.
        $postLinkItem = Get-Item -Force -LiteralPath $globalPkgPath -ErrorAction SilentlyContinue
        $postLinkIsReparse = $postLinkItem -and ($postLinkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
        if ($postLinkIsReparse -and (Test-JunctionToTarget -Path $globalPkgPath -ExpectedTarget $RepoRoot)) {
            Write-Host "  Global CLI verified and junction points to repo: $exePath" -ForegroundColor Green
            return
        }
        Write-Host "  Health check passed but global package is not a junction to repo; proceeding to fallback..." -ForegroundColor Yellow
    }

    # ---- Path C: junction fallback if health check failed ----
    Write-Host "  Health check failed; attempting junction fallback..." -ForegroundColor Yellow

    # Safe conflict handling: never delete a real directory
    # Use Get-Item -Force to detect dangling reparse points
    $existingItem = Get-Item -Force -LiteralPath $globalPkgPath -ErrorAction SilentlyContinue
    if ($existingItem) {
        $isLink = $existingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint
        if ($isLink) {
            Remove-JunctionSafely -Path $globalPkgPath
        }
        else {
            # Ordinary directory - refuse to delete
            throw ("A real directory exists at $globalPkgPath and is not a junction. " +
                   "Remove it manually if you want the junction fallback, then re-run this script.")
        }
    }

    # Create directory junction
    $junctionParent = Split-Path $globalPkgPath -Parent
    if (-not (Get-Item -Force -LiteralPath $junctionParent -ErrorAction SilentlyContinue)) {
        New-Item -ItemType Directory -Path $junctionParent -Force | Out-Null
    }
    New-Item -ItemType Junction -Path $globalPkgPath -Target $RepoRoot | Out-Null
    Write-Host "  Created junction: $globalPkgPath -> $RepoRoot" -ForegroundColor Yellow

    # Re-run health check after junction creation
    $lastHealthCheck = Test-GlobalCliHealth -ExePath $exePath

    # Verify junction actually points to repo (not just that health check passed)
    $junctionVerified = Test-JunctionToTarget -Path $globalPkgPath -ExpectedTarget $RepoRoot

    # ---- Final verdict ----
    if ($lastHealthCheck.Success -and $junctionVerified) {
        Write-Host "  Global CLI verified and junction points to repo: $exePath" -ForegroundColor Green
    }
    else {
        # Print meaningful diagnostics before throwing
        Write-Host ""
        Write-Host "  FINAL VERIFICATION FAILED" -ForegroundColor Red
        Write-Host "    Executable       : $exePath" -ForegroundColor Red
        Write-Host "    Health check     : $(if ($lastHealthCheck.Success) { 'passed' } else { "failed (exit $($lastHealthCheck.ExitCode))" })" -ForegroundColor Red
        Write-Host "    Junction to repo : $(if ($junctionVerified) { 'verified' } else { 'FAILED' })" -ForegroundColor Red
        if ($lastHealthCheck.StdOut) {
            Write-Host "    stdout           : $($lastHealthCheck.StdOut.Trim())" -ForegroundColor Yellow
        }
        if ($lastHealthCheck.StdErr) {
            Write-Host "    stderr           : $($lastHealthCheck.StdErr.Trim())" -ForegroundColor Yellow
        }
        if ($lastLinkResult) {
            Write-Host "    bun link -g exit  : $($lastLinkResult.ExitCode)" -ForegroundColor Yellow
            if ($lastLinkResult.StdOut) {
                Write-Host "    bun link -g stdout: $($lastLinkResult.StdOut.Trim())" -ForegroundColor Yellow
            }
            if ($lastLinkResult.StdErr) {
                Write-Host "    bun link -g stderr: $($lastLinkResult.StdErr.Trim())" -ForegroundColor Yellow
            }
        }
        Write-Host ""
        throw "Global CLI verification failed after junction fallback. See diagnostics above."
    }
}

# ---- Step 7: Report artifact existence ----
Write-Host ""
Write-Host "[7] Checking build artifacts" -ForegroundColor Cyan
Write-Host ("-" * 60)

$artifacts = @(
    @{ Path = Join-Path $RepoRoot 'dist\index.js';               Label = 'dist\index.js' }
    @{ Path = Join-Path $RepoRoot 'dist\index.d.ts';             Label = 'dist\index.d.ts' }
    @{ Path = Join-Path $RepoRoot 'dist\commander-ui\index.html'; Label = 'dist\commander-ui\index.html' }
)

$missingArtifactCount = 0
foreach ($a in $artifacts) {
    if (Test-Path $a.Path) {
        Write-Host "  [OK]   $($a.Label)" -ForegroundColor Green
    }
    else {
        Write-Host "  [MISS] $($a.Label)" -ForegroundColor Yellow
        $missingArtifactCount++
    }
}

# ---- Summary ----
Write-Host ""
if ($exitCode -ne 0) {
    Write-Host "Completed with warnings (see above)." -ForegroundColor Yellow
}
elseif ($missingArtifactCount -gt 0) {
    Write-Host "Build completed but $missingArtifactCount artifact(s) missing (see above)." -ForegroundColor Yellow
}
else {
    Write-Host "All steps completed successfully." -ForegroundColor Green
}

exit $exitCode
