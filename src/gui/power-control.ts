import { spawn } from "node:child_process";

export function requestWindowsSleep(delaySeconds = 2): boolean {
  if (process.platform !== "win32") return false;
  const boundedDelay = Math.max(1, Math.min(30, Math.round(delaySeconds)));
  const script = [
    `Start-Sleep -Seconds ${boundedDelay}`,
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PingGPTPower { [DllImport(\"powrprof.dll\", SetLastError=true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent); }'",
    "[PingGPTPower]::SetSuspendState($false, $false, $false) | Out-Null",
  ].join("; ");
  try {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle", "Hidden",
      "-Command", script,
    ], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
