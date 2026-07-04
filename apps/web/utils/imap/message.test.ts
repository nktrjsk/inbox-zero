import { describe, expect, it, vi } from "vitest";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import {
  convertImapMessage,
  fetchMessagesByUids,
  fetchThreadMessagesAcrossFolders,
  findUidInSelectedMailbox,
  isLegacyUidMessageId,
  listMessagesWithFilters,
  locateMessages,
  parseSearchQuery,
  parseStructuredImapQuery,
} from "@/utils/imap/message";
import { buildThreadId } from "@/utils/imap/thread";

function createFetchMessage(overrides: {
  uid?: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}): FetchMessageObject {
  return {
    uid: overrides.uid ?? 7,
    flags: new Set<string>(),
    envelope: {
      from: [{ name: "Alice", address: "alice@example.com" }],
      to: [{ name: "Bob", address: "bob@example.com" }],
      subject: "Hello",
      date: new Date("2026-01-01T00:00:00Z"),
      messageId: overrides.messageId,
      inReplyTo: overrides.inReplyTo,
    },
    ...(overrides.references && {
      headers: Buffer.from(`References: ${overrides.references}\r\n`),
    }),
  } as unknown as FetchMessageObject;
}

describe("convertImapMessage", () => {
  it("uses the bare RFC822 Message-ID as the message id", async () => {
    const parsed = await convertImapMessage(
      createFetchMessage({ messageId: "<abc-123@mail.example.com>" }),
    );
    expect(parsed?.id).toBe("abc-123@mail.example.com");
  });

  it("falls back to the UID when there is no Message-ID header", async () => {
    const parsed = await convertImapMessage(
      createFetchMessage({ uid: 42, messageId: undefined }),
    );
    expect(parsed?.id).toBe("42");
  });

  it("falls back to the UID when the Message-ID contains a comma", async () => {
    const parsed = await convertImapMessage(
      createFetchMessage({ uid: 42, messageId: "<a,b@example.com>" }),
    );
    expect(parsed?.id).toBe("42");
  });

  it("sets internalDate to the envelope date for a standalone message with no In-Reply-To", async () => {
    const parsed = await convertImapMessage(
      createFetchMessage({ messageId: "<root@example.com>" }),
    );
    expect(parsed?.internalDate).toBe("2026-01-01T00:00:00.000Z");
  });

  it("sets internalDate to the envelope date for a reply with an In-Reply-To header", async () => {
    const parsed = await convertImapMessage(
      createFetchMessage({
        messageId: "<reply@example.com>",
        inReplyTo: "<root@example.com>",
      }),
    );
    expect(parsed?.internalDate).toBe("2026-01-01T00:00:00.000Z");
  });

  it("derives the threadId from a References header carried in msg.headers when no body was fetched", async () => {
    const parsed = await convertImapMessage(
      createFetchMessage({
        messageId: "<c@x.com>",
        references: "<root@x.com> <b@x.com>",
      }),
    );
    expect(parsed?.threadId).toBe(
      buildThreadId("<root@x.com> <b@x.com>", undefined, undefined),
    );
  });

  it("groups a root message and a header-only reply into the same thread", async () => {
    const root = await convertImapMessage(
      createFetchMessage({ messageId: "<root@x.com>" }),
    );
    const reply = await convertImapMessage(
      createFetchMessage({
        messageId: "<reply@x.com>",
        references: "<root@x.com>",
      }),
    );
    expect(root?.threadId).toBe(reply?.threadId);
  });
});

describe("isLegacyUidMessageId", () => {
  it("treats numeric ids as legacy UIDs", () => {
    expect(isLegacyUidMessageId("3117")).toBe(true);
  });

  it("treats RFC822 Message-IDs as non-legacy", () => {
    expect(isLegacyUidMessageId("abc-123@mail.example.com")).toBe(false);
  });
});

type FakeFolderMessage = {
  uid: number;
  messageId?: string;
  date?: string;
  from?: string;
  to?: string;
  subject?: string;
  seen?: boolean;
  inReplyTo?: string;
  references?: string;
};

