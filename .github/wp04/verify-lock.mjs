/* global process, console */
// Temporary (WP-04): checks that adding the dev dependencies changed nothing else.
import { readFileSync } from "node:fs";

const [pkgBeforePath, lockBeforePath] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const pkgBefore = read(pkgBeforePath);
const pkgAfter = read("package.json");
const lockBefore = read(lockBeforePath);
const lockAfter = read("package-lock.json");
const expected = ["eslint", "@eslint/js", "typescript-eslint", "eslint-config-prettier", "prettier"].sort();
const problems = [];

// package.json: only the expected devDependencies were added.
const { devDependencies: devBefore = {}, ...restBefore } = pkgBefore;
const { devDependencies: devAfter = {}, ...restAfter } = pkgAfter;
if (JSON.stringify(restBefore) !== JSON.stringify(restAfter)) problems.push("package.json changed outside devDependencies");
for (const [name, range] of Object.entries(devBefore)) {
  if (devAfter[name] !== range) problems.push(`devDependency ${name} changed: ${range} -> ${devAfter[name]}`);
}
const added = Object.keys(devAfter)
  .filter((n) => !(n in devBefore))
  .sort();
if (JSON.stringify(added) !== JSON.stringify(expected)) problems.push(`unexpected devDependencies: ${added.join(", ")}`);

// package-lock.json: the root's runtime dependencies and every existing entry are unchanged.
const rootBefore = lockBefore.packages[""] ?? {};
const rootAfter = lockAfter.packages[""] ?? {};
for (const key of ["dependencies", "optionalDependencies"]) {
  if (JSON.stringify(rootBefore[key]) !== JSON.stringify(rootAfter[key])) problems.push(`lock root ${key} changed`);
}
let kept = 0;
for (const [path, entry] of Object.entries(lockBefore.packages)) {
  if (path === "") continue;
  const now = lockAfter.packages[path];
  if (!now) {
    problems.push(`entry removed: ${path}`);
    continue;
  }
  for (const key of ["version", "resolved", "integrity"]) {
    if (entry[key] !== now[key]) problems.push(`${path}: ${key} ${entry[key]} -> ${now[key]}`);
  }
  kept++;
}
const newEntries = Object.keys(lockAfter.packages).filter((p) => !(p in lockBefore.packages));

console.log(`- package.json: added devDependencies ${added.map((n) => `${n}@${devAfter[n]}`).join(", ")}`);
console.log(`- package-lock.json: ${kept} existing entries unchanged, ${newEntries.length} entries added`);
for (const n of expected) {
  const e = lockAfter.packages[`node_modules/${n}`];
  console.log(`  - ${n} ${e?.version} ${e?.integrity}`);
}
if (problems.length > 0) {
  console.log("- Problems:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
