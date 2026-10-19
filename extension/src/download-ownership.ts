/** Exact response capability for AD-33. This module never matches URLs/times. */
export interface OwnedResponse {
  readonly frameId: string;
  readonly sessionId?: string;
  readonly requestId: string;
  readonly token: string;
  readonly filename: string;
  readonly originalName: string;
  guid?: string;
  downloadId?: number;
}

export class OwnershipError extends Error {}

/** 192 unpredictable bits, generated only in the extension, not supplied by a page. */
export function ownershipToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fail closed on formats we cannot preserve exactly. In particular never turn
 * an unparsed filename* (.exe, .lnk, etc.) into a benign .bin/.tmp name.
 */
export function markedDisposition(value: string, token: string): { value: string; name: string; original: string } {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new OwnershipError("Invalid ownership capability.");
  const match =
    /^\s*(attachment|inline)\s*;\s*filename\s*=\s*(?:"([A-Za-z0-9][A-Za-z0-9._ -]{0,119})"|([A-Za-z0-9][A-Za-z0-9._-]{0,119}))\s*$/i.exec(
      value,
    );
  if (!match) throw new OwnershipError("Unsupported download Content-Disposition.");
  const original = match[2] ?? match[3]!;
  if (/[. ]$/.test(original)) throw new OwnershipError("Ambiguous download filename suffix.");
  const name = "crot-" + token + "-" + original;
  return { value: match[1] + '; filename="' + name + '"', name, original };
}

/**
 * The capability is inserted into one selected frame's response BEFORE it can
 * become a DownloadItem. Seeing a sole same-URL candidate never reaches here.
 */
export class DownloadOwnership {
  private response: OwnedResponse | undefined;
  private failed = false;

  constructor(private readonly createToken: () => string = ownershipToken) {}

  mark(
    frameId: string,
    sessionId: string | undefined,
    requestId: string,
    disposition: string,
  ): { header: string; response: OwnedResponse } {
    this.assertValid();
    if (this.response) return this.fail("More than one target download response.");
    const token = this.createToken();
    const marked = markedDisposition(disposition, token);
    const response: OwnedResponse = {
      frameId,
      ...(sessionId === undefined ? {} : { sessionId }),
      requestId,
      token,
      filename: marked.name,
      originalName: marked.original,
    };
    this.response = response;
    return { header: marked.value, response };
  }

  /** A CDP event is accepted only from the session/frame whose response was marked. */
  begin(frameId: string, sessionId: string | undefined, guid: string, suggestedFilename: string): boolean {
    this.assertValid();
    const r = this.response;
    if (!r || suggestedFilename !== r.filename) return false;
    if (frameId !== r.frameId || sessionId !== r.sessionId) return this.fail("Ownership frame/session mismatch.");
    if (!guid || (r.guid !== undefined && r.guid !== guid)) return this.fail("Reused ownership capability.");
    r.guid = guid;
    return true;
  }

  /** Only inspect the basename supplied by the browser, never any filesystem path. */
  item(id: number, filename: string): "unrelated" | "pending" | "owned" {
    this.assertValid();
    const r = this.response;
    if (!r || filename !== r.filename) return "unrelated";
    if (!Number.isSafeInteger(id) || id < 0) return this.fail("Invalid download id.");
    if (r.downloadId !== undefined && r.downloadId !== id) return this.fail("Reused ownership capability.");
    r.downloadId = id;
    return r.guid === undefined ? "pending" : "owned";
  }

  proved(): Readonly<OwnedResponse> | undefined {
    this.assertValid();
    const r = this.response;
    return r?.guid !== undefined && r.downloadId !== undefined ? r : undefined;
  }

  invalidate(): void {
    this.failed = true;
    this.response = undefined;
  }

  private assertValid(): void {
    if (this.failed) throw new OwnershipError("Download ownership is invalidated.");
  }

  private fail(message: string): never {
    this.invalidate();
    throw new OwnershipError(message);
  }
}
