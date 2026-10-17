import { describe, expect, it } from "vitest";
import { accessStackTokens } from "./diagnostics/owned-access-stack.js";
import { ownedStackNames } from "./diagnostics/owned-stack.js";

describe("owned debugger call-site sanitizer", () => {
  it("keeps native frames even after the managed-frame budget is exhausted", () => {
    const text =
      Array(130).fill("001 002 System.Reflection.Assembly.LoadFrom(System.String)").join("\n") +
      "\n001 002 ntdll!NtWaitForSingleObject+0x14\n003 004 fusion!LoadAssembly+0x20";
    const names = ownedStackNames(text);
    expect(names.managed).toHaveLength(100);
    expect(names.native).toEqual(["ntdll!NtWaitForSingleObject+0x14", "fusion!LoadAssembly+0x20"]);
  });
  it("does not emit paths, addresses, managed arguments, environment or unrelated text", () => {
    expect(
      ownedStackNames(
        [
          "000001 000002 System.Reflection.Assembly.LoadFrom(System.String SECRET)",
          "000003 000004 KERNELBASE!WaitForSingleObjectEx+0x8",
          "ModLoad: 000005 000006 C:\\private\\secret.dll",
          "TOKEN=private-value",
          "debugger error 0x8007006d",
        ].join("\n"),
      ),
    ).toEqual({
      native: ["KERNELBASE!WaitForSingleObjectEx+0x8"],
      managed: ["System.Reflection.Assembly.LoadFrom"],
    });
  });
  it("bounds both independent budgets and symbol lengths", () => {
    const names = ownedStackNames(
      Array(250)
        .fill("001 002 clr!" + "a".repeat(500))
        .join("\n"),
    );
    expect(names.native).toHaveLength(180);
    expect(names.native.every((n) => n.length === 160)).toBe(true);
  });
});

it("does not count echoed breakpoint commands as a denied call or stack frame", () => {
  const data = '0:000> bp ntdll!RtlSetLastWin32Error ".echo CROT_ACCESS_DENIED;k 16;gc"';
  expect(accessStackTokens(data)).toEqual({ denialSites: 0, frames: { native: [], managed: [] } });
});
it("retains only actual stack rows after a standalone denied marker", () => {
  const data = [
    "CROT_ACCESS_DENIED",
    "00 00000001`12345000 00000002`12345000 ntdll!RtlSetLastWin32Error+0x4",
    "01 00000001`12345010 00000002`12345010 user32!UserClientDllInitialize+0x20",
    "C:\\private\\user-secret.txt 0x1234",
  ].join("\n");
  expect(accessStackTokens(data)).toEqual({
    denialSites: 1,
    frames: { native: ["ntdll!RtlSetLastWin32Error+0x4", "user32!UserClientDllInitialize+0x20"], managed: [] },
  });
});
