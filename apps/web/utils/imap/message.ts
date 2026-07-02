import type { ImapFlow, FetchMessageObject, MailboxObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { ParsedMessage, ParsedMessageHeaders } from "@/utils/types";
import { buildThreadId, getThreadIdCandidates } from "@/utils/imap/thread";
import { listSearchableFolders } from "@/utils/imap/folder";

/**
 * Fetch a single message by sequence number with full body content.
 */
export async function fetchMessageBySeq(
  client: ImapFlow,
  seq: number,
): Promise<ParsedMessage | null> {
  const msg = await client.fetchOne(String(seq), {
    uid: true,
    envelope: true,
    flags: true,
  });

  if (!msg) return null;

  const body = await downloadMessageBody(client, seq);
  return convertImapMessage(msg, body);
}

/**
 * Fetch a single message by UID with full body content.
 * Uses SEARCH to find the sequence number first (WorkMail-compatible).
 */
export async function fetchMessageByUid(
  client: ImapFlow,
  uid: number,
): Promise<ParsedMessage | null> {
  try {
    // Find the sequence number for this UID
    const seqNums = await client.search({ uid: `${uid}` }, { uid: false });
    if (!seqNums || seqNums.length === 0) return null;

    const seq = seqNums[0];
    const msg = await client.fetchOne(String(seq), {
      uid: true,
      envelope: true,
      flags: true,
    });
    if (!msg) return null;

    const body = await downloadMessageBody(client, seq);
    return convertImapMessage(msg, body);
  } catch {
    return null;
  }
}

/**
 * Fetch the most recent N messages from the currently selected mailbox.
 * Uses sequence numbers (most reliable across IMAP servers).
 */
export async function fetchRecentMessages(
  client: ImapFlow,
  mailbox: MailboxObject,
  maxResults: number,
): Promise<ParsedMessage[]> {
  const total = mailbox.exists || 0;
  if (total === 0) return [];

  const start = Math.max(1, total - maxResults + 1);
  const range = `${start}:*`;

  const messages: ParsedMessage[] = [];
  for await (const msg of client.fetch(range, {
    uid: true,
    envelope: true,
    flags: true,
  })) {
    const parsed = await convertImapMessage(msg);
    if (parsed) messages.push(parsed);
  }

  // Return newest first
  messages.reverse();
  return messages;
}

/**
 * List messages in the currently selected mailbox, newest first, filtered
 * client-side by date range, unread state, and sender. Index-backed servers
 * (e.g. Stalwart) silently under-return SEARCH results for dates and sender,
 * so only data fetched directly from the messages is trusted here.
 */
export async function listMessagesWithFilters(
  client: ImapFlow,
  options: {
    offset: number;
    maxResults: number;
    before?: Date;
    after?: Date;
    unreadOnly?: boolean;
    fromEmail?: string;
  },
): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
  const exists = typeof client.mailbox === "object" ? client.mailbox.exists : 0;
  if (!exists) return { messages: [] };

  const matching: ParsedMessage[] = [];
  for await (const msg of client.fetch("1:*", {
    uid: true,
    envelope: true,
    flags: true,
  })) {
    const parsed = await convertImapMessage(msg);
    if (parsed && messageMatchesFilters(parsed, options)) matching.push(parsed);
  }
  // IMAP sequence order is oldest-first
  matching.reverse();

  const { offset, maxResults } = options;
  const messages = matching.slice(offset, offset + maxResults);
  const nextOffset = offset + maxResults;
  return {
    messages,
    nextPageToken:
      nextOffset < matching.length ? String(nextOffset) : undefined,
  };
}

/**
 * Fetch multiple messages by UIDs - envelope only (no body).
 * Uses UID-based SEARCH to find each message's sequence number,
 * then fetches by sequence range (WorkMail-compatible).
 */
