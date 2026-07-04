import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import type { RunRulesResult } from "@/utils/ai/choose-rule/run-rules";
import { runRulesOnMessage } from "@/utils/ai/choose-rule/run-rules-on-message";
import { applyRulesToMessageTool } from "./apply-rules-to-message-tool";

vi.mock("@/utils/ai/choose-rule/run-rules-on-message", () => ({
  runRulesOnMessage: vi.fn(),
}));
vi.mock("@/utils/posthog", () => ({
  posthogCaptureEvent: vi.fn().mockResolvedValue(undefined),
}));

const logger = createTestLogger();
const runRulesOnMessageMock = vi.mocked(runRulesOnMessage);

const matchedResult = (
  overrides: Partial<NonNullable<RunRulesResult["rule"]>> = {},
): RunRulesResult[] => [
  {
    rule: {
      id: "rule-newsletter",
      name: "Newsletter",
      systemType: null,
      instructions: null,
      groupId: null,
      from: null,
      to: null,
      subject: null,
      body: null,
      conditionalOperator: "AND",
      ...overrides,
    } as NonNullable<RunRulesResult["rule"]>,
    actionItems: [{ type: "LABEL" } as never],
    reason: "Matched because sender is a newsletter",
    status: ExecutedRuleStatus.APPLIED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
];

const noMatchResult = (): RunRulesResult[] => [
  {
    rule: null,
    reason: "No rules matched",
    status: ExecutedRuleStatus.SKIPPED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
];

describe("applyRulesToMessageTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls runRulesOnMessage with isTest:true and rerun:false for dryRun=true", async () => {
    runRulesOnMessageMock.mockResolvedValue(matchedResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
    });

    await toolInstance.execute({
      dryRun: true,
      messageId: "message-1",
      threadId: "thread-1",
    });

    expect(runRulesOnMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        threadId: "thread-1",
        isTest: true,
        rerun: false,
      }),
    );
  });

  it("calls runRulesOnMessage with isTest:false and rerun:true for dryRun=false", async () => {
    runRulesOnMessageMock.mockResolvedValue(matchedResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
    });

    await toolInstance.execute({
      dryRun: false,
      messageId: "message-1",
      threadId: "thread-1",
    });

    expect(runRulesOnMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        threadId: "thread-1",
        isTest: false,
        rerun: true,
      }),
    );
  });

  it("falls back to fixContext messageId/threadId when omitted", async () => {
    runRulesOnMessageMock.mockResolvedValue(matchedResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
      fixContext: {
        messageId: "fix-message-1",
        threadId: "fix-thread-1",
        expected: "none",
      },
    });

    await toolInstance.execute({ dryRun: true });

    expect(runRulesOnMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "fix-message-1",
        threadId: "fix-thread-1",
      }),
    );
  });

  it("returns an error when no message is specified and no email is being fixed", async () => {
    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
    });

    const result = await toolInstance.execute({ dryRun: true });

    expect(result).toEqual({
      error: "No message specified and no email is being fixed.",
    });
    expect(runRulesOnMessageMock).not.toHaveBeenCalled();
  });

  it("matchesExpected is true when a specific expected rule id matches", async () => {
    runRulesOnMessageMock.mockResolvedValue(matchedResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
      fixContext: {
        messageId: "message-1",
        threadId: "thread-1",
        expected: { id: "rule-newsletter", name: "Newsletter" },
      },
    });

    const result = await toolInstance.execute({ dryRun: true });

    expect(result).toMatchObject({ status: "matched", matchesExpected: true });
  });

  it("matchesExpected is false when a specific expected rule id does not match", async () => {
    runRulesOnMessageMock.mockResolvedValue(matchedResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
      fixContext: {
        messageId: "message-1",
        threadId: "thread-1",
        expected: { id: "rule-other", name: "Other Rule" },
      },
    });

    const result = await toolInstance.execute({ dryRun: true });

    expect(result).toMatchObject({
      status: "matched",
      matchesExpected: false,
    });
  });

  it('matchesExpected is true when expected is "none" and no rule matched', async () => {
    runRulesOnMessageMock.mockResolvedValue(noMatchResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
      fixContext: {
        messageId: "message-1",
        threadId: "thread-1",
        expected: "none",
      },
    });

    const result = await toolInstance.execute({ dryRun: true });

    expect(result).toMatchObject({
      status: "no_match",
      matchesExpected: true,
    });
  });

  it('matchesExpected is false when expected is "none" but a rule matched', async () => {
    runRulesOnMessageMock.mockResolvedValue(matchedResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
      fixContext: {
        messageId: "message-1",
        threadId: "thread-1",
        expected: "none",
      },
    });

    const result = await toolInstance.execute({ dryRun: true });

    expect(result).toMatchObject({
      status: "matched",
      matchesExpected: false,
    });
  });

  it('matchesExpected is true when expected is "new" and a rule matched', async () => {
    runRulesOnMessageMock.mockResolvedValue(matchedResult());

    const toolInstance = applyRulesToMessageTool({
      email: "user@example.com",
      emailAccountId: "email-account-1",
      provider: "google",
      logger,
      fixContext: {
        messageId: "message-1",
        threadId: "thread-1",
        expected: "new",
      },
    });

    const result = await toolInstance.execute({ dryRun: true });

    expect(result).toMatchObject({ status: "matched", matchesExpected: true });
  });
});
