& {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0

    $Project = '@@PROJECT@@'
    $ExpectedCommit = '@@EXPECTED_COMMIT@@'
    $ExpectedZipHash = '@@EXPECTED_ZIP_HASH@@'
    $ExpectedFileCount = @@EXPECTED_FILE_COUNT@@
    $PatchFileName = '@@PATCH_FILENAME@@'
    $RollbackFileName = '@@ROLLBACK_FILENAME@@'

    $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\PingGPT'
    $Exe = Join-Path $InstallRoot 'PingGPT.exe'
    $AppRoot = Join-Path $InstallRoot 'resources\app'
    $Dist = Join-Path $AppRoot 'dist'
    $Renderer = Join-Path $AppRoot 'src\gui\renderer'
    $Assets = Join-Path $AppRoot 'src\gui\assets'
    $PackageJson = Join-Path $AppRoot 'package.json'

    $UserHome = [Environment]::GetFolderPath('UserProfile')
    $ConfigBase = if ([string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) { Join-Path $UserHome '.config' } else { $env:XDG_CONFIG_HOME }
    $StateBase = if ([string]::IsNullOrWhiteSpace($env:XDG_STATE_HOME)) { Join-Path $UserHome '.local\state' } else { $env:XDG_STATE_HOME }
    $ConfigDir = Join-Path $ConfigBase 'automode'
    $StateDir = Join-Path $StateBase 'automode'

    $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $Desktop = [Environment]::GetFolderPath('Desktop')
    $BackupRoot = Join-Path $Desktop "@@BACKUP_TAG@@_$Stamp"
    $TempRoot = Join-Path $env:TEMP "@@TEMP_TAG@@_$Stamp"
    $MutationStarted = $false
    $BackupComplete = $false

    function Get-Sha256([string]$Path) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
    }

    function Backup-StateFile([string]$Key, [string]$Source, [string]$Relative) {
        $Manifest = Join-Path $BackupRoot 'STATE_BACKUP_MANIFEST.txt'
        if (Test-Path -LiteralPath $Source -PathType Leaf) {
            $Destination = Join-Path $BackupRoot $Relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            "$Key|PRESENT|$(Get-Sha256 $Source)" | Add-Content -LiteralPath $Manifest -Encoding UTF8
        } else {
            "$Key|ABSENT|" | Add-Content -LiteralPath $Manifest -Encoding UTF8
        }
    }

    function Backup-ScheduledTasks {
        $TaskRoot = Join-Path $BackupRoot 'scheduled-tasks'
        New-Item -ItemType Directory -Path $TaskRoot -Force | Out-Null
        $Index = Join-Path $TaskRoot 'TASK_INDEX.txt'
        'SCHEMA=pinggpt.scheduler-backup.v1' | Set-Content -LiteralPath $Index -Encoding UTF8

        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        $folder = $svc.GetFolder('\')
        $owned = @($folder.GetTasks(0) | Where-Object {
            $_.Name -like 'Automode GUI Ping *' -or $_.Name -like 'PingGPT Task Resume *'
        })

        $i = 0
        foreach ($task in $owned) {
            $i++
            $fileName = ('task-{0:D3}.xml' -f $i)
            $xmlPath = Join-Path $TaskRoot $fileName
            $task.Xml | Set-Content -LiteralPath $xmlPath -Encoding Unicode
            $name64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$task.Name))
            "TASK|$name64|$fileName|$(Get-Sha256 $xmlPath)" | Add-Content -LiteralPath $Index -Encoding UTF8
        }
        "COUNT=$i" | Add-Content -LiteralPath $Index -Encoding UTF8
    }

    function Restore-CodeBackup {
        Write-Host 'ROLLBACK_CODE        : START'
        Get-Process -Name 'PingGPT' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        foreach ($Target in @($Dist, $Renderer, $Assets)) {
            if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
        }
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\dist') -Destination $Dist -Recurse -Force
        New-Item -ItemType Directory -Path (Split-Path -Parent $Renderer) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\src\gui\renderer') -Destination $Renderer -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\src\gui\assets') -Destination $Assets -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\package.json') -Destination $PackageJson -Force
        Write-Host 'ROLLBACK_CODE        : PASS'
    }

    Write-Host '============================================================'
    Write-Host "PROJECT       : $Project"
    Write-Host "SOURCE COMMIT : $ExpectedCommit"
    Write-Host 'MODE          : CODE ONLY + ROLLBACK SNAPSHOT'
    Write-Host 'ADMIN         : NOT REQUIRED'
    Write-Host 'STATUS        : PREFLIGHT'
    Write-Host '============================================================'

    try {
        if (@(Get-Process -Name 'PingGPT' -ErrorAction SilentlyContinue).Count -gt 0) {
            throw 'PingGPT is still running. Use Exit PingGPT, then run this script again.'
        }

        foreach ($Required in @($Exe, $Dist, $Renderer, $Assets, $PackageJson)) {
            if (-not (Test-Path -LiteralPath $Required)) { throw "Required installed target is missing: $Required" }
        }

        if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
            throw 'The apply script must be run from the extracted DeliveryBundle folder.'
        }

        $PatchZip = Join-Path $PSScriptRoot $PatchFileName
        $RollbackSource = Join-Path $PSScriptRoot $RollbackFileName
        if (-not (Test-Path -LiteralPath $PatchZip -PathType Leaf)) { throw "Expected sibling runtime ZIP is missing: $PatchFileName" }
        if (-not (Test-Path -LiteralPath $RollbackSource -PathType Leaf)) { throw "Expected sibling rollback script is missing: $RollbackFileName" }

        $ObservedZipHash = Get-Sha256 $PatchZip
        if ($ObservedZipHash -cne $ExpectedZipHash) {
            throw "Runtime ZIP SHA256 mismatch. Expected=$ExpectedZipHash Actual=$ObservedZipHash"
        }
        $ExeHashBefore = Get-Sha256 $Exe

        if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force }
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

        $Entries = @($ManifestLines | Where-Object { $_ -like 'FILE=*' })
        if ($Entries.Count -ne $ExpectedFileCount) {
            throw "Unexpected manifest file count. Expected=$ExpectedFileCount Actual=$($Entries.Count)"
        }

        $ManifestPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $VerifiedFiles = 0
        foreach ($Line in $Entries) {
            $Parts = $Line -split '\|'
            if ($Parts.Count -ne 3) { throw "Malformed manifest row: $Line" }
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

        $ActualFiles = @(Get-ChildItem -LiteralPath $PayloadRoot -File -Recurse | ForEach-Object {
            $Prefix = $PayloadRoot.TrimEnd('\') + '\'
            $_.FullName.Substring($Prefix.Length).Replace('\','/')
        })
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

        New-Item -ItemType Directory -Path (Join-Path $BackupRoot 'app\src\gui') -Force | Out-Null
        Copy-Item -LiteralPath $Dist -Destination (Join-Path $BackupRoot 'app\dist') -Recurse -Force
        Copy-Item -LiteralPath $Renderer -Destination (Join-Path $BackupRoot 'app\src\gui\renderer') -Recurse -Force
        Copy-Item -LiteralPath $Assets -Destination (Join-Path $BackupRoot 'app\src\gui\assets') -Recurse -Force
        Copy-Item -LiteralPath $PackageJson -Destination (Join-Path $BackupRoot 'app\package.json') -Force

        'SCHEMA=pinggpt.r107-state-backup.v1' | Set-Content -LiteralPath (Join-Path $BackupRoot 'STATE_BACKUP_MANIFEST.txt') -Encoding UTF8
        Backup-StateFile 'CONFIG' (Join-Path $ConfigDir 'config.toml') 'user-config\config.toml'
        Backup-StateFile 'PREFERENCES' (Join-Path $StateDir 'gui-preferences.json') 'user-state\gui-preferences.json'
        Backup-StateFile 'PING_RECEIPT' (Join-Path $StateDir 'gui-schedule.json') 'user-state\gui-schedule.json'
        Backup-StateFile 'RESUME_RECEIPT' (Join-Path $StateDir 'task-resume-schedule.json') 'user-state\task-resume-schedule.json'
        Backup-ScheduledTasks
        Copy-Item -LiteralPath $RollbackSource -Destination (Join-Path $BackupRoot $RollbackFileName) -Force
        $BackupComplete = $true

        Write-Host "PATCH ZIP            : $PatchZip"
        Write-Host "PATCH SHA256         : $ExpectedZipHash"
        Write-Host "PAYLOAD VERIFIED     : $VerifiedFiles / $ExpectedFileCount"
        Write-Host "BACKUP PATH          : $BackupRoot"
        Write-Host "ROLLBACK SCRIPT      : $(Join-Path $BackupRoot $RollbackFileName)"
        Write-Host 'PREFLIGHT             : PASS'

        $MutationStarted = $true
        Remove-Item -LiteralPath $Dist -Recurse -Force
        Remove-Item -LiteralPath $Renderer -Recurse -Force
        Remove-Item -LiteralPath $Assets -Recurse -Force

        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'dist') -Destination $Dist -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'src\gui\renderer') -Destination $Renderer -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'src\gui\assets') -Destination $Assets -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PayloadRoot 'package.json') -Destination $PackageJson -Force

        $InstalledVerified = 0
        foreach ($Line in $Entries) {
            $Parts = $Line -split '\|'
            $Relative = $Parts[0].Substring(5)
            $ExpectedSize = [Int64]$Parts[1].Substring(5)
            $ExpectedHash = $Parts[2].Substring(7).ToUpperInvariant()
            $InstalledFile = Join-Path $AppRoot ($Relative.Replace('/', '\'))
            if (-not (Test-Path -LiteralPath $InstalledFile -PathType Leaf)) { throw "Installed file missing: $Relative" }
            if ((Get-Item -LiteralPath $InstalledFile).Length -ne $ExpectedSize) { throw "Installed size mismatch: $Relative" }
            if ((Get-Sha256 $InstalledFile) -cne $ExpectedHash) { throw "Installed SHA256 mismatch: $Relative" }
            $InstalledVerified++
        }

        $ExeHashAfter = Get-Sha256 $Exe
        if ($ExeHashAfter -cne $ExeHashBefore) { throw 'Existing PingGPT.exe changed unexpectedly.' }
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue

        Write-Host ''
        Write-Host '================ RESULT ================'
        Write-Host "PROJECT              : $Project"
        Write-Host "SOURCE_COMMIT        : $ExpectedCommit"
        Write-Host "PATCH_SHA256         : $ExpectedZipHash"
        Write-Host "PAYLOAD_VERIFIED     : $VerifiedFiles / $ExpectedFileCount"
        Write-Host "INSTALLED_VERIFIED   : $InstalledVerified / $ExpectedFileCount"
        Write-Host 'PINGGPT_EXE_CHANGED   : NO'
        Write-Host 'NODE_MODULES_CHANGED  : NO / OUTSIDE MUTATION SCOPE'
        Write-Host "BACKUP_PATH          : $BackupRoot"
        Write-Host "ROLLBACK_SCRIPT      : $(Join-Path $BackupRoot $RollbackFileName)"
        Write-Host 'STATUS               : PATCH_VERIFIED'
        Write-Host '========================================'
        Start-Process -FilePath $Exe
    }
    catch {
        $Failure = $_.Exception.Message
        Write-Host ''
        Write-Host "ERROR                : $Failure"
        if ($MutationStarted -and $BackupComplete) {
            try { Restore-CodeBackup }
            catch { Write-Host "ROLLBACK_CODE        : FAILED / $($_.Exception.Message)" }
        } else {
            Write-Host 'ROLLBACK_CODE        : NOT NEEDED / mutation did not start'
        }
        if (Test-Path -LiteralPath $TempRoot) {
            Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}