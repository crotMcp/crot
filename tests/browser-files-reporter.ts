/** Native Core file-contour evidence from actual completed Vitest cases. */
import { writeSync } from "node:fs";
export default class BrowserFilesReporter {
  onFinished(files: unknown[]): void {
    // GitHub's built-in reporter can omit suite-level hook/import errors.
    // Keep bounded file errors visible without changing the result or gate.
    if (process.env.GITHUB_ACTIONS === "true") {
      for (const item of files) {
        const file = item as {
          filepath?: string;
          result?: { state?: string; errors?: { name?: string; message?: string }[] };
        };
        if (file.result?.state !== "fail") continue;
        const detail = JSON.stringify({
          file: file.filepath,
          errors: file.result.errors?.map((e) => ({ name: e.name, message: e.message?.slice(0, 1800) })),
        });
        writeSync(
          1,
          `\n::error title=CROT-failed-suite::${detail.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
        );
      }
    }
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
