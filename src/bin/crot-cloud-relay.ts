#!/usr/bin/env node
/**
 * crot-cloud-relay: the CROT Cloud Relay v1 server (ARCHITECTURE.md §22,
 * §27 AD-22; WP-29). Not part of the device package; deployed by WP-38/WP-39.
 *
 *   node dist/bin/crot-cloud-relay.js --config relay.json
 *
 * Logs are JSON lines on stderr without tokens, headers, bodies or paths.
 */
import { AccountService } from "../account-service/service.js";
import { StripeBillingProvider, WorkOSRevoker } from "../account-service/billing.js";
import { readFile } from "node:fs/promises";
import { parseRelayConfig } from "../cloud-relay/config.js";
import { jsonLineLogger } from "../cloud-relay/log.js";
import { FileDeviceRegistry } from "../cloud-relay/registry.js";
import { CloudRelay } from "../cloud-relay/server.js";
import { createIdentityHttp } from "../identity/http.js";
import { IssuerKeySet } from "../identity/jwks.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--config");
  if (i === -1 || !args[i + 1]) throw new Error("usage: crot-cloud-relay --config <file>");
  const config = parseRelayConfig(JSON.parse(await readFile(args[i + 1]!, "utf8")));
  const log = jsonLineLogger();
  const keys = new IssuerKeySet({ issuer: config.issuer, http: createIdentityHttp() });
  const revoker = config.workosSecretFile
    ? new WorkOSRevoker((await readFile(config.workosSecretFile, "utf8")).trim())
    : undefined;
  const accounts = await AccountService.open(config.accountFile, { revoker });
  const billing = config.billing
    ? new StripeBillingProvider({
        secretKey: (await readFile(config.billing.secretKeyFile, "utf8")).trim(),
        webhookSecret: (await readFile(config.billing.webhookSecretFile, "utf8")).trim(),
        prices: config.billing.prices,
        returnUrl: config.billing.returnUrl,
      })
    : undefined;
  const metricsToken = config.metricsTokenFile ? (await readFile(config.metricsTokenFile, "utf8")).trim() : undefined;
  if (metricsToken !== undefined && metricsToken.length < 32) throw new Error("metrics token is too short");
  const relay = new CloudRelay({
    accounts,
    billing,
    portalClientIds: config.portalClientIds,
    portalMetadata: () => keys.metadata(),
    minimumDeviceVersion: config.minimumDeviceVersion,
    minimumClientVersion: config.minimumClientVersion,
    limits: config.limits,
    relayHost: config.relayHost,
    issuer: config.issuer,
    pairingClientId: config.pairingClientId,
    environment: config.environment,
    keys,
    registry: await FileDeviceRegistry.open(config.registryFile),
    exchangeDeadlineMs: config.exchangeDeadlineMs,
    metricsToken,
    log,
  });
  const tls = config.tls
    ? { cert: await readFile(config.tls.certFile), key: await readFile(config.tls.keyFile) }
    : undefined;
  await relay.listen({ port: config.port, host: config.host, ...(tls ? { tls } : {}) });
  const stop = () => {
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(() => {
  // Startup errors can contain secret/config paths. Never serialize provider or filesystem errors.
  process.stderr.write("crot-cloud-relay: startup_failed (check configuration and provider availability)\n");
  process.exit(1);
});