function createFakeClient(options: {
  // header-search results keyed by Message-ID; missing key = no hits
  headerSearchUids?: Record<string, number[]>;
  // messages visible to an envelope scan, per folder (INBOX for single-folder tests)
  folderMessages?: Record<string, FakeFolderMessage[]>;
}) {
  const folderMessages = options.folderMessages ?? {};
  let selectedFolder = "INBOX";

  const mailboxState = (folder: string) => {
    const msgs = folderMessages[folder] ?? [];
    const maxUid = msgs.reduce((max, m) => Math.max(max, m.uid), 0);
    return { exists: msgs.length, uidNext: maxUid + 1 };
  };

  const client = {
    mailbox: mailboxState(selectedFolder),
    mailboxOpen: vi.fn(async (folder: string) => {
      selectedFolder = folder;
      client.mailbox = mailboxState(folder);
    }),
    search: vi.fn(async (criteria: { header?: Record<string, string> }) => {
      const messageId = criteria.header?.["Message-ID"];
      return (messageId && options.headerSearchUids?.[messageId]) || [];
    }),
    fetch: vi.fn(async function* () {
      let seq = 0;
      for (const msg of folderMessages[selectedFolder] ?? []) {
        seq += 1;
        yield {
          seq,
          uid: msg.uid,
          flags: new Set(msg.seen ? ["\\Seen"] : []),
          envelope: {
            messageId: msg.messageId,
            date: msg.date ? new Date(msg.date) : undefined,
            from: msg.from ? [{ address: msg.from }] : undefined,
            to: msg.to ? [{ address: msg.to }] : undefined,
            subject: msg.subject ?? "Test",
            inReplyTo: msg.inReplyTo,
          },
          headers: msg.references
            ? Buffer.from(`References: ${msg.references}\r\n`)
            : undefined,
        };
      }
    }),
    list: vi.fn(async () =>
      Object.keys(folderMessages).map((path) => ({
        path,
        flags: new Set<string>(),
        specialUse: undefined,
      })),
    ),
  };

  return client as unknown as ImapFlow & typeof client;
}

