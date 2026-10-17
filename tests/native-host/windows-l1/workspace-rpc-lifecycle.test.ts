/** Portable transport ownership tests; not Windows filesystem/security proof. */
import { createServer, connect, type Socket } from "node:net";
import { expect, it } from "vitest";
import { waitFor } from "../../helpers.js";

it.each(["accepted", "refused", "malformed", "oversized"] as const)(
  "releases the owned socket before settling an %s exchange",
  async (mode) => {
    const rpc = await import(new URL("./fixtures/workspace-rpc-request.mjs", import.meta.url).href);
    const sockets = new Set<Socket>();
    let ack = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      let sent = false;
      socket.on("data", (data) => {
        if (sent) {
          ack = data.toString() === ".";
          return;
        }
        sent = true;
        const envelope = JSON.parse(data.toString());
        expect(envelope.request).toEqual({ op: "remove", path: "owned.txt" });
        socket.write(
          mode === "malformed"
            ? "{not-json}\n"
            : mode === "oversized"
              ? "x".repeat(65537)
              : JSON.stringify({ ok: mode === "accepted" }) + "\n",
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing owned listener.");
    let clientClosed = false;
    try {
      const promise = rpc.requestOnce("test-owned", "test-only", { op: "remove", path: "owned.txt" }, () => {
        const socket = connect({ host: "127.0.0.1", port: address.port });
        socket.on("close", () => (clientClosed = true));
        return socket;
      });
      if (mode === "accepted" || mode === "refused") expect(await promise).toBe(mode === "accepted");
      else await expect(promise).rejects.toThrow();
      // Both successful and failed requests must leave no active client.
      expect(clientClosed).toBe(true);
      await waitFor(() => sockets.size === 0, 3000);
      if (mode === "accepted" || mode === "refused") expect(ack).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  },
);
