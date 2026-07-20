#!/usr/bin/env node
/**
 * npm "prepare" hook: auto-install wick's git hooks after `npm install`,
 * Husky-style. Dogfooding must never break an install:
 *   - opt out with WICK_AUTOINSTALL=0
 *   - skipped in CI and when wick is installed as a dependency
 *   - any failure warns and exits 0
 */
import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

try {
  if (process.env.WICK_AUTOINSTALL === "0" || process.env.CI) process.exit(0);

  const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const toplevel = execSync("git rev-parse --show-toplevel", {
    cwd: pkgRoot,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
  // Only when developing wick itself — as a dependency under node_modules the
  // git toplevel is the host repo, and we must not touch its hooks uninvited.
  if (path.resolve(toplevel) !== path.resolve(pkgRoot)) process.exit(0);

  execSync("npm run build", { cwd: pkgRoot, stdio: "ignore" });
  execSync(`node ${JSON.stringify(path.join(pkgRoot, "dist", "cli.js"))} install`, {
    cwd: pkgRoot,
    stdio: "inherit",
  });
} catch {
  console.warn("wick: hook auto-install skipped — run `npx wick install` manually");
}
process.exit(0);
