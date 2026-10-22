import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ReleaseDownloads } from "../../src/cloud-relay/downloads.js";
const directories: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "crot-downloads-"));
  directories.push(dir);
  const downloads = new ReleaseDownloads({ origin: "https://relay.example", artifactDirectory: dir });
  const server = createServer((req, res) => {
    void downloads
      .handle(req, res, req.url!)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { dir, url: `http://127.0.0.1:${address.port}` };
}
describe("fixed public release downloads", () => {
  it.each(["linux", "macos", "windows"])("returns a real attachment bootstrap for %s", async (platform) => {
    const f = await fixture(),
      response = await fetch(f.url + "/download/" + platform),
      body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-checksum-sha256")).toBe(createHash("sha256").update(body).digest("hex"));
    expect(body).toContain("https://relay.example/download/bundle/" + platform);
    expect(body).toMatch(/checksum mismatch/i);
    expect(body).not.toContain("github.com/crotMcp/crot/archive");
  });
  it("streams published packages and exposes the same digest through HEAD and checksum endpoint", async () => {
    const f = await fixture(),
      bytes = Buffer.from("test release bytes");
    await writeFile(path.join(f.dir, "crot-linux.tar.gz"), bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const response = await fetch(f.url + "/download/linux");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("x-checksum-sha256")).toBe(expected);
    const head = await fetch(f.url + "/download/linux", { method: "HEAD" });
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect((await (await fetch(f.url + "/download/bundle/linux.sha256")).text()).trim()).toBe(expected);
  });
  it("does not pretend unpublished bundles or extensions exist", async () => {
    const f = await fixture();
    for (const route of ["bundle/linux", "bundle/windows.sha256", "extension"])
      expect((await fetch(f.url + "/download/" + route)).status).toBe(503);
  });
  it("refuses writes and arbitrary filesystem paths", async () => {
    const f = await fixture();
    expect((await fetch(f.url + "/download/linux", { method: "POST" })).status).toBe(405);
    expect((await fetch(f.url + "/download/%2e%2e%2fsecret")).status).toBe(404);
  });
  it.skipIf(process.platform === "win32")("does not follow artifact symlinks", async () => {
    const f = await fixture();
    await writeFile(path.join(f.dir, "secret"), "must not serve");
    await symlink(path.join(f.dir, "secret"), path.join(f.dir, "crot-linux.tar.gz"));
    expect((await fetch(f.url + "/download/linux")).status).toBe(500);
  });
  it("requires a fixed HTTPS origin, not a request Host header", () => {
    expect(() => new ReleaseDownloads({ origin: "http://evil.example" })).toThrow("HTTPS");
  });
});
