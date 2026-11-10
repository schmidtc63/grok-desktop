# Builds the Windows release zip into out/. Run npm ci and npm run build first.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (Test-Path -LiteralPath out) { Remove-Item -LiteralPath out -Recurse -Force }
New-Item -ItemType Directory -Path out | Out-Null
$version = (Get-Content -Raw -LiteralPath package.json | ConvertFrom-Json).version
$name = "Codewomplers Grok Desktop"
& npx --no-install electron-packager . $name `
	--platform=win32 `
	--arch=x64 `
	--icon=assets/codewomplers-grok-desktop.ico `
	--app-copyright="Copyright (c) 2026 Codewomplers" `
	--win32metadata.CompanyName=Codewomplers `
	--win32metadata.FileDescription=$name `
	--win32metadata.ProductName=$name `
	--win32metadata.InternalName=Grok `
	--win32metadata.OriginalFilename=Grok.exe `
	--out=out `
	--no-asar `
	--no-prune `
	--ignore='^/(node_modules|src|out|[.]github|public|scripts/(fixtures|test-[^/]+[.]cjs|grokbot-fake-server[.]cjs))(/|$)'
if ($LASTEXITCODE -ne 0) { throw "electron-packager failed with exit code $LASTEXITCODE." }
$app = Join-Path $root "out\$name-win32-x64"
& node (Join-Path $PSScriptRoot "package-node-pty.cjs") (Join-Path $app "resources\app") win32 x64
if ($LASTEXITCODE -ne 0) { throw "The Windows terminal runtime could not be packaged." }
$exe = Join-Path $app "$name.exe"
foreach ($rel in @("$name.exe", "resources\app\electron\main.cjs", "resources\app\dist\index.html", "resources\app\scripts\update-helper.cjs")) {
	if (-not (Test-Path -LiteralPath (Join-Path $app $rel))) { throw "The package is missing $rel." }
}
$info = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
if ($info.FileDescription -ne $name) { throw "FileDescription is '$($info.FileDescription)'." }
if ($info.ProductName -ne $name) { throw "ProductName is '$($info.ProductName)'." }
$product = [string]$info.ProductVersion
$file = [string]$info.FileVersion
if ($product -ne $version -and -not $file.StartsWith("$version")) { throw "Packaged version is '$product' / '$file', expected $version." }
$zip = Join-Path $root "out\Codewomplers-Grok-Desktop-win-x64.zip"
Compress-Archive -Path $app -DestinationPath $zip
if (-not (Test-Path -LiteralPath $zip)) { throw "The zip was not written." }
