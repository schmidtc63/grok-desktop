; Builds out/Codewomplers-Grok-Desktop-Setup.exe from the packaged app. ISCC /DAppVersion=X.Y.Z scripts/windows-setup.iss
; Same folder and Start menu shortcut as scripts/install-windows.ps1, so either one updates the other's copy.
; ponytail: no uninstaller; the install command replaces the folder and would orphan one. Add it with an uninstaller-aware update path.
[Setup]
AppName=Codewomplers Grok Desktop
AppVersion={#AppVersion}
AppPublisher=Codewomplers
DefaultDirName={localappdata}\Programs\Codewomplers Grok Desktop
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
Uninstallable=no
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\codewomplers-grok-desktop.ico
OutputDir=..\out
OutputBaseFilename=Codewomplers-Grok-Desktop-Setup

[Files]
Source: "..\out\Codewomplers Grok Desktop-win32-x64\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{userprograms}\Codewomplers Grok Desktop"; Filename: "{app}\Codewomplers Grok Desktop.exe"; WorkingDir: "{app}"

[Run]
Filename: "{app}\Codewomplers Grok Desktop.exe"; Description: "Open Codewomplers Grok Desktop"; Flags: nowait postinstall skipifsilent
