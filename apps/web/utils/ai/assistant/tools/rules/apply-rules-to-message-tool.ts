import { type InferUITool, tool } from "ai";
import { z } from "zod";
import type { Logger } from "@/utils/logger";
import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";
import { runRulesOnMessage } from "@/utils/ai/choose-rule/run-rules-on-message";
import { trackRuleToolCall } from "./shared";

const applyRulesToMessageInputSchema = z.object({
  dryRun: z
    .boolean()
    .describe(
      "true = verify only (dry run, no side effects). false = apply for real (executes the matched rule's actions on the email). Only call with false AFTER a dryRun:true call confirmed matchesExpected is true.",
    ),
  messageId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Message ID to classify. Omit to use the email currently being fixed.",
    ),
  threadId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Thread ID for the message. Omit to use the email currently being fixed.",
    ),
});

type MatchedRule = {
  ruleId: string | null;
  ruleName: string | null;
  systemType: string | null;
};

type ApplyRulesToMessageOutput =
  | {
      messageId: string;
      dryRun: boolean;
      status: "matched" | "no_match";
      matchedRules: MatchedRule[];
      reason: string | null;
      expected: MessageContext["expected"] | null;
      matchesExpected: boolean | null;
      actions?: unknown;
    }
  | { error: string };

export const applyRulesToMessageTool = ({
  email,
  emailAccountId,
  provider,
  logger,
  fixContext,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
  fixContext?: {
    messageId: string;
    threadId: string;
    expected: MessageContext["expected"];
  };
}) =>
  tool<
    z.infer<typeof applyRulesToMessageInputSchema>,
    ApplyRulesToMessageOutput
  >({
    description:
      "Run the real rule engine against a specific email to verify how it classifies, or to apply that classification for real. This is the only way to confirm whether a rule change actually fixed how an email is handled — never claim a rule fix worked without calling this tool first. Call with dryRun=true to check which rule(s) match without taking any action (no labels, archiving, drafts, or other side effects, and nothing is recorded as an executed rule). Call with dryRun=false only after a dryRun=true call confirms the expected outcome; dryRun=false performs the real, side-effecting actions the matched rule defines (e.g. labeling, archiving, drafting) and records the execution. If messageId/threadId are omitted, this applies to the email currently being fixed (from the hidden fix-rule context), if any. When resolving a reported misclassification, matchesExpected in the result tells you whether the fix worked; do not tell the user the issue is resolved unless matchesExpected is true.",
    inputSchema: applyRulesToMessageInputSchema,
    execute: async ({
      dryRun,
      messageId: inputMessageId,
      threadId: inputThreadId,
    }) => {
      trackRuleToolCall({
        tool: "apply_rules_to_message",
        email,
        logger,
      });

      const messageId = inputMessageId ?? fixContext?.messageId;
      const threadId = inputThreadId ?? fixContext?.threadId;

      if (!messageId || !threadId) {
        return {
          error: "No message specified and no email is being fixed.",
        };
      }

      try {
        const results = await runRulesOnMessage({
          emailAccountId,
          provider,
          messageId,
          threadId,
          isTest: dryRun,
          rerun: !dryRun,
          logger,
        });

        const matchedResults = results.filter((result) => !!result.rule);
        const matchedRules: MatchedRule[] = matchedResults.map((result) => ({
          ruleId: result.rule?.id ?? null,
          ruleName: result.rule?.name ?? null,
          systemType: result.rule?.systemType ?? null,
        }));
        const status = matchedRules.length ? "matched" : "no_match";
        const reason = results[0]?.reason ?? null;
        const expected = fixContext?.expected ?? null;
        const matchesExpected = expected
          ? computeMatchesExpected({ expected, status, matchedRules })
          : null;

        return {
          messageId,
          dryRun,
          status,
          matchedRules,
          reason,
          expected,
          matchesExpected,
          ...(dryRun
            ? {}
            : { actions: matchedResults[0]?.actionItems ?? null }),
        };
      } catch (error) {
        logger.error("Failed to run rules on message", {
          error,
          messageId,
          threadId,
        });
        return { error: "Failed to run rules on message" };
      }
    },
  });

export type ApplyRulesToMessageTool = InferUITool<
  ReturnType<typeof applyRulesToMessageTool>
>;

function computeMatchesExpected({
  expected,
  status,
  matchedRules,
}: {
  expected: NonNullable<MessageContext["expected"]>;
  status: "matched" | "no_match";
  matchedRules: MatchedRule[];
}): boolean {
  if (expected === "none") return status === "no_match";
  if (expected === "new") return status === "matched";

  if ("id" in expected) {
    return matchedRules.some(
      (rule) =>
        rule.ruleId === expected.id ||
        (!!expected.name &&
          rule.ruleName?.toLowerCase() === expected.name.toLowerCase()),
    );
  }

  return matchedRules.some(
    (rule) => rule.ruleName?.toLowerCase() === expected.name.toLowerCase(),
  );
}
