/** Regression: ordinary AppContainer startup must never attempt privileged DeviceMap assignment. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("keeps DeviceMap out of the launcher, retaining verified pre-resume cleanup", () => {
  const source = readFileSync(
    new URL("../../../src/native-host/windows-l1/appcontainer-process.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(/device-map|pipeMap|NtSetInformationProcess/);
  expect(source).toContain("abortedBeforeResume: () =>");
  expect(source).toContain("if (abortedBeforeResume) launchers.clear()");
});
