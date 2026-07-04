import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/__mocks__/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";
import { executeBulkProcessPage } from "./execute";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/ai/choose-rule/run-rules");
vi.mock("@/utils/email/provider");
vi.mock("@/utils/queue/dispatch");
vi.mock("@/utils/user/get");

const logger = createScopedLogger("test");
const JOB_ID = "job-1";
const EMAIL_ACCOUNT_ID = "email-account-1";

function makeThread(id: number) {
  return {
    id: `thread-${id}`,
    messages: [{ id: `msg-${id}` }],
  };
}

function mockJob(overrides: Record<string, unknown>) {
  prisma.bulkProcessJob.findUnique.mockResolvedValue({
    id: JOB_ID,
    emailAccountId: EMAIL_ACCOUNT_ID,
    status: "RUNNING",
    processed: 0,
    ruleRuns: 0,
    maxEmails: null,
    after: new Date("2024-01-01"),
    before: null,
    includeRead: false,
    pageToken: null,
    ...overrides,
  } as never);
}

describe("executeBulkProcessPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getEmailAccountForRuleExecution).mockResolvedValue({
      account: { provider: "imap" },
    } as never);
    vi.mocked(createEmailProvider).mockResolvedValue({} as never);
    vi.mocked(runRules).mockResolvedValue({} as never);
    vi.mocked(enqueueBackgroundJob).mockResolvedValue(undefined as never);
    prisma.rule.findMany.mockResolvedValue([] as never);
    prisma.bulkProcessJob.updateMany.mockResolvedValue({ count: 1 } as never);
    // Default: no thread has been executed before.
    prisma.executedRule.findFirst.mockResolvedValue(null as never);
  });

  it("does not count executedRule-skipped threads against maxEmails", async () => {
    // maxEmails cap of 2. First two threads were already processed (skipped),
    // only the last two should actually run rules and consume the cap.
    mockJob({ maxEmails: 2 });

    const threads = [
      makeThread(1),
      makeThread(2),
      makeThread(3),
      makeThread(4),
    ];
    const provider = {
      getThreadsWithQuery: vi
        .fn()
        .mockResolvedValue({ threads, nextPageToken: "next" }),
    };
    vi.mocked(createEmailProvider).mockResolvedValue(provider as never);

    prisma.executedRule.findFirst.mockImplementation((({
      where,
    }: {
      where: { threadId: string };
    }) =>
      Promise.resolve(
        where.threadId === "thread-1" || where.threadId === "thread-2"
          ? { id: "existing" }
          : null,
      )) as never);

    await executeBulkProcessPage({ jobId: JOB_ID, logger });

    // Rules ran on thread-3 and thread-4 only (the two unprocessed ones).
    expect(runRules).toHaveBeenCalledTimes(2);

    const update = prisma.bulkProcessJob.updateMany.mock.calls[0][0];
    expect(update.data.ruleRuns).toEqual({ increment: 2 });
    // Cap of 2 rule-runs is reached => job completes, no re-enqueue.
    expect(update.data.status).toBe("COMPLETED");
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("stops running rules once the maxEmails cap is reached mid-page", async () => {
    // Already ran rules on 1, cap is 2 => budget of 1 remaining this page.
    mockJob({ maxEmails: 2, ruleRuns: 1 });

    const threads = [makeThread(1), makeThread(2), makeThread(3)];
    const provider = {
      getThreadsWithQuery: vi
        .fn()
        .mockResolvedValue({ threads, nextPageToken: "next" }),
    };
    vi.mocked(createEmailProvider).mockResolvedValue(provider as never);

    await executeBulkProcessPage({ jobId: JOB_ID, logger });

    expect(runRules).toHaveBeenCalledTimes(1);
    const update = prisma.bulkProcessJob.updateMany.mock.calls[0][0];
    expect(update.data.status).toBe("COMPLETED");
  });

  it("re-enqueues the next page when under the cap", async () => {
    mockJob({ maxEmails: 10 });

    const threads = [makeThread(1), makeThread(2)];
    const provider = {
      getThreadsWithQuery: vi
        .fn()
        .mockResolvedValue({ threads, nextPageToken: "next" }),
    };
    vi.mocked(createEmailProvider).mockResolvedValue(provider as never);

    await executeBulkProcessPage({ jobId: JOB_ID, logger });

    expect(runRules).toHaveBeenCalledTimes(2);
    const update = prisma.bulkProcessJob.updateMany.mock.calls[0][0];
    expect(update.data.status).toBeUndefined();
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });
});
