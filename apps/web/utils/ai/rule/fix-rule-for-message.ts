import { z } from "zod";
import { createGenerateObject } from "@/utils/llms";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import {
  type CreateRuleSchema,
  createRuleSchema,
} from "@/utils/ai/rule/create-rule-schema";
import type { Logger } from "@/utils/logger";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";

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

type FixRuleExpected =
  | { kind: "new" }
  | { kind: "none" }
  | { kind: "rule"; id: string; name: string };

export async function aiFixRuleForMessage({
  emailAccount,
  emailForLLM,
  expected,
  targetRule,
  matchedRules,
  explanation,
  verifierFeedback,
  logger,
}: {
  emailAccount: EmailAccountWithAI;
  emailForLLM: string;
  expected: FixRuleExpected;
  targetRule?: RuleSnapshot;
  matchedRules?: RuleSnapshot[];
  explanation?: string;
  verifierFeedback?: string;
  logger: Logger;
}): Promise<{ assessment: string; rule: CreateRuleSchema }> {
  const system = getSystemPrompt();
  const prompt = getUserPrompt({
    emailForLLM,
    expected,
    targetRule,
    matchedRules,
    explanation,
    verifierFeedback,
  });

  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.PromptToRules,
  );

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Fix rule for message",
    modelOptions,
    promptHardening: { trust: "trusted" },
  });

  const aiResponse = await generateObject({
    ...modelOptions,
    prompt,
    system,
    schema: z.object({
      assessment: z
        .string()
        .describe(
          "Your own honest, independent one-sentence assessment of how this email should be classified and why. This is shown to the user for transparency; it does not need to agree with the user's chosen outcome.",
        ),
      rule: createRuleSchema(emailAccount.account.provider),
    }),
  });

  if (!aiResponse.object) {
    logger.error("No rule found in AI response", { aiResponse });
    throw new Error("No rule found in AI response");
  }

  return aiResponse.object;
}

function getSystemPrompt() {
  return `You are an AI assistant that fixes a single email-management rule so it correctly handles one specific email the user flagged as misclassified.

You will be told what the user expects to happen, and you must output a revised (or new) rule that achieves that outcome. You always output exactly one rule using the schema.

General principles:
- Prefer broadening or tightening the semantic "aiInstructions" condition over adding brittle static keyword matches.
- Preserve the rule's existing legitimate coverage and intent; make the smallest change that fixes this specific case.
- Preserve the rule's existing actions unless the user's explanation clearly implies a different action is needed.
- Use short, concise rule names (preferably a single word), consistent with the rule's existing name where one exists.
- Do not invent actions unsupported by the schema.
- If the user provided an explanation for why this email should be handled differently, fold that reasoning into the revised condition.
- If told that a previous attempt still failed verification, adjust your change so it addresses that specific feedback.

Output policy:
- Return a JSON object only. No prose and no markdown.
- The output must match the schema exactly: { "assessment": "...", "rule": { ... } }.
- "assessment" is your own independent read of how this email should be classified; it is shown to the user as-is, and their chosen outcome still wins regardless of whether you agree.`;
}

function getUserPrompt({
  emailForLLM,
  expected,
  targetRule,
  matchedRules,
  explanation,
  verifierFeedback,
}: {
  emailForLLM: string;
  expected: FixRuleExpected;
  targetRule?: RuleSnapshot;
  matchedRules?: RuleSnapshot[];
  explanation?: string;
  verifierFeedback?: string;
}) {
  const sections = [`<email>\n${emailForLLM}\n</email>`];

  sections.push(getExpectationSection({ expected, targetRule, matchedRules }));

  if (explanation) {
    sections.push(
      `The user gave this explanation for why this email should be handled this way:\n<explanation>\n${explanation}\n</explanation>`,
    );
  }

  if (verifierFeedback) {
    sections.push(
      `A previous attempt still did not work: ${verifierFeedback}. Adjust accordingly.`,
    );
  }

  return sections.join("\n\n");
}

function getExpectationSection({
  expected,
  targetRule,
  matchedRules,
}: {
  expected: FixRuleExpected;
  targetRule?: RuleSnapshot;
  matchedRules?: RuleSnapshot[];
}) {
  switch (expected.kind) {
    case "rule": {
      return `The user insists this email should be handled by the rule named "${expected.name}", but it currently does not match. Output a REVISED version of this rule with the SAME name and PRESERVE its existing actions and original intent, but with conditions broadened so it also matches this email:
<rule>
${JSON.stringify(targetRule, null, 2)}
</rule>`;
    }
    case "new": {
      return "The user wants a NEW rule created for emails like this one. Generate a concise rule (short name) that matches this kind of email, with sensible actions inferred from the email content and any explanation given.";
    }
    case "none": {
      const [primaryRule] = matchedRules ?? [];
      return `The user says this email should match NO rule, but the following rule(s) wrongly matched it. Output a revised version of the PRIMARY rule below, TIGHTENED so it no longer matches this email, while preserving its legitimate coverage and existing actions:
<primaryRule>
${JSON.stringify(primaryRule, null, 2)}
</primaryRule>
<allMatchedRules>
${JSON.stringify(matchedRules, null, 2)}
</allMatchedRules>`;
    }
    default: {
      const _exhaustive: never = expected;
      return _exhaustive;
    }
  }
}
