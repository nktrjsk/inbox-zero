import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { withImapConnection } from "@/utils/imap/client";
import { getImapCredentials } from "@/utils/imap/credential";
import { fetchMessageByUid, searchImapMessages } from "@/utils/imap/message";
import type { ParsedMessage } from "@/utils/types";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { pollAllImapAccounts, pollImapAccount } from "./poll";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/imap/client");
vi.mock("@/utils/imap/credential");
vi.mock("@/utils/imap/message");
vi.mock("@/utils/webhook/process-history-item");
vi.mock("@/utils/webhook/validate-webhook-account");
vi.mock("@/utils/email/provider");

const EMAIL_ACCOUNT_ID = "email-account-1";

const fakeClient = {
  mailboxOpen: vi.fn(),
};

function mockMailbox({ uidNext }: { uidNext: number }) {
  fakeClient.mailboxOpen.mockResolvedValue({ uidNext });
}

function mockStoredUid(lastSeenUid: number | null) {
  prisma.imapCredential.findFirst.mockResolvedValue({
    id: "credential-1",
    lastSeenUid,
  } as never);
}

function makeMessage(uid: number): ParsedMessage {
  return {
    id: `msg-${uid}`,
    threadId: `thread-${uid}`,
    headers: { from: `sender-${uid}@example.com` },
  } as unknown as ParsedMessage;
}

describe("pollImapAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getImapCredentials).mockResolvedValue({
      email: "user@example.com",
      emailAccountId: EMAIL_ACCOUNT_ID,
    } as never);
    vi.mocked(withImapConnection).mockImplementation(async (_config, fn) =>
      fn(fakeClient as never),
    );
    prisma.imapCredential.update.mockResolvedValue({} as never);

    vi.mocked(getWebhookEmailAccount).mockResolvedValue({
      id: EMAIL_ACCOUNT_ID,
    } as never);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          id: EMAIL_ACCOUNT_ID,
          email: "user@example.com",
          rules: [{ id: "rule-1" }],
        },
        hasAutomationRules: true,
        hasAiAccess: true,
      },
    } as never);
    vi.mocked(createEmailProvider).mockResolvedValue({
      name: "imap",
    } as never);
    vi.mocked(processHistoryItem).mockResolvedValue(undefined);
    vi.mocked(fetchMessageByUid).mockImplementation(async (_client, uid) =>
      makeMessage(uid),
    );
  });

  it("initializes lastSeenUid on first poll without running rules", async () => {
    mockMailbox({ uidNext: 100 });
    mockStoredUid(null);

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(prisma.imapCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSeenUid: 99 }),
      }),
    );
    expect(searchImapMessages).not.toHaveBeenCalled();
    expect(processHistoryItem).not.toHaveBeenCalled();
    expect(result).toMatchObject({ newMessages: 0, processedMessages: 0 });
  });

  it("does nothing when there are no new messages", async () => {
    mockMailbox({ uidNext: 50 });
    mockStoredUid(49);

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(searchImapMessages).not.toHaveBeenCalled();
    expect(prisma.imapCredential.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ newMessages: 0, processedMessages: 0 });
  });

  it("ignores stale UIDs returned by the n:* range quirk", async () => {
    // `n:*` matches the highest-UID message even when n exceeds it
    mockMailbox({ uidNext: 14 });
    mockStoredUid(12);
    vi.mocked(searchImapMessages).mockResolvedValue([12]);

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(processHistoryItem).not.toHaveBeenCalled();
    expect(prisma.imapCredential.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ newMessages: 0, processedMessages: 0 });
  });

  it("runs rules on each new message and advances lastSeenUid", async () => {
    mockMailbox({ uidNext: 13 });
    mockStoredUid(10);
    vi.mocked(searchImapMessages).mockResolvedValue([11, 12]);

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(processHistoryItem).toHaveBeenCalledTimes(2);
    expect(processHistoryItem).toHaveBeenCalledWith(
      {
        messageId: "msg-11",
        threadId: "thread-11",
        message: expect.objectContaining({ id: "msg-11" }),
      },
      expect.objectContaining({
        hasAutomationRules: true,
        hasAiAccess: true,
        rules: [{ id: "rule-1" }],
      }),
    );
    expect(prisma.imapCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSeenUid: 12 }),
      }),
    );
    expect(result).toMatchObject({ newMessages: 2, processedMessages: 2 });
  });

  it("caps a large backlog and only advances past fetched messages", async () => {
    mockMailbox({ uidNext: 100 });
    mockStoredUid(10);
    const backlog = Array.from({ length: 40 }, (_, i) => 11 + i);
    vi.mocked(searchImapMessages).mockResolvedValue(backlog);

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(fetchMessageByUid).toHaveBeenCalledTimes(25);
    expect(processHistoryItem).toHaveBeenCalledTimes(25);
    // 25th uid starting at 11 is 35; the rest is picked up next poll
    expect(prisma.imapCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSeenUid: 35 }),
      }),
    );
    expect(result).toMatchObject({ newMessages: 25, processedMessages: 25 });
  });

  it("still advances lastSeenUid when account validation fails", async () => {
    mockMailbox({ uidNext: 13 });
    mockStoredUid(10);
    vi.mocked(searchImapMessages).mockResolvedValue([11, 12]);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: false,
      response: {},
    } as never);

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(processHistoryItem).not.toHaveBeenCalled();
    expect(prisma.imapCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSeenUid: 12 }),
      }),
    );
    expect(result).toMatchObject({ newMessages: 2, processedMessages: 0 });
  });

  it("does not advance lastSeenUid when rule setup throws", async () => {
    mockMailbox({ uidNext: 13 });
    mockStoredUid(10);
    vi.mocked(searchImapMessages).mockResolvedValue([11, 12]);
    vi.mocked(getWebhookEmailAccount).mockRejectedValue(
      new Error("transient DB error"),
    );

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(processHistoryItem).not.toHaveBeenCalled();
    expect(prisma.imapCredential.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSeenUid: 12 }),
      }),
    );
    expect(result).toMatchObject({ newMessages: 0, processedMessages: 0 });
    expect(result.error).toBeDefined();
  });

  it("continues processing when a single message fails", async () => {
    mockMailbox({ uidNext: 13 });
    mockStoredUid(10);
    vi.mocked(searchImapMessages).mockResolvedValue([11, 12]);
    vi.mocked(processHistoryItem)
      .mockRejectedValueOnce(new Error("rule run failed"))
      .mockResolvedValueOnce(undefined);

    const result = await pollImapAccount(EMAIL_ACCOUNT_ID);

    expect(processHistoryItem).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ newMessages: 2, processedMessages: 1 });
  });
});

describe("pollAllImapAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getImapCredentials).mockResolvedValue({
      email: "user@example.com",
      emailAccountId: EMAIL_ACCOUNT_ID,
    } as never);
    vi.mocked(withImapConnection).mockImplementation(async (_config, fn) =>
      fn(fakeClient as never),
    );
    prisma.imapCredential.update.mockResolvedValue({} as never);
    // Every account is on its first poll (no new mail), so each just
    // initializes lastSeenUid and returns a zero-work result.
    mockMailbox({ uidNext: 100 });
    mockStoredUid(null);
  });

  it("returns a result for every active account", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "acct-1" },
      { id: "acct-2" },
      { id: "acct-3" },
    ] as never);

    const results = await pollAllImapAccounts();

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.emailAccountId).sort()).toEqual([
      "acct-1",
      "acct-2",
      "acct-3",
    ]);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it("returns an empty list when there are no active accounts", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([] as never);
    expect(await pollAllImapAccounts()).toEqual([]);
  });
});
