# Device tunnel (WP-30)

The device tunnel is the client side of the relay–device tunnel (ARCHITECTURE.md §27, AD-22). The local CROT service opens it. The server side is the Cloud Relay (WP-29, see [RELAY.md](RELAY.md)).

## What it does

- **One outbound WebSocket.** While remote mode is on and the device is paired in the active identity environment, the service keeps one WebSocket open to `wss://<relayHost>/.crot/tunnel` with subprotocol `crot-tunnel.v1`.
- **Handshake (AD-22 point 3).** The relay sends a CHALLENGE. The device checks that the challenge names the pinned relay host. A challenge for any other host is never signed. The device then answers with HELLO, which carries the device id, the proof signed with the device credential, and `maxStreams`. The relay answers with READY.
- **Refusals.** Close codes 4401 (bad proof or unknown device), 4403 (not entitled) and 4426 (unsupported version) put the tunnel into the `blocked` state. It then retries hourly, or sooner after pairing changes. Other failures reconnect with exponential backoff and full jitter: 1 s up to 60 s, reset after 60 s of READY, and `retryAfter` is honoured.
- **Request routing.** Each stream is one HTTP exchange. It is forwarded unmodified to a loopback-only `CrotHttpServer` that uses the **relay entry point**. That entry point runs the full existing pipeline, unchanged:
  - OAuth access-token verification, bound to this device and account (AD-21)
  - device-side admission: remote mode and revocation (AD-19)
  - sessions, PermissionEngine, ExecutionGuard, approvals and audit (AD-15)
- **The tunnel adds no authorization.** It replaces only the two AD-22 point 7 checks:
  - Host must equal the pinned relay host.
  - Path must be `/d/<own deviceId>/mcp`.

## Safety properties

- **Refusals before forwarding.** A stream refused before it is forwarded gets RESET `refused`, and the relay reports `not_executed`. This covers: over `maxStreams`, a wrong path, a wrong host, a bad method, and a body over 4 MiB.
- **Unknown outcomes.** A forwarded stream that does not finish its response is reported by the relay as `unknown`.
- **Tunnel loss.** Losing the tunnel aborts every forwarded request through the pipeline's AbortSignal. Pending approvals and operations that have not started are cancelled. A new tunnel starts with no streams, so **nothing is ever replayed** (points 9 and 13).
- **Cancellation.** A relay RESET, such as the client closing its request, destroys the local request. That cancels pending approvals.
- **Memory bounds:**
  - streams: `maxStreams = min(1024, maxConcurrentRequests + maxSessions)`
  - request body: 4 MiB
  - response: 32 MiB, otherwise RESET `response_too_large`
  - frames: 64 KiB
  - credit is returned only when bytes have been written locally (point 8)
- **Liveness.** A PING is sent after 20 s of silence. The tunnel counts as dead after 60 s of silence.
- **Logs.** Logs contain only the tunnel id, stream ids and codes. Tokens, headers, paths and bodies are never logged.

## OD-5: timeouts (decided, AD-22 points 12–13)

- **Deadline.** Each exchange has a hard deadline of 15 minutes, set by the relay. The device aborts the local request at *deadline − 5 s* and resets the stream with `deadline_exceeded`. The relay reports that outcome as `unknown`.
- **Long approvals and bounded browser waits.** These run inside the deadline. No separate idle timeout applies to an exchange that is waiting for approval.
- **Cancellation.** Cancellation reaches the pipeline only through the AbortSignal. Neither side ever retries automatically.

## Lifecycle in the service

`RemoteTunnel` (`src/service/remote-tunnel.ts`) keeps the tunnel in step with the device state:

- It re-checks the state right after the `remote.setMode`, `device.unpair` and `pairing.start` control requests, and every 2 s, which picks up completed pairing.
- When remote mode is turned off, the tunnel closes with GOAWAY `remote_disabled` and close code 1000.
- When the device is unpaired, it closes with GOAWAY `unpaired`.
- On service shutdown, it closes with GOAWAY `shutting_down`.
- When the system resumes from sleep, it reconnects immediately.
- The tray overview (`remote.tunnel`) shows the current tunnel state.

Local stdio and loopback HTTP are not affected.

## Tests

`tests/cloud-relay/device-tunnel.test.ts` runs the real WP-29 relay (harness) → `DeviceTunnel` → the relay entry point → Core. The `TestDevice` stand-in is not used. The suite covers:

- SDK clients (2026-07-28 and legacy) and every legacy version
- parallel requests and streaming across flow-control windows
- approval, cancellation, and tunnel loss during an approval (outcome `unknown`, no replay)
- tokens for another device or account, and expired tokens
- bad signature or unknown device (4401)
- unsupported version (4426), and a challenge for another relay host
- reconnecting with backoff, GOAWAY, and secret-free logs
