# toolbelt.ps1 — Windows shim (v1 stub).
# The doctor's check framework is platform-aware (each check declares per-OS
# implementations); Windows implementations are planned but not yet written.
# This stub verifies Node and runs the doctor, which will report win32 checks
# as "skip — not yet implemented".

$ErrorActionPreference = "Stop"

$ToolbeltDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "toolbelt: Node.js not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Fix:  winget install OpenJS.NodeJS.LTS"
    Write-Host ""
    Write-Host "Windows support is planned; today the doctor runs but most checks"
    Write-Host "report 'skip - not yet implemented on win32'."
    exit 1
}

$major = & node -e "process.stdout.write(String(process.versions.node.split('.')[0]))"
if ([int]$major -lt 18) {
    Write-Host "toolbelt: Node >=18 required (found $(& node --version))." -ForegroundColor Red
    Write-Host "  Fix:  winget install OpenJS.NodeJS.LTS"
    exit 1
}

& node "$ToolbeltDir\doctor\cli.mjs" @args
exit $LASTEXITCODE
