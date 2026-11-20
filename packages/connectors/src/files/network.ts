/**
 * The only way a file source or an API source reaches the network.  The server supplies it, built
 * on the same guarded client that webhooks and imports use, so the private-network rule lives in
 * one place: every address a host resolves to must be on the public internet unless the operator
 * allows private hosts, the connection goes to the address that was checked, and every redirect is
 * checked the same way before anything follows it.  DuckDB never fetches anything itself.
 */

export type FileNetworkProblem =
  /** The address isn't https, and isn't a plain-http `localhost` the operator allows */
  | 'https'
  /** The address, or one a redirect names, is on a private network */
  | 'blocked'
  /** The host's name didn't resolve */
  | 'resolve'
  /** The answer passed the size limit */
  | 'tooLarge'
  /** The connection failed, or the answer went quiet for too long */
  | 'failed';

export class FileNetworkError extends Error {
  constructor(
    readonly problem: FileNetworkProblem,
    readonly detail?: string,
  ) {
    super(detail ?? problem);
    this.name = 'FileNetworkError';
  }
}

export interface CheckedAddress {
  address: string;
  family: 4 | 6;
}

export interface FileRequest {
  url: URL;
  /** `POST` carries a query or token request and never follows a redirect */
  method: 'GET' | 'HEAD' | 'POST' | 'PROPFIND';
  /** Sent to the address asked for, and after a redirect only while it stays on the same origin */
  headers: Record<string, string>;
  /** A `POST`'s body */
  body?: string;
  /** The most the answer may hold.  Reading past it fails with `tooLarge`. */
  maxBytes: number;
  signal: AbortSignal;
  /** How long connecting, and each quiet stretch while reading, may take */
  idleMs: number;
}

export interface FileResponse {
  status: number;
  /** Header names in lower case */
  headers: Record<string, string | undefined>;
  /** Where the answer came from, after any redirects */
  url: URL;
  body: AsyncIterable<Buffer>;
  /** Stops reading the body and lets the connection go */
  close(): void;
}

export interface FileNetwork {
  /** Whether an address may be asked for at all: https, or plain http to an allowed `localhost` */
  allowsAddress(url: URL): boolean;
  /** Resolves the host and checks every address it resolves to.  Connections go to the one returned. */
  check(url: URL, signal: AbortSignal): Promise<CheckedAddress>;
  request(request: FileRequest): Promise<FileResponse>;
}

/** A network for a server that hasn't supplied one, which refuses everything. */
export const NO_NETWORK: FileNetwork = {
  allowsAddress: () => false,
  check: () => Promise.reject(new FileNetworkError('blocked', 'file sources have no network on this server')),
  request: () =>
    Promise.reject(new FileNetworkError('blocked', 'file sources have no network on this server')),
};
