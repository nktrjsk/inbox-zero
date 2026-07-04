import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

const {
  aiFixRuleForMessageMock,
  assertRuleIsNotOrgManagedMock,
  createEmailProviderMock,
  createRuleMock,
  getEmailAccountWithAiMock,
  updateRuleMock,
} = vi.hoisted(() => ({
  aiFixRuleForMessageMock: vi.fn(),
  assertRuleIsNotOrgManagedMock: vi.fn(),
  createEmailProviderMock: vi.fn(),
  createRuleMock: vi.fn(),
  getEmailAccountWithAiMock: vi.fn(),
  updateRuleMock: vi.fn(),
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: createEmailProviderMock,
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: getEmailAccountWithAiMock,
}));
vi.mock("@/utils/ai/rule/fix-rule-for-message", () => ({
  aiFixRuleForMessage: aiFixRuleForMessageMock,
}));
vi.mock("@/utils/rule/rule", () => ({
  createRule: createRuleMock,
  updateRule: updateRuleMock,
}));
vi.mock("@/utils/organizations/rules", () => ({
  assertRuleIsNotOrgManaged: assertRuleIsNotOrgManagedMock,
}));

import { fixRuleForMessageAction } from "@/utils/actions/fix-rule";

const AI_RULE_RESULT = {
  assessment: "This looks like a newsletter.",
  rule: {
    name: "Newsletter",
    condition: {
      conditionalOperator: "AND",
      aiInstructions: "Match newsletters",
      static: null,
    },
    actions: [{ type: "ARCHIVE", fields: null, delayInMinutes: null }],
  },
};

describe("fixRuleForMessageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      account: {
        userId: "user-1",
        provider: "google",
      },
    } as any);

    getEmailAccountWithAiMock.mockResolvedValue({
      id: "account-1",
      email: "user@example.com",
      user: {},
      account: { provider: "google" },
    });

    createEmailProviderMock.mockResolvedValue({
      getMessage: vi.fn(async () => ({
        id: "message-1",
        threadId: "thread-1",
        headers: { from: "a@b.com", to: "me@x.com", subject: "Hi" },
        internalDate: "1700000000000",
      })),
    });

    aiFixRuleForMessageMock.mockResolvedValue(AI_RULE_RESULT);

    createRuleMock.mockResolvedValue({ id: "new-rule-1", name: "Newsletter" });
    updateRuleMock.mockResolvedValue({ id: "rule-1", name: "Newsletter" });
    assertRuleIsNotOrgManagedMock.mockResolvedValue(undefined);
  });

  it("creates a new rule for expected.kind 'new' and does not update anything", async () => {
    const result = await fixRuleForMessageAction("account-1", {
      messageId: "message-1",
      threadId: "thread-1",
      expected: { kind: "new" },
    });

    expect(createRuleMock).toHaveBeenCalledTimes(1);
    expect(createRuleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: AI_RULE_RESULT.rule,
        emailAccountId: "account-1",
        runOnThreads: false,
      }),
    );
    expect(updateRuleMock).not.toHaveBeenCalled();
    expect(result?.data).toEqual({
      assessment: AI_RULE_RESULT.assessment,
      operation: "create",
      ruleId: "new-rule-1",
      ruleName: "Newsletter",
    });
  });

  it("updates the target rule for expected.kind 'rule' after checking org-managed status", async () => {
    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      name: "Newsletter",
      instructions: "old instructions",
      from: null,
      to: null,
      subject: null,
      conditionalOperator: "AND",
      actions: [{ type: "ARCHIVE", label: null }],
    } as any);

    const result = await fixRuleForMessageAction("account-1", {
      messageId: "message-1",
      threadId: "thread-1",
      expected: { kind: "rule", id: "rule-1", name: "Newsletter" },
    });

    expect(assertRuleIsNotOrgManagedMock).toHaveBeenCalledWith({
      ruleId: "rule-1",
      emailAccountId: "account-1",
    });
    expect(updateRuleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: "rule-1",
        result: expect.objectContaining({
          ...AI_RULE_RESULT.rule,
          ruleId: "rule-1",
        }),
        emailAccountId: "account-1",
      }),
    );
    expect(createRuleMock).not.toHaveBeenCalled();
    expect(result?.data).toEqual({
      assessment: AI_RULE_RESULT.assessment,
      operation: "update",
      ruleId: "rule-1",
      ruleName: "Newsletter",
    });
  });

  it("updates the first matched rule for expected.kind 'none' with matchedRuleIds", async () => {
    prisma.rule.findMany.mockResolvedValue([
      {
        id: "rule-2",
        name: "Marketing",
        instructions: "old",
        from: null,
        to: null,
        subject: null,
        conditionalOperator: "AND",
        actions: [{ type: "LABEL", label: "Marketing" }],
      },
      {
        id: "rule-3",
        name: "Other",
        instructions: null,
        from: null,
        to: null,
        subject: null,
        conditionalOperator: "AND",
        actions: [],
      },
    ] as any);

    const result = await fixRuleForMessageAction("account-1", {
      messageId: "message-1",
      threadId: "thread-1",
      expected: { kind: "none" },
      matchedRuleIds: ["rule-2", "rule-3"],
    });

    expect(assertRuleIsNotOrgManagedMock).toHaveBeenCalledWith({
      ruleId: "rule-2",
      emailAccountId: "account-1",
    });
    expect(updateRuleMock).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "rule-2" }),
    );
    expect(result?.data).toEqual({
      assessment: AI_RULE_RESULT.assessment,
      operation: "update",
      ruleId: "rule-1",
      ruleName: "Newsletter",
    });
  });

  it("does not update anything for expected.kind 'none' with no matchedRuleIds", async () => {
    const result = await fixRuleForMessageAction("account-1", {
      messageId: "message-1",
      threadId: "thread-1",
      expected: { kind: "none" },
      matchedRuleIds: [],
    });

    expect(updateRuleMock).not.toHaveBeenCalled();
    expect(assertRuleIsNotOrgManagedMock).not.toHaveBeenCalled();
    expect(result?.data).toEqual({
      assessment: AI_RULE_RESULT.assessment,
      operation: "update",
      ruleId: null,
      ruleName: null,
    });
  });

  it("passes explanation and verifierFeedback through to aiFixRuleForMessage", async () => {
    await fixRuleForMessageAction("account-1", {
      messageId: "message-1",
      threadId: "thread-1",
      expected: { kind: "new" },
      explanation: "It's actually spam",
      verifierFeedback: "Still matched the wrong rule",
    });

    expect(aiFixRuleForMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        explanation: "It's actually spam",
        verifierFeedback: "Still matched the wrong rule",
      }),
    );
  });
});
