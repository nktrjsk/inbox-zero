import { runWithBoundedConcurrency } from "@/utils/async";
import { createEmailProvider } from "@/utils/email/provider";
import { withImapConnection } from "@/utils/imap/client";
import { getImapCredentials } from "@/utils/imap/credential";
import { fetchMessageByUid, searchImapMessages } from "@/utils/imap/message";
import type { Logger } from "@/utils/logger";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";

const defaultLogger = createScopedLogger("imap/poll");

// Rule runs hit the LLM per message, so cap each poll cycle. lastSeenUid only
// advances past the messages we fetched, so a backlog drains across polls.
const MAX_MESSAGES_PER_POLL = 25;

// Poll several accounts at once, but bounded so a large deployment doesn't open
// a connection per account simultaneously.
const POLL_CONCURRENCY = 5;

interface PollResult {
  emailAccountId: string;
  error?: string;
  newMessages: number;
  processedMessages: number;
}

// lastSeenUid isn't persisted until rules have run for these messages
// without throwing, so highestUid is only set when there's something new
// to advance past.
interface ImapPollFetchResult {
  credentialId: string;
  highestUid?: number;
  messages: ParsedMessage[];
  newMessages: number;
}

/**
 * Poll a single IMAP account for new messages and run automation rules on
 * them, mirroring what the Gmail/Outlook webhooks do for new inbound mail.
 * Compares the current UIDNEXT with the stored lastSeenUid.
 */
export async function pollImapAccount(
  emailAccountId: string,
  logger?: Logger,
): Promise<PollResult> {
  const log = logger || defaultLogger;

  try {
    const credentials = await getImapCredentials(emailAccountId);

    const result = await withImapConnection<ImapPollFetchResult>(
      credentials,
      async (client) => {
        const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });

        // Get the stored last seen UID
        const credential = await prisma.imapCredential.findFirst({
          where: {
            account: { emailAccount: { id: emailAccountId } },
          },
          select: { id: true, lastSeenUid: true },
        });

        if (!credential) {
          throw new Error("IMAP credential not found");
        }

        const lastSeenUid = credential.lastSeenUid || 0;
        const uidNext = (mailbox.uidNext as number) || 0;

        // First poll for this account: start watching from the current
        // state instead of running rules over the entire historic inbox.
        if (!lastSeenUid) {
          await prisma.imapCredential.update({
            where: { id: credential.id },
            data: {
              lastSeenUid: Math.max(uidNext - 1, 0),
              lastPolledAt: new Date(),
            },
          });
          return {
            newMessages: 0,
            messages: [],
            credentialId: credential.id,
          };
        }

        if (uidNext <= lastSeenUid + 1) {
          // No new messages
          return {
            newMessages: 0,
            messages: [],
            credentialId: credential.id,
          };
        }

        // Search for messages with UID > lastSeenUid. An IMAP range `n:*`
        // always matches the highest-UID message even when n exceeds it, so
        // filter out anything at or below lastSeenUid.
        const searchedUids = await searchImapMessages(client, {
          uid: `${lastSeenUid + 1}:*`,
        });
        const newUids = searchedUids.filter((uid) => uid > lastSeenUid);

        if (newUids.length === 0) {
          return {
            newMessages: 0,
            messages: [],
            credentialId: credential.id,
          };
        }

        // Oldest first; leave anything past the cap for the next poll
        const sortedUids = [...newUids].sort((a, b) => a - b);
        const uidsToProcess = sortedUids.slice(0, MAX_MESSAGES_PER_POLL);

        log.info("Found new IMAP messages", {
          emailAccountId,
          count: newUids.length,
          processing: uidsToProcess.length,
        });

        const messages: ParsedMessage[] = [];
        for (const uid of uidsToProcess) {
          const message = await fetchMessageByUid(client, uid);
          if (message) messages.push(message);
        }

        // lastSeenUid is persisted only after rules run successfully (see
        // below), so a transient failure doesn't permanently skip these
        // messages.
        const highestUid = uidsToProcess[uidsToProcess.length - 1];
        return {
          newMessages: uidsToProcess.length,
          messages,
          credentialId: credential.id,
          highestUid,
        };
      },
    );

    const processedMessages = await runRulesOnNewMessages({
      emailAccountId,
      email: credentials.email,
      messages: result.messages,
      log,
    });

    if (result.highestUid !== undefined) {
      await prisma.imapCredential.update({
        where: { id: result.credentialId },
        data: {
          lastSeenUid: result.highestUid,
          lastPolledAt: new Date(),
        },
      });
    }

    return {
      emailAccountId,
      newMessages: result.newMessages,
      processedMessages,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("Error polling IMAP account", {
      emailAccountId,
      error: errorMessage,
    });
    return {
      emailAccountId,
      newMessages: 0,
      processedMessages: 0,
      error: errorMessage,
    };
  }
}

/**
 * Poll all active IMAP accounts.
 */
export async function pollAllImapAccounts(
  logger?: Logger,
): Promise<PollResult[]> {
  const log = logger || defaultLogger;

  const imapAccounts = await prisma.emailAccount.findMany({
    where: {
      account: {
        provider: "imap",
        disconnectedAt: null,
      },
    },
    select: { id: true },
  });

  log.info("Polling IMAP accounts", { count: imapAccounts.length });

  const settled = await runWithBoundedConcurrency({
    items: imapAccounts,
    concurrency: POLL_CONCURRENCY,
    run: (account) => pollImapAccount(account.id, log),
  });

  // pollImapAccount catches its own errors and resolves to a PollResult, so a
  // rejection here is unexpected; surface it as an error result rather than
  // dropping the account silently.
  return settled.map(({ item, result }) =>
    result.status === "fulfilled"
      ? result.value
      : {
          emailAccountId: item.id,
          newMessages: 0,
          processedMessages: 0,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error",
        },
  );
}

async function runRulesOnNewMessages({
  emailAccountId,
  email,
  messages,
  log,
}: {
  emailAccountId: string;
  email: string;
  messages: ParsedMessage[];
  log: Logger;
}): Promise<number> {
  if (messages.length === 0) return 0;

  const accountData = await getWebhookEmailAccount({ email }, log);
  const validation = await validateWebhookAccount(accountData, log);
  if (!validation.success) {
    log.info("Skipping rule run for IMAP account", { emailAccountId });
    return 0;
  }

  const { emailAccount, hasAutomationRules, hasAiAccess } = validation.data;
  const provider = await createEmailProvider({
    emailAccountId,
    provider: "imap",
    logger: log,
  });

  let processed = 0;
  for (const message of messages) {
    try {
      await processHistoryItem(
        { messageId: message.id, threadId: message.threadId, message },
        {
          provider,
          emailAccount: {
            ...emailAccount,
            account: { provider: "imap" },
          },
          hasAutomationRules,
          hasAiAccess,
          rules: emailAccount.rules,
          logger: log,
        },
      );
      processed++;
    } catch (error) {
      log.error("Error running rules on new IMAP message", {
        emailAccountId,
        messageId: message.id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return processed;
}
