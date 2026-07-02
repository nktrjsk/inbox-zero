import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";
import { ImapProvider } from "@/utils/email/imap";
import type { ImapCredentialConfig } from "@/utils/imap/types";

const { withImapConnectionMock } = vi.hoisted(() => ({
  withImapConnectionMock: vi.fn(),
}));

vi.mock("@/utils/imap/client", () => ({
  withImapConnection: withImapConnectionMock,
}));

function createFakeClient() {
  return {
    list: vi.fn().mockResolvedValue([
      { path: "INBOX", name: "INBOX", flags: new Set<string>() },
      { path: "Newsletter", name: "Newsletter", flags: new Set<string>() },
    ]),
    mailboxOpen: vi.fn().mockResolvedValue({ exists: 0 }),
    mailboxCreate: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([42]),
    messageMove: vi.fn().mockResolvedValue(undefined),
  };
}

function createProvider(config?: Partial<ImapCredentialConfig>) {
  return new ImapProvider({
    email: "user@example.com",
    emailAccountId: "account-1",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    username: "user@example.com",
    password: "secret",
    ...config,
  });
}

describe("ImapProvider label actions", () => {
  let fakeClient: ReturnType<typeof createFakeClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeClient = createFakeClient();
    withImapConnectionMock.mockImplementation(
      (_config, fn: (client: ImapFlow) => Promise<unknown>) =>
        fn(fakeClient as unknown as ImapFlow),
    );
  });

  describe("with folder sorting disabled (default)", () => {
    it("labelMessage does not touch the mailbox", async () => {
      const provider = createProvider();

      const result = await provider.labelMessage({
        messageId: "abc@example.com",
        labelId: "Newsletter",
        labelName: "Newsletter",
      });

      expect(result).toEqual({ actualLabelId: "Newsletter" });
      expect(withImapConnectionMock).not.toHaveBeenCalled();
    });

    it("createLabel does not create an IMAP folder", async () => {
      const provider = createProvider();

      const label = await provider.createLabel("Newsletter");

      expect(label).toEqual({
        id: "Newsletter",
        name: "Newsletter",
        type: "user",
      });
      expect(withImapConnectionMock).not.toHaveBeenCalled();
    });
  });

  describe("with folder sorting enabled", () => {
    it("labelMessage moves a message found by Message-ID to the folder", async () => {
      const provider = createProvider({ folderSortingEnabled: true });

      const result = await provider.labelMessage({
        messageId: "abc@example.com",
        labelId: "Newsletter",
        labelName: "Newsletter",
      });

      expect(result).toEqual({ actualLabelId: "Newsletter" });
      expect(fakeClient.search).toHaveBeenCalledWith(
        { header: { "Message-ID": "abc@example.com" } },
        { uid: true },
      );
      expect(fakeClient.messageMove).toHaveBeenCalledWith("42", "Newsletter", {
        uid: true,
      });
    });

    it("labelMessage moves a legacy UID message from INBOX", async () => {
      const provider = createProvider({ folderSortingEnabled: true });

      await provider.labelMessage({
        messageId: "3117",
        labelId: "Newsletter",
        labelName: "Newsletter",
      });

      expect(fakeClient.search).not.toHaveBeenCalled();
      expect(fakeClient.messageMove).toHaveBeenCalledWith(
        "3117",
        "Newsletter",
        {
          uid: true,
        },
      );
    });
  });
});
