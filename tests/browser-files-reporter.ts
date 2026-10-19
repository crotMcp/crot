/** Native Core file-contour evidence from actual completed Vitest cases. */
import { writeSync } from "node:fs";
export default class BrowserFilesReporter {
  onFinished(files: unknown[]): void {
    const suites: { file: string; rows: { name: string; state: string }[] }[] = [];
    for (const item of files) {
      const file = item as { filepath?: string; name?: string; tasks?: unknown[] };
      const name = (file.filepath ?? file.name ?? "").replace(/\\/g, "/");
      if (!/\/core\/browser-files(?:-integration)?\.test\.ts$/.test(name)) continue;
      const rows: { name: string; state: string }[] = [];
      const visit = (raw: unknown) => {
        const task = raw as { type?: string; name?: string; result?: { state?: string }; tasks?: unknown[] };
        if (task.type === "test") rows.push({ name: task.name ?? "", state: task.result?.state ?? "NOT_RUN" });
        for (const child of task.tasks ?? []) visit(child);
      };
      for (const task of file.tasks ?? []) visit(task);
      suites.push({ file: name.split("/").pop()!, rows });
    }
    if (!suites.length) return;
    const rows = suites.flatMap((s) => s.rows);
    const result = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      total: rows.length,
      passed: rows.filter((r) => r.state === "pass").length,
      skipped: rows.filter((r) => r.state === "skip" || r.state === "todo").length,
      other: rows.filter((r) => !["pass", "skip", "todo"].includes(r.state)).length,
    };
    writeSync(1, `\n::notice title=CROT-browser-files-native::${JSON.stringify(result)}\n`);
    if (result.skipped) throw new Error("Native browser file qualification cannot contain skipped tests.");
  }
}
