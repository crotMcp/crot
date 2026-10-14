/* Trusted, disposable canary process; never CROT state or a user secret. */
import process from "node:process";
import { Buffer } from "node:buffer";
import { writeFileSync, renameSync } from "node:fs";
import { setInterval } from "node:timers";
import { bindings, canaryPipe } from "./memory-ipc.mjs";
const [koffiPath, ready, file, ownerSid, prefix, expectedHex] = process.argv.slice(2);
const bytes = Buffer.from(expectedHex, "hex");
const api = bindings(koffiPath);
const handle = api.file(file, 0x80000000, 1, null, 3, 0, 0);
if (!handle || BigInt(handle) === 0xffffffffffffffffn) throw new Error("canary file open failed");
const pipes = {
  control: prefix + "-control",
  ordinary: prefix + "-plain",
  protected: prefix + "-nr",
  low: prefix + "-low",
};
const owned = [
  canaryPipe(koffiPath, pipes.control, ownerSid, "medium-nr", bytes),
  canaryPipe(koffiPath, pipes.ordinary, ownerSid, "medium", bytes),
  canaryPipe(koffiPath, pipes.protected, ownerSid, "medium-nr", bytes),
  canaryPipe(koffiPath, pipes.low, ownerSid, "low", bytes),
];
const report = {
  pid: process.pid,
  address: api.ffi.address(bytes).toString(),
  handle: BigInt(handle).toString(),
  pipes,
};
writeFileSync(ready + ".tmp", JSON.stringify(report));
renameSync(ready + ".tmp", ready);
// Hold the exact buffer and handles until the test-owned Job ends this process.
setInterval(() => {
  void bytes[0];
  void owned.length;
}, 1000);
