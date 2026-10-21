#!/usr/bin/env node
/** Offline backup/restore for the relay's single-writer state. Stop relay first. */
import { parseArgs } from "node:util";
import { backupRelayState, restoreRelayState } from "../cloud-relay/operations.js";
async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { registry: { type: "string" }, accounts: { type: "string" }, backup: { type: "string" } },
  });
  const [action] = parsed.positionals;
  const registryFile = parsed.values.registry;
  const accountFile = parsed.values.accounts;
  const backupDir = parsed.values.backup;
  if (!registryFile || !accountFile || !backupDir || (action !== "backup" && action !== "restore"))
    throw new Error(
      "usage: crot-relay-ops backup|restore --registry <file> --accounts <file> --backup <dir> (relay must be stopped)",
    );
  if (action === "backup") {
    const result = await backupRelayState({ registryFile, accountFile, outputDir: backupDir });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    await restoreRelayState({ backupDir, registryFile, accountFile });
    process.stdout.write("restore complete\n");
  }
}
main().catch(() => {
  process.stderr.write("crot-relay-ops: operation failed; state was not partially accepted\n");
  process.exit(1);
});
