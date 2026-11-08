# studio.ps1 - start and stop ComfyUI and the web interface on MSI in the background.
# Entry point: studio.bat in the repo root (its header lists the commands).
# Each service runs in a hidden window. Its output goes to logs\<name>.log in the repo root,
# the launcher pid to logs\<name>.pid (logs\ is git-ignored).
# ASCII only: Windows PowerShell 5.1 reads a script without BOM in the ANSI code page.

param(
    [Parameter(Position = 0)][string]$Action = "help",
    [Parameter(Position = 1)][string]$Target = "all"
)

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Logs = Join-Path $Repo "logs"
$WebDir = Join-Path $Repo "web-interface"

function Get-WebPort {
    $file = Join-Path $WebDir ".env"
    if (Test-Path $file) {
        foreach ($line in Get-Content $file -Encoding UTF8) {
            if ($line -match '^\s*PORT\s*=\s*"?(\d+)') { return [int]$Matches[1] }
        }
    }
    8000
}

$Units = [ordered]@{
    comfy = @{ Key = "comfy"; Name = "ComfyUI"; Port = 8188; Wait = 180; Dir = $Repo
               Command = '"' + (Join-Path $PSScriptRoot "comfy_start.bat") + '"' }
    web   = @{ Key = "web"; Name = "Mila Draw AI"; Port = (Get-WebPort); Wait = 60; Dir = $WebDir
               Command = "uv run --python 3.13 python -m server" }
}

function Get-ListenPid([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
}

function Get-LanIp {
    # Same trick as server/__main__.py: the address Windows would use to leave the PC.
    try {
        $udp = New-Object System.Net.Sockets.UdpClient
        $udp.Connect("10.255.255.255", 1)
        $ip = $udp.Client.LocalEndPoint.Address.ToString()
        $udp.Close()
        $ip
    } catch { $null }
}

function Get-Address($u) {
    $text = "http://127.0.0.1:$($u.Port)"
    if ($u.Key -eq "web") {
        $ip = Get-LanIp
        if ($ip) { $text += "   phone / Mac: http://${ip}:$($u.Port)" }
    }
    $text
}

function Start-Unit($u) {
    if (Get-ListenPid $u.Port) {
        Write-Host "$($u.Name): already running - $(Get-Address $u)"
        return $null
    }
    New-Item -ItemType Directory -Force $Logs | Out-Null
    $log = Join-Path $Logs "$($u.Key).log"
    $env:PYTHONUNBUFFERED = "1"
    $env:PYTHONIOENCODING = "utf-8"
    $cmdLine = '/s /c "' + $u.Command + ' > "' + $log + '" 2>&1"'
    $proc = Start-Process cmd.exe -ArgumentList $cmdLine -WorkingDirectory $u.Dir -WindowStyle Hidden -PassThru
    Set-Content (Join-Path $Logs "$($u.Key).pid") "$($proc.Id) $($proc.StartTime.Ticks)"
    Write-Host "$($u.Name): starting..."
    $proc
}

function Wait-Unit($u, $proc) {
    $deadline = (Get-Date).AddSeconds($u.Wait)
    while ((Get-Date) -lt $deadline) {
        if (Get-ListenPid $u.Port) {
            Write-Host "$($u.Name): ready - $(Get-Address $u)"
            return $true
        }
        if ($proc.HasExited) {
            Write-Host "$($u.Name): FAILED to start. Last lines of logs\$($u.Key).log:"
            Get-Content (Join-Path $Logs "$($u.Key).log") -Tail 15 -Encoding UTF8 |
                ForEach-Object { Write-Host "  $_" }
            return $false
        }
        Start-Sleep -Seconds 1
    }
    Write-Host "$($u.Name): no answer after $($u.Wait) s - see logs\$($u.Key).log"
    $false
}

function Stop-Unit($u) {
    $ids = @()
    $pidFile = Join-Path $Logs "$($u.Key).pid"
    if (Test-Path $pidFile) {
        # Kill the launcher only if it is still the same process (pids get reused).
        $id, $ticks = (Get-Content $pidFile -Raw).Trim() -split ' '
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($proc -and "$($proc.StartTime.Ticks)" -eq $ticks) { $ids += [int]$id }
        Remove-Item $pidFile
    }
    $ids += @(Get-ListenPid $u.Port)
    $ids = @($ids | Where-Object { $_ } | Select-Object -Unique)
    if (-not $ids) {
        Write-Host "$($u.Name): not running"
        return
    }
    foreach ($id in $ids) { cmd /c "taskkill /PID $id /T /F >nul 2>&1" }
    for ($i = 0; $i -lt 40 -and (Get-ListenPid $u.Port); $i++) { Start-Sleep -Milliseconds 250 }
    Write-Host "$($u.Name): stopped"
}

function Show-Status($u) {
    $id = Get-ListenPid $u.Port | Select-Object -First 1
    if ($id) { Write-Host ("{0,-14} running   {1}" -f $u.Name, (Get-Address $u)) }
    else { Write-Host ("{0,-14} stopped" -f $u.Name) }
}

function Show-Help {
    Write-Host @"
Usage: studio <command> [comfy|web]      (in PowerShell: .\studio ...)

  studio start          start ComfyUI and the web interface
  studio stop           stop both
  studio restart        restart both
  studio start comfy    only ComfyUI         (stop comfy, restart comfy - the same way)
  studio start web      only the web interface
  studio status         what is running and the addresses
  studio logs web       follow a log, Ctrl+C to quit (or: studio logs comfy)

Logs: logs\comfy.log and logs\web.log in the repo root.
"@
}

if ($Target -eq "all") { $targets = @($Units.Keys) }
elseif ($Units.Contains($Target)) { $targets = @($Target) }
else {
    Write-Host "Unknown service '$Target': use comfy, web or nothing for both."
    exit 1
}

function Invoke-Start {
    $started = @()
    foreach ($t in $targets) {
        $proc = Start-Unit $Units[$t]
        if ($proc) { $started += , @($Units[$t], $proc) }
    }
    $ok = $true
    foreach ($pair in $started) {
        if (-not (Wait-Unit $pair[0] $pair[1])) { $ok = $false }
    }
    $ok
}

function Invoke-Stop {
    # Web first: it talks to ComfyUI, not the other way round.
    foreach ($t in ($targets | Sort-Object { if ($_ -eq "web") { 0 } else { 1 } })) { Stop-Unit $Units[$t] }
}

switch ($Action) {
    "start"   { if (-not (Invoke-Start)) { exit 1 } }
    "stop"    { Invoke-Stop }
    "restart" { Invoke-Stop; if (-not (Invoke-Start)) { exit 1 } }
    "status"  { foreach ($u in $Units.Values) { Show-Status $u } }
    "logs" {
        if ($Target -eq "all") { Write-Host "Which log: studio logs comfy  or  studio logs web"; exit 1 }
        $log = Join-Path $Logs "$Target.log"
        if (-not (Test-Path $log)) { Write-Host "No log yet: $log"; exit 1 }
        Get-Content $log -Tail 40 -Wait -Encoding UTF8
    }
    default { Show-Help }
}
