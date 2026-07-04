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

  const bare = messageId?.replace(/^<|>$/g, "").trim();
  return bare || "unknown";
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
 * now normalizes brackets everywhere, so a message's own Message-ID and ids
 * parsed from References/In-Reply-To hash the same way. But thread ids
 * computed without body access still fall back to In-Reply-To (the parent,
 * not the root) — so messages in the same thread can disagree on the thread
 * id — and older thread ids may have been computed and stored before this
 * fix (bracketed root) or by a message that lacked References. This
 * generates both bare and bracketed variants (plus references-root and
 * in-reply-to-parent) so lookups can still match any of them.
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
