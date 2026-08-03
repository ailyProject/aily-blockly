param(
  [ValidateSet('worker', 'utility')]
  [string]$Mode = 'worker',
  [switch]$NoCacheClean
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeModule = Join-Path $repoRoot 'electron\chat-runtime-lex-execution-runtime.mjs'

if (-not (Test-Path -LiteralPath $runtimeModule)) {
  throw "Missing Lex execution-host runtime module: $runtimeModule"
}

$sharpPackageJson = Join-Path $repoRoot 'electron\node_modules\sharp\package.json'
if (-not (Test-Path -LiteralPath $sharpPackageJson)) {
  throw 'Missing electron dependency "sharp". Run: npm install --prefix electron'
}

Push-Location $repoRoot
try {
  $env:AILY_CHAT_EXECUTION_HOST = $Mode
  $env:AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE = $runtimeModule
  $env:AILY_CHAT_TRACE_RUNTIME_HOST = '1'

  if (-not $NoCacheClean) {
    Remove-Item -LiteralPath (Join-Path $repoRoot '.angular\cache') -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host '[AilyChat] Starting Electron with real non-renderer Lex execution host.'
  Write-Host "[AilyChat] AILY_CHAT_EXECUTION_HOST=$env:AILY_CHAT_EXECUTION_HOST"
  Write-Host "[AilyChat] AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE=$env:AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE"
  Write-Host ''
  Write-Host 'Expected app log markers before judging performance:'
  Write-Host '  [AilyChat][RuntimeHostBootstrapSource]'
  Write-Host '  [AilyChat][ExecutionHostStart] {"phase":"started",...}'
  Write-Host '  [AilyChat][ExecutionHostStart] {"phase":"ready",...}'
  Write-Host '  [AilyChat][RuntimeOwnerRegistered] ... "kind":"worker" or "kind":"utilityProcess"'
  Write-Host '  [AilyChat][RuntimeHostOwnerDispatch] ... "owner":{"kind":"worker" or "utilityProcess"}'
  Write-Host ''
  Write-Host 'If those markers are absent, the run is still on the renderer fallback chain.'
  Write-Host ''

  npm run electron
} finally {
  Pop-Location
}
