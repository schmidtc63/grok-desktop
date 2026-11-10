; Builds out/Codewomplers-Grok-Desktop-Setup.exe from the packaged app. ISCC /DAppVersion=X.Y.Z scripts/windows-setup.iss
; Same folder and Start menu shortcut as scripts/install-windows.ps1, so either one updates the other's copy.
; The install command keeps this uninstaller's unins000.* files when it replaces the folder, so the Apps and Features entry stays valid.
; The app's own update runs this with /SILENT, /WAITPID=<its process id> and /RELAUNCH=1 (installedUpdateCommand in electron/updates.cjs).
#define AppDirectory "{localappdata}\Programs\Codewomplers Grok Desktop"

[Setup]
AppId={{FE3FA70B-5AFB-45F3-8794-F66CEDED10B2}
AppName=Codewomplers Grok Desktop
AppVersion={#AppVersion}
AppPublisher=Codewomplers
DefaultDirName={#AppDirectory}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UninstallDisplayName=Codewomplers Grok Desktop
UninstallDisplayIcon={app}\Codewomplers Grok Desktop.exe
; Drop recursive delete entries recorded by earlier installers in custom folders.
UninstallLogMode=overwrite
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\codewomplers-grok-desktop.ico
OutputDir=..\out
OutputBaseFilename=Codewomplers-Grok-Desktop-Setup

; Clear old resources only in the standard folder.
[InstallDelete]
Type: filesandordirs; Name: "{app}\resources"; Check: IsStandardInstallDir

[Files]
Source: "..\out\Codewomplers Grok Desktop-win32-x64\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

; The install command can leave unlisted files in the standard folder. In custom folders, uninstall uses the list of installed files.
[UninstallDelete]
Type: filesandordirs; Name: "{app}"; Check: IsStandardInstallDir

[Icons]
Name: "{userprograms}\Codewomplers Grok Desktop"; Filename: "{app}\Codewomplers Grok Desktop.exe"; WorkingDir: "{app}"

; Open at sign-in writes this value (the app's user model id). Uninstalling removes it, and leaves the Run key alone if the app never set it.
[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "Grok.Code"; Flags: dontcreatekey uninsdeletevalue

[Run]
Filename: "{app}\Codewomplers Grok Desktop.exe"; Description: "Open Codewomplers Grok Desktop"; Flags: nowait postinstall skipifsilent
; The line above is skipped in silent mode, so the app's own update opens the new version here.
Filename: "{app}\Codewomplers Grok Desktop.exe"; WorkingDir: "{app}"; Flags: nowait; Check: ShouldRelaunch

[Code]
const SYNCHRONIZE = $00100000;
function OpenProcess(Access: DWORD; Inherit: BOOL; Pid: DWORD): THandle; external 'OpenProcess@kernel32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Ms: DWORD): DWORD; external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): BOOL; external 'CloseHandle@kernel32.dll stdcall';

function IsStandardInstallDir(): Boolean;
begin
	Result := CompareText(ExpandConstant('{app}'), ExpandConstant('{#AppDirectory}')) = 0;
end;

function ShouldRelaunch(): Boolean;
begin
	Result := ExpandConstant('{param:RELAUNCH|0}') = '1';
end;

// A file still in use by the closing app would stop the install, so wait for it to exit.
function InitializeSetup(): Boolean;
var Pid: Integer; Handle: THandle;
begin
	Result := True;
	Pid := StrToIntDef(ExpandConstant('{param:WAITPID|0}'), 0);
	if Pid > 0 then
	begin
		Handle := OpenProcess(SYNCHRONIZE, False, Pid);
		if Handle <> 0 then
		begin
			WaitForSingleObject(Handle, 60000);
			CloseHandle(Handle);
		end;
	end;
end;
