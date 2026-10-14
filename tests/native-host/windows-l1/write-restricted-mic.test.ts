/** Comparative research, not production L1 acceptance. Never relabel user files. */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi, type JobObjectApi } from "../../../src/native-host/windows-job.js";
import { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import type { ProbeProcess } from "../../../src/native-host/windows-l1/probe-process.js";
import { isWindows, makeTempDirs, waitFor, type TempDirs } from "../../helpers.js";

if (process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1" && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required native Windows MIC experiment cannot run on this platform/architecture.");
const GRANT = `
$ErrorActionPreference = 'Stop'
$p = $env:CROT_MIC_WORKSPACE
$acl = [System.IO.Directory]::GetAccessControl($p)
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:CROT_MIC_SID)
$flags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Modify, $flags, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($p, $acl)
`;
describe.skipIf(!isWindows).each(["write-only", "mic-only"] as const)(
  "Windows L1 spike: %s / MIC comparison, disposable fixtures only",
  (mode) => {
    let dirs: TempDirs;
    let host: NativeHost;
    let token: RestrictedToken;
    let jobs: JobObjectApi;
    let label: Awaited<ReturnType<typeof loadProbeIntegrity>>;
    let executable: string;
    let project: string;
    let secret: string;
    const probes: ProbeProcess[] = [];
    beforeEach(async () => {
      dirs = await makeTempDirs();
      host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
      jobs = await loadJobObjectApi();
      label = await loadProbeIntegrity();
      const n = randomBytes(16);
      const sid = `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`;
      token = (await loadRestrictedTokens()).create(sid, mode === "write-only", undefined, mode);
      const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows");
      token.prepareProbeObjects(await currentUserSid(tools));
      await runTool(tools.powershell, ["-NoProfile", "-NonInteractive", "-Command", GRANT], {
        ...host.platform.baseEnvironment,
        CROT_MIC_WORKSPACE: dirs.workspace,
        CROT_MIC_SID: sid,
      });
      project = path.join(dirs.outside, "owner-project.txt");
      secret = path.join(dirs.outside, "crot-like-canary.txt");
      for (const file of [project, secret]) {
        await writeFile(file, "owner-content");
        await host.platform.privateFiles.protectFile!(file);
      }
      label(dirs.workspace, "medium-write");
      label(project, "medium-write");
      label(secret, "medium-write");
      executable = path.join(dirs.workspace, "node probe.exe");
      await copyFile(process.execPath, executable);
    });
    afterEach(async () => {
      for (const probe of probes.splice(0)) probe.close();
      token?.close();
      await host?.close();
      await dirs?.cleanup();
    });
    const execute = async (body: string) => {
      const result = path.join(dirs.workspace, "result.json");
      const p = token.launchProbe(
        {
          executable,
          args: [
            "-e",
            `void(async()=>{const fs=require('fs');const attempt=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};const r=await(${body});fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(r));})();`,
          ],
          cwd: dirs.workspace,
          env: {
            SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
            PATH: dirs.workspace,
            TEMP: dirs.workspace,
            TMP: dirs.workspace,
          },
        },
        jobs.createKillOnCloseJob(),
      );
      probes.push(p);
      await waitFor(() => p.exitCode() !== null, 10000);
      expect(p.exitCode()).toBe(0);
      return JSON.parse(await readFile(result, "utf8"));
    };
    it("candidate before Low/NR preserves owner-project reads but DOES NOT protect owner-only secrets", async () => {
      expect(token.fileDaclAccess(project).readData).toBe(true);
      expect(token.fileDaclAccess(secret).readData).toBe(true);
      const r = await execute(
        `{project:attempt(()=>fs.readFileSync(${JSON.stringify(project)})),secret:attempt(()=>fs.readFileSync(${JSON.stringify(secret)}))}`,
      );
      expect(r).toEqual({ project: "ALLOWED", secret: "ALLOWED" });
      // Expected exposure is evidence against accepting WRITE_RESTRICTED alone.
    });
    it("low IL + medium NO_READ_UP denies secret reads while retaining project reads and low fixture writes", async () => {
      label(dirs.workspace, "low-write");
      label(secret, "medium-no-read");
      token.lowerProbeIntegrity();
      // DACL-only AccessCheck cannot establish or refute the MIC boundary.
      expect(token.fileDaclAccess(secret).readData).toBe(true);
      const r = await execute(
        `{project:attempt(()=>fs.readFileSync(${JSON.stringify(project)})),read:attempt(()=>fs.readFileSync(${JSON.stringify(secret)})),write:attempt(()=>fs.writeFileSync(${JSON.stringify(secret)},'changed')),remove:attempt(()=>fs.unlinkSync(${JSON.stringify(secret)})),projectWrite:attempt(()=>fs.writeFileSync(${JSON.stringify(project)},'changed'))}`,
      );
      expect(r.project).toBe("ALLOWED");
      for (const key of ["read", "write", "remove", "projectWrite"]) expect(["EACCES", "EPERM"]).toContain(r[key]);
      expect(await readFile(secret, "utf8")).toBe("owner-content");
      expect(await readFile(project, "utf8")).toBe("owner-content");
    });
    it("documents the workspace gap: low IL cannot write an ordinary medium workspace without mediation", async () => {
      // Results use a separate low disposable directory, not the medium workspace.
      const output = path.join(dirs.workspace, "low-output");
      await mkdir(output);
      label(output, "low-write");
      label(secret, "medium-no-read");
      token.lowerProbeIntegrity();
      const result = path.join(output, "gap.json");
      const target = path.join(dirs.workspace, "must-not-write.txt");
      const script = `const fs=require('fs');let outcome;try{fs.writeFileSync(${JSON.stringify(target)},'bad');outcome='ALLOWED'}catch(e){outcome=e.code}fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({outcome}));`;
      const p = token.launchProbe(
        {
          executable,
          args: ["-e", script],
          cwd: dirs.workspace,
          env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: output, TMP: output },
        },
        jobs.createKillOnCloseJob(),
      );
      probes.push(p);
      await waitFor(() => p.exitCode() !== null, 10000);
      expect(p.exitCode()).toBe(0);
      expect(["EACCES", "EPERM"]).toContain(JSON.parse(await readFile(result, "utf8")).outcome);
    });
    it("cannot raise its own token from Low to Medium, with a successful same-Low API control", async () => {
      label(dirs.workspace, "low-write");
      label(secret, "medium-no-read");
      token.lowerProbeIntegrity();
      const fixture = new URL("./fixtures/raise-integrity.mjs", import.meta.url).href;
      const koffi = createRequire(import.meta.url).resolve("koffi");
      const r = await execute(`import(${JSON.stringify(fixture)}).then(m=>m.default(${JSON.stringify(koffi)}))`);
      expect(r.open).toBe(1);
      expect(r.lowSid).toBe(1);
      expect(r.mediumSid).toBe(1);
      expect(r.sameLow).toBe(1);
      expect(r.raise).toBe(0);
      // ERROR_ACCESS_DENIED / ERROR_PRIVILEGE_NOT_HELD, not a malformed ABI error.
      expect([5, 1314]).toContain(r.raiseError);
    });
    it("secret MIC survives preexisting hard-link and junction aliases; normal project aliases remain readable", async () => {
      label(dirs.workspace, "low-write");
      label(secret, "medium-no-read");
      const hard = path.join(dirs.workspace, "secret-hard-link.txt");
      const projectHard = path.join(dirs.workspace, "project-hard-link.txt");
      const junction = path.join(dirs.workspace, "outside-junction");
      // Trusted setup creates actual aliases; denied alias creation is not proof
      // that opening an existing alias is protected. Do not relabel a tree after
      // creating a reparse point (that could alter the target fixture labels).
      await link(secret, hard);
      await link(project, projectHard);
      await symlink(dirs.outside, junction, "junction");
      token.lowerProbeIntegrity();
      const alias = path.join(junction, path.basename(secret));
      const projectAlias = path.join(junction, path.basename(project));
      const copy = path.join(dirs.workspace, "must-not-extract-secret.txt");
      const r = await execute(
        `{hard:attempt(()=>fs.readFileSync(${JSON.stringify(hard)})),junction:attempt(()=>fs.readFileSync(${JSON.stringify(alias)})),copy:attempt(()=>fs.copyFileSync(${JSON.stringify(hard)},${JSON.stringify(copy)})),projectHard:attempt(()=>fs.readFileSync(${JSON.stringify(projectHard)})),projectJunction:attempt(()=>fs.readFileSync(${JSON.stringify(projectAlias)}))}`,
      );
      for (const key of ["hard", "junction", "copy"]) expect(["EACCES", "EPERM"]).toContain(r[key]);
      expect(r.projectHard).toBe("ALLOWED");
      expect(r.projectJunction).toBe("ALLOWED");
      expect(await readFile(secret, "utf8")).toBe("owner-content");
    });
    it.each([true, false])(
      "compares hidden=%s descendant launch without treating console failure as full L1 acceptance",
      async (hidden) => {
        label(dirs.workspace, "low-write");
        label(secret, "medium-no-read");
        token.lowerProbeIntegrity();
        const child = `const fs=require('fs');const attempt=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};console.log(JSON.stringify({project:attempt(()=>fs.readFileSync(${JSON.stringify(project)})),secret:attempt(()=>fs.readFileSync(${JSON.stringify(secret)}))}));`;
        const body = `(()=>{const p=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{windowsHide:${hidden},encoding:'utf8',maxBuffer:4096,timeout:5000,env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP}});return {status:p.status,error:p.error?.code??null,result:p.status===0?JSON.parse(p.stdout):null}})()`;
        const r = await execute(body);
        if (mode === "write-only") {
          // Both default and hidden write-only descendants failed EPERM in
          // native CI (d0057d74/4cdd9d19). Record the rejected candidate gap;
          // MIC-only must actually launch while retaining all secret denials.
          expect(r.error).toBe("EPERM");
          expect(r.status).toBeNull();
          expect(r.result).toBeNull();
        } else {
          expect(r.error).toBeNull();
          expect(r.status).toBe(0);
          expect(r.result.project).toBe("ALLOWED");
          expect(["EACCES", "EPERM"]).toContain(r.result.secret);
        }
      },
    );
  },
);
