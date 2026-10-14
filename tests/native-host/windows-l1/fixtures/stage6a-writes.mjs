/* Test-owned disposable paths only. No broker or host command facility. */
import process from "node:process";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
const rows = [];
for (const [area, root] of [
  ["mediumWorkspace", process.env.CROT_6A_WORKSPACE],
  ["privateLowControl", process.env.TEMP],
  ["outsideLowControl", process.env.CROT_6A_OUTSIDE_LOW],
]) {
  for (const op of ["read", "create", "write", "rename", "remove"]) {
    const source = path.join(root, `${op} проба.txt`);
    const destination = path.join(root, "renamed проба.txt");
    const row = { area, op, attempted: true };
    try {
      if (op === "read") row.readMatched = readFileSync(source, "utf8") === "before";
      if (op === "create" || op === "write") writeFileSync(source, "after");
      if (op === "rename") renameSync(source, destination);
      if (op === "remove") unlinkSync(source);
      row.result = "ALLOWED";
    } catch (e) {
      row.result = e.code;
    }
    rows.push(row);
  }
}
writeFileSync(
  process.env.CROT_6A_RESULT,
  JSON.stringify({ cwdMatched: process.cwd() === process.env.CROT_6A_WORKSPACE, rows }),
);
