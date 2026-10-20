# WP-38 staging repository delivery

The repository supplies a non-root TLS relay container, compose lifecycle,
verified health command and a pinned identity build. Public infrastructure and
live WorkOS qualification are **not** implied; the local TLS acceptance emulator
is documented separately in [WP-32 acceptance](acceptance/WP-32-acceptance.md).

## Prepare trusted operator configuration

1. Create `deploy/staging/config/` (gitignored). Copy `relay.example.json` to
   `config/relay.json` and replace issuer, public relay DNS and pairing client id.
   Configure the matching live provider resource indicator, public clients,
   PKCE S256 and JWKS as described in `IDENTITY.md`. Do not use the example
   placeholder as an approved environment or put client secrets into it.
2. Supply a real certificate chain as `config/tls.crt` and private key as
   `config/tls.key`, readable only by the service uid 10001 (directory traversal
   limited to the operator/service). Use 0700 directory and 0600 key on POSIX;
   owner/service-only ACLs on Windows. Never commit keys, accounts or tokens.
3. The allowlisted `.dockerignore` excludes local keys/configuration, `.git` and
   workspace/test data from the Docker build context. Compose builds the locked dependency graph (`npm ci`), runs as uid 10001,
   drops capabilities and disallows privilege escalation, uses a read-only root
   filesystem and a 16 MiB temporary filesystem. Only registry state is writable
   persistently in the dedicated named volume. Registry ownership is initialized
   by the image's `/state` directory owner on an empty volume. Back up and protect
   that volume: it contains public device/account bindings, not device keys.
4. The default bind is **127.0.0.1:8443**, intentionally not an accidental public
   service. A public operator must explicitly provision the TLS domain/network
   route (normally port 443) without a logging proxy that captures authorization,
   query strings or bodies. The relay terminates TLS directly. Renew certificates
   and restart the relay under controlled operations. No paid host is required
   to run the automated local tests.

```sh
npm run staging -- up
npm run staging -- status
npm run staging -- health https://relay.staging.example.com:8443 /path/to/trusted-ca.pem
npm run staging -- down
# Destructive, operator-only reset: fixed crot-staging compose volume, never arbitrary paths.
npm run staging -- reset --confirm-staging-reset
```

Health verifies TLS/hostname using the supplied CA and calls `/.crot/health`.
Its aggregate 200 means the listener is reachable, **not** that OAuth/JWKS,
entitlement or a device tunnel is ready. Complete the OAuth/tool run before
calling the deployment accepted. The lifecycle script never invokes a shell or
accepts a configurable compose project/volume for deletion.

## Pinned device artifact (N3 / AD-21)

Create a reviewed **public metadata-only** identity JSON with the fields shown in
`deploy/staging/identity.example.json`. The staging/production values must be
approved independently from a test emulator.

```sh
npm ci
npm run build:release -- --environment /trusted/staging-identity.json --out dist-release
node dist-release/bin/crot-mcp.js
```

The builder compiles the real sources into a fresh temporary directory, validates
the strict bounded metadata, then replaces **only the emitted**
`identity/release-environment.js` with a frozen data literal and emits
`release-identity.json`. It never edits the development source sentinel. A pinned
artifact ignores `CROT_IDENTITY_DEV_ENVIRONMENT` even if it points at another
issuer or an unreadable/malicious file. Plain `npm run build` remains explicitly
unpinned/development. Distribute the selected **release output**, not an older
`dist/` tree; packaging/signing enforcement is WP-34. Invalid metadata cannot
replace an existing release artifact. Treat the output as unpublished until the
build process exits successfully; no concurrent writers to one output directory.
Node base image tags remain operator-updated major tags; pin image digests in a
particular operational deployment/release record for byte-identical rebuilds.

The existing x64 installed-L1 CI jobs also build the actual Dockerfile, validate
the compose tmpfs configuration and run the non-root, read-only image with a
disposable test certificate. The real `staging health` command must verify its
TLS listener. This smoke test is not a public deployment or live OAuth check.

## Metadata-only diagnostics and teardown

The relay's existing fixed-schema JSON logger outputs event/outcome/status,
counts, sizes, durations and identifiers. It does not log arbitrary headers,
authorization, tokens, URLs/queries, OAuth proofs, request/response bodies or file
contents. Compose uses bounded local log rotation and has no body/access logger.
Do not enable generic HTTP trace/debug middleware or platform request-body
capture in a hosting layer. The acceptance suite checks token/file/page canaries
against actual relay and device diagnostics; file audit retains paths/sizes and
control decisions, not file bodies. Command audits intentionally retain script
text under the existing audit contract; they are not relay diagnostics.

`down` retains the registry; confirmed `reset` deletes only this staging volume.
Remove test device pairing using normal unpair/deregistration, revoke test
accounts at the identity provider, then delete the operator's local secrets
according to its OS lifecycle policy. Reset does not pretend to revoke a live
provider token or erase an unrelated machine's local configuration.
