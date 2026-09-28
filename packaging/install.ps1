#Requires -Version 5.1
#
# Sabia server installer for Windows (PowerShell 5.1 and later).
#
# Two supported invocation forms:
#   irm https://raw.githubusercontent.com/oshogun/sabia/main/packaging/install.ps1 | iex
#     (options are passed as SABIA_* environment variables, since a param()
#     block cannot bind arguments when its text is fed to iex)
#   & ([scriptblock]::Create((irm .../install.ps1))) -Port 3443
#     (options are passed as named parameters; falls back to SABIA_* env vars,
#     then to defaults, exactly like install.sh's flag/env precedence)
#
# This script never calls exit at the top level: under iex that would close
# the caller's PowerShell window. Failures are reported with throw, which
# under iex ends the piped evaluation without closing the session, and under
# a real .ps1 invocation sets a non-zero automatic result the caller can
# catch with try/catch.

param(
    [string] $Version = $env:SABIA_VERSION,
    [string] $Bundle = $env:SABIA_BUNDLE,
    [string] $InstallDir = $env:SABIA_INSTALL_DIR,
    [string] $Port = $env:SABIA_PORT,
    [string] $BindHost = $env:SABIA_BIND_HOST,
    [string] $Username = $env:SABIA_OPERATOR_USERNAME,
    [string] $PasswordFile = $env:SABIA_OPERATOR_PASSWORD_FILE,
    [string] $TlsSan = $env:SABIA_TLS_SAN,
    [switch] $RenewCert = ($env:SABIA_RENEW_CERT -eq '1'),
    [switch] $NoChromium = ($env:SABIA_NO_CHROMIUM -eq '1'),
    [switch] $NoService = ($env:SABIA_NO_SERVICE -eq '1'),
    [switch] $Force = ($env:SABIA_FORCE -eq '1'),
    [switch] $Uninstall = ($env:SABIA_UNINSTALL -eq '1'),
    [switch] $Purge = ($env:SABIA_PURGE -eq '1'),
    [switch] $Yes = ($env:SABIA_YES -eq '1'),
    [switch] $NoElevate = ($env:SABIA_NO_ELEVATE -eq '1'),
    [switch] $Help
)

