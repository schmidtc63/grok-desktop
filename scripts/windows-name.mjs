import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { rcedit } from "rcedit";

// The Windows file properties are the only thing this script names; macOS and Linux have nothing to edit.
if (process.platform !== "win32") { process.exit(0); }
// Electron 45 downloads its binary the first time its package is required, so a fresh install has no dist/ until then.
const exe = createRequire(import.meta.url)("electron");
const current = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", `$i = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:GROK_EXE); "$($i.FileDescription)|$($i.ProductName)|$($i.InternalName)|$($i.OriginalFilename)"`],
  { encoding: "utf8", env: { ...process.env, GROK_EXE: exe } },
).trim();
if (current === "Codewomplers Grok Desktop|Codewomplers Grok Desktop|Grok|Grok.exe") process.exit(0);
await rcedit(exe, {
  "version-string": {
    FileDescription: "Codewomplers Grok Desktop",
    ProductName: "Codewomplers Grok Desktop",
    CompanyName: "Codewomplers",
    LegalCopyright: "Copyright (c) 2026 Codewomplers",
    InternalName: "Grok",
    OriginalFilename: "Grok.exe",
  },
});
