/** Public, fixed-name release downloads. No request-derived filesystem paths or redirects. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { posixInstaller, windowsInstaller } from "./install-scripts.js";

const ARTIFACTS: Readonly<Record<string, readonly string[]>> = {
  linux: ["crot-linux.deb", "crot-linux.tar.gz"],
  macos: ["crot-macos.pkg", "crot-macos.tar.gz"],
  windows: ["crot-windows.exe", "crot-windows.zip"],
  extension: ["crot-extension.zip"],
};
const BUNDLES: Readonly<Record<string, string>> = {
  linux: "crot-linux.tar.gz",
  macos: "crot-macos.tar.gz",
  windows: "crot-windows.zip",
};
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export interface DownloadOptions {
  readonly origin: string;
  readonly artifactDirectory?: string;
}
export class ReleaseDownloads {
  private active = 0;
  constructor(private readonly options: DownloadOptions) {
    const origin = new URL(options.origin);
    if (
      !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(options.origin) ||
      origin.protocol !== "https:" ||
      origin.origin !== options.origin ||
      origin.username ||
      origin.password
    )
      throw new Error("Downloads require an HTTPS origin");
  }
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith("/download/")) return false;
    const match = /^\/download\/(linux|macos|windows|extension)$/.exec(pathname);
    const bundle = /^\/download\/bundle\/(linux|macos|windows)(\.sha256)?$/.exec(pathname);
    if (!match && !bundle) {
      res.writeHead(404);
      res.end();
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return true;
    }
    if (this.active >= 4) {
      res.writeHead(503, { "retry-after": "5" });
      res.end();
      return true;
    }
    this.active++;
    let file: FileHandle | undefined;
    try {
      const platform = (match?.[1] ?? bundle![1])!;
      const names = bundle ? [BUNDLES[platform]!] : ARTIFACTS[platform]!;
      if (this.options.artifactDirectory)
        for (const name of names) {
          try {
            file = await open(
              path.join(this.options.artifactDirectory, name),
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES || stat.size === 0) {
              await file.close();
              file = undefined;
              continue;
            }
            const hash = createHash("sha256");
            // Both passes use the same descriptor; release files must be published by atomic rename, never modified in place.
            for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
            const digest = hash.digest();
            if (bundle?.[2]) {
              this.send(
                req,
                res,
                Buffer.from(digest.toString("hex") + "\n"),
                name + ".sha256",
                "text/plain; charset=utf-8",
              );
            } else {
              res.writeHead(200, this.headers(name, stat.size, "application/octet-stream", digest));
              if (req.method === "HEAD") res.end();
              else
                await new Promise<void>((resolve, reject) => {
                  const stream = file!.createReadStream({ start: 0, autoClose: false });
                  res.once("close", () => {
                    stream.destroy();
                    resolve();
                  });
                  stream.once("error", reject);
                  res.once("error", reject);
                  res.once("finish", resolve);
                  stream.pipe(res);
                });
            }
            return true;
          } catch (error) {
            if (file) {
              await file.close().catch(() => undefined);
              file = undefined;
            }
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      if (bundle || platform === "extension") {
        res.writeHead(503, { "retry-after": "300", "content-type": "text/plain; charset=utf-8" });
        res.end("Release artifact has not been published. No installation was performed.\n");
        return true;
      }
      const body =
        platform === "windows"
          ? windowsInstaller(this.options.origin)
          : posixInstaller(this.options.origin, platform as "linux" | "macos");
      this.send(
        req,
        res,
        Buffer.from(body),
        platform === "windows" ? "crot-install.ps1" : "crot-install.sh",
        "text/plain; charset=utf-8",
      );
      return true;
    } finally {
      if (file) await file.close();
      this.active--;
    }
  }
  private headers(name: string, size: number, type: string, digest: Buffer): Record<string, string | number> {
    return {
      "content-type": type,
      "content-length": size,
      "content-disposition": 'attachment; filename="' + name + '"',
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-checksum-sha256": digest.toString("hex"),
      digest: "sha-256=" + digest.toString("base64"),
    };
  }
  private send(req: IncomingMessage, res: ServerResponse, body: Buffer, name: string, type: string): void {
    res.writeHead(200, this.headers(name, body.length, type, createHash("sha256").update(body).digest()));
    res.end(req.method === "HEAD" ? undefined : body);
  }
}