function Install-Sabia {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $ReleaseBaseUrl = if ($env:SABIA_RELEASE_BASE_URL) { $env:SABIA_RELEASE_BASE_URL } else { 'https://github.com/oshogun/sabia/releases/download' }
    $ApiUrl = if ($env:SABIA_API_URL) { $env:SABIA_API_URL } else { 'https://api.github.com/repos/oshogun/sabia/releases/latest' }
    $NodeDistUrl = if ($env:SABIA_NODE_DIST_URL) { $env:SABIA_NODE_DIST_URL } else { 'https://nodejs.org/dist' }

    $AppEntries = @('dist', 'client', 'package.json', 'package-lock.json', 'airports.json', 'airport-tiers.json', 'VERSION', 'LICENSE')

    # Variables the server itself reads. Any of these lingering in the
    # installer's own session (or the service wrapper's) must never leak into
    # a node process the installer launches, or that process can silently
    # target the wrong port/database/certificate.
    $ServerEnvKeys = @(
        'PORT', 'BIND_HOST', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'INGEST_TOKEN', 'MCP_TOKEN',
        'SESSION_SECRET', 'FLIGHTS_DB_PATH', 'NAVDATA_DB_PATH', 'ALLOW_PLAINTEXT_HTTP',
        'ALLOW_UNAUTHENTICATED_INGEST', 'PUPPETEER_CACHE_DIR'
    )

    # ---- small utilities --------------------------------------------------

    function Write-Info([string] $Message) { Write-Host "sabia-install: $Message" }
    function Write-Warn2([string] $Message) { Write-Warning "sabia-install: $Message" }

    function New-Utf8NoBomFile([string] $Path, [string] $Content) {
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $encoding = New-Object Text.UTF8Encoding($false)
        $tmp = "$Path.$PID.tmp"
        [IO.File]::WriteAllText($tmp, $Content, $encoding)
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    }

    function Get-InstallDirDefault {
        $localAppData = $env:LOCALAPPDATA
        if (-not $localAppData) { throw 'LOCALAPPDATA is not set; cannot compute a default install directory. Pass -InstallDir.' }
        return (Join-Path $localAppData 'Sabia')
    }

    function Assert-ValidInstallDir([string] $Path) {
        $full = [IO.Path]::GetFullPath($Path)
        if ($full -match '[#%"\r\n]') {
            throw "Install directory `"$full`" must not contain '#', '%', a double quote, or a line break."
        }
        $root = [IO.Path]::GetPathRoot($full)
        if ($full.TrimEnd('\') -eq $root.TrimEnd('\')) {
            throw "Install directory `"$full`" must not be a drive root."
        }
        if ($env:USERPROFILE -and ($full.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\'))) {
            throw "Install directory `"$full`" must not be the user's profile directory itself."
        }
        return $full
    }

    function Assert-ValidPort([string] $Value, [string] $Label) {
        if (($Value -notmatch '^\d+$') -or ([int] $Value -lt 1024) -or ([int] $Value -gt 65535)) {
            throw "$Label must be an integer between 1024 and 65535, got '$Value'."
        }
    }

    # Reads one KEY from a raw sabia.env snapshot without going through the
    # helper CLI - used only to decide whether the requested port/bind-host
    # differs from what is already running, never as the source of truth for
    # what gets written (env-merge remains that).
    function Get-EnvFileValue([string] $Text, [string] $Key) {
        if (-not $Text) { return $null }
        $line = ($Text -split "`r?`n") | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -Last 1
        if (-not $line) { return $null }
        $value = $line.Substring($line.IndexOf('=') + 1)
        $hashIndex = $value.IndexOf('#')
        if ($hashIndex -ge 0) { $value = $value.Substring(0, $hashIndex) }
        return $value.Trim()
    }

    # PowerShell single-quoted strings escape an embedded quote by doubling
    # it; every path interpolated into a single-quoted segment of a command
    # string handed to an elevated process must go through this first, or a
    # path like "O'Brien" breaks the command.
    function Format-PSSingleQuoted([string] $Value) {
        return $Value -replace "'", "''"
    }

    function Read-Marker([string] $Root) {
        $path = Join-Path $Root '.sabia-install'
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        $marker = @{}
        # Read as raw UTF-8 explicitly, same reason as the sabia.env snapshot
        # further down: Get-Content without -Encoding would decode this
        # BOM-less file using the system codepage on Windows PowerShell 5.1.
        $text = [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))
        foreach ($line in ($text -split "`r?`n")) {
            if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
            $idx = $line.IndexOf('=')
            $key = $line.Substring(0, $idx).Trim()
            $value = $line.Substring($idx + 1).Trim()
            $marker[$key] = $value
        }
        return $marker
    }

    function Write-Marker([string] $Root, [hashtable] $Fields) {
        $order = @('layout', 'version', 'node', 'os', 'arch', 'autostart', 'firewall_rule', 'state', 'installed_at', 'updated_at')
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add('# Sabia install marker - written by the installer, do not edit.')
        foreach ($key in $order) {
            if ($Fields.ContainsKey($key)) { $lines.Add("$key=$($Fields[$key])") }
        }
        New-Utf8NoBomFile -Path (Join-Path $Root '.sabia-install') -Content (($lines -join "`n") + "`n")
    }

    function Get-NodeArch {
        $arch = $env:PROCESSOR_ARCHITEW6432
        if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
        switch ($arch) {
            'AMD64' { return 'x64' }
            'ARM64' { return 'arm64' }
            default { throw "Unsupported processor architecture '$arch'. Sabia's private Node download supports x64 and arm64 only." }
        }
    }

    function Test-IsElevated {
        $identity = New-Object Security.Principal.WindowsIdentity([Security.Principal.WindowsIdentity]::GetCurrent().Token)
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }

    function Invoke-ElevatedCommand([string] $Command) {
        $bytes = [Text.Encoding]::Unicode.GetBytes($Command)
        $encoded = [Convert]::ToBase64String($bytes)
        $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
        return $proc.ExitCode
    }

    # Runs a scriptblock with every $ServerEnvKeys variable removed from the
    # process environment, then restores exactly what was there before -
    # restoring a stray value is as important as clearing it, since these
    # variables live in the caller's session, not this function's scope.
    function Invoke-WithoutServerEnv([scriptblock] $Body) {
        $saved = @{}
        foreach ($key in $ServerEnvKeys) {
            $saved[$key] = [Environment]::GetEnvironmentVariable($key)
            if ($null -ne $saved[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }
        }
        try {
            & $Body
        } finally {
            foreach ($key in $ServerEnvKeys) {
                if ($null -ne $saved[$key]) { Set-Item -Path "Env:$key" -Value $saved[$key] -ErrorAction SilentlyContinue }
            }
        }
    }

    # Every text download (the GitHub API JSON, nodejs.org's SHASUMS256.txt,
    # a release's .sha256) goes through a file rather than the response
    # object's own .Content property: Invoke-WebRequest -UseBasicParsing
    # returns .Content as a byte[], not a string, whenever the server's
    # Content-Type isn't recognised as text - and GitHub serves a release
    # .sha256 asset (and gh release upload assigns it) as
    # application/octet-stream. Binding that byte[] to a [string] parameter
    # doesn't throw; it silently becomes space-joined decimal numbers, which
    # is not the hash anyone was expecting. -OutFile always writes the exact
    # response bytes regardless of Content-Type, so reading them back
    # ourselves with an explicit encoding is what actually makes this
    # independent of what the server claims to be serving.
    function Invoke-TextDownload([string] $Uri, [hashtable] $Headers) {
        $tempPath = Join-Path $lockDir "download.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
        try {
            if ($Headers) {
                Invoke-WebRequest -Uri $Uri -OutFile $tempPath -UseBasicParsing -Headers $Headers
            } else {
                Invoke-WebRequest -Uri $Uri -OutFile $tempPath -UseBasicParsing
            }
            return [IO.File]::ReadAllText($tempPath, (New-Object Text.UTF8Encoding($false)))
        } finally {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }

    # Deliberately does not merge stderr with 2>&1: under Windows PowerShell
    # 5.1, a native command's stderr line merged into the success stream can
    # be wrapped as a non-terminating ErrorRecord, which $ErrorActionPreference
    # = 'Stop' (set by the caller, Install-Sabia) would then escalate into a
    # terminating error before the exit code is ever inspected - unverifiable
    # without a real Windows host, so it is avoided rather than risked.
    # $ErrorActionPreference is set to 'Continue' here, function-scoped, so it
    # reverts automatically on return and never affects the caller.
    function Invoke-Helper([string] $NodeExe, [string] $CliPath, [string[]] $CliArgs) {
        $ErrorActionPreference = 'Continue'
        # Under the root's own .install.lock, never %TEMP% - nothing this
        # installer writes should land outside the root, and .install.lock
        # exists for the whole run.
        $stderrFile = Join-Path $lockDir "helper.$PID.$([Guid]::NewGuid().ToString('N')).err"
        $utf8NoBom = New-Object Text.UTF8Encoding($false)
        # PowerShell decodes a captured native process's stdout using
        # [Console]::OutputEncoding (not the file-system-safe wide APIs that
        # Join-Path/Test-Path/etc use), and encodes text piped into a native
        # process's stdin using $OutputEncoding. Node always writes/reads
        # UTF-8, and this helper's own output can contain the install root
        # (env-merge's TLS_CERT_FILE, cert's paths, pairing's URLs and PEM),
        # so both are pinned to UTF-8 for the call and restored after - the
        # default on 5.1 is the console's ANSI codepage, which would mangle
        # any non-ASCII path otherwise. Console.OutputEncoding is not
        # settable in every host (no console at all), so this is best-effort.
        $prevOutputEncoding = $OutputEncoding
        $prevConsoleEncoding = $null
        try { $prevConsoleEncoding = [Console]::OutputEncoding } catch { Write-Verbose $_.Exception.Message }
        $OutputEncoding = $utf8NoBom
        try { [Console]::OutputEncoding = $utf8NoBom } catch { Write-Verbose $_.Exception.Message }
        try {
            $stdout = Invoke-WithoutServerEnv { & $NodeExe $CliPath @CliArgs 2>$stderrFile }
            $code = $LASTEXITCODE
            $stderrText = if (Test-Path -LiteralPath $stderrFile) { [IO.File]::ReadAllText($stderrFile, $utf8NoBom) } else { $null }
        } finally {
            Remove-Item -LiteralPath $stderrFile -ErrorAction SilentlyContinue
            $OutputEncoding = $prevOutputEncoding
            if ($null -ne $prevConsoleEncoding) { try { [Console]::OutputEncoding = $prevConsoleEncoding } catch { Write-Verbose $_.Exception.Message } }
        }
        $lines = @()
        if ($stdout) { $lines += @($stdout) }
        if ($stderrText) { $lines += @($stderrText.TrimEnd()) }
        return [pscustomobject]@{ ExitCode = $code; Output = $lines }
    }

    function Test-PidFileProcess([string] $PidFile, [string] $ExpectedImagePath) {
        if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
        $procId = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if (-not $procId) { return $null }
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { return $null }
        try {
            $imagePath = $proc.Path
        } catch {
            $imagePath = $null
        }
        if ($ExpectedImagePath -and $imagePath -and ($imagePath -ne $ExpectedImagePath)) { return $null }
        return $proc
    }

    function Stop-SabiaService([string] $Root) {
        $task = Get-ScheduledTask -TaskName 'Sabia' -ErrorAction SilentlyContinue
        if ($task) {
            try { Stop-ScheduledTask -TaskName 'Sabia' -ErrorAction SilentlyContinue } catch { Write-Verbose $_.Exception.Message }
        }
        # Never kill by process name: only a PID file whose recorded path
        # matches the expected binary is trusted.
        $supervisorPid = Join-Path $Root 'run\supervisor.pid'
        $nodePid = Join-Path $Root 'run\node.pid'
        $proc = Test-PidFileProcess -PidFile $supervisorPid -ExpectedImagePath $null
        if ($proc -and ($proc.ProcessName -eq 'powershell' -or $proc.ProcessName -eq 'pwsh')) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { Write-Verbose $_.Exception.Message }
        }
        $nodeExePath = Join-Path $Root 'node\node.exe'
        $nodeProc = Test-PidFileProcess -PidFile $nodePid -ExpectedImagePath $nodeExePath
        if ($nodeProc) {
            try { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue } catch { Write-Verbose $_.Exception.Message }
        }
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            $stillSup = Test-PidFileProcess -PidFile $supervisorPid -ExpectedImagePath $null
            $stillNode = Test-PidFileProcess -PidFile $nodePid -ExpectedImagePath $nodeExePath
            if (-not $stillSup -and -not $stillNode) { break }
            Start-Sleep -Milliseconds 500
        }
        Remove-Item -LiteralPath $supervisorPid -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $nodePid -ErrorAction SilentlyContinue
    }

    # Starts (or re-starts) the service in whichever autostart mode a marker
    # recorded. Every path handed to Start-Process's -ArgumentList is
    # embedded in its own escaped double quotes: that parameter joins array
    # elements with a plain space and does not quote them itself, so an
    # unquoted element breaks for any install path containing a space.
    function Start-SabiaAutostartMode([string] $Root, [string] $Mode) {
        if ($Mode -eq 'task') {
            try { Start-ScheduledTask -TaskName 'Sabia' -ErrorAction Stop; return } catch { Write-Verbose $_.Exception.Message }
        }
        if ($Mode -eq 'task' -or $Mode -eq 'startup-folder') {
            $scriptPath = Join-Path $Root 'bin\sabia-service.ps1'
            Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$scriptPath`""
            )
        }
    }

    # ---- wrapper and task definitions (written at install time) -----------

    function Get-ServiceWrapperContent {
        return @'
# Sabia service supervisor - written by the installer. Runs the server and
# restarts it with backoff on an unexpected exit. Derives its own root from
# its own location so it carries no machine-specific path.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root 'run'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$supervisorPidFile = Join-Path $runDir 'supervisor.pid'
$nodePidFile = Join-Path $runDir 'node.pid'

# This process's own environment must never pass PORT/TLS_*/INGEST_TOKEN/etc
# to the server as a stray inherited value - only sabia.env, via --env-file,
# is allowed to set them.
foreach ($sabiaEnvKey in @('PORT', 'BIND_HOST', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'INGEST_TOKEN', 'MCP_TOKEN', 'SESSION_SECRET', 'FLIGHTS_DB_PATH', 'NAVDATA_DB_PATH', 'ALLOW_PLAINTEXT_HTTP', 'ALLOW_UNAUTHENTICATED_INGEST', 'PUPPETEER_CACHE_DIR')) {
    Remove-Item -Path "Env:$sabiaEnvKey" -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $supervisorPidFile) {
    $existingId = Get-Content -LiteralPath $supervisorPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingId) {
        $existing = Get-Process -Id $existingId -ErrorAction SilentlyContinue
        if ($existing -and ($existing.ProcessName -eq 'powershell' -or $existing.ProcessName -eq 'pwsh')) {
            return
        }
    }
}
Set-Content -LiteralPath $supervisorPidFile -Value $PID -Encoding ASCII

function Move-LogAside([string] $Path) {
    if (Test-Path -LiteralPath $Path) {
        Move-Item -LiteralPath $Path -Destination "$Path.1" -Force -ErrorAction SilentlyContinue
    }
}

$backoffSteps = @(5, 10, 20, 40, 60, 60)
$backoffIndex = 0

try {
    while ($true) {
        $outLog = Join-Path $logDir 'sabia.out.log'
        $errLog = Join-Path $logDir 'sabia.err.log'
        Move-LogAside $outLog
        Move-LogAside $errLog

        $nodeExe = Join-Path $root 'node\node.exe'
        $envFile = Join-Path $root 'sabia.env'
        $startedAt = Get-Date

        $proc = Start-Process -FilePath $nodeExe `
            -ArgumentList @("--env-file=`"$envFile`"", 'dist\index.js') `
            -WorkingDirectory $root `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput $outLog `
            -RedirectStandardError $errLog

        # Touching Handle keeps PowerShell 5.1 from losing ExitCode later.
        $null = $proc.Handle
        Set-Content -LiteralPath $nodePidFile -Value $proc.Id -Encoding ASCII
        $proc.WaitForExit()
        Remove-Item -LiteralPath $nodePidFile -ErrorAction SilentlyContinue

        $uptimeSeconds = ((Get-Date) - $startedAt).TotalSeconds
        if ($uptimeSeconds -ge 600) { $backoffIndex = 0 }

        if ($proc.ExitCode -eq 0) { break }

        $delay = $backoffSteps[[Math]::Min($backoffIndex, $backoffSteps.Length - 1)]
        $backoffIndex++
        Start-Sleep -Seconds $delay
    }
} finally {
    Remove-Item -LiteralPath $nodePidFile -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorPidFile -ErrorAction SilentlyContinue
}
'@
    }

    function Get-TaskXmlContent([string] $Root) {
        $user = "$env:USERDOMAIN\$env:USERNAME"
        $escapedRoot = [Security.SecurityElement]::Escape($Root)
        $escapedUser = [Security.SecurityElement]::Escape($user)
        return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sabia flight logger server (per-user, starts at logon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$escapedUser</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$escapedUser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$escapedRoot\bin\sabia-service.ps1"</Arguments>
      <WorkingDirectory>$escapedRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
    }

    function Get-StartupShortcutPath {
        return Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Sabia.lnk'
    }

    function New-StartupShortcut([string] $Root) {
        $wsh = New-Object -ComObject WScript.Shell
        $lnkPath = Get-StartupShortcutPath
        $shortcut = $wsh.CreateShortcut($lnkPath)
        $shortcut.TargetPath = 'powershell.exe'
        $shortcut.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\bin\sabia-service.ps1`""
        $shortcut.WorkingDirectory = $Root
        $shortcut.WindowStyle = 7
        $shortcut.Save()
    }

    function Set-SabiaFirewallRule([string] $Root, [int] $Port) {
        $nodeExe = Join-Path $Root 'node\node.exe'
        Remove-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue
        New-NetFirewallRule -Name 'SabiaServer-In' -DisplayName 'Sabia server' -Direction Inbound -Action Allow -Profile Private -Program $nodeExe -Protocol TCP -LocalPort $Port | Out-Null
    }

    function Register-SabiaAutostart([string] $Root, [int] $ResolvedPort) {
        $taskXmlPath = Join-Path $Root '.staging\Sabia-task.xml'
        New-Utf8NoBomFile -Path $taskXmlPath -Content (Get-TaskXmlContent -Root $Root)
        $nodeExe = Join-Path $Root 'node\node.exe'
        # Embedded in single-quoted segments of an elevated command string
        # below: an apostrophe in the install path (an "O'Brien" profile)
        # would otherwise close the quote early and break the command.
        $nodeExeQ = Format-PSSingleQuoted $nodeExe
        $taskXmlPathQ = Format-PSSingleQuoted $taskXmlPath

        $ruleExists = $null -ne (Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue)
        $ruleMatches = $false
        if ($ruleExists) {
            $filter = Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
            $portFilter = Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
            if ($filter -and $portFilter -and ($filter.Program -eq $nodeExe) -and ($portFilter.LocalPort -eq [string] $ResolvedPort)) {
                $ruleMatches = $true
            }
        }

        # Passed directly from the generator, not re-read from the file this
        # installer's own process just wrote: Get-Content with no -Encoding
        # would decode that BOM-less file using the ANSI codepage on Windows
        # PowerShell 5.1, corrupting a non-ASCII <root> (a "Joao" profile)
        # into a broken -File path the task would silently fail to run.
        $taskXmlContent = Get-TaskXmlContent -Root $Root

        $taskRegistered = $false
        try {
            Register-ScheduledTask -TaskName 'Sabia' -Xml $taskXmlContent -Force -ErrorAction Stop | Out-Null
            $taskRegistered = $true
        } catch {
            $taskRegistered = $false
        }

        $needsFirewall = -not $ruleMatches
        $needsTask = -not $taskRegistered

        if ($needsFirewall -or $needsTask) {
            if (Test-IsElevated) {
                if ($needsFirewall) { Set-SabiaFirewallRule -Root $Root -Port $ResolvedPort }
                if ($needsTask) {
                    try {
                        Register-ScheduledTask -TaskName 'Sabia' -Xml $taskXmlContent -Force -ErrorAction Stop | Out-Null
                        $taskRegistered = $true
                    } catch { $taskRegistered = $false }
                }
            } elseif (-not $NoElevate) {
                # The elevated process is a separate powershell.exe and can't
                # share $taskXmlContent, so it must re-read the file from
                # disk - with an explicit UTF-8 encoding, for the same reason
                # $taskXmlContent is passed directly above rather than
                # re-read here.
                $cmd = "Remove-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue; " +
                    "New-NetFirewallRule -Name 'SabiaServer-In' -DisplayName 'Sabia server' -Direction Inbound -Action Allow -Profile Private -Program '$nodeExeQ' -Protocol TCP -LocalPort $ResolvedPort | Out-Null; " +
                    "Register-ScheduledTask -TaskName 'Sabia' -Xml ([IO.File]::ReadAllText('$taskXmlPathQ', (New-Object Text.UTF8Encoding(`$false)))) -Force | Out-Null"
                Invoke-ElevatedCommand -Command $cmd | Out-Null
                $ruleExists = $null -ne (Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue)
                $taskRegistered = $null -ne (Get-ScheduledTask -TaskName 'Sabia' -ErrorAction SilentlyContinue)
            } else {
                Write-Warn2 "-NoElevate given: the firewall rule and/or the logon task were not created. Run as administrator: New-NetFirewallRule -Name SabiaServer-In -DisplayName 'Sabia server' -Direction Inbound -Action Allow -Profile Private -Program `"$nodeExe`" -Protocol TCP -LocalPort $ResolvedPort"
            }
        }

        $ruleNow = $null -ne (Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue)
        if (-not $ruleNow) {
            Write-Warn2 'The firewall rule SabiaServer-In was not created. LAN clients cannot reach the server until it is (a same-machine MCDU still works via https://127.0.0.1). If Windows shows a "blocked some features" prompt, choose Private and Allow.'
        }

        try {
            $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
            foreach ($p in $profiles) {
                if ($p.NetworkCategory -eq 'Public') {
                    Write-Warn2 "Network '$($p.Name)' is classified Public; the Private-only firewall rule does not apply there. Mark it Private in Windows Settings if LAN clients need to connect."
                }
            }
        } catch {
            Write-Warn2 "Could not read the active network profile: $($_.Exception.Message)"
        }

        if ($taskRegistered) {
            try { Start-ScheduledTask -TaskName 'Sabia' -ErrorAction Stop } catch { Start-SabiaAutostartMode -Root $Root -Mode 'startup-folder' }
            return 'task'
        }

        New-StartupShortcut -Root $Root
        Start-SabiaAutostartMode -Root $Root -Mode 'startup-folder'
        return 'startup-folder'
    }

    # ---- bundle verification -------------------------------------------------

    # Never swallowed: a mismatch always throws. The only thing allowed to be
    # "best effort" is *fetching* a checksum to compare against (e.g. a
    # missing .sha256 next to a local -Bundle), never the comparison itself.
    function Assert-BundleChecksum([string] $BundlePath, [string] $Sha256Text, [string] $Source) {
        $expected = ($Sha256Text -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $BundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "Bundle checksum mismatch for $BundlePath (against $Source)." }
    }

    # ---- uninstall ----------------------------------------------------------

    function Invoke-SabiaUninstall([string] $Root) {
        $marker = Read-Marker -Root $Root
        if (-not $marker) { throw "Sabia is not installed at $Root (no .sabia-install marker)." }

        Stop-SabiaService -Root $Root

        $ruleExists = $null -ne (Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue)
        $taskExists = $null -ne (Get-ScheduledTask -TaskName 'Sabia' -ErrorAction SilentlyContinue)
        $taskUnregistered = $false
        if ($taskExists) {
            try {
                Unregister-ScheduledTask -TaskName 'Sabia' -Confirm:$false -ErrorAction Stop
                $taskUnregistered = $true
            } catch {
                $taskUnregistered = $false
            }
        } else {
            $taskUnregistered = $true
        }

        $shortcutPath = Get-StartupShortcutPath
        if (Test-Path -LiteralPath $shortcutPath) {
            Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
        }

        $needsElevation = $ruleExists -or (-not $taskUnregistered)
        if ($needsElevation) {
            if (Test-IsElevated) {
                if ($ruleExists) { Remove-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue }
                if (-not $taskUnregistered) { Unregister-ScheduledTask -TaskName 'Sabia' -Confirm:$false -ErrorAction SilentlyContinue }
            } elseif (-not $NoElevate) {
                $cmd = "Remove-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'Sabia' -Confirm:`$false -ErrorAction SilentlyContinue"
                Invoke-ElevatedCommand -Command $cmd | Out-Null
            } else {
                Write-Warn2 'Run as administrator to finish removing the firewall rule and/or scheduled task:'
                Write-Warn2 '  Remove-NetFirewallRule -Name SabiaServer-In'
                Write-Warn2 '  Unregister-ScheduledTask -TaskName Sabia -Confirm:$false'
            }
        }

        $removePaths = @('dist', 'client', 'package.json', 'package-lock.json', 'airports.json', 'airport-tiers.json', 'VERSION', 'LICENSE', 'node_modules', 'node', 'chrome', 'bin', 'run', '.staging', '.install.lock')
        foreach ($entry in $removePaths) {
            $p = Join-Path $Root $entry
            if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
        }

        $kept = @('sabia.env', 'flights.db', 'flights.db-wal', 'flights.db-shm', 'flight_plans', 'navdata', 'backups', 'certs', 'logs') |
            ForEach-Object { Join-Path $Root $_ } | Where-Object { Test-Path -LiteralPath $_ }

        $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $marker['state'] = 'uninstalled'
        $marker['updated_at'] = $now
        Write-Marker -Root $Root -Fields $marker

        Write-Info "Sabia service removed. Kept (reinstall will find them): $($kept -join ', ')"

        if ($Purge) {
            $stillHasMarker = Test-Path -LiteralPath (Join-Path $Root '.sabia-install')
            if (-not $stillHasMarker) { throw 'Refusing to purge: marker file is gone; the install directory may not be ours.' }
            if (-not $Yes) {
                $answer = Read-Host "Type 'purge' to permanently delete $Root, including flights.db and backups"
                if ($answer -ne 'purge') { throw 'Purge cancelled: confirmation text did not match.' }
            }
            Remove-Item -LiteralPath $Root -Recurse -Force
            Write-Info "Purged $Root."
        }
    }

    # ---- main body ----------------------------------------------------------

    if ($Help) {
        Write-Host 'Usage: install.ps1 [-Version X.Y.Z] [-InstallDir path] [-Port n] [-BindHost host] [-Uninstall [-Purge]] ...'
        Write-Host 'See https://github.com/oshogun/sabia for the full flag list (each also has a SABIA_* environment variable).'
        return
    }

    if ($Purge -and -not $Uninstall) { throw '-Purge requires -Uninstall.' }
    if ($Port) { Assert-ValidPort -Value $Port -Label '-Port' }

    $arch = Get-NodeArch
    $rootInput = if ($InstallDir) { $InstallDir } else { Get-InstallDirDefault }
    $root = Assert-ValidInstallDir -Path $rootInput

    if ($Uninstall) {
        Invoke-SabiaUninstall -Root $root
        return
    }

    if ((Test-Path -LiteralPath $root) -and -not (Test-Path -LiteralPath (Join-Path $root '.sabia-install'))) {
        $existingItems = Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue
        if ($existingItems -and $existingItems.Count -gt 0) {
            throw "$root already exists, is not empty, and has no .sabia-install marker. Choose a different -InstallDir or remove it first."
        }
    }
    New-Item -ItemType Directory -Path $root -Force | Out-Null

    $lockDir = Join-Path $root '.install.lock'
    try {
        New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
    } catch {
        throw "Another install/upgrade appears to be in progress ($lockDir already exists)."
    }

    try {
        $marker = Read-Marker -Root $root
        if ($marker -and ([int] $marker['layout'] -gt 1)) {
            throw "This installer is older than the install at $root (layout $($marker['layout'])). Get a newer install.ps1."
        }

        # Whether there is a previously-successful install to protect/roll
        # back to - decided from the marker's own state as read here, before
        # the "installing" rewrite below can touch the in-memory copy, not
        # from a proxy like "does .staging\old exist" (which is empty on a
        # same-version re-run that only changes -Port, even though a real
        # running install still needs the same protection).
        $wasInstalled = $marker -and ($marker['state'] -eq 'installed')

        # A failed first install must be retryable and uninstallable: mark
        # the root as "installing" before anything is downloaded. version is
        # left empty so the skip-if-current check below always runs the full
        # install until a run actually finishes. Only applies to a fresh or
        # still-"installing" root - an already-"installed" root (a normal
        # upgrade) keeps its real marker untouched until the run succeeds, so
        # a failed upgrade can still fall back to it.
        if ((-not $marker) -or ($marker['state'] -eq 'installing')) {
            $nowInstalling = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            $marker = @{
                layout = '1'
                version = ''
                node = if ($marker) { $marker['node'] } else { '' }
                os = 'win32'
                arch = $arch
                autostart = if ($marker) { $marker['autostart'] } else { 'none' }
                firewall_rule = if ($marker) { $marker['firewall_rule'] } else { '0' }
                state = 'installing'
                installed_at = if ($marker -and $marker['installed_at']) { $marker['installed_at'] } else { $nowInstalling }
                updated_at = $nowInstalling
            }
            Write-Marker -Root $root -Fields $marker
        }

        # Resolve target version. PowerShell's own ConvertFrom-Json handles
        # the GitHub API response natively, so unlike install.sh this script
        # never needs Node just to pick a version string.
        $bundleIsUrl = $false
        $targetVersion = $null
        $bundlePath = $null

        if ($Bundle) {
            $bundleIsUrl = $Bundle -match '^https?://'
        } elseif ($Version) {
            $targetVersion = $Version.TrimStart('v')
            if ($targetVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "-Version must look like X.Y.Z, got '$Version'." }
        } else {
            try {
                $apiText = Invoke-TextDownload -Uri $ApiUrl -Headers @{ 'User-Agent' = 'sabia-install.ps1' }
                $json = $apiText | ConvertFrom-Json
                $targetVersion = ([string] $json.tag_name).TrimStart('v')
            } catch {
                Write-Warn2 "Could not query $ApiUrl ($($_.Exception.Message)); falling back to the releases/latest redirect."
                $req = [Net.WebRequest]::Create('https://github.com/oshogun/sabia/releases/latest')
                $req.AllowAutoRedirect = $false
                $r = $req.GetResponse()
                $location = $r.Headers['Location']
                $r.Close()
                if ($location -notmatch '/tag/v([0-9]+\.[0-9]+\.[0-9]+)$') { throw "Could not resolve the latest release from $location." }
                $targetVersion = $Matches[1]
            }
            if (-not $targetVersion) { throw 'Could not determine the latest Sabia version.' }
        }

        # ---- Node (staged only - swapped in below, alongside or independently of an app swap) ----
        $nodeDir = Join-Path $root 'node'
        $currentNodeVersion = if ($marker) { $marker['node'] } else { $null }

        $shasumsUrl = "$NodeDistUrl/latest-v24.x/SHASUMS256.txt"
        $shasums = Invoke-TextDownload -Uri $shasumsUrl
        $nodeFilePattern = "node-v24\.[0-9]+\.[0-9]+-win-$arch\.zip"
        $nodeLine = ($shasums -split "`r?`n") | Where-Object { $_ -match $nodeFilePattern } | Select-Object -First 1
        if (-not $nodeLine) { throw "Could not find a win-$arch Node 24 build in $shasumsUrl." }
        $nodeParts = $nodeLine -split '\s+'
        $nodeSha256 = $nodeParts[0]
        $nodeFile = $nodeParts[1]
        if ($nodeFile -notmatch 'node-v(24\.[0-9]+\.[0-9]+)-win') { throw "Could not parse a version out of '$nodeFile'." }
        $resolvedNodeVersion = $Matches[1]

        $stagingDir = Join-Path $root '.staging'
        New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
        $needNode = (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) -or ($currentNodeVersion -ne $resolvedNodeVersion)
        $stagedNodeDir = $null
        if ($needNode) {
            Write-Info "Downloading Node $resolvedNodeVersion ($arch)..."
            $nodeZip = Join-Path $stagingDir $nodeFile
            Invoke-WebRequest -Uri "$NodeDistUrl/v$resolvedNodeVersion/$nodeFile" -OutFile $nodeZip -UseBasicParsing
            $actualHash = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $nodeSha256.ToLowerInvariant()) { throw "Node download checksum mismatch for $nodeFile." }
            $nodeExtractDir = Join-Path $stagingDir 'node-extract'
            if (Test-Path -LiteralPath $nodeExtractDir) { Remove-Item -LiteralPath $nodeExtractDir -Recurse -Force }
            Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtractDir -Force
            $innerDir = Get-ChildItem -LiteralPath $nodeExtractDir -Directory | Select-Object -First 1
            $stagedNodeDir = Join-Path $stagingDir 'node'
            if (Test-Path -LiteralPath $stagedNodeDir) { Remove-Item -LiteralPath $stagedNodeDir -Recurse -Force }
            Move-Item -LiteralPath $innerDir.FullName -Destination $stagedNodeDir
            Remove-Item -LiteralPath $nodeZip -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $nodeExtractDir -Recurse -Force -ErrorAction SilentlyContinue
        }

        # Used for staging-time operations only (npm ci, the smoke test, the
        # helper CLI before any swap has happened). Re-resolved to the real
        # <root>\node\node.exe further down, right after the swap - never
        # used again from .staging afterward.
        $activeNodeExe = if ($stagedNodeDir) { Join-Path $stagedNodeDir 'node.exe' } else { Join-Path $nodeDir 'node.exe' }

        # ---- decide whether a bundle swap is needed ----
        $alreadyCurrent = $marker -and (-not $Bundle) -and ($marker['version'] -eq $targetVersion) -and (Test-Path -LiteralPath (Join-Path $root 'dist\index.js')) -and (-not $Force)

        $stagedAppDir = $null
        if (-not $alreadyCurrent) {
            $stagedAppDir = Join-Path $stagingDir 'app'
            if (Test-Path -LiteralPath $stagedAppDir) { Remove-Item -LiteralPath $stagedAppDir -Recurse -Force }

            if ($Bundle -and -not $bundleIsUrl) {
                $bundlePath = $Bundle
                $sha256Sibling = "$Bundle.sha256"
                if (Test-Path -LiteralPath $sha256Sibling) {
                    Assert-BundleChecksum -BundlePath $bundlePath -Sha256Text (Get-Content -LiteralPath $sha256Sibling -Raw) -Source $sha256Sibling
                } else {
                    Write-Warn2 "No checksum file found at $sha256Sibling; installing $bundlePath unverified."
                }
            } else {
                $bundleUrl = if ($bundleIsUrl) { $Bundle } else { "$ReleaseBaseUrl/v$targetVersion/sabia-server-$targetVersion.tar.gz" }
                $bundlePath = Join-Path $stagingDir (Split-Path -Leaf $bundleUrl)
                Write-Info "Downloading $bundleUrl ..."
                Invoke-WebRequest -Uri $bundleUrl -OutFile $bundlePath -UseBasicParsing
                $sha256Url = "$bundleUrl.sha256"
                $sha256Text = $null
                try {
                    $sha256Text = Invoke-TextDownload -Uri $sha256Url
                } catch {
                    if ($Bundle) {
                        # An explicit -Bundle URL: the user pointed at it
                        # directly, so a missing checksum is a warning, same
                        # leniency as a local -Bundle path with no sibling
                        # .sha256.
                        Write-Warn2 "Could not fetch the bundle checksum from $sha256Url ($($_.Exception.Message)); installing unverified."
                    } else {
                        # The normal release flow: a release build is always
                        # expected to have a checksum published beside it, so
                        # a failure to fetch it is not swallowed.
                        throw "Could not fetch the bundle checksum from $sha256Url ($($_.Exception.Message))."
                    }
                }
                # The fetch may fail softly only for an explicit -Bundle URL
                # (above); a fetched checksum that does not match must always
                # abort - never swallowed by the fetch's own try/catch.
                if ($sha256Text) { Assert-BundleChecksum -BundlePath $bundlePath -Sha256Text $sha256Text -Source $sha256Url }
            }

            $extractDir = Join-Path $stagingDir 'extract'
            if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
            New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
            # Windows 10 1803+ ships tar.exe (bsdtar); the bundle is a plain
            # gzip tarball on every OS so build-bundle.sh only has to produce
            # one artifact. bsdtar's own handling of a non-ASCII absolute path
            # in argv is untrusted, so the bundle is copied to a fixed
            # ASCII-only name and tar is run with its working directory set
            # to the staging dir and only ASCII-only relative arguments - the
            # actual (possibly non-ASCII) root never appears in tar's argv at
            # all. The working directory itself is set via .NET's own
            # Unicode-safe process-creation path, not through argv, so a
            # "Joao" root is fine there.
            $bundleForTar = Join-Path $stagingDir 'bundle.tar.gz'
            Copy-Item -LiteralPath $bundlePath -Destination $bundleForTar -Force
            Push-Location $stagingDir
            try {
                & tar.exe -xzf 'bundle.tar.gz' -C 'extract'
                if ($LASTEXITCODE -ne 0) { throw "tar.exe failed to extract $bundlePath." }
            } finally {
                Pop-Location -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $bundleForTar -Force -ErrorAction SilentlyContinue
            }
            $inner = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
            Move-Item -LiteralPath $inner.FullName -Destination $stagedAppDir

            $bundleVersion = (Get-Content -LiteralPath (Join-Path $stagedAppDir 'VERSION') -Raw).Trim()
            if ($Bundle) { $targetVersion = $bundleVersion }
            if ($bundleVersion -ne $targetVersion) { throw "Bundle VERSION ($bundleVersion) does not match the resolved target ($targetVersion)." }

            Write-Info 'Installing dependencies (npm ci)...'
            $prevPath = $env:PATH
            $prevCacheDir = $env:PUPPETEER_CACHE_DIR
            $prevSkipShell = $env:PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD
            $prevSkip = $env:PUPPETEER_SKIP_DOWNLOAD
            try {
                $env:PATH = "$(Split-Path -Parent $activeNodeExe);$env:PATH"
                $env:PUPPETEER_CACHE_DIR = Join-Path $root 'chrome'
                $env:PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD = 'true'
                if ($NoChromium) { $env:PUPPETEER_SKIP_DOWNLOAD = 'true' }
                Push-Location $stagedAppDir
                $npmCli = Join-Path (Split-Path -Parent $activeNodeExe) 'node_modules\npm\bin\npm-cli.js'
                Invoke-WithoutServerEnv { & $activeNodeExe $npmCli ci --omit=dev --no-audit --no-fund }
                if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
            } finally {
                Pop-Location -ErrorAction SilentlyContinue
                $env:PATH = $prevPath
                $env:PUPPETEER_CACHE_DIR = $prevCacheDir
                $env:PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD = $prevSkipShell
                $env:PUPPETEER_SKIP_DOWNLOAD = $prevSkip
            }

            Write-Info 'Smoke-testing better-sqlite3...'
            Push-Location $stagedAppDir
            try {
                Invoke-WithoutServerEnv { & $activeNodeExe -e "new (require('better-sqlite3'))(':memory:').close()" }
                if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 smoke test failed; nothing was swapped in.' }
            } finally {
                Pop-Location -ErrorAction SilentlyContinue
            }
        }

        # ---- config ----
        $envFile = Join-Path $root 'sabia.env'
        # Snapshotted before env-merge writes anything. On an existing
        # install, the running service must never be stopped until every
        # pre-swap step (including the port check below and the cert step
        # just after) has succeeded, and this snapshot - together with the
        # cert backup further down - is what a failure at any point after
        # this line restores, verbatim, before the old service is brought
        # back. Read as raw UTF-8 explicitly: Get-Content without -Encoding
        # decodes a BOM-less file using the system codepage on Windows
        # PowerShell 5.1, which would corrupt a non-ASCII install path (a
        # "Joao" profile) written back out by New-Utf8NoBomFile.
        $envBackup = if (Test-Path -LiteralPath $envFile) { [IO.File]::ReadAllText($envFile, (New-Object Text.UTF8Encoding($false))) } else { $null }
        $priorPort = Get-EnvFileValue -Text $envBackup -Key 'PORT'
        $priorBindHost = Get-EnvFileValue -Text $envBackup -Key 'BIND_HOST'
        $helperCli = if ($stagedAppDir) { Join-Path $stagedAppDir 'dist\install\cli.js' } else { Join-Path $root 'dist\install\cli.js' }

        $mergeArgs = @('env-merge', '--file', $envFile, '--root', $root, '--default-bind-host', '0.0.0.0')
        if ($Port) { $mergeArgs += @('--port', $Port) }
        if ($BindHost) { $mergeArgs += @('--bind-host', $BindHost) }
        $mergeResult = Invoke-Helper -NodeExe $activeNodeExe -CliPath $helperCli -CliArgs $mergeArgs
        if ($mergeResult.ExitCode -ne 0) { throw "env-merge failed: $($mergeResult.Output)" }
        $mergeJson = ($mergeResult.Output -join "`n") | ConvertFrom-Json
        $resolvedPort = [int] $mergeJson.values.PORT
        $resolvedBindHost = [string] $mergeJson.values.BIND_HOST

        $certPath = $mergeJson.values.TLS_CERT_FILE
        $keyPath = $mergeJson.values.TLS_KEY_FILE
        $needsCert = $RenewCert -or (-not (Test-Path -LiteralPath $certPath)) -or (-not (Test-Path -LiteralPath $keyPath))
        # Backed up (not regenerated blind) so a rollback restores the exact
        # bytes a paired MCDU's pinned fingerprint already trusts, rather than
        # minting a new cert that would unpair it. Declared before the cert
        # step runs so a failure inside that step can call this too - a
        # config error must restore sabia.env (and the cert, if it was
        # touched) exactly like a busy-port abort does, not leave the live
        # file half-updated.
        $certBackupDir = $null
        function Restore-PreSwapConfig {
            if ($null -ne $envBackup) { New-Utf8NoBomFile -Path $envFile -Content $envBackup }
            if ($certBackupDir) {
                Copy-Item -LiteralPath (Join-Path $certBackupDir 'sabia.crt') -Destination $certPath -Force
                if (Test-Path -LiteralPath (Join-Path $certBackupDir 'sabia.key')) { Copy-Item -LiteralPath (Join-Path $certBackupDir 'sabia.key') -Destination $keyPath -Force }
            }
        }

        if ($needsCert -and ($certPath -eq (Join-Path $root 'certs\sabia.crt'))) {
            if (Test-Path -LiteralPath $certPath) {
                $certBackupDir = Join-Path $stagingDir 'cert-backup'
                New-Item -ItemType Directory -Path $certBackupDir -Force | Out-Null
                Copy-Item -LiteralPath $certPath -Destination (Join-Path $certBackupDir 'sabia.crt') -Force
                if (Test-Path -LiteralPath $keyPath) { Copy-Item -LiteralPath $keyPath -Destination (Join-Path $certBackupDir 'sabia.key') -Force }
            }
            $certArgs = @('cert', '--cert', $certPath, '--key', $keyPath, '--bind-host', $resolvedBindHost, '--force')
            if ($TlsSan) { $certArgs += @('--san', $TlsSan) }
            $certResult = Invoke-Helper -NodeExe $activeNodeExe -CliPath $helperCli -CliArgs $certArgs
            if ($certResult.ExitCode -ne 0) {
                Restore-PreSwapConfig
                throw "Certificate generation failed: $($certResult.Output)"
            }
        }

        # Everything that is actually going to be swapped this run - the app
        # entries only if a new bundle was staged, the node directory only if
        # a new Node was staged - independently of each other, so a Node-only
        # refresh on an otherwise-current install still lands instead of
        # being silently discarded while the marker claims it happened.
        $entriesToSwap = @()
        if ($stagedAppDir) { $entriesToSwap += $AppEntries; $entriesToSwap += 'node_modules' }
        if ($stagedNodeDir) { $entriesToSwap += 'node' }

        # ---- verify the port before the running service is touched ----
        # Skip the probe only when there was already a working install of
        # ours on this exact port/host - the one case where a "busy" result
        # would just be our own, about-to-be-stopped service, and probing
        # first would always (wrongly) report busy. Every other case -
        # nothing installed yet, a root left over from an uninstall, or a
        # genuinely different port/host - is probed before anything is
        # stopped, so a foreign listener is caught instead of producing a
        # false "installed" or leaving a crash-looping service behind, and a
        # busy port never costs an existing service its uptime.
        $portOrHostChanged = (-not $wasInstalled) -or ($null -eq $envBackup) -or ($priorPort -ne [string] $resolvedPort) -or ($priorBindHost -ne $resolvedBindHost)
        if ($portOrHostChanged) {
            $portFreeResult = Invoke-Helper -NodeExe $activeNodeExe -CliPath $helperCli -CliArgs @('port-free', '--host', $resolvedBindHost, '--port', [string] $resolvedPort)
            $portBusy = ($portFreeResult.ExitCode -eq 3)
            if ($portBusy -or ($portFreeResult.ExitCode -ne 0)) {
                # Nothing has been stopped or swapped yet - restore the
                # snapshot and leave the running service exactly as it was.
                Restore-PreSwapConfig
                if ($portBusy) {
                    throw "Port $resolvedPort is already used by another program; pass -Port to choose a different one."
                } else {
                    throw "port-free check failed: $($portFreeResult.Output)"
                }
            }
        }

        # ---- stop, swap, restart ----
        Stop-SabiaService -Root $root

        if ($entriesToSwap.Count -gt 0) {
            $oldDir = Join-Path $stagingDir 'old'
            if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force }
            New-Item -ItemType Directory -Path $oldDir -Force | Out-Null

            foreach ($entry in $entriesToSwap) {
                $current = Join-Path $root $entry
                if (Test-Path -LiteralPath $current) {
                    $dest = Join-Path $oldDir $entry
                    $retries = 3
                    while ($retries -gt 0) {
                        try { Move-Item -LiteralPath $current -Destination $dest -Force; break } catch {
                            $retries--
                            if ($retries -le 0) { throw }
                            Start-Sleep -Seconds 1
                        }
                    }
                }
            }
            if ($stagedAppDir) {
                foreach ($entry in $AppEntries) {
                    Move-Item -LiteralPath (Join-Path $stagedAppDir $entry) -Destination (Join-Path $root $entry) -Force
                }
                Move-Item -LiteralPath (Join-Path $stagedAppDir 'node_modules') -Destination (Join-Path $root 'node_modules') -Force
            }
            if ($stagedNodeDir) {
                Move-Item -LiteralPath $stagedNodeDir -Destination $nodeDir -Force
            }
        }

        # Re-resolve now that the swap (if any) has happened: .staging\node
        # no longer exists once $stagedNodeDir has been moved into $nodeDir,
        # and even when nothing was staged this run, $nodeDir\node.exe is
        # always the authoritative binary from this point on.
        $activeNodeExe = Join-Path $nodeDir 'node.exe'

        # ---- operator account ----
        # operator-status resolves the database path relative to the current
        # directory (no --env-file of its own), so run it with cwd = root.
        Push-Location $root
        try {
            $opStatus = Invoke-Helper -NodeExe $activeNodeExe -CliPath (Join-Path $root 'dist\install\cli.js') -CliArgs @('operator-status')
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
        }
        # Any non-zero, non-"none" exit is a failure - never assume the only
        # failure code is 1; the helper CLI's own exit-code table is the source
        # of truth, not a hardcoded comparison here.
        if (($opStatus.ExitCode -ne 0) -and ($opStatus.ExitCode -ne 3)) {
            throw "operator-status failed: $($opStatus.Output)"
        }
        if ($opStatus.ExitCode -eq 3) {
            $setPwArgs = @("--env-file=$envFile", 'dist\setPassword.js')
            if ($Username) { $setPwArgs += @('--username', $Username) }
            Push-Location $root
            try {
                if ($PasswordFile) {
                    # Explicit UTF-8, not Get-Content with no -Encoding: a
                    # non-ASCII password would otherwise be decoded using the
                    # ANSI codepage on Windows PowerShell 5.1 and sent to
                    # setPassword.js corrupted. ReadAllText still honours an
                    # actual BOM if the file has one (Notepad-saved), and
                    # only falls back to UTF-8 when there isn't one.
                    $pwFileText = [IO.File]::ReadAllText($PasswordFile, (New-Object Text.UTF8Encoding($false)))
                    $pw = ($pwFileText -split "`r?`n")[0]
                    if (-not $pw) { throw "Password file $PasswordFile is empty." }
                    $prevOutputEncoding = $OutputEncoding
                    $OutputEncoding = New-Object Text.UTF8Encoding($false)
                    try { Invoke-WithoutServerEnv { $pw | & $activeNodeExe @setPwArgs } } finally { $OutputEncoding = $prevOutputEncoding }
                } elseif ($env:SABIA_OPERATOR_PASSWORD) {
                    $prevOutputEncoding = $OutputEncoding
                    $OutputEncoding = New-Object Text.UTF8Encoding($false)
                    try { Invoke-WithoutServerEnv { $env:SABIA_OPERATOR_PASSWORD | & $activeNodeExe @setPwArgs } } finally { $OutputEncoding = $prevOutputEncoding }
                } elseif ([Environment]::UserInteractive) {
                    # Run directly, with no piped stdin: setPassword.js does
                    # its own hidden prompt-with-confirmation against the
                    # console when it is not fed anything on stdin.
                    Invoke-WithoutServerEnv { & $activeNodeExe @setPwArgs }
                } else {
                    throw "No operator account exists and no password source is available. Re-run with -PasswordFile <path> or set SABIA_OPERATOR_PASSWORD, then: `"$activeNodeExe`" --env-file=`"$envFile`" `"$root\dist\setPassword.js`""
                }
                if ($LASTEXITCODE -ne 0) { throw 'setPassword.js failed.' }
            } finally {
                Pop-Location -ErrorAction SilentlyContinue
            }
        }

        # ---- service definition ----
        $autostart = 'none'
        # Whatever port SabiaServer-In already pointed at, before this run's
        # Register-SabiaAutostart potentially moves it to $resolvedPort - so a
        # rollback can put it back rather than leaving a rule for a version
        # that is no longer running.
        $priorFirewallPort = $null
        if (-not $NoService) {
            $existingRule = Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue
            if ($existingRule) {
                $existingPortFilter = $existingRule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
                if ($existingPortFilter) { $priorFirewallPort = $existingPortFilter.LocalPort }
            }
            New-Utf8NoBomFile -Path (Join-Path $root 'bin\sabia-service.ps1') -Content (Get-ServiceWrapperContent)
            $autostart = Register-SabiaAutostart -Root $root -ResolvedPort $resolvedPort
        }

        # ---- wait-healthy (rolls back a regression on an existing install) ----
        if (-not $NoService) {
            $healthResult = Invoke-Helper -NodeExe $activeNodeExe -CliPath (Join-Path $root 'dist\install\cli.js') -CliArgs @('wait-healthy', '--env-file', $envFile, '--timeout', '60')
            if ($healthResult.ExitCode -ne 0) {
                $logCmd = "Get-Content `"$root\logs\sabia.err.log`" -Tail 50"
                Stop-SabiaService -Root $root
                if ($wasInstalled) {
                    # A real upgrade (or a same-version re-run) that
                    # regressed: move any broken entries aside, restore
                    # whatever was moved to .staging\old (nothing, on a
                    # same-version re-run with no swap), restore the env
                    # and cert snapshots, revert a firewall rule this run
                    # changed, and bring the old version back up rather than
                    # leaving the failure live. Decided from the marker's
                    # original state, not from whether anything was staged -
                    # see $wasInstalled above.
                    $failedDir = Join-Path $stagingDir 'failed'
                    if (Test-Path -LiteralPath $failedDir) { Remove-Item -LiteralPath $failedDir -Recurse -Force }
                    New-Item -ItemType Directory -Path $failedDir -Force | Out-Null
                    foreach ($entry in $entriesToSwap) {
                        $cur = Join-Path $root $entry
                        if (Test-Path -LiteralPath $cur) { Move-Item -LiteralPath $cur -Destination (Join-Path $failedDir $entry) -Force }
                    }
                    foreach ($entry in $entriesToSwap) {
                        $old = Join-Path (Join-Path $stagingDir 'old') $entry
                        if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination (Join-Path $root $entry) -Force }
                    }
                    Restore-PreSwapConfig
                    $activeNodeExe = Join-Path $nodeDir 'node.exe'

                    if (-not $NoService -and $priorFirewallPort -and ($priorFirewallPort -ne [string] $resolvedPort)) {
                        try {
                            if (Test-IsElevated) {
                                Set-SabiaFirewallRule -Root $root -Port ([int] $priorFirewallPort)
                            } elseif (-not $NoElevate) {
                                $nodeExeForRevert = Format-PSSingleQuoted (Join-Path $root 'node\node.exe')
                                $revertCmd = "Remove-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue; " +
                                    "New-NetFirewallRule -Name 'SabiaServer-In' -DisplayName 'Sabia server' -Direction Inbound -Action Allow -Profile Private -Program '$nodeExeForRevert' -Protocol TCP -LocalPort $priorFirewallPort | Out-Null"
                                Invoke-ElevatedCommand -Command $revertCmd | Out-Null
                            }
                        } catch {
                            Write-Warn2 "Could not revert the firewall rule to port $priorFirewallPort after the rollback: $($_.Exception.Message)"
                        }
                    }

                    Start-SabiaAutostartMode -Root $root -Mode $marker['autostart']
                    # Re-check the restored old version actually comes back
                    # up - a rollback that silently leaves the old version
                    # unhealthy too is worse than reporting it.
                    $recheck = Invoke-Helper -NodeExe $activeNodeExe -CliPath (Join-Path $root 'dist\install\cli.js') -CliArgs @('wait-healthy', '--env-file', $envFile, '--timeout', '30')
                    if ($recheck.ExitCode -eq 0) {
                        Write-Warn2 "The upgrade did not come up healthy and was rolled back to the previous version, which is healthy again; see: $logCmd"
                        throw "wait-healthy failed on the new version (rolled back successfully): $($healthResult.Output)"
                    } else {
                        Write-Warn2 "The upgrade did not come up healthy, and the rolled-back previous version did not come back up healthy either; see: $logCmd"
                        throw "wait-healthy failed on the new version, and the rollback to the previous version also failed to become healthy: $($healthResult.Output) / $($recheck.Output)"
                    }
                } else {
                    # First install (or a reinstall after --uninstall): there
                    # is nothing to roll back to. Leave the files in place -
                    # the marker is still "installing", so a retry or
                    # -Uninstall can find and act on this root.
                    Write-Warn2 "Sabia did not come up healthy after install; see: $logCmd"
                    throw "wait-healthy failed: $($healthResult.Output)"
                }
            }
        }

        # ---- finalize ----
        Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
        $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        # Only record the Node version actually on disk after this run - not
        # the one merely resolved/downloaded, which is discarded rather than
        # swapped in whenever $stagedNodeDir was never set.
        $finalNodeVersion = if ($stagedNodeDir) { $resolvedNodeVersion } else { $currentNodeVersion }
        $newMarker = @{
            layout = '1'
            version = $targetVersion
            node = $finalNodeVersion
            os = 'win32'
            arch = $arch
            autostart = $autostart
            firewall_rule = if ($null -ne (Get-NetFirewallRule -Name 'SabiaServer-In' -ErrorAction SilentlyContinue)) { '1' } else { '0' }
            state = 'installed'
            installed_at = if ($marker -and $marker['installed_at']) { $marker['installed_at'] } else { $now }
            updated_at = $now
        }
        Write-Marker -Root $root -Fields $newMarker

        if (-not $NoService) {
            # pairing only prints URLs/token/cert/fingerprint/PEM; the
            # installed-instance commands and log location are ours to add.
            $pairing = Invoke-Helper -NodeExe $activeNodeExe -CliPath (Join-Path $root 'dist\install\cli.js') -CliArgs @('pairing', '--env-file', $envFile)
            $pairing.Output | ForEach-Object { Write-Host $_ }
        }
        Write-Info "Sabia $targetVersion installed at $root."
        Write-Info "Backup:   Set-Location `"$root`"; .\node\node.exe --env-file=sabia.env dist\backup.js"
        Write-Info "Password: Set-Location `"$root`"; .\node\node.exe --env-file=sabia.env dist\setPassword.js"
        if ($autostart -eq 'task' -or $autostart -eq 'startup-folder') {
            Write-Info "Logs:     $root\logs\sabia.out.log and $root\logs\sabia.err.log"
        }
    } finally {
        Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Sabia