export async function fetchMessagesByUids(
  client: ImapFlow,
  uids: number[],
): Promise<ParsedMessage[]> {
  if (uids.length === 0) return [];

  // Find the sequence numbers for these UIDs via SEARCH
  // Then fetch by sequence range which works on all servers
  const messages: ParsedMessage[] = [];

  for (const uid of uids) {
    try {
      // SEARCH UID <uid> returns matching sequence numbers
      const seqNums = await client.search({ uid: `${uid}` }, { uid: false });
      if (!seqNums || seqNums.length === 0) continue;

      const seq = seqNums[0];
      const msg = await client.fetchOne(String(seq), {
        uid: true,
        envelope: true,
        flags: true,
      });
      if (msg) {
        const parsed = await convertImapMessage(msg);
        if (parsed) messages.push(parsed);
      }
    } catch {
      // Skip messages that fail to fetch
    }
  }

  return messages;
}

/**
 * Download the full body of a message by sequence number.
 */
async function downloadMessageBody(
  client: ImapFlow,
  seq: number,
): Promise<{ textHtml?: string; textPlain?: string; references?: string }> {
  try {
    const downloaded = await client.download(String(seq));
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    const parsed = await simpleParser(raw);

    let references: string | undefined;
    if (parsed.references) {
      references = Array.isArray(parsed.references)
        ? parsed.references.join(" ")
        : parsed.references;
    }

    return {
      textHtml: parsed.html || undefined,
      textPlain: parsed.text || undefined,
      references,
    };
  } catch {
    return {};
  }
}

/**
 * Legacy message ids (and messages without a Message-ID header) are raw INBOX UIDs.
 * Current ids are bare RFC822 Message-IDs, which always contain non-digits.
 */
export function isLegacyUidMessageId(messageId: string): boolean {
  return /^\d+$/.test(messageId);
}

/**
 * Resolve a message id (bare RFC822 Message-ID or legacy numeric UID) to a UID
 * in the currently selected mailbox. Returns null if the message isn't there.
 */
export async function findUidInSelectedMailbox(
  client: ImapFlow,
  messageId: string,
): Promise<number | null> {
  if (isLegacyUidMessageId(messageId)) return Number(messageId);
  const uid = await searchUidByMessageIdHeader(client, messageId);
  if (uid) return uid;
  const scanned = await scanSelectedMailboxForMessageIds(client, [messageId]);
  return scanned.get(messageId) ?? null;
}

export interface ImapMessageLocation {
  folder: string;
  uid: number;
}

/**
 * Locate messages by id across mailboxes. Message-IDs are stable when a
 * message moves between folders (UIDs are not), so we search INBOX first and
 * continue through the remaining folders until every id is found.
 */
export async function locateMessages(
  client: ImapFlow,
  messageIds: string[],
): Promise<Map<string, ImapMessageLocation>> {
  const locations = new Map<string, ImapMessageLocation>();
  let unresolved: string[] = [];

  for (const id of messageIds) {
    if (isLegacyUidMessageId(id)) {
      // Legacy UIDs were only ever captured in INBOX
      locations.set(id, { folder: "INBOX", uid: Number(id) });
    } else {
      unresolved.push(id);
    }
  }

  if (unresolved.length === 0) return locations;

  for (const folder of await listSearchableFolders(client)) {
    try {
      await client.mailboxOpen(folder, { readOnly: true });
    } catch {
      continue;
    }

    let stillUnresolved: string[] = [];
    for (const id of unresolved) {
      const uid = await searchUidByMessageIdHeader(client, id);
      if (uid) {
        locations.set(id, { folder, uid });
      } else {
        stillUnresolved.push(id);
      }
    }

    if (stillUnresolved.length > 0) {
      const scanned = await scanSelectedMailboxForMessageIds(
        client,
        stillUnresolved,
      );
      for (const [id, uid] of scanned) {
        locations.set(id, { folder, uid });
      }
      stillUnresolved = stillUnresolved.filter((id) => !scanned.has(id));
    }

    unresolved = stillUnresolved;
    if (unresolved.length === 0) break;
  }

  return locations;
}

// Bounds the per-folder envelope scan when collecting a thread; messages
// older than this per folder won't be found.
const THREAD_SCAN_LIMIT = 500;

/**
 * Collect a thread's messages across all folders. Thread ids are one-way
 * hashes of the root Message-ID, so they can't be searched server-side; scan
 * recent envelopes per folder and match against every thread id variant a
 * message may be stored under (see getThreadIdCandidates). Bodies are
 * downloaded for matches only.
 */
