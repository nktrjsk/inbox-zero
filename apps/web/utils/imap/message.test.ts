import { describe, expect, it } from "vitest";
import type { FetchMessageObject } from "imapflow";
import {
  convertImapMessage,
  isLegacyUidMessageId,
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
