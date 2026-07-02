import { describe, expect, it, vi } from "vitest";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import {
  convertImapMessage,
  findUidInSelectedMailbox,
  isLegacyUidMessageId,
  locateMessages,
  parseSearchQuery,
} from "@/utils/imap/message";

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

function createFakeClient(options: {
  // header-search results keyed by Message-ID; missing key = no hits
  headerSearchUids?: Record<string, number[]>;
  // messages visible to an envelope scan, per folder (INBOX for single-folder tests)
  folderMessages?: Record<string, { uid: number; messageId?: string }[]>;
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
      for (const msg of folderMessages[selectedFolder] ?? []) {
        yield {
          uid: msg.uid,
          envelope: { messageId: msg.messageId },
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
