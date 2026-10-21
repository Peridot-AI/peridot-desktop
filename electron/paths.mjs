// Path confinement for the coding agent, kept free of Electron imports so it can be tested on its own.
import fs from "node:fs";
import path from "node:path";

/**
 * Resolves a user/model supplied path inside `root` (a real path), following symlinks.
 * Throws when the result would be outside the workspace.
 */
export function resolveInside(root, rel = ".") {
  if (!root) throw new Error("No folder is open.");
  const abs = path.resolve(root, String(rel));
  // For files that don't exist yet, check the nearest existing parent
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Path is outside the workspace: ${rel}`);
  return abs;
}
