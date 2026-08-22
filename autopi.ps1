$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliMode = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]

foreach ($arg in $args) {
	if ($arg -eq "--cli") {
		$cliMode = $true
	} else {
		$forwardArgs.Add($arg)
	}
}

if ($cliMode) {
	& (Join-Path $scriptDir "pi-test.ps1") @forwardArgs
} else {
	& (Join-Path $scriptDir "pi-desktop.ps1") @forwardArgs
}

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
