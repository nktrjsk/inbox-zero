import { createHash } from "node:crypto";

/**
 * Build a deterministic thread ID from email threading headers.
 * Uses the root Message-ID from the References chain (first entry),
 * falling back to In-Reply-To, then the message's own Message-ID.
 */
export function buildThreadId(
  references: string | undefined,
  inReplyTo: string | undefined,
  messageId: string | undefined,
): string {
  const rootId = getRootMessageId(references, inReplyTo, messageId);
  return hashToThreadId(rootId);
}

/**
 * Extract the root message ID from threading headers.
 * The References header lists Message-IDs oldest-first,
 * so the first entry is the original message that started the thread.
 */
export function getRootMessageId(
  references: string | undefined,
  inReplyTo: string | undefined,
  messageId: string | undefined,
): string {
  if (references) {
    const ids = parseMessageIdList(references);
    if (ids.length > 0) return ids[0];
  }

  if (inReplyTo) {
    const ids = parseMessageIdList(inReplyTo);
    if (ids.length > 0) return ids[0];
  }

  return messageId || "unknown";
}

/**
 * Parse a space/comma-separated list of Message-IDs (RFC 5322 format).
 * Handles both `<id@domain>` and bare `id@domain` formats.
 */
export function parseMessageIdList(header: string): string[] {
  const ids: string[] = [];
  const regex = /<([^>]+)>/g;
  let match: RegExpExecArray | null;

  match = regex.exec(header);
  while (match !== null) {
    ids.push(match[1]);
    match = regex.exec(header);
  }

  // If no angle-bracket IDs found, try splitting by whitespace
  if (ids.length === 0) {
    return header
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return ids;
}

/**
 * Hash a message ID to a fixed-length thread ID.
 */
function hashToThreadId(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex").slice(0, 24);
}

/**
 * All thread ids a message in a thread may be stored under. getRootMessageId
 * strips angle brackets from References/In-Reply-To ids but keeps them on a
 * root message's own Message-ID, and ids computed without body access fall
 * back to In-Reply-To (the parent, not the root) — so messages in the same
 * thread can disagree on the thread id. Lookups should match any of these.
 */
export function getThreadIdCandidates(
  references: string | undefined,
  inReplyTo: string | undefined,
  messageId: string | undefined,
): Set<string> {
  const candidates = new Set<string>();

  const addBracketVariants = (id: string | undefined) => {
    if (!id) return;
    const bare = id.replace(/^<|>$/g, "").trim();
    if (!bare) return;
    candidates.add(hashToThreadId(bare));
    candidates.add(hashToThreadId(`<${bare}>`));
  };

  addBracketVariants(
    references ? parseMessageIdList(references)[0] : undefined,
  );
  addBracketVariants(inReplyTo ? parseMessageIdList(inReplyTo)[0] : undefined);
  addBracketVariants(messageId);

  return candidates;
}
