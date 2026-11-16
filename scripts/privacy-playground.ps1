param([string]$PythonPath = $env:PII_TEST_PYTHON)
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
  & $nodePath --experimental-strip-types (Join-Path $PSScriptRoot 'privacy-playground.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Playground exited with code $LASTEXITCODE" }
} finally { $env:PII_TEST_PYTHON = $previousPython }
