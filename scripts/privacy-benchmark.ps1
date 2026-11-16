param([string]$PythonPath = $env:PII_TEST_PYTHON, [switch]$ReportOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $PythonPath) {
  $localPython = Join-Path $projectRoot '.sites-runtime/pii-venv/Scripts/python.exe'
  if (Test-Path -LiteralPath $localPython) { $PythonPath = $localPython }
}
if (-not $PythonPath) { throw 'Set -PythonPath to the Python 3.12 environment with services/pii/requirements.lock.txt installed.' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$previousPython = $env:PII_TEST_PYTHON
try {
  $env:PII_TEST_PYTHON = $PythonPath
  $benchmarkArgs = @('--experimental-strip-types', (Join-Path $PSScriptRoot 'privacy-benchmark.mjs'), '--output', 'outputs/pii-benchmark.json')
  if ($ReportOnly) { $benchmarkArgs += '--report-only' }
  & $nodePath @benchmarkArgs
  if ($LASTEXITCODE -ne 0) { throw "Benchmark has failures (code $LASTEXITCODE). See outputs/pii-benchmark.json; use -ReportOnly to collect a report without a failing exit code." }
} finally { $env:PII_TEST_PYTHON = $previousPython }
