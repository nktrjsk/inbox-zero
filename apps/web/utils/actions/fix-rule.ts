"use server";

import prisma from "@/utils/prisma";
import { actionClient } from "@/utils/actions/safe-action";
import { fixRuleForMessageBody } from "@/utils/actions/fix-rule.validation";
import { aiFixRuleForMessage } from "@/utils/ai/rule/fix-rule-for-message";
import { getEmailAccountWithAi } from "@/utils/user/get";
import { createEmailProvider } from "@/utils/email/provider";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import { stringifyEmail } from "@/utils/stringify-email";
import { createRule, updateRule } from "@/utils/rule/rule";
import { assertRuleIsNotOrgManaged } from "@/utils/organizations/rules";
import { SafeError } from "@/utils/error";
import type { CreateOrUpdateRuleSchema } from "@/utils/ai/rule/create-rule-schema";
import type { Logger } from "@/utils/logger";

export const fixRuleForMessageAction = actionClient
  .metadata({ name: "fixRuleForMessage" })
  .inputSchema(fixRuleForMessageBody)
  .action(async ({ ctx, parsedInput }) => {
    const { emailAccountId, provider, logger } = ctx;
    const {
      messageId,
      threadId,
      expected,
      explanation,
      matchedRuleIds,
      verifierFeedback,
    } = parsedInput;

    try {
      const emailAccount = await getEmailAccountWithAi({ emailAccountId });
      if (!emailAccount) throw new SafeError("Email account not found");

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      const message = await emailProvider.getMessage(messageId);
      const emailForLLM = stringifyEmail(
        getEmailForLLM(message, { maxLength: 3000 }),
        3000,
      );

      const { targetRule, matchedRules } = await loadRuleContext({
        emailAccountId,
        expected,
        matchedRuleIds,
      });

      const result = await aiFixRuleForMessage({
        emailAccount,
        emailForLLM,
        expected,
        targetRule,
        matchedRules,
        explanation: explanation ?? undefined,
        verifierFeedback: verifierFeedback ?? undefined,
        logger,
      });

      return applyFixRuleResult({
        expected,
        matchedRules,
        rule: result.rule,
        assessment: result.assessment,
        emailAccountId,
        provider,
        logger,
      });
    } catch (error) {
      logger.error("fixRuleForMessageAction failed", {
        error,
        messageId,
        threadId,
      });
      throw error;
    }
  });

type FixRuleExpected =
  | { kind: "new" }
  | { kind: "none" }
  | { kind: "rule"; id: string; name: string };

type RuleSnapshot = {
  id: string;
  name: string;
  instructions: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  conditionalOperator: string;
  actions: { type: string; label: string | null }[];
};

async function loadRuleContext({
  emailAccountId,
  expected,
  matchedRuleIds,
}: {
  emailAccountId: string;
  expected: FixRuleExpected;
  matchedRuleIds?: string[] | null;
}): Promise<{
  targetRule?: RuleSnapshot;
  matchedRules?: RuleSnapshot[];
}> {
  if (expected.kind === "rule") {
    const rule = await prisma.rule.findUnique({
      where: { id_emailAccountId: { id: expected.id, emailAccountId } },
      include: { actions: true },
    });
    if (!rule) throw new SafeError("Rule not found");
    return { targetRule: mapRuleToSnapshot(rule) };
  }

  if (expected.kind === "none") {
    if (!matchedRuleIds?.length) return { matchedRules: [] };

    const rules = await prisma.rule.findMany({
      where: { emailAccountId, id: { in: matchedRuleIds } },
      include: { actions: true },
    });
    // Preserve the caller-provided order (first = primary matched rule).
    const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
    const orderedRules = matchedRuleIds
      .map((id) => rulesById.get(id))
      .filter((rule): rule is NonNullable<typeof rule> => Boolean(rule));

    return { matchedRules: orderedRules.map(mapRuleToSnapshot) };
  }

  return {};
}

async function applyFixRuleResult({
  expected,
  matchedRules,
  rule,
  assessment,
  emailAccountId,
  provider,
  logger,
}: {
  expected: FixRuleExpected;
  matchedRules?: RuleSnapshot[];
  rule: CreateOrUpdateRuleSchema;
  assessment: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) {
  if (expected.kind === "new") {
    const created = await createRule({
      result: rule,
      emailAccountId,
      provider,
      runOnThreads: false,
      logger,
    });
    return {
      assessment,
      operation: "create" as const,
      ruleId: created.id,
      ruleName: created.name,
    };
  }

  if (expected.kind === "rule") {
    await assertRuleIsNotOrgManaged({ ruleId: expected.id, emailAccountId });
    const updated = await updateRule({
      ruleId: expected.id,
      result: { ...rule, ruleId: expected.id },
      emailAccountId,
      provider,
      logger,
    });
    return {
      assessment,
      operation: "update" as const,
      ruleId: updated.id,
      ruleName: updated.name,
    };
  }

  // expected.kind === "none"
  const primaryRule = matchedRules?.[0];
  if (!primaryRule) {
    return {
      assessment,
      operation: "update" as const,
      ruleId: null,
      ruleName: null,
    };
  }

  await assertRuleIsNotOrgManaged({ ruleId: primaryRule.id, emailAccountId });
  const updated = await updateRule({
    ruleId: primaryRule.id,
    result: { ...rule, ruleId: primaryRule.id },
    emailAccountId,
    provider,
    logger,
  });
  return {
    assessment,
    operation: "update" as const,
    ruleId: updated.id,
    ruleName: updated.name,
  };
}

function mapRuleToSnapshot(rule: {
  id: string;
  name: string;
  instructions: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  conditionalOperator: string;
  actions: { type: string; label: string | null }[];
}): RuleSnapshot {
  return {
    id: rule.id,
    name: rule.name,
    instructions: rule.instructions,
    from: rule.from,
    to: rule.to,
    subject: rule.subject,
    conditionalOperator: rule.conditionalOperator,
    actions: rule.actions.map((action) => ({
      type: action.type,
      label: action.label ?? null,
    })),
  };
}
