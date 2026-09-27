/**
 * Cross-platform test launcher.
 *
 * Shell glob expansion differs across POSIX shells and Windows PowerShell.
 * Enumerate compiled test files in Node so npm test behaves identically.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = join(process.cwd(), "dist", "tests");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(dir, name));

if (!files.length) {
  console.error("automode: no compiled test files found");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
