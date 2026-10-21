import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parseRelayConfig } from "../../src/cloud-relay/config.js";
import { resolveIdentityEnvironment } from "../../src/identity/environment.js";
const exec = promisify(execFile);
let temp = "";
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
it("WP-38 release artifact pins public identity; dev override cannot redirect it", async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "crot-wp38-"));
  const input = path.join(temp, "identity.json"),
    out = path.join(temp, "build");
  const source = "src/identity/release-environment.ts",
    before = await readFile(source, "utf8");
  await writeFile(input, await readFile("deploy/staging/identity.example.json"));
  await exec(process.execPath, ["scripts/build-release.mjs", "--environment", input, "--out", out]);
  const module = await import(pathToFileURL(path.join(out, "identity/environment.js")).href);
  const result = await module.resolveIdentityEnvironment({
    env: { CROT_IDENTITY_DEV_ENVIRONMENT: "attacker.json" },
    read: () => {
      throw new Error("dev file must never be read");
    },
  });
  expect(result).toMatchObject({
    ok: true,
    environment: { kind: "release", id: "staging", relayHost: "relay-staging.crot.network" },
  });
  expect(result.notes).toHaveLength(1);
  expect(await readFile(source, "utf8")).toBe(before);
  const artifact = await readFile(path.join(out, "identity/release-environment.js"), "utf8");
  await writeFile(input, JSON.stringify({ issuer: "http://attacker.invalid" }));
  await expect(
    exec(process.execPath, ["scripts/build-release.mjs", "--environment", input, "--out", out]),
  ).rejects.toThrow();
  expect(await readFile(path.join(out, "identity/release-environment.js"), "utf8")).toBe(artifact);
  expect(
    await resolveIdentityEnvironment({
      env: { CROT_IDENTITY_DEV_ENVIRONMENT: "dev.json" },
      read: async () => readFile("deploy/staging/identity.example.json", "utf8"),
    }),
  ).toMatchObject({ ok: true, environment: { kind: "development" } });
}, 60000);
it("WP-38 relay example validates and lifecycle reset is explicitly scoped", async () => {
  expect(parseRelayConfig(JSON.parse(await readFile("deploy/staging/relay.example.json", "utf8")))).toMatchObject({
    port: 8443,
    tls: { keyFile: "/config/tls.key" },
  });
  // Execute the actual JS module from Node, rather than a test implementation of the reset policy.
  const script = `import {composeArguments} from './scripts/staging.mjs'; let rejected=false; try {composeArguments('reset')} catch {rejected=true}; if(!rejected) process.exit(1); console.log(JSON.stringify(composeArguments('reset',true)));`;
  const result = await exec(process.execPath, ["--input-type=module", "-e", script]);
  expect(JSON.parse(result.stdout)).toContain("--volumes");
  expect(JSON.parse(result.stdout)).toContain("crot-staging");
});
