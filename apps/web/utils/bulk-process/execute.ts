import { z } from "zod";
import { BulkProcessJobStatus } from "@/generated/prisma/enums";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import type { ThreadsQuery } from "@/utils/threads/validation";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

export const executeBulkProcessBody = z.object({ jobId: z.string() });

const PAGE_SIZE = 25;
const BULK_PROCESS_QUEUE = "bulk-process";

/**
 * Process one page of a durable "Process Past Emails" job, then re-enqueue
 * itself for the next page until the inbox range is exhausted, the maxEmails
 * cap is hit, or the job is stopped. Because each page is driven by a queued
 * server job (not the browser), the run survives the tab closing.
 */
export async function executeBulkProcessPage({
  jobId,
  logger,
}: {
  jobId: string;
  logger: Logger;
}) {
  const job = await prisma.bulkProcessJob.findUnique({ where: { id: jobId } });

  if (!job) {
    logger.error("Bulk process job not found", { jobId });
    return;
  }

  if (job.status !== BulkProcessJobStatus.RUNNING) {
    logger.info("Bulk process job no longer running, stopping", {
      jobId,
      status: job.status,
    });
    return;
  }

  const { emailAccountId } = job;

  try {
    const emailAccount = await getEmailAccountForRuleExecution({
      emailAccountId,
    });
    if (!emailAccount) throw new Error("Email account not found");

    const provider = await createEmailProvider({
      emailAccountId,
      provider: emailAccount.account.provider,
      logger,
    });

    const rules = await prisma.rule.findMany({
      where: { emailAccountId, enabled: true },
      include: { actions: true },
    });

    // The cap counts emails we actually run rules on (the costly LLM work),
    // not emails merely inspected — threads already handled by a prior run are
    // skipped for free and must not consume the budget.
    const runBudget =
      job.maxEmails == null ? undefined : job.maxEmails - job.ruleRuns;
    if (runBudget !== undefined && runBudget <= 0) {
      await markCompleted(jobId);
      return;
    }

    const query: ThreadsQuery = {
      type: "inbox",
      limit: PAGE_SIZE,
      after: job.after,
      ...(job.before ? { before: job.before } : {}),
      ...(job.includeRead ? {} : { isUnread: true }),
    };

    const { threads, nextPageToken } = await provider.getThreadsWithQuery({
      query,
      maxResults: PAGE_SIZE,
      pageToken: job.pageToken || undefined,
    });

    let ruleRuns = 0;
    let checked = 0;
    for (const thread of threads) {
      if (runBudget !== undefined && ruleRuns >= runBudget) break;

      const message = thread.messages[thread.messages.length - 1];
      if (!message) continue;
      checked++;

      // Skip threads already handled by a rule (mirrors the "no plan" filter
      // in the client flow and the runRulesAction dedupe).
      const existing = await prisma.executedRule.findFirst({
        where: { emailAccountId, threadId: thread.id, messageId: message.id },
        select: { id: true },
      });
      if (existing) continue;

      try {
        await runRules({
          isTest: false,
          provider,
          message,
          rules,
          emailAccount,
          logger,
          modelType: "default",
        });
        ruleRuns++;
      } catch (error) {
        logger.error("Bulk process: failed to run rules on message", {
          jobId,
          messageId: message.id,
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    const totalRuleRuns = job.ruleRuns + ruleRuns;
    const hitMax = job.maxEmails != null && totalRuleRuns >= job.maxEmails;
    const done = !nextPageToken || hitMax;

    // Only advance a job that is still RUNNING, so a concurrent Stop wins.
    const updated = await prisma.bulkProcessJob.updateMany({
      where: { id: jobId, status: BulkProcessJobStatus.RUNNING },
      data: {
        processed: { increment: checked },
        ruleRuns: { increment: ruleRuns },
        pageToken: nextPageToken ?? null,
        status: done ? BulkProcessJobStatus.COMPLETED : undefined,
      },
    });

    if (updated.count === 0) {
      logger.info("Bulk process job stopped mid-page", { jobId });
      return;
    }

    logger.info("Bulk process page complete", {
      jobId,
      checked,
      ruleRuns,
      done,
    });

    if (!done) {
      await enqueueBulkProcessPage({ jobId, logger });
    }
  } catch (error) {
    logger.error("Bulk process job failed", {
      jobId,
      error: error instanceof Error ? error.message : error,
    });
    await prisma.bulkProcessJob.updateMany({
      where: { id: jobId, status: BulkProcessJobStatus.RUNNING },
      data: {
        status: BulkProcessJobStatus.FAILED,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
}

export async function enqueueBulkProcessPage({
  jobId,
  logger,
}: {
  jobId: string;
  logger: Logger;
}) {
  await enqueueBackgroundJob({
    topic: "bulk-process-execute",
    body: { jobId },
    qstash: {
      queueName: BULK_PROCESS_QUEUE,
      parallelism: 1,
      path: "/api/bulk-process/execute",
    },
    logger,
  });
}

async function markCompleted(jobId: string) {
  await prisma.bulkProcessJob.updateMany({
    where: { id: jobId, status: BulkProcessJobStatus.RUNNING },
    data: { status: BulkProcessJobStatus.COMPLETED },
  });
}
