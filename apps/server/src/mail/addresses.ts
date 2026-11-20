/**
 * Addresses as the JSON services want them, split into an address and the name beside it.  SMTP and
 * the transports that send raw MIME pass a whole header value along, but Azure Communication
 * Services asks for each part on its own.
 */

export interface MailAddress {
  address: string;
  /** The name shown beside the address, when the value carried one */
  displayName?: string;
}

const BARE = /^[^\s@<>"]+@[^\s@<>"]+$/;

/** The address in `Riosoma <mail@example.test>` or in a bare address, or null when there is none. */
export function addressOf(value: string | undefined): MailAddress | null {
  if (!value) return null;
  const bracketed = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (bracketed) {
    const displayName = bracketed[1]!.replace(/^["']|["']$/g, '').trim();
    return { address: bracketed[2]!, ...(displayName ? { displayName } : {}) };
  }
  const bare = value.trim();
  return BARE.test(bare) ? { address: bare } : null;
}
