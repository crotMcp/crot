#!/usr/bin/env node
/**
 * CI only (GitHub Actions): create a second OS account for the WP-20 endpoint
 * test ("another OS user cannot connect to the shim or control endpoint",
 * tests/service/shim.test.ts) and export it to the following steps through
 * $GITHUB_ENV (CROT_TEST_OTHER_USER; on Windows also CROT_TEST_OTHER_PASSWORD,
 * masked in the log). Linux and macOS runners have passwordless sudo, which the
 * test uses to run a probe as that account.
 *
 * Workflow step (before `npm test`):  - run: node scripts/ci-other-user.mjs
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import console from "node:console";
import process from "node:process";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_ENV) {
  console.error("ci-other-user: refusing to create an OS account outside GitHub Actions.");
  process.exit(2);
}

const run = (file, args) => execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"] });
const exportEnv = (name, value) => appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);

let user;
if (process.platform === "linux") {
  user = "crot-other";
  run("sudo", ["useradd", "--create-home", user]);
} else if (process.platform === "darwin") {
  user = "crotother";
  run("sudo", ["sysadminctl", "-addUser", user, "-password", randomBytes(16).toString("hex")]);
} else if (process.platform === "win32") {
  user = "crotother";
  // Meets the default complexity policy; never printed.
  const password = `Crot-${randomBytes(12).toString("hex")}-a1`;
  console.log(`::add-mask::${password}`);
  // /Y answers net's prompt for passwords longer than 14 characters (CI has no console input).
  run("net", ["user", user, password, "/add", "/Y"]);
  exportEnv("CROT_TEST_OTHER_PASSWORD", password);
} else {
  console.error(`ci-other-user: unsupported platform ${process.platform}`);
  process.exit(1);
}
exportEnv("CROT_TEST_OTHER_USER", user);
console.log(`ci-other-user: created ${user}`);
