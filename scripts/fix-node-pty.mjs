/**
 * Make node-pty's spawn-helper executable.
 *
 * node-pty creates the PTY through a small helper binary it ships as a
 * prebuild. Depending on how npm unpacks the tarball, that helper can land
 * without its executable bit, and then every spawn dies with a bare
 * "posix_spawnp failed" that says nothing about permissions.
 *
 * This runs on install and puts the bit back. It is deliberately silent and
 * never fails the install: if node-pty is missing or already fine, there is
 * nothing to do, and a broken postinstall is worse than the bug it fixes.
 *
 * Upstream: https://github.com/microsoft/node-pty/issues/508
 */

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const EXECUTABLE = 0o755;

function nodePtyRoot() {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

function fix(path) {
  if (!existsSync(path)) return false;
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o111) return false; // already executable
  chmodSync(path, EXECUTABLE);
  return true;
}

const root = nodePtyRoot();
if (root) {
  let fixed = 0;
  const prebuilds = join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
      if (fix(join(prebuilds, platform, "spawn-helper"))) fixed += 1;
    }
  }
  // Present instead when node-pty had to compile from source.
  if (fix(join(root, "build", "Release", "spawn-helper"))) fixed += 1;

  if (fixed) console.log(`automode: made node-pty's spawn-helper executable (${fixed})`);
}
