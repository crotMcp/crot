import { describe, expect, it } from "vitest";
import {
  checkContainerCreate,
  checkExecCreate,
  checkHostConfig,
  checkInspectedMounts,
  checkServiceSpec,
  checkSource,
  checkVolumeCreate,
  Refusal,
} from "../../../src/native-host/linux-l1/docker-policy.js";
import {
  canonicalWindowsDockerPath,
  createWindowsDockerBoundary,
  parseWindowsDockerBind,
} from "../../../src/native-host/windows-l1/docker-paths.js";

const options = () => ({
  writable: ["C:\\work", "D:\\L1\\private"],
  protectedPaths: ["C:\\Users\\Owner\\.crot", "C:\\work\\crot.json"],
  dockerContextPaths: ["C:\\Users\\Owner\\.docker"],
  unreadable: ["C:\\private"],
  daemonSockets: ["//./pipe/docker_engine"],
  endpointSocket: "\\\\.\\pipe\\LOCAL\\crot-l1-docker-1234",
  resolve: (source: string) => source,
});
const boundary = () => createWindowsDockerBoundary(options());
const bind = (source: string, readOnly = false) => ({ Mounts: [{ Type: "bind", Source: source, ReadOnly: readOnly }] });

describe("Windows Docker host-path policy (not native transport qualification)", () => {
  it("keeps drive colons separate from target and options, including Linux targets", () => {
    expect(parseWindowsDockerBind("C:\\work\\src:D:\\src:ro")).toEqual({
      source: "C:\\work\\src",
      readOnly: true,
      namedVolume: false,
    });
    expect(parseWindowsDockerBind("C:/work/src:/src:rw")).toEqual({
      source: "C:/work/src",
      readOnly: false,
      namedVolume: false,
    });
    expect(parseWindowsDockerBind("cache:C:\\cache")).toEqual({ source: "cache", readOnly: false, namedVolume: true });
  });
  it("normalizes case, separators and dot segments without allowing prefix siblings", () => {
    expect(canonicalWindowsDockerPath("C:/WORK/src/../Data")).toBe("c:\\work\\data");
    expect(canonicalWindowsDockerPath("C:\\")).toBe("c:\\");
    expect(() => checkHostConfig(boundary(), bind("c:/WORK/src"))).not.toThrow();
    expect(() => checkHostConfig(boundary(), bind("C:\\work-other"))).toThrow(/inside the workspace/);
    expect(() => checkHostConfig(boundary(), bind("C:\\work\\..\\outside"))).toThrow(/inside the workspace/);
    expect(() => checkHostConfig(boundary(), bind("D:\\L1\\private\\cache"))).not.toThrow();
  });
  it("checks protected ancestors and descendants, even read-only", () => {
    for (const source of ["C:\\Users", "c:/users/owner/.CROT/service-token", "C:\\work", "C:\\work\\crot.json"]) {
      expect(() => checkHostConfig(boundary(), bind(source, true))).toThrow(/CROT-protected/);
    }
    expect(() => checkHostConfig(boundary(), bind("C:\\work\\src", true))).not.toThrow();
  });
  it("rejects drive-relative, UNC, volume, device and Docker Desktop aliases", () => {
    for (const source of [
      "C:work",
      "\\work",
      "\\\\server\\share",
      "\\\\?\\C:\\work",
      "\\\\?\\Volume{abcd}\\work",
      "\\??\\C:\\work",
      "/host_mnt/c/work",
      "/run/desktop/mnt/host/c/work",
      "/mnt/c/work",
      "relative",
      "",
    ]) {
      expect(() => checkHostConfig(boundary(), bind(source))).toThrow(Refusal);
    }
  });
  it("rejects ADS, short names, environment expansion, Win32 device and trailing aliases", () => {
    for (const source of [
      "C:\\work\\file:secret",
      "C:\\WORK~1",
      "C:\\work\\%TEMP%",
      "C:\\work\\NUL.txt",
      "C:\\work\\COM1",
      "C:\\work\\lpt².txt",
      "C:\\work.\\src",
      "C:\\work \\src",
      "C:\\work\\a?",
      "C:\\work\\a\u0000",
    ]) {
      expect(() => checkHostConfig(boundary(), bind(source))).toThrow(Refusal);
    }
  });
  it("checks both lexical and native-resolved paths; resolver failure is refusal", () => {
    const b = createWindowsDockerBoundary({ ...options(), resolve: () => "C:\\Users\\Owner\\.crot\\service-token" });
    expect(() => checkHostConfig(b, bind("C:\\work\\src", true))).toThrow(/CROT-protected/);
    const reverse = createWindowsDockerBoundary({ ...options(), resolve: () => "C:\\work\\src" });
    expect(() => checkHostConfig(reverse, bind("C:\\Users\\Owner\\.crot", true))).toThrow(/CROT-protected/);
    for (const resolve of [
      () => {
        throw new Error("identity conflict");
      },
      () => "\\\\?\\C:\\work",
      () => "C:\\outside",
    ]) {
      expect(() =>
        checkHostConfig(createWindowsDockerBoundary({ ...options(), resolve }), bind("C:\\work\\src")),
      ).toThrow(Refusal);
    }
  });
  it("refuses secrets and context keys outside the workspace, with hidden workspace exception", () => {
    expect(() => checkHostConfig(boundary(), bind("C:\\Users\\Owner\\.docker\\key.pem", true))).toThrow(
      /CROT-protected/,
    );
    expect(() => checkHostConfig(boundary(), bind("C:\\public", true))).not.toThrow();
    expect(() =>
      checkHostConfig(
        createWindowsDockerBoundary({ ...options(), unreadable: ["C:\\work"] }),
        bind("C:\\work\\src", true),
      ),
    ).not.toThrow();
  });
  it("routes Binds, Mounts, inspect, local volumes and Swarm through the same Windows policy", () => {
    const b = boundary();
    const source = "C:\\Users\\Owner\\.crot\\service-token";
    const cases = [
      () => checkContainerCreate(b, { HostConfig: { Binds: [`${source}:C:\\secrets:ro`] } }),
      () => checkHostConfig(b, bind(source, true)),
      () => checkInspectedMounts(b, [{ Type: "bind", Source: source, RW: false }], "inspect"),
      () => checkVolumeCreate(b, { Driver: "local", DriverOpts: { type: "none", o: "bind,ro", device: source } }),
      () =>
        checkHostConfig(b, {
          Mounts: [{ Type: "volume", VolumeOptions: { DriverConfig: { Options: { o: "bind", device: source } } } }],
        }),
      () =>
        checkServiceSpec(b, {
          TaskTemplate: { ContainerSpec: { Mounts: [{ Type: "bind", Source: source, ReadOnly: true }] } },
        }),
    ];
    for (const run of cases) expect(run).toThrow(/CROT-protected/);
  });
  it("only treats strictly parsed Binds names as named volumes, never a relative bind Source", () => {
    expect(() => checkHostConfig(boundary(), { Binds: ["cache:C:\\cache:rw"] })).not.toThrow();
    expect(() => checkHostConfig(boundary(), bind("cache"))).toThrow(Refusal);
    expect(() => checkVolumeCreate(boundary(), { DriverOpts: { o: "bind", device: "cache" } })).toThrow(Refusal);
    for (const value of [
      "C:relative:C:\\target",
      "../cache:/target",
      "cache:relative",
      "C:\\work\\src:C:\\target:ro,rw",
      "C:\\work\\src:C:\\target:ro:extra",
      "C:\\work\\src:C:\\target:",
    ]) {
      expect(() => checkHostConfig(boundary(), { Binds: [value] })).toThrow(Refusal);
    }
  });
  it("refuses raw daemon/service pipes and allows only the exact owned LOCAL endpoint", () => {
    for (const source of [
      "//./pipe/docker_engine",
      "\\\\?\\pipe\\docker_engine",
      "\\\\.\\PIPE\\control.sock",
      "\\\\.\\pipe\\service.sock",
      `${options().endpointSocket}-other`,
    ]) {
      expect(() => checkSource(boundary(), source, true, "test")).toThrow(Refusal);
    }
    expect(() => checkSource(boundary(), options().endpointSocket, false, "test")).not.toThrow();
  });
  it("checks Windows npipe mounts and inspected pipes, including Binds", () => {
    const b = boundary();
    for (const source of ["//./pipe/docker_engine", "\\\\.\\pipe\\control.sock"]) {
      expect(() => checkHostConfig(b, { Mounts: [{ Type: "npipe", Source: source }] })).toThrow(Refusal);
      expect(() => checkInspectedMounts(b, [{ Type: "npipe", Source: source, RW: false }], "inspect")).toThrow(Refusal);
      expect(() => checkHostConfig(b, { Binds: [`${source}:\\\\.\\pipe\\inside`] })).toThrow(Refusal);
    }
    expect(() =>
      checkHostConfig(b, { Binds: [`${options().endpointSocket}:\\\\.\\pipe\\docker_engine`] }),
    ).not.toThrow();
  });
  it("protects Docker context keys even if their directory is a writable root", () => {
    const b = createWindowsDockerBoundary({ ...options(), writable: ["C:\\Users\\Owner"] });
    expect(() => checkHostConfig(b, bind("C:\\Users\\Owner\\.docker\\key.pem", true))).toThrow(/CROT-protected/);
    expect(() => checkHostConfig(b, bind("C:\\Users\\Owner\\.docker\\key.pem", false))).toThrow(/CROT-protected/);
  });
  it("preserves shared privileged, capability and namespace refusal", () => {
    for (const config of [
      { Privileged: true },
      { CapAdd: ["SYS_ADMIN"] },
      { PidMode: "host" },
      { IpcMode: "host" },
      { SecurityOpt: ["seccomp=unconfined"] },
    ]) {
      expect(() => checkHostConfig(boundary(), config)).toThrow(Refusal);
    }
    expect(() => checkExecCreate({ Privileged: true })).toThrow(Refusal);
  });
  it("freezes boundary snapshots and requires a resolver and LOCAL name", () => {
    const o = options();
    const b = createWindowsDockerBoundary(o);
    o.writable.push("C:\\outside");
    o.protectedPaths.length = 0;
    expect(() => checkHostConfig(b, bind("C:\\outside"))).toThrow(Refusal);
    expect(() => checkHostConfig(b, bind("C:\\work", true))).toThrow(/CROT-protected/);
    expect(Object.isFrozen(b.hostPaths)).toBe(true);
    expect(() => createWindowsDockerBoundary({ ...options(), endpointSocket: "//./pipe/docker_engine" })).toThrow(
      Refusal,
    );
    expect(() => createWindowsDockerBoundary({ ...options(), resolve: undefined! })).toThrow(Refusal);
  });
});
