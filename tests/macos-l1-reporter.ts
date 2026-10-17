/** Native qualification evidence; never changes test results or skips failures. */
import { readFileSync, writeSync } from "node:fs";
import { encodeEvidence } from "./stage6a-reporter.js";
export default class MacosL1Reporter {
  onFinished(files: unknown[], errors: unknown[] = []): void {
    const events: unknown[] = [];
    const evidence = process.env.CROT_6A_EVIDENCE_FILE;
    if (evidence) {
      try {
        for (const line of readFileSync(evidence, "utf8").split("\n").filter(Boolean)) events.push(JSON.parse(line));
      } catch {
        events.push({ title: "CROT-macOS-evidence-delivery", value: "UNAVAILABLE" });
      }
    }
    for (const file of files) {
      const f = file as { filepath?: string; name?: string; result?: { state?: string }; tasks?: unknown[] };
      if (!(f.filepath ?? f.name ?? "").replace(/\\/g, "/").includes("/macos-l1/")) continue;
      const rows: unknown[] = [];
      const visit = (task: unknown): void => {
        const t = task as { type?: string; name?: string; result?: { state?: string }; tasks?: unknown[] };
        if (t.type === "test") rows.push({ name: t.name, state: t.result?.state ?? "NOT_RUN" });
        for (const child of t.tasks ?? []) visit(child);
      };
      for (const task of f.tasks ?? []) visit(task);
      events.push({
        title: "CROT-macOS-test-summary",
        value: { file: f.filepath ?? f.name, state: f.result?.state, rows },
      });
    }
    events.push({ title: "CROT-macOS-global-errors", value: errors.length });
    for (const part of encodeEvidence(events))
      writeSync(1, `\n::notice title=CROT-macOS-bundle-${part.part}::${JSON.stringify(part)}\n`);
  }
}
