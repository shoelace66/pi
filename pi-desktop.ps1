$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopApp = Join-Path $scriptDir "apps\desktop"
$electronBin = Join-Path $scriptDir "node_modules\.bin\electron.cmd"
$mainFile = Join-Path $desktopApp "dist\electron\main.js"
$viteBin = Join-Path $scriptDir "node_modules\vite\bin\vite.js"

function Test-DesktopBuildRequired {
	if (-not (Test-Path -LiteralPath $mainFile)) { return $true }
	$builtAt = (Get-Item -LiteralPath $mainFile).LastWriteTimeUtc
	$inputs = @(
		(Join-Path $desktopApp "electron"),
		(Join-Path $desktopApp "renderer"),
		(Join-Path $desktopApp "shared"),
		(Join-Path $desktopApp "package.json"),
		(Join-Path $desktopApp "tsconfig.json")
	)
	foreach ($input in $inputs) {
		if ((Test-Path -LiteralPath $input -PathType Leaf) -and (Get-Item -LiteralPath $input).LastWriteTimeUtc -gt $builtAt) {
			return $true
		}
		if (Test-Path -LiteralPath $input -PathType Container) {
			$newer = Get-ChildItem -LiteralPath $input -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $builtAt } | Select-Object -First 1
			if ($newer) { return $true }
		}
	}
	return $false
}

$forceBuild = $false
$devMode = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]
foreach ($arg in $args) {
	if ($arg -eq "--build") { $forceBuild = $true }
	elseif ($arg -eq "--dev") { $devMode = $true }
	else { $forwardArgs.Add($arg) }
}

if (-not (Test-Path -LiteralPath $electronBin)) {
	throw "Electron not found at $electronBin. Run 'npm install --ignore-scripts' from the repo root first."
}

if ($devMode) {
	if (-not (Test-Path -LiteralPath $viteBin)) {
		throw "Vite not found at $viteBin. Run 'npm install --ignore-scripts' from the repo root first."
	}
	if ($forceBuild -or (Test-DesktopBuildRequired)) {
		Write-Host "Building AutoPi Desktop runtime..."
		npm.cmd --prefix $desktopApp run build
		if ($LASTEXITCODE -ne 0) { throw "Build failed. Run 'npm.cmd --prefix apps\desktop run build' to see details." }
	}
	Write-Host "Starting Vite dev server..."
	$viteProc = Start-Process -FilePath "node" -ArgumentList "`"$viteBin`"","--config","`"$(Join-Path $desktopApp 'renderer\vite.config.ts')`"" -WorkingDirectory $desktopApp -PassThru -WindowStyle Hidden
	try {
		$ready = $false
		for ($i = 0; $i -lt 40; $i++) {
			Start-Sleep -Milliseconds 500
			try {
				$response = Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 2
				if ($response.StatusCode -eq 200) { $ready = $true; break }
			} catch {}
		}
		if (-not $ready) { throw "Vite dev server did not start at http://localhost:5173" }
	Write-Host "Launching AutoPi (dev mode)..."
		& $electronBin $desktopApp --dev @forwardArgs
	} finally {
		if ($viteProc -and -not $viteProc.HasExited) { Stop-Process -Id $viteProc.Id -Force -ErrorAction SilentlyContinue }
	}
} else {
	if ($forceBuild -or (Test-DesktopBuildRequired)) {
		Write-Host "Building AutoPi Desktop..."
		npm.cmd --prefix $desktopApp run build
		if ($LASTEXITCODE -ne 0) { throw "Build failed. Run 'npm.cmd --prefix apps\\desktop run build' to see details." }
	}
	& $electronBin $desktopApp @forwardArgs
}

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) { exit $exitCode }
