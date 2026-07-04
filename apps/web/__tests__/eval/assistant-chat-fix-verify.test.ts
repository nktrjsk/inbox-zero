import type { ModelMessage } from "ai";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  captureAssistantChatToolCalls,
  summarizeRecordedToolCalls,
  type RecordedToolCall,
} from "@/__tests__/eval/assistant-chat-eval-utils";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import {
  buildDefaultSystemRuleRows,
  configureRuleEvalPrisma,
  configureRuleEvalProvider,
  configureRuleMutationMocks,
} from "@/__tests__/eval/assistant-chat-rule-eval-test-utils";
import { getMockMessage, type getEmailAccount } from "@/__tests__/helpers";
import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";

// pnpm test-ai eval/assistant-chat-fix-verify
// Multi-model: EVAL_MODELS=all pnpm test-ai eval/assistant-chat-fix-verify

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = 120_000;
const evalReporter = createEvalReporter({
  evalName: "assistant-chat-fix-verify",
});
const logger = createScopedLogger("eval-assistant-chat-fix-verify");
const ruleUpdatedAt = new Date("2026-03-13T00:00:00.000Z");
const defaultRuleRows = buildDefaultSystemRuleRows(ruleUpdatedAt);
const newsletterRule = defaultRuleRows.find(
  (rule) => rule.name === "Newsletter",
);
if (!newsletterRule) {
  throw new Error("Expected a default 'Newsletter' system rule for this eval");
}
const about = "I manage a company inbox.";

const {
  mockCreateRule,
  mockPartialUpdateRule,
  mockUpdateRuleActions,
  mockSaveLearnedPatterns,
  mockCreateEmailProvider,
  mockPosthogCaptureEvent,
  mockRedis,
  mockUnsubscribeSenderAndMark,
  mockRunRulesOnMessage,
} = vi.hoisted(() => ({
  mockCreateRule: vi.fn(),
  mockPartialUpdateRule: vi.fn(),
  mockUpdateRuleActions: vi.fn(),
  mockSaveLearnedPatterns: vi.fn(),
  mockCreateEmailProvider: vi.fn(),
  mockPosthogCaptureEvent: vi.fn(),
  mockRedis: {
    set: vi.fn(),
    rpush: vi.fn(),
    hincrby: vi.fn(),
    expire: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    llen: vi.fn().mockResolvedValue(0),
    lrange: vi.fn().mockResolvedValue([]),
  },
  mockUnsubscribeSenderAndMark: vi.fn(),
  mockRunRulesOnMessage: vi.fn(),
}));

vi.mock("@/utils/rule/rule", async (importOriginal) => {
  const { buildRuleModuleMutationMock } = await import(
    "@/__tests__/eval/assistant-chat-rule-eval-test-utils"
  );

  return buildRuleModuleMutationMock({
    importOriginal: () => importOriginal<typeof import("@/utils/rule/rule")>(),
    mockCreateRule,
    mockPartialUpdateRule,
    mockUpdateRuleActions,
  });
});

vi.mock("@/utils/rule/learned-patterns", () => ({
  saveLearnedPatterns: mockSaveLearnedPatterns,
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: mockCreateEmailProvider,
}));

vi.mock("@/utils/posthog", () => ({
  posthogCaptureEvent: mockPosthogCaptureEvent,
  getPosthogLlmClient: () => null,
}));

vi.mock("@/utils/redis", () => ({
  redis: mockRedis,
}));

vi.mock("@/utils/senders/unsubscribe", () => ({
  unsubscribeSenderAndMark: mockUnsubscribeSenderAndMark,
}));

// The tool under test calls the real rule engine via runRulesOnMessage. This
// eval is about whether the assistant *follows the verify-then-apply
// protocol* (dry run before applying, only after confirmation), not about
// whether the real classifier is correct, so we stub it to always confirm
// the fix worked once called.
vi.mock("@/utils/ai/choose-rule/run-rules-on-message", () => ({
  runRulesOnMessage: mockRunRulesOnMessage,
}));

vi.mock("@/utils/prisma");

vi.mock("@/env", async () => {
  const { buildAssistantChatEvalEnv } = await vi.importActual<
    typeof import("@/__tests__/eval/assistant-chat-eval-env")
  >("@/__tests__/eval/assistant-chat-eval-env");

  return {
    env: buildAssistantChatEvalEnv(),
  };
});

