import {
  runRules,
  type RunRulesResult,
} from "@/utils/ai/choose-rule/run-rules";
import prisma from "@/utils/prisma";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";
import { SafeError } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";

export async function runRulesOnMessage({
  emailAccountId,
  provider,
  messageId,
  threadId,
  isTest,
  rerun,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  messageId: string;
  threadId: string;
  isTest: boolean;
  rerun?: boolean;
  logger: Logger;
}): Promise<RunRulesResult[]> {
  const emailAccount = await getEmailAccountForRuleExecution({
    emailAccountId,
  });
  if (!emailAccount) throw new SafeError("Email account not found");
  if (!provider) throw new SafeError("Provider not found");

  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });

  const message = await emailProvider.getMessage(messageId);

  const fetchExecutedRule = !isTest && !rerun;

  const existingExecutedRules = fetchExecutedRule
    ? await prisma.executedRule.findMany({
        where: {
          emailAccountId,
          threadId,
          messageId,
        },
        select: {
          id: true,
          reason: true,
          actionItems: true,
          rule: true,
          createdAt: true,
          status: true,
        },
      })
    : [];

  if (existingExecutedRules.length > 0) {
    logger.info("Using existing executed rules for message", {
      executedRuleCount: existingExecutedRules.length,
    });

    return existingExecutedRules.map((executedRule) => ({
      rule: executedRule.rule,
      actionItems: executedRule.actionItems,
      reason: executedRule.reason,
      existing: true,
      createdAt: executedRule.createdAt,
      status: executedRule.status,
    }));
  }

  const rules = await prisma.rule.findMany({
    where: {
      emailAccountId,
      enabled: true,
    },
    include: {
      actions: true,
    },
  });

  logger.info("Running rules on message", {
    isTest,
    rerun,
    ruleCount: rules.length,
  });

  return runRules({
    isTest,
    provider: emailProvider,
    message,
    rules,
    emailAccount,
    logger,
    modelType: "chat",
  });
}
