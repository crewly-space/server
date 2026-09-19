#!/usr/bin/env node
/*
 * Put a built web UI under ./web for the server to serve.
 *
 * The app is a separate repository with its own release cadence, so the server
 * does not build it. This resolves, in order:
 *
 *   1. a sibling ../app/dist checkout (fastest inner loop)
 *   2. the CREWLY_APP_TARBALL url, or the app repo's release for APP_VERSION
 *
 * Usage:  node scripts/fetch-app.mjs [version]
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(repoRoot, "web");
const sibling = resolve(repoRoot, "../app/dist");

if (existsSync(sibling)) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(sibling, target, { recursive: true });
  console.log("fetch-app: copied ../app/dist -> web/");
  process.exit(0);
}

const version = process.argv[2] ?? process.env.APP_VERSION ?? "latest";
const url =
  process.env.CREWLY_APP_TARBALL ??
  `https://github.com/crewly-space/app/releases/${
    version === "latest" ? "latest/download" : `download/v${version}`
  }/crewly-app-dist.tar.gz`;

console.log(`fetch-app: downloading ${url}`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) {
  console.error(
    `fetch-app: ${response.status} ${response.statusText}.\n` +
      "Check out the app repo next to this repo and run its build, or set CREWLY_APP_TARBALL.",
  );
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const tarball = resolve(repoRoot, "app-dist.tar.gz");
writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], { stdio: "inherit" });
rmSync(tarball, { force: true });
console.log("fetch-app: unpacked into web/");