describe("findUidInSelectedMailbox", () => {
  it("returns the header-search hit without scanning envelopes", async () => {
    const client = createFakeClient({
      headerSearchUids: { "abc@example.com": [42] },
    });

    await expect(
      findUidInSelectedMailbox(client, "abc@example.com"),
    ).resolves.toBe(42);
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("falls back to an envelope scan when header search finds nothing", async () => {
    // Stalwart returns no hits for SEARCH HEADER Message-ID even when the
    // message is in the mailbox
    const client = createFakeClient({
      folderMessages: {
        INBOX: [
          { uid: 1, messageId: "<other@example.com>" },
          { uid: 2, messageId: "<abc@example.com>" },
        ],
      },
    });

    await expect(
      findUidInSelectedMailbox(client, "abc@example.com"),
    ).resolves.toBe(2);
  });

  it("returns null when the message is not found by search or scan", async () => {
    const client = createFakeClient({
      folderMessages: {
        INBOX: [{ uid: 1, messageId: "<other@example.com>" }],
      },
    });

    await expect(
      findUidInSelectedMailbox(client, "missing@example.com"),
    ).resolves.toBeNull();
  });

  it("resolves legacy numeric ids without talking to the server", async () => {
    const client = createFakeClient({});

    await expect(findUidInSelectedMailbox(client, "3117")).resolves.toBe(3117);
    expect(client.search).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
  });
});

describe("locateMessages", () => {
  it("resolves messages via the scan fallback across folders", async () => {
    const client = createFakeClient({
      folderMessages: {
        INBOX: [{ uid: 5, messageId: "<in-inbox@example.com>" }],
        GitHub: [{ uid: 9, messageId: "<in-github@example.com>" }],
      },
    });

    const locations = await locateMessages(client, [
      "in-inbox@example.com",
      "in-github@example.com",
      "missing@example.com",
    ]);

    expect(locations.get("in-inbox@example.com")).toEqual({
      folder: "INBOX",
      uid: 5,
    });
    expect(locations.get("in-github@example.com")).toEqual({
      folder: "GitHub",
      uid: 9,
    });
    expect(locations.has("missing@example.com")).toBe(false);
  });

  it("scans each folder once for all unresolved ids", async () => {
    const client = createFakeClient({
      folderMessages: {
        INBOX: [
          { uid: 1, messageId: "<a@example.com>" },
          { uid: 2, messageId: "<b@example.com>" },
        ],
      },
    });

    const locations = await locateMessages(client, [
      "a@example.com",
      "b@example.com",
    ]);

    expect(locations.size).toBe(2);
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchThreadMessagesAcrossFolders", () => {
  const rootThreadId = buildThreadId(
    undefined,
    undefined,
    "<root@example.com>",
  );

  it("collects thread messages spread across folders, oldest first", async () => {
    const client = createFakeClient({
      folderMessages: {
        INBOX: [
          {
            uid: 10,
            messageId: "<reply@example.com>",
            inReplyTo: "<root@example.com>",
            references: "<root@example.com>",
            date: "2026-06-02T10:00:00Z",
          },
          {
            uid: 11,
            messageId: "<unrelated@example.com>",
            date: "2026-06-03T10:00:00Z",
          },
        ],
        Receipt: [
          {
            uid: 3,
            messageId: "<root@example.com>",
            date: "2026-06-01T10:00:00Z",
          },
        ],
      },
    });

    const messages = await fetchThreadMessagesAcrossFolders(
      client,
      rootThreadId,
    );

    expect(messages.map((m) => m.id)).toEqual([
      "root@example.com",
      "reply@example.com",
    ]);
  });

  it("matches deeper replies via the References header", async () => {
    // In-Reply-To points at the parent, not the root; only References
    // identifies the thread
    const client = createFakeClient({
      folderMessages: {
        INBOX: [
          {
            uid: 20,
            messageId: "<third@example.com>",
            inReplyTo: "<reply@example.com>",
            references: "<root@example.com> <reply@example.com>",
            date: "2026-06-03T10:00:00Z",
          },
        ],
      },
    });

    const messages = await fetchThreadMessagesAcrossFolders(
      client,
      rootThreadId,
    );

    expect(messages.map((m) => m.id)).toEqual(["third@example.com"]);
  });

  it("matches the envelope-only thread id variant for deeper replies", async () => {
    // Thread ids stored without body/References access hash the In-Reply-To
    // parent instead of the root
    const envelopeOnlyThreadId = buildThreadId(
      undefined,
      "<reply@example.com>",
      "<third@example.com>",
    );
    const client = createFakeClient({
      folderMessages: {
        INBOX: [
          {
            uid: 20,
            messageId: "<third@example.com>",
            inReplyTo: "<reply@example.com>",
            references: "<root@example.com> <reply@example.com>",
            date: "2026-06-03T10:00:00Z",
          },
        ],
      },
    });

    const messages = await fetchThreadMessagesAcrossFolders(
      client,
      envelopeOnlyThreadId,
    );

    expect(messages.map((m) => m.id)).toEqual(["third@example.com"]);
  });

  it("dedupes copies of the same message across folders", async () => {
    const copy = {
      messageId: "<root@example.com>",
      date: "2026-06-01T10:00:00Z",
    };
    const client = createFakeClient({
      folderMessages: {
        INBOX: [{ uid: 1, ...copy }],
        Sent: [{ uid: 2, ...copy }],
      },
    });

    const messages = await fetchThreadMessagesAcrossFolders(
      client,
      rootThreadId,
    );

    expect(messages).toHaveLength(1);
  });
});

describe("listMessagesWithFilters", () => {
  const inbox: FakeFolderMessage[] = [
    // oldest-first, as IMAP sequence order
    {
      uid: 1,
      messageId: "<old@example.com>",
      date: "2026-06-01T10:00:00Z",
      from: "alice@example.com",
      seen: true,
    },
    {
      uid: 2,
      messageId: "<mid@example.com>",
      date: "2026-06-20T10:00:00Z",
      from: "bob@example.com",
      seen: true,
    },
    {
      uid: 3,
      messageId: "<new-read@example.com>",
      date: "2026-06-28T10:00:00Z",
      from: "alice@example.com",
      seen: true,
    },
    {
      uid: 4,
      messageId: "<new-unread@example.com>",
      date: "2026-06-29T10:00:00Z",
      from: "bob@example.com",
      seen: false,
    },
  ];

  it("returns only messages within the date range", async () => {
    const client = createFakeClient({ folderMessages: { INBOX: inbox } });

    const { messages } = await listMessagesWithFilters(client, {
      maxResults: 20,
      after: new Date("2026-06-25T00:00:00Z"),
      before: new Date("2026-06-29T00:00:00Z"),
    });

    expect(messages.map((m) => m.id)).toEqual(["new-read@example.com"]);
  });

  it("excludes read messages when unreadOnly is set", async () => {
    const client = createFakeClient({ folderMessages: { INBOX: inbox } });

    const { messages } = await listMessagesWithFilters(client, {
      maxResults: 20,
      unreadOnly: true,
    });

    expect(messages.map((m) => m.id)).toEqual(["new-unread@example.com"]);
  });

  it("filters by sender email", async () => {
    const client = createFakeClient({ folderMessages: { INBOX: inbox } });

    const { messages } = await listMessagesWithFilters(client, {
      maxResults: 20,
      fromEmail: "alice@example.com",
    });

    expect(messages.map((m) => m.id)).toEqual([
      "new-read@example.com",
      "old@example.com",
    ]);
  });

  it("returns newest first and paginates the filtered results", async () => {
    const client = createFakeClient({ folderMessages: { INBOX: inbox } });

    const page1 = await listMessagesWithFilters(client, {
      maxResults: 2,
      after: new Date("2026-05-01T00:00:00Z"),
    });
    expect(page1.messages.map((m) => m.id)).toEqual([
      "new-unread@example.com",
      "new-read@example.com",
    ]);
    expect(page1.nextPageToken).toBe("3");

    const page2 = await listMessagesWithFilters(client, {
      cursorUid: Number(page1.nextPageToken),
      maxResults: 2,
      after: new Date("2026-05-01T00:00:00Z"),
    });
    expect(page2.messages.map((m) => m.id)).toEqual([
      "mid@example.com",
      "old@example.com",
    ]);
    expect(page2.nextPageToken).toBeUndefined();
  });

  it("does not skip messages when earlier ones are marked read between pages", async () => {
    // Regression test for the bulk-process data-loss bug: the old offset-based
    // cursor sliced by position, so when rules marked page-1 messages read
    // between pages, the unread set shrank and page 2 skipped messages that
    // shifted into the now-vacated earlier positions. A UID watermark cursor
    // is immune to this because it filters by UID, not position.
    const mutableInbox: FakeFolderMessage[] = [
      { uid: 1, messageId: "<old@example.com>", seen: false },
      { uid: 2, messageId: "<mid@example.com>", seen: false },
      { uid: 3, messageId: "<new-read@example.com>", seen: false },
      { uid: 4, messageId: "<new-unread@example.com>", seen: false },
    ];
    const client = createFakeClient({
      folderMessages: { INBOX: mutableInbox },
    });

    const page1 = await listMessagesWithFilters(client, {
      maxResults: 2,
      unreadOnly: true,
    });
    expect(page1.messages.map((m) => m.id)).toEqual([
      "new-unread@example.com",
      "new-read@example.com",
    ]);
    expect(page1.nextPageToken).toBe("3");

    // Simulate rules marking the page-1 messages read between pages
    mutableInbox[2].seen = true;
    mutableInbox[3].seen = true;

    const page2 = await listMessagesWithFilters(client, {
      cursorUid: Number(page1.nextPageToken),
      maxResults: 2,
      unreadOnly: true,
    });
    // The old offset code returned [] here — a silent skip of these messages.
    expect(page2.messages.map((m) => m.id)).toEqual([
      "mid@example.com",
      "old@example.com",
    ]);
  });

  it("filters by subject", async () => {
    const client = createFakeClient({
      folderMessages: {
        INBOX: [
          { uid: 1, messageId: "<a@example.com>", subject: "Invoice #1" },
          { uid: 2, messageId: "<b@example.com>", subject: "Meeting notes" },
        ],
      },
    });

    const { messages } = await listMessagesWithFilters(client, {
      maxResults: 20,
      subject: "invoice",
    });

    expect(messages.map((m) => m.id)).toEqual(["a@example.com"]);
  });

  it("filters by recipient", async () => {
    const client = createFakeClient({
      folderMessages: {
        INBOX: [
          { uid: 1, messageId: "<a@example.com>", to: "alice@example.com" },
          { uid: 2, messageId: "<b@example.com>", to: "bob@example.com" },
        ],
      },
    });

    const { messages } = await listMessagesWithFilters(client, {
      maxResults: 20,
      to: "alice@example.com",
    });

    expect(messages.map((m) => m.id)).toEqual(["a@example.com"]);
  });

  it("keeps only seen messages when seenOnly is set", async () => {
    const client = createFakeClient({ folderMessages: { INBOX: inbox } });

    const { messages } = await listMessagesWithFilters(client, {
      maxResults: 20,
      seenOnly: true,
    });

    expect(messages.map((m) => m.id)).toEqual([
      "new-read@example.com",
      "mid@example.com",
      "old@example.com",
    ]);
  });

  it("paginates a large mailbox across windows without skipping or duplicating", async () => {
    // 20 messages, page size 2 => scan window of 8 UIDs per page, so a full
    // walk spans several windows. Every message must appear exactly once, in
    // newest-first order, with no gaps at window boundaries.
    const many: FakeFolderMessage[] = Array.from({ length: 20 }, (_, i) => ({
      uid: i + 1,
      messageId: `<m${i + 1}@example.com>`,
      date: "2026-06-01T10:00:00Z",
      seen: false,
    }));
    const client = createFakeClient({ folderMessages: { INBOX: many } });

    const collected: string[] = [];
    let cursorUid: number | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const { messages, nextPageToken } = await listMessagesWithFilters(
        client,
        {
          maxResults: 2,
          cursorUid,
          unreadOnly: true,
        },
      );
      collected.push(...messages.map((m) => m.id));
      if (!nextPageToken) break;
      cursorUid = Number(nextPageToken);
    }

    const expected = Array.from(
      { length: 20 },
      (_, i) => `m${20 - i}@example.com`,
    );
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(20);
  });

  it("returns a short page and advances past a sparsely-matching window", async () => {
    // Only the newest and oldest messages match; the middle window matches
    // nothing. The scan must still advance the cursor past each window so the
    // oldest match is eventually reached.
    const many: FakeFolderMessage[] = Array.from({ length: 20 }, (_, i) => ({
      uid: i + 1,
      messageId: `<m${i + 1}@example.com>`,
      from: i === 0 || i === 19 ? "match@example.com" : "other@example.com",
    }));
    const client = createFakeClient({ folderMessages: { INBOX: many } });

    const collected: string[] = [];
    let cursorUid: number | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const { messages, nextPageToken } = await listMessagesWithFilters(
        client,
        {
          maxResults: 2,
          cursorUid,
          fromEmail: "match@example.com",
        },
      );
      collected.push(...messages.map((m) => m.id));
      if (!nextPageToken) break;
      cursorUid = Number(nextPageToken);
    }

    expect(collected).toEqual(["m20@example.com", "m1@example.com"]);
  });
});

describe("parseStructuredImapQuery", () => {
  it("parses from:", () => {
    expect(parseStructuredImapQuery("from:alice@example.com")).toEqual({
      filters: { from: "alice@example.com" },
      fullyStructured: true,
    });
  });

  it("parses to:", () => {
    expect(parseStructuredImapQuery("to:bob@example.com")).toEqual({
      filters: { to: "bob@example.com" },
      fullyStructured: true,
    });
  });

  it("parses subject:", () => {
    expect(parseStructuredImapQuery("subject:invoice")).toEqual({
      filters: { subject: "invoice" },
      fullyStructured: true,
    });
  });

  it("parses a quoted subject: phrase, stripping the quotes", () => {
    expect(parseStructuredImapQuery('subject:"quarterly report"')).toEqual({
      filters: { subject: "quarterly report" },
      fullyStructured: true,
    });
  });

  it("parses is:unread", () => {
    expect(parseStructuredImapQuery("is:unread")).toEqual({
      filters: { unreadOnly: true },
      fullyStructured: true,
    });
  });

  it("parses is:read", () => {
    expect(parseStructuredImapQuery("is:read")).toEqual({
      filters: { seenOnly: true },
      fullyStructured: true,
    });
  });

  it("parses since:", () => {
    expect(parseStructuredImapQuery("since:2026-06-01")).toEqual({
      filters: { after: new Date("2026-06-01") },
      fullyStructured: true,
    });
  });

  it("parses before:", () => {
    expect(parseStructuredImapQuery("before:2026-06-30")).toEqual({
      filters: { before: new Date("2026-06-30") },
      fullyStructured: true,
    });
  });

  it("combines multiple structured filters", () => {
    expect(
      parseStructuredImapQuery("from:alice@example.com is:unread"),
    ).toEqual({
      filters: { from: "alice@example.com", unreadOnly: true },
      fullyStructured: true,
    });
  });

  it("treats has:attachment as a recognized no-op that stays structured", () => {
    expect(
      parseStructuredImapQuery("from:alice@example.com has:attachment"),
    ).toEqual({
      filters: { from: "alice@example.com" },
      fullyStructured: true,
    });
  });

  it("is not fully structured when has:attachment is the only token", () => {
    expect(parseStructuredImapQuery("has:attachment")).toEqual({
      filters: {},
      fullyStructured: false,
    });
  });

  it("is not fully structured when a bare word is present", () => {
    expect(parseStructuredImapQuery("invoice")).toEqual({
      filters: {},
      fullyStructured: false,
    });
  });

  it("is not fully structured when mixed with a bare word", () => {
    expect(parseStructuredImapQuery("from:alice@example.com invoice")).toEqual({
      filters: { from: "alice@example.com" },
      fullyStructured: false,
    });
  });

  it("is not fully structured for unsupported operators like label:", () => {
    expect(parseStructuredImapQuery("label:work")).toEqual({
      filters: {},
      fullyStructured: false,
    });
  });

  it("is not fully structured for an empty query", () => {
    expect(parseStructuredImapQuery("")).toEqual({
      filters: {},
      fullyStructured: false,
    });
  });

  it("is not fully structured for a whitespace-only query", () => {
    expect(parseStructuredImapQuery("   ")).toEqual({
      filters: {},
      fullyStructured: false,
    });
  });

  it("is not fully structured when since: has an invalid date", () => {
    expect(parseStructuredImapQuery("since:not-a-date")).toEqual({
      filters: {},
      fullyStructured: false,
    });
  });
});

describe("parseSearchQuery", () => {
  it("parses from: query", () => {
    const result = parseSearchQuery("from:test@example.com");
    expect(result).toEqual({ from: "test@example.com" });
  });

  it("parses to: query", () => {
    const result = parseSearchQuery("to:user@example.com");
    expect(result).toEqual({ to: "user@example.com" });
  });

  it("parses subject: query", () => {
    const result = parseSearchQuery("subject:meeting");
    expect(result).toEqual({ subject: "meeting" });
  });

  it("parses is:unread", () => {
    const result = parseSearchQuery("is:unread");
    expect(result).toEqual({ unseen: true });
  });

  it("parses is:read", () => {
    const result = parseSearchQuery("is:read");
    expect(result).toEqual({ seen: true });
  });

  it("parses combined queries", () => {
    const result = parseSearchQuery("from:test@ex.com is:unread");
    expect(result).toEqual({
      and: [{ from: "test@ex.com" }, { unseen: true }],
    });
  });

  it("returns all:true for empty query", () => {
    const result = parseSearchQuery("");
    expect(result).toEqual({ all: true });
  });

  it("treats bare text as body search", () => {
    const result = parseSearchQuery("important");
    expect(result).toEqual({ body: "important" });
  });
});

describe("fetchMessagesByUids", () => {
  // uid -> seq store; search resolves a UID set to seq numbers in one call,
  // fetch yields the messages for a seq set in one call.
  function createFakeClient(store: { uid: number; messageId: string }[]) {
    const bySeq = new Map<number, { uid: number; messageId: string }>();
    const seqByUid = new Map<number, number>();
    store.forEach((msg, index) => {
      const seq = index + 1;
      bySeq.set(seq, msg);
      seqByUid.set(msg.uid, seq);
    });

    const search = vi.fn(async (criteria: { uid?: string }) => {
      const requested = (criteria.uid ?? "").split(",").map(Number);
      return requested
        .map((uid) => seqByUid.get(uid))
        .filter((seq): seq is number => seq !== undefined);
    });

    const fetch = vi.fn(async function* (range: string) {
      for (const seqStr of range.split(",")) {
        const msg = bySeq.get(Number(seqStr));
        if (!msg) continue;
        yield {
          seq: Number(seqStr),
          uid: msg.uid,
          flags: new Set<string>(),
          envelope: { messageId: msg.messageId, subject: "Test" },
        };
      }
    });

    const client = { search, fetch };
    return { client: client as unknown as ImapFlow, search, fetch };
  }

  it("returns empty without hitting the server for no UIDs", async () => {
    const { client, search, fetch } = createFakeClient([]);
    expect(await fetchMessagesByUids(client, [])).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves and fetches all UIDs in a single round trip each", async () => {
    const { client, search, fetch } = createFakeClient([
      { uid: 10, messageId: "<a@ex.com>" },
      { uid: 20, messageId: "<b@ex.com>" },
      { uid: 30, messageId: "<c@ex.com>" },
    ]);

    const result = await fetchMessagesByUids(client, [10, 20, 30]);

    expect(result.map((m) => m.id)).toEqual([
      "a@ex.com",
      "b@ex.com",
      "c@ex.com",
    ]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the requested UID order and drops missing UIDs", async () => {
    const { client } = createFakeClient([
      { uid: 10, messageId: "<a@ex.com>" },
      { uid: 20, messageId: "<b@ex.com>" },
    ]);

    // Request in a different order, with a UID that isn't in the mailbox.
    const result = await fetchMessagesByUids(client, [20, 99, 10]);

    expect(result.map((m) => m.id)).toEqual(["b@ex.com", "a@ex.com"]);
  });
});
