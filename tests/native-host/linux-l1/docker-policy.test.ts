/**
 * The fixed checks a-d of the L1 Docker endpoint (AD-20 point 9), each rule
 * with an accepted and a refused case. Pure functions: no daemon (unit tests).
 */
import { describe, expect, it } from "vitest";
import {
  checkBuildQuery,
  checkContainerCreate,
  checkExecCreate,
  checkHostConfig,
  checkInspectedMounts,
  checkServiceSpec,
  checkSource,
  checkVolumeCreate,
  classify,
  deviceAllowed,
  parseBind,
  Refusal,
  REFUSED_CAPABILITIES,
  withContainerProfile,
  type DockerBoundary,
} from "../../../src/native-host/linux-l1/docker-policy.js";

const boundary: DockerBoundary = {
  writable: ["/home/u/ws", "/var/tmp/crot-l1-1000/abc"],
  protectedPaths: ["/home/u/.config/crot", "/srv/crot/audit.jsonl"],
  unreadable: ["/tmp", "/var/tmp", "/proc", "/run/user/1000", "/home/u/.local/share/keyrings"],
  daemonSockets: ["/var/run/docker.sock", "/run/docker.sock"],
  endpointSocket: "/var/tmp/crot-l1-1000/abc/run/docker-1.sock",
};

const refused = (fn: () => unknown, reason: RegExp) => {
  expect(fn).toThrow(Refusal);
  expect(fn).toThrow(reason);
};
const create = (HostConfig: Record<string, unknown>) => () =>
  checkContainerCreate(boundary, { Image: "x", HostConfig });

describe("rule a: bind mounts and volume driver options", () => {
  it("accepts writable sources inside the workspace or the L1 storage, read-only sources the sandbox can read", () => {
    expect(create({ Binds: ["/home/u/ws:/src", "/home/u/ws/sub:/sub:rw"] })).not.toThrow();
    expect(create({ Binds: ["/var/tmp/crot-l1-1000/abc/x:/x"] })).not.toThrow();
    expect(create({ Binds: ["/usr/share:/share:ro", "/home/u/projects:/p:ro"] })).not.toThrow();
    expect(create({ Mounts: [{ Type: "bind", Source: "/etc/ssl", Target: "/ssl", ReadOnly: true }] })).not.toThrow();
    // named volumes are not host paths
    expect(
      create({ Binds: ["cache:/cache"], Mounts: [{ Type: "volume", Source: "data", Target: "/d" }] }),
    ).not.toThrow();
  });

  it("refuses a writable source outside the workspace", () => {
    refused(create({ Binds: ["/srv/data:/d"] }), /writable bind source must be inside the workspace/);
    refused(create({ Mounts: [{ Type: "bind", Source: "/etc", Target: "/e" }] }), /inside the workspace/);
  });

  it("refuses a source that is or contains a CROT-protected path, read-only too", () => {
    refused(create({ Binds: ["/srv/crot/audit.jsonl:/c:ro"] }), /CROT-protected path/);
    refused(create({ Binds: ["/home/u/.config:/c:ro"] }), /CROT-protected path/);
    refused(create({ Binds: ["/home/u:/h:ro"] }), /CROT-protected path/);
    // A workspace that contains a CROT-protected path (a configuration file in it) cannot be bound whole.
    const b: DockerBoundary = { ...boundary, protectedPaths: ["/home/u/ws/crot.json"] };
    expect(() => checkSource(b, "/home/u/ws", false, "t")).toThrow(/CROT-protected path/);
    expect(() => checkSource(b, "/home/u/ws/src", false, "t")).not.toThrow();
  });

  it("refuses read-only sources the sandbox cannot read (hidden entries, host /tmp)", () => {
    refused(create({ Binds: ["/tmp/x:/x:ro"] }), /cannot read/);
    refused(create({ Binds: ["/home/u/.local/share:/s:ro"] }), /cannot read/);
    refused(create({ Binds: ["/:/host:ro"] }), /daemon endpoint|CROT-protected|cannot read/);
  });

  it("accepts a read-only bind of a workspace that lies below a hidden root", () => {
    const b: DockerBoundary = { ...boundary, writable: ["/tmp/ws"], protectedPaths: [] };
    expect(() => checkSource(b, "/tmp/ws/src", true, "t")).not.toThrow();
    expect(() => checkSource(b, "/tmp/other", true, "t")).toThrow(Refusal);
  });

  it("checks symbolic links through resolve()", () => {
    const b: DockerBoundary = { ...boundary, resolve: (p) => (p === "/home/u/ws/link" ? "/etc" : p) };
    expect(() => checkSource(b, "/home/u/ws/link", false, "t")).toThrow(/inside the workspace/);
  });

  it("checks volume driver options that bind host paths (create, Mounts and services)", () => {
    expect(() =>
      checkVolumeCreate(boundary, { Driver: "local", DriverOpts: { type: "none", o: "bind", device: "/home/u/ws/d" } }),
    ).not.toThrow();
    refused(
      () =>
        checkVolumeCreate(boundary, { Driver: "local", DriverOpts: { type: "none", o: "bind", device: "/home/u" } }),
      /volume driver option device/,
    );
    expect(() =>
      checkVolumeCreate(boundary, { Driver: "local", DriverOpts: { type: "tmpfs", device: "tmpfs" } }),
    ).not.toThrow();
    refused(
      create({
        Mounts: [
          {
            Type: "volume",
            Target: "/v",
            VolumeOptions: { DriverConfig: { Options: { o: "bind", device: "/etc" } } },
          },
        ],
      }),
      /volume driver option/,
    );
    refused(
      () =>
        checkServiceSpec(boundary, {
          TaskTemplate: { ContainerSpec: { Mounts: [{ Type: "bind", Source: "/etc", Target: "/e" }] } },
        }),
      /inside the workspace/,
    );
  });

  it("parses Binds options", () => {
    expect(parseBind("/a:/b")).toEqual({ source: "/a", readOnly: false });
    expect(parseBind("/a:/b:ro,z")).toEqual({ source: "/a", readOnly: true });
    expect(parseBind("vol:/b:rw")).toEqual({ source: "vol", readOnly: false });
  });
});

