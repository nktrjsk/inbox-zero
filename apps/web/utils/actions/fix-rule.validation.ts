import { z } from "zod";

export const fixRuleForMessageBody = z.object({
  messageId: z.string(),
  threadId: z.string(),
  expected: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("new") }),
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("rule"),
      id: z.string(),
      name: z.string(),
    }),
  ]),
  explanation: z.string().nullish(),
  matchedRuleIds: z.array(z.string()).nullish(),
  verifierFeedback: z.string().nullish(),
});

export type FixRuleForMessageBody = z.infer<typeof fixRuleForMessageBody>;
