; Builds out/Codewomplers-Grok-Desktop-Setup.exe from the packaged app. ISCC /DAppVersion=X.Y.Z scripts/windows-setup.iss
; Same folder and Start menu shortcut as scripts/install-windows.ps1, so either one updates the other's copy.
; The install command keeps this uninstaller's unins000.* files when it replaces the folder, so the Apps and Features entry stays valid.
[Setup]
AppId={{FE3FA70B-5AFB-45F3-8794-F66CEDED10B2}
AppName=Codewomplers Grok Desktop
AppVersion={#AppVersion}
AppPublisher=Codewomplers
DefaultDirName={localappdata}\Programs\Codewomplers Grok Desktop
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UninstallDisplayName=Codewomplers Grok Desktop
UninstallDisplayIcon={app}\Codewomplers Grok Desktop.exe
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\codewomplers-grok-desktop.ico
OutputDir=..\out
OutputBaseFilename=Codewomplers-Grok-Desktop-Setup

[Files]
Source: "..\out\Codewomplers Grok Desktop-win32-x64\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

; The install command can leave files this uninstaller didn't list, so remove the whole folder. Settings and history live in %APPDATA% and stay.
[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Icons]
Name: "{userprograms}\Codewomplers Grok Desktop"; Filename: "{app}\Codewomplers Grok Desktop.exe"; WorkingDir: "{app}"

[Run]
Filename: "{app}\Codewomplers Grok Desktop.exe"; Description: "Open Codewomplers Grok Desktop"; Flags: nowait postinstall skipifsilent
