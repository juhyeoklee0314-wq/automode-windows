& {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0

    $Project = '@@PROJECT@@'
    $ExpectedCommit = '@@EXPECTED_COMMIT@@'
    $BackupRoot = $PSScriptRoot

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

    function Get-StateTarget([string]$Key) {
        switch ($Key) {
            'CONFIG' { return @{ Target = (Join-Path $ConfigDir 'config.toml'); Backup = (Join-Path $BackupRoot 'user-config\config.toml') } }
            'PREFERENCES' { return @{ Target = (Join-Path $StateDir 'gui-preferences.json'); Backup = (Join-Path $BackupRoot 'user-state\gui-preferences.json') } }
            'PING_RECEIPT' { return @{ Target = (Join-Path $StateDir 'gui-schedule.json'); Backup = (Join-Path $BackupRoot 'user-state\gui-schedule.json') } }
            'RESUME_RECEIPT' { return @{ Target = (Join-Path $StateDir 'task-resume-schedule.json'); Backup = (Join-Path $BackupRoot 'user-state\task-resume-schedule.json') } }
            default { throw "Unknown rollback state key: $Key" }
        }
    }

    function Snapshot-CurrentState {
        $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $Root = Join-Path $BackupRoot "pre-rollback-state_$Stamp"
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
        foreach ($pair in @(
            @{ Key='CONFIG'; Path=(Join-Path $ConfigDir 'config.toml') },
            @{ Key='PREFERENCES'; Path=(Join-Path $StateDir 'gui-preferences.json') },
            @{ Key='PING_RECEIPT'; Path=(Join-Path $StateDir 'gui-schedule.json') },
            @{ Key='RESUME_RECEIPT'; Path=(Join-Path $StateDir 'task-resume-schedule.json') }
        )) {
            if (Test-Path -LiteralPath $pair.Path -PathType Leaf) {
                Copy-Item -LiteralPath $pair.Path -Destination (Join-Path $Root ($pair.Key + '.bak')) -Force
            }
        }
        return $Root
    }

    function Restore-State {
        $Manifest = Join-Path $BackupRoot 'STATE_BACKUP_MANIFEST.txt'
        if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { throw 'State backup manifest is missing.' }
        foreach ($line in Get-Content -LiteralPath $Manifest -Encoding UTF8) {
            if ($line -like 'SCHEMA=*' -or [string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split '\|', 3
            if ($parts.Count -lt 2) { throw "Malformed state backup row: $line" }
            $mapping = Get-StateTarget $parts[0]
            $target = [string]$mapping.Target
            $backup = [string]$mapping.Backup
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            if ($parts[1] -eq 'PRESENT') {
                if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Backup state file missing: $backup" }
                Copy-Item -LiteralPath $backup -Destination $target -Force
            } elseif ($parts[1] -eq 'ABSENT') {
                Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
            } else {
                throw "Unknown state backup status: $($parts[1])"
            }
        }
    }

    function Restore-ScheduledTasks {
        $TaskRoot = Join-Path $BackupRoot 'scheduled-tasks'
        $Index = Join-Path $TaskRoot 'TASK_INDEX.txt'
        if (-not (Test-Path -LiteralPath $Index -PathType Leaf)) { throw 'Scheduled-task backup index is missing.' }

        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        $folder = $svc.GetFolder('\')
        $current = @($folder.GetTasks(0) | Where-Object {
            $_.Name -like 'Automode GUI Ping *' -or $_.Name -like 'PingGPT Task Resume *'
        })
        foreach ($task in $current) { $folder.DeleteTask($task.Name, 0) }

        foreach ($line in Get-Content -LiteralPath $Index -Encoding UTF8) {
            if ($line -notlike 'TASK|*') { continue }
            $parts = $line -split '\|'
            if ($parts.Count -ne 4) { throw "Malformed scheduled-task backup row: $line" }
            $name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
            $xml = Join-Path $TaskRoot $parts[2]
            if (-not (Test-Path -LiteralPath $xml -PathType Leaf)) { throw "Scheduled-task XML is missing: $xml" }
            & schtasks.exe /Create /F /TN $name /XML $xml | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Could not restore scheduled task: $name" }
        }
    }

    Write-Host '============================================================'
    Write-Host "PROJECT       : $Project"
    Write-Host "SOURCE COMMIT : $ExpectedCommit"
    Write-Host "BACKUP ROOT   : $BackupRoot"
    Write-Host 'MODE          : R1.07 FULL ROLLBACK'
    Write-Host '============================================================'

    if ([string]::IsNullOrWhiteSpace($BackupRoot) -or -not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
        throw 'Run this rollback script from the backup folder created by the R1.07 apply script.'
    }

    foreach ($Required in @(
        (Join-Path $BackupRoot 'app\dist'),
        (Join-Path $BackupRoot 'app\src\gui\renderer'),
        (Join-Path $BackupRoot 'app\src\gui\assets'),
        (Join-Path $BackupRoot 'app\package.json')
    )) {
        if (-not (Test-Path -LiteralPath $Required)) { throw "Required code backup is missing: $Required" }
    }

    Get-Process -Name 'PingGPT' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $PreRollback = Snapshot-CurrentState

    foreach ($Target in @($Dist, $Renderer, $Assets)) {
        if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    }
    Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\dist') -Destination $Dist -Recurse -Force
    New-Item -ItemType Directory -Path (Split-Path -Parent $Renderer) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\src\gui\renderer') -Destination $Renderer -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\src\gui\assets') -Destination $Assets -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $BackupRoot 'app\package.json') -Destination $PackageJson -Force

    Restore-State
    Restore-ScheduledTasks

    Write-Host ''
    Write-Host '================ RESULT ================'
    Write-Host 'CODE_RESTORED         : YES'
    Write-Host 'SETTINGS_RESTORED     : YES'
    Write-Host 'SCHEDULER_RESTORED    : YES'
    Write-Host "PRE_ROLLBACK_SNAPSHOT : $PreRollback"
    Write-Host 'NEW_CODEX_STORES      : LEFT UNTOUCHED'
    Write-Host 'STATUS                : ROLLBACK_COMPLETE'
    Write-Host '========================================'
    Start-Process -FilePath $Exe
}