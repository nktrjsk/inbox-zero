import { describe, expect, it, vi } from "vitest";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import {
  convertImapMessage,
  fetchThreadMessagesAcrossFolders,
  findUidInSelectedMailbox,
  isLegacyUidMessageId,
  listMessagesWithFilters,
  locateMessages,
  parseSearchQuery,
} from "@/utils/imap/message";
import { buildThreadId } from "@/utils/imap/thread";

function createFetchMessage(overrides: {
  uid?: number;
  messageId?: string;
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
    },
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

  const client = {
    mailbox: { exists: folderMessages[selectedFolder]?.length ?? 0 },
    mailboxOpen: vi.fn(async (folder: string) => {
      selectedFolder = folder;
      client.mailbox = { exists: folderMessages[folder]?.length ?? 0 };
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
            subject: "Test",
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
      offset: 0,
      maxResults: 20,
      after: new Date("2026-06-25T00:00:00Z"),
      before: new Date("2026-06-29T00:00:00Z"),
    });

    expect(messages.map((m) => m.id)).toEqual(["new-read@example.com"]);
  });

  it("excludes read messages when unreadOnly is set", async () => {
    const client = createFakeClient({ folderMessages: { INBOX: inbox } });

    const { messages } = await listMessagesWithFilters(client, {
      offset: 0,
      maxResults: 20,
      unreadOnly: true,
    });

    expect(messages.map((m) => m.id)).toEqual(["new-unread@example.com"]);
  });

  it("filters by sender email", async () => {
    const client = createFakeClient({ folderMessages: { INBOX: inbox } });

    const { messages } = await listMessagesWithFilters(client, {
      offset: 0,
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
      offset: 0,
      maxResults: 2,
      after: new Date("2026-05-01T00:00:00Z"),
    });
    expect(page1.messages.map((m) => m.id)).toEqual([
      "new-unread@example.com",
      "new-read@example.com",
    ]);
    expect(page1.nextPageToken).toBe("2");

    const page2 = await listMessagesWithFilters(client, {
      offset: Number(page1.nextPageToken),
      maxResults: 2,
      after: new Date("2026-05-01T00:00:00Z"),
    });
    expect(page2.messages.map((m) => m.id)).toEqual([
      "mid@example.com",
      "old@example.com",
    ]);
    expect(page2.nextPageToken).toBeUndefined();
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
