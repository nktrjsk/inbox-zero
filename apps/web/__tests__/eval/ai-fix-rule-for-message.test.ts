import { afterAll, describe, expect, test } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { getEmail } from "@/__tests__/helpers";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import { aiFixRuleForMessage } from "@/utils/ai/rule/fix-rule-for-message";
import { stringifyEmail } from "@/utils/stringify-email";

// pnpm test-ai eval/ai-fix-rule-for-message
// Multi-model: EVAL_MODELS=all pnpm test-ai eval/ai-fix-rule-for-message

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = 60_000;
const logger = createScopedLogger("eval-ai-fix-rule-for-message");

const newsletterEmail = getEmail({
  from: "newsletter@techdigest.example",
  to: "user@test.com",
  subject: "This week in tech: 10 stories you shouldn't miss",
  content: `Hi there,

Here's your weekly roundup of the biggest stories in tech this week:

1. New AI model released
2. Startup raises $50M Series B
3. Big tech layoffs continue

Read more on our site. Unsubscribe anytime.

- The Tech Digest Team`,
  date: new Date("2026-04-21T10:00:00Z"),
});

const targetRule = {
  id: "rule-newsletter-1",
  name: "Newsletter",
  instructions:
    "Match promotional newsletters and content digests sent to a broad subscriber list.",
  from: null,
  to: null,
  subject: null,
  conditionalOperator: "AND",
  actions: [{ type: "ARCHIVE", label: null }],
};

describe.runIf(shouldRunEval)("Eval: ai fix rule for message", () => {
  const evalReporter = createEvalReporter({
    evalName: "ai-fix-rule-for-message",
  });

  describeEvalMatrix("fix rule for message", (model, emailAccount) => {
    test(
      "revises the target rule so it matches the newsletter email and keeps its actions",
      async () => {
        const emailForLLM = stringifyEmail(newsletterEmail, 3000);

        const result = await aiFixRuleForMessage({
          emailAccount,
          emailForLLM,
          expected: {
            kind: "rule",
            id: targetRule.id,
            name: targetRule.name,
          },
          targetRule,
          explanation: "This is clearly a newsletter and should be archived",
          logger,
        });

        const hasNonEmptyCondition = Boolean(
          result.rule.condition.aiInstructions?.trim() ||
            result.rule.condition.static?.from?.trim() ||
            result.rule.condition.static?.to?.trim() ||
            result.rule.condition.static?.subject?.trim(),
        );
        const preservesArchiveAction = result.rule.actions.some(
          (action) => action.type === "ARCHIVE",
        );
        const pass =
          Boolean(result.assessment) &&
          hasNonEmptyCondition &&
          preservesArchiveAction;

        evalReporter.record({
          testName: "revises target rule for newsletter email",
          model: model.label,
          pass,
          actual: JSON.stringify({
            assessment: result.assessment,
            condition: result.rule.condition,
            actions: result.rule.actions.map((a) => a.type),
          }),
          expected:
            "non-empty assessment, a non-empty condition, and an ARCHIVE action preserved",
        });

        expect(result.assessment.length).toBeGreaterThan(0);
        expect(hasNonEmptyCondition).toBe(true);
        expect(preservesArchiveAction).toBe(true);
      },
      TIMEOUT,
    );
  });

  afterAll(() => {
    evalReporter.printReport();
  });
});
