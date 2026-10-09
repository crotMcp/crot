/**
 * Authorization server metadata (RFC 8414) of the configured issuer
 * (ARCHITECTURE.md §27, AD-21 points 1 and 7). The JWKS location is taken
 * from this document, fetched from the configured issuer itself; the
 * document's `issuer` must equal the configured issuer byte for byte
 * (RFC 8414 section 3.3), otherwise nothing from it is used.
 */
import { isHttpsUrl, IdentityHttpError, type IdentityHttp } from "./http.js";

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** PKCE S256 advertised (AD-21 R1); pairing requires it. */
  readonly s256: boolean;
  /**
   * RFC 9207 `authorization_response_iss_parameter_supported`. Reported only:
   * AD-21 records RFC 9207 as an open condition before Gate G4 (R7); the
   * device does not depend on it.
   */
  readonly issParameterSupported: boolean;
}

export function metadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-authorization-server`;
}

export async function discoverAuthorizationServer(
  issuer: string,
  http: IdentityHttp,
): Promise<AuthorizationServerMetadata> {
  const doc = await http.getJson(metadataUrl(issuer));
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    throw new IdentityHttpError("authorization server metadata is not a JSON object");
  const m = doc as Record<string, unknown>;
  if (m.issuer !== issuer) throw new IdentityHttpError("authorization server metadata names another issuer");
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (!isHttpsUrl(m[field])) throw new IdentityHttpError(`authorization server metadata: ${field} is not https`);
  }
  const methods = Array.isArray(m.code_challenge_methods_supported) ? m.code_challenge_methods_supported : [];
  return {
    issuer,
    authorizationEndpoint: m.authorization_endpoint as string,
    tokenEndpoint: m.token_endpoint as string,
    jwksUri: m.jwks_uri as string,
    s256: methods.includes("S256"),
    issParameterSupported: m.authorization_response_iss_parameter_supported === true,
  };
}
