# slack-cli - Diagnostic Script (Windows PowerShell)
#
#   .\diagnose.ps1          report runtime, Chrome, configuration, network, auth cache
#   .\diagnose.ps1 -Reset   delete the auth cache and the Chrome profile (forces a fresh login)
#
# Reports metadata only. It never prints the token or cookies.
param(
    [switch]$Reset,
    [switch]$r
)

$authFile = Join-Path $env:USERPROFILE ".slack-cli-auth.json"
$profileDir = if ($env:SLACK_CLI_PROFILE) { $env:SLACK_CLI_PROFILE } else { Join-Path $env:USERPROFILE ".slack-cli" }
$configFile = Join-Path $env:USERPROFILE ".config\slack-cli\config.json"

if ($Reset -or $r) {
    Write-Host "Resetting slack-cli session state..." -ForegroundColor Cyan
    Write-Host ""
    if (Test-Path $authFile) {
        Remove-Item $authFile -Force
        Write-Host "   deleted auth cache: $authFile" -ForegroundColor Green
    } else {
        Write-Host "   auth cache not found (already clean)" -ForegroundColor Yellow
    }
    if (Test-Path $profileDir) {
        Remove-Item $profileDir -Recurse -Force
        Write-Host "   deleted browser profile: $profileDir" -ForegroundColor Green
    } else {
        Write-Host "   browser profile not found (already clean)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Reset complete. The next command opens Chrome for a fresh sign-in." -ForegroundColor Cyan
    exit 0
}

Write-Host "slack-cli - Diagnostics" -ForegroundColor Cyan
Write-Host "=======================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Node.js:" -ForegroundColor Yellow
try {
    $nodeVersion = node -v 2>$null
    if ($nodeVersion) {
        $major = [int]($nodeVersion -replace 'v' -split '\.')[0]
        if ($major -ge 22) {
            Write-Host "   ok: $nodeVersion (>= 22.12 required)" -ForegroundColor Green
        } else {
            Write-Host "   FAIL: $nodeVersion is too old (need >= 22.12)" -ForegroundColor Red
        }
    } else {
        Write-Host "   FAIL: not installed" -ForegroundColor Red
    }
} catch {
    Write-Host "   FAIL: not installed" -ForegroundColor Red
}
Write-Host ""

Write-Host "Google Chrome:" -ForegroundColor Yellow
if ($env:CHROME_PATH) {
    if (Test-Path $env:CHROME_PATH) {
        Write-Host "   ok: CHROME_PATH=$env:CHROME_PATH" -ForegroundColor Green
    } else {
        Write-Host "   FAIL: CHROME_PATH set but not found: $env:CHROME_PATH" -ForegroundColor Red
    }
} else {
    $chromePaths = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $foundChrome = $null
    foreach ($p in $chromePaths) {
        if ($p -and (Test-Path $p)) { $foundChrome = $p; break }
    }
    if ($foundChrome) {
        Write-Host "   ok: $foundChrome" -ForegroundColor Green
    } else {
        Write-Host "   FAIL: not found in standard locations (set CHROME_PATH)" -ForegroundColor Red
    }
}
Write-Host ""

Write-Host "Configuration:" -ForegroundColor Yellow
$workspace = $env:SLACK_WORKSPACE_URL
$source = "env SLACK_WORKSPACE_URL"
if (-not $workspace -and (Test-Path $configFile)) {
    try {
        $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
        $workspace = $cfg.workspace_url
        $source = $configFile
    } catch {
        Write-Host "   FAIL: $configFile is not valid JSON" -ForegroundColor Red
    }
}
if ($workspace) {
    Write-Host "   ok: workspace $workspace (from $source)" -ForegroundColor Green
} else {
    Write-Host "   FAIL: no workspace configured" -ForegroundColor Red
    Write-Host "         `$env:SLACK_WORKSPACE_URL = 'https://yourco.slack.com/'" -ForegroundColor Gray
    Write-Host "         or write $configFile as {""workspace_url"": ""https://yourco.slack.com/""}" -ForegroundColor Gray
}
if ($env:SLACK_ENTERPRISE_ID) { Write-Host "   enterprise id pinned: SLACK_ENTERPRISE_ID is set" -ForegroundColor Gray }
Write-Host ""

if ($workspace) {
    Write-Host "Network ($workspace):" -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $workspace -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop | Out-Null
        Write-Host "   ok: reachable" -ForegroundColor Green
    } catch {
        Write-Host "   FAIL: not reachable (VPN or proxy required?)" -ForegroundColor Red
    }
    Write-Host ""
}

Write-Host "Authentication cache:" -ForegroundColor Yellow
if (Test-Path $authFile) {
    Write-Host "   ok: $authFile exists" -ForegroundColor Green
    $content = Get-Content $authFile -Raw
    if ($content -match '"token"') {
        Write-Host "   ok: token field present" -ForegroundColor Green
    } else {
        Write-Host "   WARN: token field missing (re-run: node cli.js login)" -ForegroundColor Yellow
    }
    if ($content -match '"workspace"\s*:\s*"([^"]+)"') {
        Write-Host "   session belongs to: $($Matches[1])" -ForegroundColor Gray
    }
} else {
    Write-Host "   none yet - the first command opens Chrome for sign-in (or run: node cli.js login)" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "Browser profile:" -ForegroundColor Yellow
if (Test-Path $profileDir) {
    Write-Host "   ok: $profileDir exists" -ForegroundColor Green
} else {
    Write-Host "   none yet - created on first sign-in" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "=======================" -ForegroundColor Cyan
Write-Host "Helpful commands:" -ForegroundColor Yellow
Write-Host "   Who am I:      node cli.js whoami" -ForegroundColor Gray
Write-Host "   Fresh login:   node cli.js login" -ForegroundColor Gray
Write-Host "   Reset session: .\diagnose.ps1 -Reset" -ForegroundColor Gray
Write-Host "   Cache details: Get-Item $authFile   (metadata only; never print this file - it holds a live token)" -ForegroundColor Gray
