& {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0

    $Project = '@@PROJECT@@'
    $Revision = 'R1.07'
    $ExpectedCommit = '@@EXPECTED_COMMIT@@'
    $ExpectedZipHash = '@@EXPECTED_ZIP_HASH@@'
    $ExpectedFileCount = @@EXPECTED_FILE_COUNT@@
    $PatchFileName = '@@PATCH_FILENAME@@'
    $BaselineManifestFileName = '@@BASELINE_MANIFEST_FILENAME@@'
    $ExpectedBaselineCommit = '@@BASELINE_COMMIT@@'

    $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\PingGPT'
    $Exe = Join-Path $InstallRoot 'PingGPT.exe'
    $AppRoot = Join-Path $InstallRoot 'resources\app'
    $Dist = Join-Path $AppRoot 'dist'
    $Renderer = Join-Path $AppRoot 'src\gui\renderer'
    $Assets = Join-Path $AppRoot 'src\gui\assets'
    $PackageJson = Join-Path $AppRoot 'package.json'

    $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $Desktop = [Environment]::GetFolderPath('Desktop')
    $BackupRoot = Join-Path $Desktop "PingGPT_PreR107_Backup_$Stamp"
    $TempRoot = Join-Path $env:TEMP "PingGPT_R107_$Stamp"
    $ReceiptPath = Join-Path $Desktop "PingGPT_R1.07_ApplyReceipt_$Stamp.txt"

    $MutationStarted = $false
    $BackupComplete = $false
    $RollbackStatus = 'NOT_NEEDED'
    $PreconditionStatus = 'UNVERIFIED'

    function Get-Sha256([string]$Path) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
    }

    function Write-Receipt([string]$Status, [string]$Detail) {
        @(
            'SCHEMA=pinggpt.apply-receipt.v1'
            "PROJECT=$Project"
            "REVISION=$Revision"
            "SOURCE_COMMIT=$ExpectedCommit"
            "BASELINE_COMMIT=$ExpectedBaselineCommit"
            "PRECONDITION=$PreconditionStatus"
            "MUTATION_STARTED=$MutationStarted"
            "BACKUP_COMPLETE=$BackupComplete"
            "ROLLBACK=$RollbackStatus"
            "STATUS=$Status"
            "DETAIL=$Detail"
            "BACKUP_PATH=$BackupRoot"
        ) | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
    }

    function Read-ManifestEntries([string[]]$Lines) {
        return @($Lines | Where-Object { $_ -like 'FILE=*' })
    }

    function Test-InstalledManifest([string[]]$Entries) {
        $Verified = 0
        foreach ($Line in $Entries) {
            $Parts = $Line -split '\|'
            if ($Parts.Count -ne 3) {
                return @{ Match = $false; Verified = $Verified; Detail = "Malformed manifest row: $Line" }
            }
            $Relative = $Parts[0].Substring(5)
            $ExpectedSize = [Int64]$Parts[1].Substring(5)
            $ExpectedHash = $Parts[2].Substring(7).ToUpperInvariant()
            if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains('..') -or [IO.Path]::IsPathRooted($Relative)) {
                return @{ Match = $false; Verified = $Verified; Detail = "Unsafe manifest path: $Relative" }
            }
            $InstalledFile = Join-Path $AppRoot ($Relative.Replace('/', '\'))
            if (-not (Test-Path -LiteralPath $InstalledFile -PathType Leaf)) {
                return @{ Match = $false; Verified = $Verified; Detail = "Missing installed file: $Relative" }
            }
            if ((Get-Item -LiteralPath $InstalledFile).Length -ne $ExpectedSize) {
                return @{ Match = $false; Verified = $Verified; Detail = "Installed size mismatch: $Relative" }
            }
            if ((Get-Sha256 $InstalledFile) -cne $ExpectedHash) {
                return @{ Match = $false; Verified = $Verified; Detail = "Installed SHA256 mismatch: $Relative" }
            }
            $Verified++
        }
        return @{ Match = $true; Verified = $Verified; Detail = 'MATCH' }
    }

    function Restore-Backup {
        Write-Host 'ROLLBACK             : START'
        Get-Process -Name 'PingGPT' -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue

        foreach ($Target in @($Dist, $Renderer, $Assets)) {
            if (Test-Path -LiteralPath $Target) {
                Remove-Item -LiteralPath $Target -Recurse -Force
            }
        }

        Copy-Item -LiteralPath (Join-Path $BackupRoot 'dist') -Destination $Dist -Recurse -Force
        New-Item -ItemType Directory -Path (Split-Path -Parent $Renderer) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'src\gui\renderer') -Destination $Renderer -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'src\gui\assets') -Destination $Assets -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'package.json') -Destination $PackageJson -Force
        $script:RollbackStatus = 'PASS'
        Write-Host 'ROLLBACK             : PASS'
    }

    Write-Host '============================================================'
    Write-Host "PROJECT       : $Project"
    Write-Host "REVISION      : $Revision"
    Write-Host "SOURCE COMMIT : $ExpectedCommit"
    Write-Host "BASELINE      : $ExpectedBaselineCommit"
    Write-Host 'MODE          : NATIVE_FILE / CODE ONLY / NO NEW EXE'
    Write-Host 'ADMIN         : NOT REQUIRED'
    Write-Host 'STATUS        : PREFLIGHT'
    Write-Host '============================================================'

    try {
        if (@(Get-Process -Name 'PingGPT' -ErrorAction SilentlyContinue).Count -gt 0) {
            throw 'PingGPT is still running. Use Exit PingGPT, then run this script again.'
        }

        foreach ($Required in @($Exe, $Dist, $Renderer, $Assets, $PackageJson)) {
            if (-not (Test-Path -LiteralPath $Required)) {
                throw "Required installed target is missing: $Required"
            }
        }

        if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
            throw 'The apply script must be run from the extracted DeliveryBundle folder.'
        }

        $PatchZip = Join-Path $PSScriptRoot $PatchFileName
        $BaselineManifestPath = Join-Path $PSScriptRoot $BaselineManifestFileName
        if (-not (Test-Path -LiteralPath $PatchZip -PathType Leaf)) {
            throw "Expected sibling runtime ZIP is missing: $PatchFileName"
        }
        if (-not (Test-Path -LiteralPath $BaselineManifestPath -PathType Leaf)) {
            throw "Expected sibling baseline manifest is missing: $BaselineManifestFileName"
        }

        $ObservedZipHash = Get-Sha256 $PatchZip
        if ($ObservedZipHash -cne $ExpectedZipHash) {
            throw "Runtime ZIP SHA256 mismatch. Expected=$ExpectedZipHash Actual=$ObservedZipHash"
        }

        if (Test-Path -LiteralPath $TempRoot) {
            Remove-Item -LiteralPath $TempRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
        Expand-Archive -LiteralPath $PatchZip -DestinationPath $TempRoot -Force

        $PayloadRoot = Join-Path $TempRoot 'payload'
        $ManifestPath = Join-Path $TempRoot 'FILE_SHA256_MANIFEST.txt'
        if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) { throw 'Patch payload is missing.' }
        if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'Patch manifest is missing.' }

        $ManifestLines = @(Get-Content -LiteralPath $ManifestPath -Encoding UTF8)
        $CommitLines = @($ManifestLines | Where-Object { $_ -like 'COMMIT=*' })
        if ($CommitLines.Count -ne 1) { throw 'Patch manifest has an invalid COMMIT field.' }
        $ObservedCommit = $CommitLines[0].Substring(7).Trim()
        if ($ObservedCommit -cne $ExpectedCommit) {
            throw "Patch commit mismatch. Expected=$ExpectedCommit Actual=$ObservedCommit"
        }
        if (@($ManifestLines | Where-Object { $_ -eq 'MODE=CODE_ONLY_NO_EXECUTABLE' }).Count -ne 1) {
            throw 'Patch is not marked CODE_ONLY_NO_EXECUTABLE.'
        }

        $Entries = Read-ManifestEntries $ManifestLines
        if ($Entries.Count -ne $ExpectedFileCount) {
            throw "Unexpected current manifest file count. Expected=$ExpectedFileCount Actual=$($Entries.Count)"
        }

        $ManifestPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $VerifiedFiles = 0
        foreach ($Line in $Entries) {
            $Parts = $Line -split '\|'
            if ($Parts.Count -ne 3) { throw "Malformed current manifest row: $Line" }
            $Relative = $Parts[0].Substring(5)
            $ExpectedSize = [Int64]$Parts[1].Substring(5)
            $ExpectedHash = $Parts[2].Substring(7).ToUpperInvariant()
            if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains('..') -or [IO.Path]::IsPathRooted($Relative)) {
                throw "Unsafe manifest path: $Relative"
            }
            [void]$ManifestPaths.Add($Relative.Replace('\','/'))
            $SourceFile = Join-Path $PayloadRoot ($Relative.Replace('/', '\'))
            if (-not (Test-Path -LiteralPath $SourceFile -PathType Leaf)) { throw "Payload file missing: $Relative" }
            if ((Get-Item -LiteralPath $SourceFile).Length -ne $ExpectedSize) { throw "Payload size mismatch: $Relative" }
            if ((Get-Sha256 $SourceFile) -cne $ExpectedHash) { throw "Payload SHA256 mismatch: $Relative" }
            $VerifiedFiles++
        }

        $ActualFiles = @(
            Get-ChildItem -LiteralPath $PayloadRoot -File -Recurse | ForEach-Object {
                $Prefix = $PayloadRoot.TrimEnd('\') + '\'
                $_.FullName.Substring($Prefix.Length).Replace('\','/')
            }
        )
        if ($ActualFiles.Count -ne $ExpectedFileCount) {
            throw "Unexpected payload file count. Expected=$ExpectedFileCount Actual=$($ActualFiles.Count)"
        }
        foreach ($Relative in $ActualFiles) {
            if (-not $ManifestPaths.Contains($Relative)) { throw "Unexpected payload file: $Relative" }
            $Ext = [IO.Path]::GetExtension($Relative).ToLowerInvariant()
            if ($Ext -in @('.exe','.dll','.node','.msi','.sys','.com','.scr','.bat','.cmd','.ps1')) {
                throw "Executable/binary-like payload is not allowed: $Relative"
            }
        }

        $BaselineLines = @(Get-Content -LiteralPath $BaselineManifestPath -Encoding UTF8)
        $BaselineCommitLines = @($BaselineLines | Where-Object { $_ -like 'COMMIT=*' })
        if ($BaselineCommitLines.Count -ne 1 -or $BaselineCommitLines[0].Substring(7).Trim() -cne $ExpectedBaselineCommit) {
            throw 'Baseline manifest commit identity does not match the expected R1.06 baseline.'
        }
        $BaselineEntries = Read-ManifestEntries $BaselineLines
        if ($BaselineEntries.Count -lt 1) { throw 'Baseline manifest contains no managed files.' }

        $CurrentInstalled = Test-InstalledManifest $Entries
        if ($CurrentInstalled.Match) {
            $PreconditionStatus = 'ALREADY_R1.07'
            Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
            Write-Receipt 'ALREADY_APPLIED' 'Installed managed code already matches the exact R1.07 payload.'
            Write-Host "PRECONDITION          : $PreconditionStatus"
            Write-Host "RECEIPT              : $ReceiptPath"
            Write-Host 'STATUS               : ALREADY_APPLIED'
            Start-Process -FilePath $Exe
            return
        }

        $BaselineInstalled = Test-InstalledManifest $BaselineEntries
        if (-not $BaselineInstalled.Match) {
            $PreconditionStatus = 'BASELINE_MISMATCH'
            throw "Installed managed code matches neither exact R1.06 baseline nor current R1.07 payload. $($BaselineInstalled.Detail)"
        }
        $PreconditionStatus = 'EXACT_R1.06_BASELINE'

        $ExeHashBefore = Get-Sha256 $Exe
        Write-Host "PATCH ZIP            : $PatchZip"
        Write-Host "PATCH SHA256         : $ExpectedZipHash"
        Write-Host "PAYLOAD VERIFIED     : $VerifiedFiles / $ExpectedFileCount"
        Write-Host "BASELINE VERIFIED    : $($BaselineInstalled.Verified) / $($BaselineEntries.Count)"
        Write-Host "PRECONDITION         : $PreconditionStatus"
        Write-Host 'PREFLIGHT             : PASS'

        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $BackupRoot 'src\gui') -Force | Out-Null
        Copy-Item -LiteralPath $Dist -Destination (Join-Path $BackupRoot 'dist') -Recurse -Force
        Copy-Item -LiteralPath $Renderer -Destination (Join-Path $BackupRoot 'src\gui\renderer') -Recurse -Force
        Copy-Item -LiteralPath $Assets -Destination (Join-Path $BackupRoot 'src\gui\assets') -Recurse -Force
        Copy-Item -LiteralPath $PackageJson -Destination (Join-Path $BackupRoot 'package.json') -Force
        $BackupComplete = $true

        $MutationStarted = $true
        Remove-Item -LiteralPath $Dist -Recurse -Force
        Remove-Item -LiteralPath $Renderer -Recurse -Force
        Remove-Item -LiteralPath $Assets -Recurse -Force

        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'dist') -Destination $Dist -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'src\gui\renderer') -Destination $Renderer -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'src\gui\assets') -Destination $Assets -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'package.json') -Destination $PackageJson -Force

        $InstalledCurrent = Test-InstalledManifest $Entries
        if (-not $InstalledCurrent.Match -or $InstalledCurrent.Verified -ne $ExpectedFileCount) {
            throw "Postcondition verification failed. $($InstalledCurrent.Detail)"
        }

        $ExeHashAfter = Get-Sha256 $Exe
        if ($ExeHashAfter -cne $ExeHashBefore) { throw 'Existing PingGPT.exe changed unexpectedly.' }

        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
        Write-Receipt 'PATCH_VERIFIED' "Installed and verified $($InstalledCurrent.Verified) managed files."

        Write-Host ''
        Write-Host '================ RESULT ================'
        Write-Host "PROJECT              : $Project"
        Write-Host "REVISION             : $Revision"
        Write-Host "SOURCE_COMMIT        : $ExpectedCommit"
        Write-Host "BASELINE_COMMIT      : $ExpectedBaselineCommit"
        Write-Host "PRECONDITION         : $PreconditionStatus"
        Write-Host "PAYLOAD_VERIFIED     : $VerifiedFiles / $ExpectedFileCount"
        Write-Host "INSTALLED_VERIFIED   : $($InstalledCurrent.Verified) / $ExpectedFileCount"
        Write-Host 'PINGGPT_EXE_CHANGED  : NO'
        Write-Host 'NODE_MODULES_CHANGED : NO / OUTSIDE MUTATION SCOPE'
        Write-Host "BACKUP_PATH          : $BackupRoot"
        Write-Host "RECEIPT              : $ReceiptPath"
        Write-Host 'STATUS               : PATCH_VERIFIED'
        Write-Host '========================================'
        Start-Process -FilePath $Exe
    }
    catch {
        $Failure = $_.Exception.Message
        Write-Host ''
        Write-Host "ERROR                : $Failure"

        if ($MutationStarted -and $BackupComplete) {
            try { Restore-Backup }
            catch {
                $RollbackStatus = "FAILED / $($_.Exception.Message)"
                Write-Host "ROLLBACK             : $RollbackStatus"
            }
        } else {
            $RollbackStatus = 'NOT_NEEDED'
            Write-Host 'ROLLBACK             : NOT NEEDED / mutation did not start'
        }

        if (Test-Path -LiteralPath $TempRoot) {
            Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        try { Write-Receipt 'FAILED' $Failure } catch { }
        Write-Host "RECEIPT              : $ReceiptPath"
        throw
    }
}
