/**
 * The sandbox a "Show me" demo runs in.  While it's open, every open database works on a throwaway
 * layer over what it shows: changes appear as they would, but no command is sent, the undo history
 * and realtime connection are left alone, and closing the sandbox throws the layer away, so the
 * interface is exactly as it was.  The network layer refuses anything else that would change
 * something on the server, so a control a demo touches can never save by another road.
 */

/** A database session, or anything else holding state a demo could change. */
export interface SandboxTarget {
  /** Starts keeping changes in a throwaway layer. */
  enterSandbox(): void;
  /** Throws the layer away and carries on as before. */
  leaveSandbox(): void;
  /** Throws the layer away and starts an empty one, for a demo stepping back. */
  resetSandbox(): void;
}

/** The message a request refused inside the sandbox carries. */
export const SANDBOX_REFUSED = 'demos.sandbox.refused';

/**
 * Requests that travel as POST only because their questions are long, and that change nothing.  A
 * demo may still read: the grid pages in rows and the find bar searches.
 */
const READS: readonly RegExp[] = [
  /^\/api\/views\/[^/]+\/search$/,
  /^\/api\/dashboards\/[^/]+\/data$/,
  /^\/api\/databases\/[^/]+\/views\/[^/]+\/aggregate$/,
  /^\/api\/interfaces\/[^/]+\/(?:data|records)$/,
  /^\/api\/tables\/[^/]+\/records\/names$/,
  /^\/api\/fields\/[^/]+\/conversion-preview$/,
];

const targets = new Set<SandboxTarget>();
let open = false;

/** Adds a target, in the sandbox at once when one is open.  Returns how to take it out again. */
export function attachSandbox(target: SandboxTarget): () => void {
  targets.add(target);
  if (open) target.enterSandbox();
  return () => {
    targets.delete(target);
  };
}

/** Whether a demo's sandbox is open. */
export function inSandbox(): boolean {
  return open;
}

export function beginSandbox(): void {
  if (open) return;
  open = true;
  for (const target of [...targets]) target.enterSandbox();
}

export function resetSandbox(): void {
  if (!open) return;
  for (const target of [...targets]) target.resetSandbox();
}

export function endSandbox(): void {
  if (!open) return;
  open = false;
  for (const target of [...targets]) target.leaveSandbox();
}

/** Whether the network layer has to refuse a request, which is anything but a read while a demo runs. */
export function sandboxRefuses(method: string | undefined, path: string): boolean {
  if (!open) return false;
  const verb = (method ?? 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return false;
  if (verb !== 'POST') return true;
  const bare = path.split(/[?#]/, 1)[0]!;
  return !READS.some((pattern) => pattern.test(bare));
}
