import type { ChromeApi, ChromeDownloadItem } from "./chrome-api.js";
import type { CdpSessions } from "./cdp.js";
import { DownloadOwnership } from "./download-ownership.js";
import { ExtensionError } from "./errors.js";
import { tabFrames } from "./frames.js";

const failure = (message: string) => new ExtensionError("OPERATION_FAILED", message);
/** One extension-wide capture window. Unknown downloads always receive suggest() unchanged. */
export class DownloadCapture {
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly handedOver = new Map<string, { id: number; timer: ReturnType<typeof setTimeout> }>();
  /** Core ACK (also on publication failure); numeric ids are recorded only after exact proof. */
  async release(stem: string): Promise<void> {
    const owned = this.handedOver.get(stem);
    if (!owned) return;
    this.handedOver.delete(stem);
    clearTimeout(owned.timer);
    await this.api.downloads?.removeFile(owned.id).catch(() => undefined);
  }
  constructor(
    private readonly api: ChromeApi,
    private readonly cdp: CdpSessions,
  ) {}
  async run(
    tabId: number,
    prefix: string,
    stem: string,
    deadline: number,
    maxBytes: number,
    trigger: () => Promise<void>,
  ): Promise<{
    tabId: number;
    originalName: string;
    size: number;
    mimeType: string;
  }> {
    if (++this.queued > 16) {
      --this.queued;
      throw new ExtensionError("RESOURCE_BUSY", "Download queue is full.");
    }
    const prior = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prior;
      return await this.capture(tabId, prefix, stem, deadline, maxBytes, trigger);
    } finally {
      --this.queued;
      release();
    }
  }
  private async capture(
    tabId: number,
    prefix: string,
    stem: string,
    deadline: number,
    maxBytes: number,
    trigger: () => Promise<void>,
  ) {
    const downloads = this.api.downloads;
    if (!downloads) throw failure("Browser downloads API is unavailable.");
    if (
      !/^CROT-private-staging\/\d+-[a-f0-9]{48}$/.test(prefix) ||
      !/^[a-f0-9]{48}$/.test(stem) ||
      !Number.isSafeInteger(deadline) ||
      deadline <= Date.now() ||
      deadline > Date.now() + 60_000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 64 * 1024 * 1024
    )
      throw failure("Invalid download capture parameters.");
    const { frames, truncated } = await tabFrames(this.cdp, tabId);
    if (truncated) throw failure("Frame tree exceeds download capture bound.");
    const sessions = [...new Set(frames.map((f) => f.sessionId))];
    const ledger = new DownloadOwnership();
    let pending: { id: number; suggest: (v?: { filename: string; conflictAction: "uniquify" }) => void } | undefined;
    let completed = false,
      closed = false,
      succeeded = false,
      failed = false,
      stagingAssigned = false;
    let ownedId: number | undefined;
    const progress = new Map<string, { sessionId?: string; state?: string }>();
    let resolve!: (item: ChromeDownloadItem) => void, reject!: (e: Error) => void;
    const done = new Promise<ChromeDownloadItem>((a, b) => {
      resolve = a;
      reject = b;
    });
    // A synchronous event can fail before trigger()/arming has finished.
    void done.catch(() => undefined);
    const fail = (e: unknown) => {
      failed = true;
      if (!closed) reject(e instanceof Error ? e : failure("Download capture failed."));
    };
    const inFlight = new Set<Promise<void>>();
    const track = (run: () => Promise<void>) => {
      const p = run().catch(fail);
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    };
    const inspect = async () => {
      if (closed || ownedId === undefined) return;
      const items = await downloads.search({ id: ownedId });
      const item = items[0];
      if (!item || item.id !== ownedId) throw failure("Owned download disappeared.");
      if (item.danger !== "safe" || item.state === "interrupted")
        throw failure("Owned download was interrupted or is unsafe.");
      if (item.bytesReceived > maxBytes || item.totalBytes > maxBytes || item.fileSize > maxBytes)
        throw failure("Download byte limit exceeded.");
      if (stagingAssigned && completed && item.state === "complete") {
        if (!Number.isSafeInteger(item.fileSize) || item.fileSize < 0 || item.fileSize !== item.bytesReceived)
          throw failure("Invalid download byte count.");
        resolve(item);
      }
    };
    const prove = () => {
      const proof = ledger.proved();
      if (!proof || !pending || proof.downloadId !== pending.id || closed) return;
      ownedId = proof.downloadId;
      const earlier = proof.guid ? progress.get(proof.guid) : undefined;
      if (earlier?.sessionId === proof.sessionId) {
        if (earlier?.state === "canceled") fail(failure("Download canceled."));
        completed = earlier?.state === "completed";
      }
      const held = pending;
      pending = undefined;
      track(async () => {
        try {
          // A proved id is not yet permission to stage unsafe bytes. Inspect
          // while its filename callback is still held, before creating a path.
          await inspect();
          if (closed || failed) {
            held.suggest();
            return;
          }
          held.suggest({ filename: prefix + "/" + stem + "-" + proof.originalName, conflictAction: "uniquify" });
          stagingAssigned = true;
        } catch (error) {
          held.suggest();
          throw error;
        }
        await inspect();
      });
    };
    const filename = (
      item: ChromeDownloadItem,
      suggest: (v?: { filename: string; conflictAction: "uniquify" }) => void,
    ): boolean | void => {
      if (closed) {
        suggest();
        return;
      }
      try {
        const status = ledger.item(item.id, item.filename);
        if (status === "unrelated") {
          suggest();
          return;
        }
        if (pending) throw failure("Ambiguous download callback.");
        pending = { id: item.id, suggest };
        prove();
        return true;
      } catch (e) {
        suggest();
        fail(e);
      }
    };
    const changed = (delta: { id: number }) => {
      if (delta.id === ownedId) track(inspect);
    };
    const detach = (source: { tabId?: number; sessionId?: string }) => {
      if (source.tabId === tabId) fail(failure("Download debugger detached."));
    };
    const removed = (id: number) => {
      if (id === tabId) fail(failure("Download tab closed."));
    };
    const stop = this.cdp.onSessionEvent((id, method, raw, sessionId) => {
      if (id !== tabId || closed) return;
      const p = raw as {
        requestId?: string;
        frameId?: string;
        request?: { url?: string };
        responseHeaders?: { name: string; value: string }[];
        responseStatusCode?: number;
        resourceType?: string;
        guid?: string;
        suggestedFilename?: string;
        state?: string;
      };
      if (method === "Fetch.requestPaused")
        track(async () => {
          let continued = false;
          try {
            if (!p.requestId) throw failure("Invalid intercepted request.");
            const headers = p.responseHeaders ?? [],
              disposition = headers.filter((h) => h.name.toLowerCase() === "content-disposition");
            if (!disposition.length || ((p.responseStatusCode ?? 0) >= 300 && (p.responseStatusCode ?? 0) < 400)) {
              await this.cdp.send(tabId, "Fetch.continueRequest", { requestId: p.requestId }, sessionId);
              continued = true;
              return;
            }
            if (
              closed ||
              p.responseStatusCode !== 200 ||
              disposition.length !== 1 ||
              p.resourceType !== "Document" ||
              !/^https?:\/\//.test(p.request?.url ?? "") ||
              !frames.some((f) => f.frameId === p.frameId && f.sessionId === sessionId)
            )
              throw failure("Unsupported download response.");
            const marked = ledger.mark(p.frameId!, sessionId, p.requestId, disposition[0]!.value);
            await this.cdp.send(
              tabId,
              "Fetch.continueResponse",
              {
                requestId: p.requestId,
                responseCode: p.responseStatusCode,
                responseHeaders: [
                  ...headers.filter((h) => h.name.toLowerCase() !== "content-disposition"),
                  { name: "Content-Disposition", value: marked.header },
                ],
              },
              sessionId,
            );
            continued = true;
          } finally {
            if (!continued && p.requestId)
              await this.cdp
                .send(tabId, "Fetch.continueRequest", { requestId: p.requestId }, sessionId)
                .catch(() => undefined);
          }
        });
      if (method === "Page.downloadWillBegin") {
        try {
          if (ledger.begin(p.frameId ?? "", sessionId, p.guid ?? "", p.suggestedFilename ?? "")) prove();
        } catch (e) {
          fail(e);
        }
      }
      if (method === "Page.downloadProgress") {
        try {
          if (p.guid && progress.size < 64) progress.set(p.guid, { sessionId, state: p.state });
          const proof = ledger.proved();
          if (proof && proof.guid === p.guid && proof.sessionId === sessionId) {
            if (p.state === "canceled") fail(failure("Download canceled."));
            if (p.state === "completed") {
              completed = true;
              track(inspect);
            }
          }
        } catch (e) {
          fail(e);
        }
      }
    });
    downloads.onDeterminingFilename.addListener(filename);
    downloads.onChanged.addListener(changed);
    this.api.debugger.onDetach.addListener(detach);
    this.api.tabs.onRemoved.addListener(removed);
    const timer = setTimeout(() => fail(failure("Download capture timed out.")), Math.max(1, deadline - Date.now()));
    try {
      for (const session of sessions)
        await this.cdp.send(
          tabId,
          "Fetch.enable",
          {
            patterns: [
              { urlPattern: "http://*", resourceType: "Document", requestStage: "Response" },
              { urlPattern: "https://*", resourceType: "Document", requestStage: "Response" },
            ],
          },
          session,
        );
      if (Date.now() >= deadline) throw failure("Download capture expired before trigger.");
      await Promise.race([trigger(), done.then(() => undefined)]);
      const item = await done,
        proof = ledger.proved();
      if (!proof || proof.downloadId !== item.id) throw failure("Download ownership was lost.");
      succeeded = true;
      // If Core disconnects after receipt, reclaim the proved download, never an unknown item.
      this.handedOver.set(stem, {
        id: item.id,
        timer: setTimeout(() => {
          void this.release(stem);
        }, 60_000),
      });
      return {
        tabId,
        originalName: proof.originalName,
        size: item.fileSize,
        mimeType: String(item.mime ?? "").slice(0, 200),
      };
    } finally {
      closed = true;
      clearTimeout(timer);
      stop();
      downloads.onDeterminingFilename.removeListener(filename);
      downloads.onChanged.removeListener(changed);
      this.api.debugger.onDetach.removeListener(detach);
      this.api.tabs.onRemoved.removeListener(removed);
      if (pending) pending.suggest();
      for (const session of sessions) await this.cdp.send(tabId, "Fetch.disable", {}, session).catch(() => undefined);
      await Promise.all(inFlight);
      // Only a two-factor-proved id may be canceled or removed, even on failure.
      if (!succeeded && ownedId !== undefined) {
        await downloads.cancel(ownedId).catch(() => undefined);
        // Cancellation acknowledgement can precede native terminal-state
        // notification. Do not let Core delete a lease while Chrome can still
        // initialize its destination in response to the filename callback.
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          const item = (await downloads.search({ id: ownedId }).catch(() => []))[0];
          if (!item || item.state !== "in_progress") break;
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        await downloads.removeFile(ownedId).catch(() => undefined);
      }
      ledger.invalidate();
    }
  }
}
