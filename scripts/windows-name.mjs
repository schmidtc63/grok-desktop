import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";

const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "electron", "dist", "electron.exe");
const current = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", `$i = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('${exe}'); "$($i.FileDescription)|$($i.ProductName)|$($i.InternalName)|$($i.OriginalFilename)"`],
  { encoding: "utf8" },
).trim();
if (current === "Grok Desktop|Grok Desktop|Grok Desktop|Grok Desktop.exe") process.exit(0);
await rcedit(exe, {
  "version-string": {
    FileDescription: "Grok Desktop",
    ProductName: "Grok Desktop",
    InternalName: "Grok Desktop",
    OriginalFilename: "Grok Desktop.exe",
  },
});