export async function fetchThreadMessagesAcrossFolders(
  client: ImapFlow,
  threadId: string,
): Promise<ParsedMessage[]> {
  const byId = new Map<string, ParsedMessage>();

  for (const folder of await listSearchableFolders(client)) {
    try {
      await client.mailboxOpen(folder, { readOnly: true });
    } catch {
      continue;
    }

    const exists =
      typeof client.mailbox === "object" ? client.mailbox.exists : 0;
    if (!exists) continue;

    const start = Math.max(1, exists - THREAD_SCAN_LIMIT + 1);
    const matches: {
      seq: number;
      msg: FetchMessageObject;
      references?: string;
    }[] = [];
    for await (const msg of client.fetch(`${start}:*`, {
      uid: true,
      envelope: true,
      flags: true,
      headers: ["references"],
    })) {
      const references = extractReferencesHeader(msg.headers);
      const inReplyTo = msg.envelope?.inReplyTo || undefined;
      const envMessageId = msg.envelope?.messageId || undefined;
      const candidates = getThreadIdCandidates(
        references,
        inReplyTo,
        envMessageId,
      );
      if (candidates.has(threadId)) {
        matches.push({ seq: msg.seq, msg, references });
      }
    }

    for (const { seq, msg, references } of matches) {
      const body = await downloadMessageBody(client, seq);
      const parsed = await convertImapMessage(msg, {
        ...body,
        references: body.references ?? references,
      });
      if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, parsed);
    }
  }

  return [...byId.values()].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
}

async function searchUidByMessageIdHeader(
  client: ImapFlow,
  messageId: string,
): Promise<number | null> {
  const uids = await client.search(
    { header: { "Message-ID": messageId } },
    { uid: true },
  );
  if (!uids || uids.length === 0) return null;
  return uids[0];
}

// Bounds the fallback scan so huge folders don't make lookups unbounded;
// anything older than this many messages per folder won't be found by scan.
const MESSAGE_ID_SCAN_LIMIT = 2000;

/**
 * Some servers (e.g. Stalwart) don't index Message-ID for SEARCH HEADER and
 * return no matches even for messages present in the mailbox. Fall back to
 * scanning envelopes of the selected mailbox (newest MESSAGE_ID_SCAN_LIMIT
 * messages) and matching Message-IDs client-side.
 */
async function scanSelectedMailboxForMessageIds(
  client: ImapFlow,
  messageIds: string[],
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const exists = typeof client.mailbox === "object" ? client.mailbox.exists : 0;
  if (!exists) return found;

  const wanted = new Set(messageIds);
  const start = Math.max(1, exists - MESSAGE_ID_SCAN_LIMIT + 1);
  for await (const msg of client.fetch(`${start}:*`, {
    uid: true,
    envelope: true,
  })) {
    const id = msg.envelope?.messageId?.replace(/^<|>$/g, "").trim();
    if (id && wanted.has(id) && !found.has(id)) {
      found.set(id, msg.uid);
    }
  }
  return found;
}

/**
 * Search messages in the currently selected mailbox.
 */
export async function searchImapMessages(
  client: ImapFlow,
  criteria: Record<string, unknown>,
  maxResults?: number,
): Promise<number[]> {
  const uids = await client.search(criteria, { uid: true });
  if (!uids) return [];

  // UIDs are returned in ascending order; reverse for newest-first
  uids.reverse();

  if (maxResults && uids.length > maxResults) {
    return uids.slice(0, maxResults);
  }

  return uids;
}

/**
 * Convert an imapflow FetchMessageObject to our ParsedMessage format.
 */
