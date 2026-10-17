import { describe, expect, it } from "vitest";
import { CrotError } from "../../../src/core/errors.js";
import type { LeaseObject } from "../../../src/native-host/windows-l1/lease-journal.js";
import { originalWorkspaceIdUnavailable } from "../../../src/native-host/windows-l1/lease-native.js";
const node: LeaseObject = {
  role: "workspace-node",
  identity: {
    volume: "\\\\?\\Volume{00000000-0000-4000-8000-000000000001}\\",
    fileId: "0000000000000002",
    creationTime: "0000000000000001",
    directory: false,
    links: 1,
  },
  original: "",
  planned: "",
};
const root: LeaseObject = {
  ...node,
  role: "workspace",
  identity: { ...node.identity, fileId: "0000000000000001", directory: true },
};
const failure = (nativeCode: number, stage = "guard by ID open") =>
  new CrotError("CONFINEMENT_FAILED", "native open", { stage, nativeCode });
describe("saved ordinary NTFS reference absence qualification", () => {
  it("requires a separately successful same-volume by-ID control for error 87", () => {
    expect(originalWorkspaceIdUnavailable(node, failure(87), root)).toBe(true);
    expect(originalWorkspaceIdUnavailable(node, failure(87))).toBe(false);
  });
  it.each([5, 32, 21, 50, 1])("never hides native failure %i", (code) =>
    expect(originalWorkspaceIdUnavailable(node, failure(code), root)).toBe(false),
  );
  it.each(["protected", "runtime", "runtime-node", "workspace", "ancestor", "workspace-link"] as const)(
    "never retires a %s identity",
    (role) => expect(originalWorkspaceIdUnavailable({ ...node, role }, failure(87), root)).toBe(false),
  );
  it("refuses ambiguous links, directories, unrelated volume/control and other stages", () => {
    for (const object of [
      { ...node, identity: { ...node.identity, links: 2 } },
      { ...node, identity: { ...node.identity, links: undefined } },
      { ...node, identity: { ...node.identity, directory: true } },
    ])
      expect(originalWorkspaceIdUnavailable(object, failure(87), root)).toBe(false);
    expect(originalWorkspaceIdUnavailable(node, failure(87, "capture open"), root)).toBe(false);
    expect(
      originalWorkspaceIdUnavailable(node, failure(87), {
        ...root,
        identity: { ...root.identity, volume: node.identity.volume.replace("000000000001", "000000000003") },
      }),
    ).toBe(false);
  });
});
