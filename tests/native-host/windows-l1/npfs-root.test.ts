import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("contains no retired NPFS root security calls", () => {
  const source = readFileSync(new URL("../../../src/native-host/windows-l1/npfs-root.ts", import.meta.url), "utf8");
  expect(readFileSync(new URL("./appcontainer-process-native.test.ts", import.meta.url), "utf8")).not.toContain(
    "bindNpfsRootQualification",
  );
  expect(source).not.toMatch(/GetSecurityInfo|GetKernelObjectSecurity|SetKernelObjectSecurity|CreateFileW/);
});