export async function convertImapMessage(
  msg: FetchMessageObject,
  body?: { textHtml?: string; textPlain?: string; references?: string },
): Promise<ParsedMessage | null> {
  try {
    const envelope = msg.envelope;
    if (!envelope) return null;

    const textHtml = body?.textHtml;
    const textPlain = body?.textPlain;
    const references = body?.references;

    const fromAddr = envelope.from?.[0];
    const fromStr = fromAddr
      ? formatAddress(fromAddr.name, fromAddr.address)
      : "";

    const toAddrs = envelope.to || [];
    const toStr = toAddrs
      .map((a) => formatAddress(a.name, a.address))
      .join(", ");

    const ccAddrs = envelope.cc || [];
    const ccStr = ccAddrs
      .map((a) => formatAddress(a.name, a.address))
      .join(", ");

    const bccAddrs = envelope.bcc || [];
    const bccStr = bccAddrs
      .map((a) => formatAddress(a.name, a.address))
      .join(", ");

    const messageId = envelope.messageId || undefined;
    const inReplyTo = envelope.inReplyTo || undefined;

    const date = envelope.date
      ? new Date(envelope.date).toISOString()
      : new Date().toISOString();

    const threadId = buildThreadId(references, inReplyTo, messageId);

    const flags = msg.flags ? [...msg.flags] : [];
    const labelIds = flags;

    const headers: ParsedMessageHeaders = {
      from: fromStr,
      to: toStr,
      subject: envelope.subject || "(no subject)",
      date,
      ...(ccStr && { cc: ccStr }),
      ...(bccStr && { bcc: bccStr }),
      ...(messageId && { "message-id": messageId }),
      ...(inReplyTo && { "in-reply-to": inReplyTo }),
      ...(references && { references }),
    };

    const snippet = textPlain
      ? textPlain.slice(0, 200).replace(/\n/g, " ")
      : envelope.subject || "";

    // The Message-ID header survives folder moves; the UID does not. Fall back
    // to the UID for messages without one (or with a comma, which would break
    // the comma-separated ids query param).
    const bareMessageId = messageId?.replace(/^<|>$/g, "").trim();
    const id =
      bareMessageId && !bareMessageId.includes(",")
        ? bareMessageId
        : String(msg.uid);

    return {
      id,
      threadId,
      historyId: String(msg.uid),
      date,
      headers,
      subject: envelope.subject || "(no subject)",
      snippet,
      textHtml,
      textPlain,
      labelIds,
      inline: [],
      ...(inReplyTo && { internalDate: date }),
    };
  } catch {
    return null;
  }
}

function extractReferencesHeader(headers?: Buffer): string | undefined {
  if (!headers) return;
  const unfolded = headers.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  return unfolded.match(/^references:[ \t]*(.+)$/im)?.[1]?.trim() || undefined;
}

function formatAddress(
  name: string | undefined,
  address: string | undefined,
): string {
  if (!address) return name || "";
  if (name) return `${name} <${address}>`;
  return address;
}

/**
 * Build an IMAP SEARCH criteria object from a simple query string.
 */
export function parseSearchQuery(query: string): Record<string, unknown> {
  const criteria: Record<string, unknown>[] = [];

  const parts = query.match(/(\w+:[^\s]+|"[^"]*"|\S+)/g) || [];

  for (const part of parts) {
    if (part.startsWith("from:")) {
      criteria.push({ from: part.slice(5) });
    } else if (part.startsWith("to:")) {
      criteria.push({ to: part.slice(3) });
    } else if (part.startsWith("subject:")) {
      criteria.push({ subject: part.slice(8) });
    } else if (part === "is:unread") {
      criteria.push({ unseen: true });
    } else if (part === "is:read") {
      criteria.push({ seen: true });
    } else if (part.startsWith("since:") || part.startsWith("after:")) {
      const dateStr = part.includes(":") ? part.split(":")[1] : "";
      criteria.push({ since: new Date(dateStr) });
    } else if (part.startsWith("before:")) {
      criteria.push({ before: new Date(part.slice(7)) });
    } else if (part === "has:attachment") {
      criteria.push({ header: { "Content-Type": "multipart/mixed" } });
    } else {
      criteria.push({ body: part });
    }
  }

  if (criteria.length === 0) return { all: true };
  if (criteria.length === 1) return criteria[0];
  return { and: criteria };
}

function messageMatchesFilters(
  message: ParsedMessage,
  filters: {
    before?: Date;
    after?: Date;
    unreadOnly?: boolean;
    fromEmail?: string;
  },
): boolean {
  const date = new Date(message.date);
  if (filters.after && date < filters.after) return false;
  if (filters.before && date >= filters.before) return false;
  if (filters.unreadOnly && message.labelIds?.includes("\\Seen")) return false;
  if (
    filters.fromEmail &&
    !message.headers.from
      .toLowerCase()
      .includes(filters.fromEmail.toLowerCase())
  ) {
    return false;
  }
  return true;
}
