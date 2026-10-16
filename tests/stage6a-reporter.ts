/** CI diagnostics only. Does not change test results or compatibility gates. */
import { readFileSync, writeSync } from "node:fs";
import { gzipSync } from "node:zlib";
export function encodeEvidence(events: unknown[]) {
  const raw = JSON.stringify(events);
  if (Buffer.byteLength(raw) > 512 * 1024) throw new Error("Diagnostic raw evidence limit exceeded.");
  const encoded = gzipSync(raw).toString("base64");
  const count = Math.ceil(encoded.length / 2800);
  if (count > 8) throw new Error("Diagnostic annotation bundle limit exceeded.");
  return Array.from({ length: count }, (_, index) => ({
    codec: "gzip-base64",
    part: index + 1,
    parts: count,
    fragment: encoded.slice(index * 2800, (index + 1) * 2800),
  }));
}
export default class Stage6aReporter {
  onFinished(files: unknown[], errors: unknown[] = []) {
    const events: { title: string; value: unknown }[] = [];
    const emit = (title: string, value: unknown) => events.push({ title, value });
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
      if (
        !/(stage6a-diagnostics|workspace-native|native-process|write-boundary|appcontainer-native|appcontainer-process-native|lease-journal|lease-recovery|lease-lock|lease-crash|lease-acl|lease-acl-native|network|network-native|actor-drain|actor-drain-ffi)\.test\.ts$/.test(
          f.filepath ?? f.name ?? "",
        )
      )
        continue;
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
    // Actions caps notice annotations and each message at 4096 chars.
    // One compressed bundle transports ALL rows; no selection or filtering.
    for (const part of encodeEvidence(events))
      writeSync(1, `\n::notice title=CROT-6A-bundle-${part.part}::${JSON.stringify(part)}\n`);
  }
}
