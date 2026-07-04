import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";

const {
  createEmailProviderMock,
  getEmailAccountForRuleExecutionMock,
  runRulesMock,
} = vi.hoisted(() => ({
  createEmailProviderMock: vi.fn(),
  getEmailAccountForRuleExecutionMock: vi.fn(),
  runRulesMock: vi.fn(),
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: createEmailProviderMock,
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountForRuleExecution: getEmailAccountForRuleExecutionMock,
}));
vi.mock("@/utils/ai/choose-rule/run-rules", () => ({
  runRules: runRulesMock,
}));

import { runRulesOnMessage } from "@/utils/ai/choose-rule/run-rules-on-message";

const logger = createTestLogger();

describe("runRulesOnMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getEmailAccountForRuleExecutionMock.mockResolvedValue({
      id: "account-1",
      email: "user@example.com",
      user: {},
      account: { provider: "google" },
    });

    createEmailProviderMock.mockResolvedValue({
      getMessage: vi.fn(async () => ({
        id: "message-1",
        threadId: "thread-1",
      })),
    });

    prisma.executedRule.findMany.mockResolvedValue([] as any);
    prisma.rule.findMany.mockResolvedValue([{ id: "rule-1" }] as any);

    runRulesMock.mockResolvedValue([
      {
        rule: { id: "rule-1", name: "Newsletter" },
        reason: "Matched",
        status: ExecutedRuleStatus.APPLIED,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("loads only enabled rules and passes them to runRules with modelType 'chat'", async () => {
    await runRulesOnMessage({
      emailAccountId: "account-1",
      provider: "google",
      messageId: "message-1",
      threadId: "thread-1",
      isTest: true,
      logger,
    });

    expect(prisma.rule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccountId: "account-1",
          enabled: true,
        }),
      }),
    );
    expect(runRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [{ id: "rule-1" }],
        modelType: "chat",
      }),
    );
  });

  it("short-circuits with existing executed rules when !isTest && !rerun", async () => {
    prisma.executedRule.findMany.mockResolvedValue([
      {
        id: "executed-1",
        reason: "Already ran",
        actionItems: [],
        rule: { id: "rule-1", name: "Newsletter" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        status: ExecutedRuleStatus.APPLIED,
      },
    ] as any);

    const result = await runRulesOnMessage({
      emailAccountId: "account-1",
      provider: "google",
      messageId: "message-1",
      threadId: "thread-1",
      isTest: false,
      rerun: false,
      logger,
    });

    expect(result).toEqual([
      {
        rule: { id: "rule-1", name: "Newsletter" },
        actionItems: [],
        reason: "Already ran",
        existing: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        status: ExecutedRuleStatus.APPLIED,
      },
    ]);
    expect(runRulesMock).not.toHaveBeenCalled();
  });

  it("does not short-circuit and calls runRules when isTest is true, even with existing executions", async () => {
    prisma.executedRule.findMany.mockResolvedValue([
      {
        id: "executed-1",
        reason: "Already ran",
        actionItems: [],
        rule: { id: "rule-1", name: "Newsletter" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        status: ExecutedRuleStatus.APPLIED,
      },
    ] as any);

    await runRulesOnMessage({
      emailAccountId: "account-1",
      provider: "google",
      messageId: "message-1",
      threadId: "thread-1",
      isTest: true,
      logger,
    });

    expect(prisma.executedRule.findMany).not.toHaveBeenCalled();
    expect(runRulesMock).toHaveBeenCalledTimes(1);
  });

  it("does not short-circuit and calls runRules when rerun is true, even with existing executions", async () => {
    prisma.executedRule.findMany.mockResolvedValue([
      {
        id: "executed-1",
        reason: "Already ran",
        actionItems: [],
        rule: { id: "rule-1", name: "Newsletter" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        status: ExecutedRuleStatus.APPLIED,
      },
    ] as any);

    await runRulesOnMessage({
      emailAccountId: "account-1",
      provider: "google",
      messageId: "message-1",
      threadId: "thread-1",
      isTest: false,
      rerun: true,
      logger,
    });

    expect(prisma.executedRule.findMany).not.toHaveBeenCalled();
    expect(runRulesMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the email account cannot be found", async () => {
    getEmailAccountForRuleExecutionMock.mockResolvedValue(null);

    await expect(
      runRulesOnMessage({
        emailAccountId: "account-1",
        provider: "google",
        messageId: "message-1",
        threadId: "thread-1",
        isTest: true,
        logger,
      }),
    ).rejects.toThrow("Email account not found");
  });
});