describe.runIf(shouldRunEval)("Eval: assistant chat fix-verify loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    configureRuleMutationMocks({
      mockCreateRule,
      mockPartialUpdateRule,
      mockUpdateRuleActions,
      mockSaveLearnedPatterns,
    });

    configureRuleEvalPrisma({
      about,
      ruleRows: defaultRuleRows,
    });

    configureRuleEvalProvider({
      mockCreateEmailProvider,
      ruleRows: defaultRuleRows,
    });

    mockRunRulesOnMessage.mockResolvedValue([
      {
        rule: {
          id: newsletterRule!.id,
          name: "Newsletter",
          systemType: newsletterRule!.systemType,
        },
        actionItems: [],
        reason: "Matches the Newsletter rule after the fix.",
        status: ExecutedRuleStatus.APPLIED,
        createdAt: new Date("2026-03-13T00:00:00.000Z"),
      },
    ]);
  });

  describeEvalMatrix(
    "assistant-chat fix-verify loop",
    (model, emailAccount) => {
      test(
        "verifies with a dry run before applying, and applies only after confirming the fix",
        async () => {
          const request =
            'This email should have matched the "Newsletter" rule but it did not. Please fix this.';
          const { toolCalls, actual } = await runAssistantChat({
            emailAccount,
            messages: [
              {
                role: "user",
                content: request,
              },
            ],
            context: buildFixRuleContext(),
          });

          const mutationIndex = toolCalls.findIndex(
            (toolCall) =>
              toolCall.toolName === "createRule" ||
              toolCall.toolName === "updateRule",
          );
          const dryRunIndex = findApplyRulesToMessageCallIndex(toolCalls, {
            dryRun: true,
          });
          const applyIndex = findApplyRulesToMessageCallIndex(toolCalls, {
            dryRun: false,
          });

          // Structural check standing in for "never asserts success without
          // verifying first": the assistant only calls apply (dryRun=false),
          // which is the point where it would tell the user the fix worked,
          // once a prior dry run has actually confirmed the match. If the
          // model skipped verification, dryRunIndex would be -1 or would
          // come after applyIndex, and this fails.
          const followedProtocol =
            mutationIndex !== -1 &&
            dryRunIndex !== -1 &&
            applyIndex !== -1 &&
            dryRunIndex > mutationIndex &&
            applyIndex > dryRunIndex;

          evalReporter.record({
            testName: "verify-then-apply protocol",
            model: model.label,
            pass: followedProtocol,
            actual,
          });

          expect(followedProtocol).toBe(true);
        },
        TIMEOUT,
      );
    },
  );

  afterAll(() => {
    evalReporter.printReport();
  });
});

async function runAssistantChat({
  emailAccount,
  messages,
  context,
}: {
  emailAccount: ReturnType<typeof getEmailAccount>;
  messages: ModelMessage[];
  context?: MessageContext;
}) {
  const toolCalls = await captureAssistantChatToolCalls({
    messages,
    emailAccount,
    context,
    logger,
  });

  return {
    toolCalls,
    actual: summarizeRecordedToolCalls(toolCalls, summarizeToolCall),
  };
}

function findApplyRulesToMessageCallIndex(
  toolCalls: RecordedToolCall[],
  { dryRun }: { dryRun: boolean },
) {
  return toolCalls.findIndex(
    (toolCall) =>
      toolCall.toolName === "applyRulesToMessage" &&
      isApplyRulesToMessageInput(toolCall.input) &&
      toolCall.input.dryRun === dryRun,
  );
}

type ApplyRulesToMessageInput = {
  dryRun: boolean;
  messageId?: string;
  threadId?: string;
};

function isApplyRulesToMessageInput(
  input: unknown,
): input is ApplyRulesToMessageInput {
  if (!input || typeof input !== "object") return false;

  const value = input as { dryRun?: unknown };
  return typeof value.dryRun === "boolean";
}

function summarizeToolCall(toolCall: RecordedToolCall) {
  if (isApplyRulesToMessageInput(toolCall.input)) {
    return `${toolCall.toolName}(dryRun=${toolCall.input.dryRun})`;
  }

  return toolCall.toolName;
}

function buildFixRuleContext(): MessageContext {
  const message = getMockMessage({
    id: "message-fix-verify",
    threadId: "thread-fix-verify",
    from: "digest@newsletter.example",
    to: "user@test.com",
    subject: "Weekly roundup",
    snippet: "Your weekly newsletter digest.",
    textPlain: "Hi,\n\nHere is your weekly newsletter digest.\n\nThanks.",
    textHtml:
      "<p>Hi,</p><p>Here is your weekly newsletter digest.</p><p>Thanks.</p>",
  });

  return {
    type: "fix-rule",
    message: {
      id: message.id,
      threadId: message.threadId,
      snippet: message.snippet,
      textPlain: message.textPlain,
      textHtml: message.textHtml,
      headers: {
        from: message.headers.from,
        to: message.headers.to,
        subject: message.headers.subject,
        date: message.headers.date,
      },
      internalDate: message.date,
    },
    results: [
      {
        ruleName: "Conversations",
        systemType: null,
        reason:
          "Matched the Conversations rule because it looked like human-to-human email.",
        matchMetadata: undefined,
      },
    ],
    expected: {
      id: newsletterRule!.id,
      name: "Newsletter",
    },
  };
}