describe("rule b: privileged containers and host-acting capabilities", () => {
  it("refuses Privileged and every listed capability (with or without CAP_)", () => {
    refused(create({ Privileged: true }), /privileged/);
    for (const cap of REFUSED_CAPABILITIES) refused(create({ CapAdd: [cap] }), new RegExp(`capability ${cap}`));
    refused(create({ CapAdd: ["cap_sys_admin"] }), /SYS_ADMIN/);
    refused(
      () => checkServiceSpec(boundary, { TaskTemplate: { ContainerSpec: { CapabilityAdd: ["CAP_BPF"] } } }),
      /BPF/,
    );
  });

  it("accepts other capabilities such as NET_ADMIN", () => {
    expect(create({ CapAdd: ["NET_ADMIN", "CAP_NET_RAW", "SYS_TIME"], CapDrop: ["ALL"] })).not.toThrow();
  });

  it("refuses a privileged exec and accepts a normal one", () => {
    refused(() => checkExecCreate({ Cmd: ["sh"], Privileged: true }), /privileged/);
    expect(() => checkExecCreate({ Cmd: ["sh"], Privileged: false })).not.toThrow();
  });
});

describe("rule c: host namespaces, unconfined security options, devices, BuildKit, plugins", () => {
  it("refuses the host PID, IPC, user and cgroup namespaces; accepts the host network", () => {
    for (const field of ["PidMode", "IpcMode", "UsernsMode", "CgroupnsMode"])
      refused(create({ [field]: "host" }), /host/);
    expect(create({ NetworkMode: "host", PidMode: "container:abc", IpcMode: "shareable" })).not.toThrow();
  });

  it("refuses security options that turn confinement off, in both spellings; accepts others", () => {
    for (const opt of [
      "apparmor=unconfined",
      "apparmor:unconfined",
      "seccomp=unconfined",
      "systempaths=unconfined",
      "label=disable",
      "label:disable",
    ])
      refused(create({ SecurityOpt: [opt] }), /security option/);
    // The CLI sends systempaths=unconfined as empty MaskedPaths/ReadonlyPaths.
    refused(create({ MaskedPaths: [] }), /systempaths=unconfined/);
    refused(create({ ReadonlyPaths: [] }), /systempaths=unconfined/);
    expect(
      create({ SecurityOpt: ["no-new-privileges", "apparmor=docker-default"], MaskedPaths: ["/proc/kcore"] }),
    ).not.toThrow();
    refused(
      () =>
        checkServiceSpec(boundary, {
          TaskTemplate: { ContainerSpec: { Privileges: { Seccomp: { Mode: "unconfined" } } } },
        }),
      /seccomp/,
    );
  });

  it("accepts device mappings of the sandbox's classes and refuses others", () => {
    for (const d of [
      "/dev/fuse",
      "/dev/net/tun",
      "/dev/dri/renderD128",
      "/dev/nvidia0",
      "/dev/nvidia-uvm",
      "/dev/kfd",
    ]) {
      expect(deviceAllowed(d)).toBe(true);
      expect(create({ Devices: [{ PathOnHost: d, PathInContainer: d }] })).not.toThrow();
    }
    for (const d of ["/dev/sda", "/dev/mem", "/dev/input/event0", "/dev/uinput", "/dev/tty0", "/dev/dri/card0"]) {
      expect(deviceAllowed(d)).toBe(false);
      refused(create({ Devices: [{ PathOnHost: d }] }), /device/);
    }
    // Device cgroup rules grant device nodes by number (interpretation: a device mapping).
    refused(create({ DeviceCgroupRules: ["c 8:* rmw"] }), /device cgroup rules/);
  });

  it("refuses build security options that turn confinement off", () => {
    expect(() => checkBuildQuery(new URLSearchParams("t=x&networkmode=host"))).not.toThrow();
    refused(() => checkBuildQuery(new URLSearchParams("securityopt=seccomp%3Dunconfined")), /security option/);
  });

  it("classifies plugin installation, exec, attach, archive, commit, BuildKit streams", () => {
    expect(classify("POST", "/v1.45/plugins/pull?remote=x").kind).toBe("plugin.install");
    expect(classify("POST", "/plugins/create?name=x").kind).toBe("plugin.install");
    expect(classify("POST", "/plugins/x/upgrade").kind).toBe("plugin.install");
    expect(classify("POST", "/plugins/x/enable").kind).toBe("other");
    expect(classify("POST", "/v1.45/containers/web/exec")).toMatchObject({ kind: "container.exec", container: "web" });
    expect(classify("POST", "/containers/a%2Fb/attach?stream=1")).toMatchObject({
      kind: "container.attach",
      container: "a/b",
    });
    expect(classify("GET", "/containers/c/attach/ws")).toMatchObject({ kind: "container.attach" });
    expect(classify("PUT", "/containers/c/archive?path=/")).toMatchObject({
      kind: "container.archive",
      container: "c",
    });
    expect(classify("GET", "/containers/c/export")).toMatchObject({ kind: "container.archive" });
    expect(classify("POST", "/commit?container=c&repo=r")).toMatchObject({ kind: "container.commit", container: "c" });
    expect(classify("POST", "/v1.45/grpc").kind).toBe("grpc");
    expect(classify("POST", "/session").kind).toBe("session");
    expect(classify("GET", "/containers/json").kind).toBe("other");
    expect(classify("POST", "/images/create?fromImage=alpine").kind).toBe("other");
  });
});

