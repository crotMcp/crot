import { describe, expect, it } from "vitest";
import { parseRelayConfig } from "../../src/cloud-relay/config.js";
import { validateEnvironment } from "../../src/identity/environment.js";
const issuer = "https://prestigious-continent-62-staging.authkit.app";
const relayHost = "relay-staging.crot.network";
describe("AD-21.1 pinned AuthKit issuer origin", () => {
  it("accepts a WorkOS authkit.app issuer independent of relayHost", () => {
    expect(
      validateEnvironment(
        {
          id: "staging",
          issuer,
          relayHost,
          pairingClientId: "client_01",
          pairingRedirectPort: 0,
          pairingScope: "openid",
        },
        "release",
      ),
    ).toMatchObject({ issuer, relayHost });
    expect(
      parseRelayConfig({
        issuer,
        relayHost,
        pairingClientId: "client_01",
        environment: "staging",
        registryFile: "registry.json",
        host: "127.0.0.1",
        port: 8443,
      }),
    ).toMatchObject({ issuer, relayHost });
  });
});
