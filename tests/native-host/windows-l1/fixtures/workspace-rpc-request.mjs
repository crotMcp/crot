/* One fixed RPC exchange; owns its socket through close, including errors. */
import { connect } from "node:net";
import { Buffer } from "node:buffer";
export const requestOnce = (pipe, capability, operation, makeSocket = connect) =>
  new Promise((resolve, reject) => {
    const socket = makeSocket(pipe);
    let response = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("timeout")));
    let result;
    let answered = false;
    let failure;
    socket.on("error", (error) => {
      failure = error;
      socket.destroy();
    });
    socket.on("close", () => {
      // Resolve only after releasing the request's transport. A JSON result
      // is not evidence that its socket/timeout no longer owns the loop.
      if (answered) resolve(result);
      else reject(failure ?? new Error("closed before response"));
    });
    socket.on("connect", () => socket.write(JSON.stringify({ capability, request: operation })));
    socket.on("data", (bytes) => {
      if (answered) return;
      response += bytes.toString("utf8");
      if (Buffer.byteLength(response) > 65536) {
        socket.destroy(new Error("oversized response"));
        return;
      }
      if (response.includes("\n")) {
        try {
          const decoded = JSON.parse(response.slice(0, response.indexOf("\n")));
          if (typeof decoded.ok !== "boolean") throw new Error("invalid response");
          result = decoded.ok;
          answered = true;
          // Ack before closing; never leave the pipe waiting for peer EOF.
          socket.end(".", () => socket.destroy());
        } catch (error) {
          socket.destroy(error);
        }
      }
    });
  });
