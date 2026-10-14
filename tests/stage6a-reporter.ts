/** CI diagnostics only. Does not change test results or compatibility gates. */
import { readFileSync, writeSync } from "node:fs";
const emit = (title: string, value: unknown) => {
  const plain = JSON.stringify(value);
  if (plain.length > 2800) {
    const parts = Math.ceil(plain.length / 1800);
    for (let index = 0; index < parts; index++)
      emit(`${title}-part-${index + 1}`, {
        part: index + 1,
        parts,
        fragment: plain.slice(index * 1800, (index + 1) * 1800),
      });
    return;
  }
  const text = JSON.stringify(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  writeSync(1, `\n::notice title=${title}::${text}\n`);
};
export default class Stage6aReporter {
  onFinished(files: unknown[], errors: unknown[] = []) {
    const boundedErrors = (items: unknown[]) =>
      items.slice(0, 10).map((item) => {
        const e = item as { name?: string; message?: string };
        return { name: e.name, message: e.message?.slice(0, 1200) };
      });
    if (errors.length) emit("CROT-6A-global-errors", boundedErrors(errors));
    const evidence = process.env.CROT_6A_EVIDENCE_FILE;
    if (evidence) {
      try {
        for (const line of readFileSync(evidence, "utf8").split("\n").filter(Boolean)) {
          const entry = JSON.parse(line);
          emit(entry.title, entry.value);
        }
      } catch (e) {
        emit("CROT-6A-evidence-delivery", { status: "UNAVAILABLE", error: e instanceof Error ? e.name : "unknown" });
      }
    }
    for (const file of files) {
      const f = file as {
        filepath?: string;
        name?: string;
        result?: { state?: string; errors?: unknown[] };
        tasks?: unknown[];
      };
      if (!/(stage6a-diagnostics|workspace-native)\.test\.ts$/.test(f.filepath ?? f.name ?? "")) continue;
      const rows: unknown[] = [];
      const visit = (task: unknown) => {
        const t = task as {
          type?: string;
          name?: string;
          result?: { state?: string; errors?: { name?: string; message?: string }[] };
          tasks?: unknown[];
        };
        if (t.type === "test")
          rows.push({
            name: t.name,
            state: t.result?.state ?? "NOT_RUN",
            errors: t.result?.errors?.map((e) => ({ name: e.name, message: e.message?.slice(0, 1200) })),
          });
        for (const child of t.tasks ?? []) visit(child);
      };
      visit(f);
      emit("CROT-6A-test-summary", {
        file: (f.filepath ?? f.name)?.split(/[\\/]/).pop(),
        state: f.result?.state,
        fileErrors: boundedErrors(f.result?.errors ?? []),
        rows,
      });
    }
  }
}
