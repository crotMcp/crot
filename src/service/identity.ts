/**
 * The device's identity runtime in the service (ARCHITECTURE.md §27, AD-21;
 * WP-28): the identity environment of this process, the issuer's keys, the
 * relay entry point's token verifier, the device's Protected Resource
 * Metadata URL, the tunnel credential and the pairing flow in progress.
 *
 * It holds no policy: pairing and unpairing are applied (and audited) by the
 * control center for requests on the control channel; remote requests are
 * admitted by the control center and authorized by Core. Nothing here
 * reaches Core except, through the verifier, the verified facts of a token.
 *
 * Pairing registers the new device at the relay (AD-22 point 4; WP-30): the
 * device key is generated first, its public key is registered with the
 * verified pairing token, and only then is the key staged for the binding.
 */
import type { AccessTokenVerifier } from "../adapters/http/auth.js";
import { canonicalDeviceUri, generateDeviceId, protectedResourceMetadataUrl } from "../identity/device-id.js";
import type { IdentityEnvironment } from "../identity/environment.js";
import { createIdentityHttp, type IdentityHttp } from "../identity/http.js";
import { IssuerKeySet } from "../identity/jwks.js";
import { devicePublicKey, deviceKeyFromSeed } from "../identity/device-credential.js";
import { startPairing, type PairingFlow, type PairingOutcome } from "../identity/pairing.js";
import { registerDeviceAtRelay, relayRegistrationUrl } from "../identity/relay-registration.js";
import { OAuthAccessTokenVerifier, UnavailableTokenVerifier, type TokenRejection } from "../identity/verifier.js";
import type { DeviceBindingStore, TunnelCredentialResult } from "./device-binding.js";
import { generateSecret } from "./secrets/store.js";

export interface DeviceIdentityOptions {
  /** The environment of this process, or why there is none. */
  readonly environment: IdentityEnvironment | { readonly unavailable: string };
  readonly binding: DeviceBindingStore;
  readonly http?: IdentityHttp;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  /** JWKS cache tuning (tests). */
  readonly keys?: { readonly minRefetchIntervalMs?: number; readonly maxAgeMs?: number; readonly maxStaleMs?: number };
  readonly pairingTimeoutMs?: number;
}

export interface PendingPairing {
  readonly deviceId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export class DeviceIdentity {
  readonly environment: IdentityEnvironment | undefined;
  readonly unavailableReason: string | undefined;
  readonly verifier: AccessTokenVerifier;
  private readonly keys: IssuerKeySet | undefined;
  private readonly http: IdentityHttp;
  private flow: PairingFlow | undefined;
  private readonly rejections = new Map<TokenRejection, number>();

  constructor(private readonly options: DeviceIdentityOptions) {
    this.http = options.http ?? createIdentityHttp();
    if ("unavailable" in options.environment) {
      this.environment = undefined;
      this.unavailableReason = options.environment.unavailable;
      this.keys = undefined;
      this.verifier = new UnavailableTokenVerifier();
      return;
    }
    const environment = options.environment;
    this.environment = environment;
    this.unavailableReason = undefined;
    this.keys = new IssuerKeySet({
      issuer: environment.issuer,
      http: this.http,
      ...(options.now ? { now: options.now } : {}),
      ...options.keys,
      onError: (m) => options.log(m),
    });
    this.verifier = new OAuthAccessTokenVerifier({
      environment,
      keys: this.keys,
      binding: () => options.binding.view(),
      ...(options.now ? { now: options.now } : {}),
      onReject: (reason) => {
        this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
        options.log(`identity: rejected a remote access token (${reason})`);
      },
    });
  }

  /** Token rejections since start, by reason (diagnostics). */
  get rejectionCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.rejections);
  }

  /** RFC 9207 support as advertised by the issuer (reported only; AD-21 R7 open condition). */
  get rfc9207(): "advertised" | "not_advertised" | "unknown" {
    const supported = this.keys?.status().issParameterSupported;
    return supported === undefined ? "unknown" : supported ? "advertised" : "not_advertised";
  }

  /** The canonical URI of the paired device in the active environment (AD-21 point 5). */
  resourceUri(): string | undefined {
    const paired = this.pairedHere();
    return paired ? canonicalDeviceUri(paired.relayHost, paired.deviceId) : undefined;
  }

  /** The device's PRM URL for 401 challenges (AD-21 point 6); undefined while not paired here. */
  resourceMetadataUrl(): string | undefined {
    const paired = this.pairedHere();
    return paired ? protectedResourceMetadataUrl(paired.relayHost, paired.deviceId) : undefined;
  }

  tunnelCredential(): TunnelCredentialResult {
    return this.options.binding.tunnelCredential(this.environment);
  }

  get pending(): PendingPairing | undefined {
    const flow = this.flow;
    return flow
      ? { deviceId: flow.deviceId, authorizationUrl: flow.authorizationUrl, expiresAt: flow.expiresAt }
      : undefined;
  }

  /**
   * Start a pairing for a new device id. `onOutcome` runs once when the user
   * signed in (or the flow failed, timed out or was cancelled).
   */
  async startPairing(onOutcome: (outcome: PairingOutcome, deviceId: string) => void): Promise<PendingPairing> {
    if (!this.environment || !this.keys) throw new Error(this.unavailableReason ?? "no identity environment");
    if (this.flow) return this.pending!;
    const metadata = await this.keys.metadata();
    const environment = this.environment;
    const deviceId = generateDeviceId();
    const seed = generateSecret();
    const publicKey = devicePublicKey(deviceKeyFromSeed(seed));
    const flow = await startPairing({
      environment,
      metadata,
      http: this.http,
      keys: this.keys,
      deviceId,
      register: async (accessToken) => {
        const result = await registerDeviceAtRelay({
          http: this.http,
          url: relayRegistrationUrl(environment.relayHost, deviceId),
          accessToken,
          publicKey,
        });
        if (!result.ok) {
          const detail = `${result.reason}${result.status !== undefined ? ` (status ${result.status})` : ""}`;
          this.options.log(`identity: the relay did not register the device: ${detail}`);
          return { ok: false, detail };
        }
        this.options.binding.stageDeviceKey(deviceId, seed);
        this.options.log(`identity: device ${result.created ? "registered" : "already registered"} at the relay`);
        return { ok: true };
      },
      ...(this.options.pairingTimeoutMs !== undefined ? { timeoutMs: this.options.pairingTimeoutMs } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    this.flow = flow;
    void flow.outcome.then((outcome) => {
      if (this.flow === flow) this.flow = undefined;
      if (!outcome.ok) this.options.binding.clearStagedKey(flow.deviceId);
      onOutcome(outcome, flow.deviceId);
    });
    return this.pending!;
  }

  cancelPairing(): boolean {
    if (!this.flow) return false;
    this.flow.cancel();
    return true;
  }

  private pairedHere() {
    const env = this.environment;
    const paired = this.options.binding.paired;
    if (!env || !paired || paired.issuer !== env.issuer || paired.relayHost !== env.relayHost) return undefined;
    return paired;
  }
}
