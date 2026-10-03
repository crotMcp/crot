#!/usr/bin/env node
/**
 * crot-browser-relay entry point: the native-messaging host for the CROT
 * Browser Extension (ARCHITECTURE.md §16). See ../browser-bridge/relay.ts.
 *
 * The browser starts it through the launcher installed by
 * `crot-mcp browser install`, which passes --state-dir. stdout is reserved for
 * native-messaging frames; all diagnostics go to stderr.
 */
import { parseRelayArgs, runRelay } from "../browser-bridge/relay.js";
import { flushStream } from "../cli/lifecycle.js";
import { CrotError } from "../core/errors.js";

const log = (message: string) => process.stderr.write(`crot-browser-relay: ${message}\n`);

async function main(): Promise<number> {
  const { stateDir } = parseRelayArgs(process.argv.slice(2));
  return runRelay({ stateDir, input: process.stdin, output: process.stdout, log });
}

async function exit(code: number): Promise<never> {
  process.exitCode = code;
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(code);
}

main().then(exit, (error: unknown) => {
  log(
    error instanceof CrotError
      ? error.message
      : `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  return exit(1);
});
