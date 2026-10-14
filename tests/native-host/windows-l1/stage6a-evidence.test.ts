import { gunzipSync } from "node:zlib";
import { it, expect } from "vitest";
import { encodeEvidence } from "../../stage6a-reporter.js";
it("round trips all diagnostic rows within Actions notice and message limits", () => {
  const events = Array.from({ length: 40 }, (_, i) => ({
    title: `row-${i}`,
    value: { unicode: "Привет 😀", report: "repeated-observation".repeat(200), index: i },
  }));
  const parts = encodeEvidence(events);
  expect(parts.length).toBeLessThanOrEqual(8);
  expect(parts.every((p) => JSON.stringify(p).length < 4096)).toBe(true);
  const restored = JSON.parse(
    gunzipSync(Buffer.from(parts.map((p) => p.fragment).join(""), "base64")).toString("utf8"),
  );
  expect(restored).toEqual(events);
});