describe("rule d: daemon endpoints", () => {
  it("refuses a bind of a real daemon socket or a directory containing one", () => {
    refused(create({ Binds: ["/var/run/docker.sock:/var/run/docker.sock"] }), /daemon endpoint/);
    refused(create({ Binds: ["/run:/hostrun:ro"] }), /daemon endpoint/);
  });

  it("accepts a bind of the endpoint's own socket (Testcontainers' helper)", () => {
    expect(create({ Binds: [`${boundary.endpointSocket}:/var/run/docker.sock`] })).not.toThrow();
  });
});

describe("existing containers and the container profile", () => {
  it("checks an existing container's configuration (exec, attach, archive, commit)", () => {
    expect(() => checkHostConfig(boundary, { Binds: ["/home/u/ws/a:/a"] }, "container c")).not.toThrow();
    refused(() => checkHostConfig(boundary, { Privileged: true }, "container c"), /container c: privileged/);
    refused(
      () => checkInspectedMounts(boundary, [{ Type: "bind", Source: "/srv/data", RW: true }], "container c"),
      /inside the workspace/,
    );
    expect(() =>
      checkInspectedMounts(boundary, [{ Type: "volume", Source: "/var/lib/docker/volumes/x", RW: true }], "c"),
    ).not.toThrow();
  });

  it("returns VolumesFrom names for their own check", () => {
    expect(checkContainerCreate(boundary, { HostConfig: { VolumesFrom: ["other:ro", "third"] } })).toEqual({
      volumesFrom: ["other", "third"],
    });
  });

  it("sets crot-l1-container-<v> and replaces any other AppArmor option", () => {
    const body = withContainerProfile(
      { Image: "x", HostConfig: { SecurityOpt: ["apparmor=docker-default", "no-new-privileges"] } },
      "crot-l1-container-1",
    );
    expect((body.HostConfig as { SecurityOpt: string[] }).SecurityOpt).toEqual([
      "no-new-privileges",
      "apparmor=crot-l1-container-1",
    ]);
    expect(withContainerProfile({ Image: "x" }, "p").HostConfig).toEqual({ SecurityOpt: ["apparmor=p"] });
  });
});
