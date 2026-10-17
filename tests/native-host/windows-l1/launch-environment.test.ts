import { describe, expect, it } from "vitest";
import { WindowsLaunchEnvironment } from "../../../src/native-host/windows-l1/launch-environment.js";
const layout = {
  systemRoot: "C:\\Windows",
  privateRoot: "C:\\CROT\\private",
  runtimeBins: ["C:\\Tools\\node", "c:\\tools\\NODE", "C:\\Tools\\git\\bin"],
};
describe("Windows native bounded launch environment", () => {
  it("uses fixed system and explicit runtime bins, never caller or host PATH; keeps ordinary literal variables", () => {
    const policy = new WindowsLaunchEnvironment(layout);
    const env = policy.prepare({
      Path: "C:\\unapproved;;%PATH%;.",
      SystemRoot: "Z:\\fake",
      TEMP: "C:\\outside",
      Keep: "literal value",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    expect(env.Path).toBe(policy.path);
    expect(env.PATH).toBeUndefined();
    expect(env.SystemRoot).toBe(layout.systemRoot);
    expect(env.TEMP).toBe(policy.directories.temp);
    expect(env.Keep).toBe("literal value");
    expect(policy.path.split(";")).toEqual([
      "C:\\Tools\\node",
      "C:\\Tools\\git\\bin",
      "C:\\Windows\\System32",
      "C:\\Windows",
      "C:\\Windows\\System32\\Wbem",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    ]);
  });
  it("pins temp/profile/cache/system variables and removes direct Docker settings and PSModulePath", () => {
    const policy = new WindowsLaunchEnvironment(layout);
    const env = policy.prepare({
      COMSPEC: "C:\\bad.exe",
      PSModulePath: "C:\\unapproved",
      Docker_Host: "npipe:////./pipe/docker_engine",
      DOCKER_CONTEXT: "host",
    });
    expect(env.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(
      Object.keys(env).some((k) => k.toUpperCase().startsWith("DOCKER_") || k.toUpperCase() === "PSMODULEPATH"),
    ).toBe(false);
    expect(env.USERPROFILE).toBe(policy.directories.home);
    expect(env.PSModuleAnalysisCachePath).toBe("C:\\CROT\\private\\cache\\ModuleAnalysisCache");
    expect(env.npm_config_cache).toBe("C:\\CROT\\private\\cache\\npm");
    expect(env.PIP_CACHE_DIR).toBe("C:\\CROT\\private\\cache\\pip");
  });
  it("overrides all incoming Docker settings with the trusted LOCAL endpoint only", () => {
    const dockerHost = "npipe:////./pipe/LOCAL/crot-l1-docker-" + "a".repeat(48);
    const policy = new WindowsLaunchEnvironment({ ...layout, dockerHost });
    const env = policy.prepare({
      Docker_Host: "npipe:////./pipe/docker_engine",
      DOCKER_CONTEXT: "host",
      DOCKER_TLS_VERIFY: "1",
    });
    expect(env.DOCKER_HOST).toBe(dockerHost);
    expect(env.Docker_Host).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(() => new WindowsLaunchEnvironment({ ...layout, dockerHost: "npipe:////./pipe/docker_engine" })).toThrow();
  });
  it.each(["relative", "\\\\server\\share", "C:\\a;%PATH%", "C:\\bad\u0000name"])(
    "rejects ambiguous or nonlocal trusted layout %j",
    (privateRoot) => {
      expect(() => new WindowsLaunchEnvironment({ ...layout, privateRoot })).toThrow();
    },
  );
  it("rejects malformed or ambiguous input before filtering", () => {
    const policy = new WindowsLaunchEnvironment(layout);
    expect(() => policy.prepare({ PATH: "a", Path: "b" })).toThrow();
    expect(() => policy.prepare({ DOCKER_HOST: "x\u0000y" })).toThrow();
  });
});
