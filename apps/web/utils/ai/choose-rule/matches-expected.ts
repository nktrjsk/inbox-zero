import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";

export type MatchedRuleSummary = {
  ruleId: string | null;
  ruleName: string | null;
  systemType: string | null;
};

// Deterministic check of whether a classification result matches the outcome
// the user picked in the Fix flow. Kept out of the LLM loop on purpose: the
// verifier grades the independent classifier against the user's choice, the
// user is always the authority.
export function computeMatchesExpected({
  expected,
  status,
  matchedRules,
}: {
  expected: NonNullable<MessageContext["expected"]>;
  status: "matched" | "no_match";
  matchedRules: MatchedRuleSummary[];
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
