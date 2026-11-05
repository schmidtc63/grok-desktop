# Installs or updates Codewomplers Grok Desktop on Windows:
#   irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex
# To install a release instead of the latest, set $GrokDesktopTag first:
#   $GrokDesktopTag = "v0.6.0"; irm https://raw.githubusercontent.com/schmidtc63/grok-desktop/main/scripts/install-windows.ps1 | iex
# The body is a function called on the last line, so a download that stops partway installs nothing.
# irm | iex runs in the current session: failures throw, and this script never calls exit.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Install-GrokDesktop {
	param([string]$Tag)
	# iex runs this file in the caller's scope, so this preference stays inside the function.
	$ErrorActionPreference = "Stop"
	if ($env:OS -ne "Windows_NT") { throw "This installer is for Windows." }
	if (-not [Environment]::Is64BitOperatingSystem) { throw "This installer is for 64-bit Windows." }
	if ($Tag -and $Tag -notmatch '^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$') {
		throw "That release tag isn't valid."
	}
	$repo = "schmidtc63/grok-desktop"
	$release = "latest/download"
	if ($Tag) { $release = "download/$Tag" }
	$dest = Join-Path $env:LOCALAPPDATA "Programs\Codewomplers Grok Desktop"
	$exeName = "Codewomplers Grok Desktop.exe"
	$exe = Join-Path $dest $exeName
	$work = Join-Path ([System.IO.Path]::GetTempPath()) ("grok-desktop-install-" + [guid]::NewGuid().ToString("n"))
	New-Item -ItemType Directory -Path $work | Out-Null
	try {
		$zip = Join-Path $work "app.zip"
		$ProgressPreference = "SilentlyContinue"
		Invoke-WebRequest -Uri "https://github.com/$repo/releases/$release/Codewomplers-Grok-Desktop-win-x64.zip" -OutFile $zip -UseBasicParsing
		Expand-Archive -LiteralPath $zip -DestinationPath $work
		$unpacked = Join-Path $work "Codewomplers Grok Desktop-win32-x64"
		if (-not (Test-Path -LiteralPath (Join-Path $unpacked $exeName))) { throw "The download didn't contain Codewomplers Grok Desktop." }
		$running = @(Get-Process -Name "Codewomplers Grok Desktop" -ErrorAction SilentlyContinue | Where-Object {
			$path = $null
			try { $path = $_.Path } catch {}
			$path -and [string]::Equals($path, $exe, [StringComparison]::OrdinalIgnoreCase)
		})
		if ($running.Count -gt 0) { throw "Quit Codewomplers Grok Desktop, then run this again." }
		New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
		$previous = $null
		if (Test-Path -LiteralPath $dest) {
			$previous = Join-Path $work "previous"
			Move-Item -LiteralPath $dest -Destination $previous
		}
		try {
			Move-Item -LiteralPath $unpacked -Destination $dest
		} catch {
			if ($previous) { Move-Item -LiteralPath $previous -Destination $dest }
			throw "The app couldn't be moved into ${dest}: $($_.Exception.Message)"
		}
		$shortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Codewomplers Grok Desktop.lnk"
		$shell = New-Object -ComObject WScript.Shell
		$shortcut = $shell.CreateShortcut($shortcutPath)
		$shortcut.TargetPath = $exe
		$shortcut.WorkingDirectory = $dest
		$shortcut.Description = "Codewomplers Grok Desktop"
		$shortcut.Save()
		Write-Output "Installed $dest. Open it from the Start menu."
	} finally {
		Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
	}
}

$tagValue = ""
$tagVar = Get-Variable -Name GrokDesktopTag -ErrorAction SilentlyContinue
if ($tagVar) { $tagValue = [string]$tagVar.Value }
Install-GrokDesktop -Tag $tagValue
