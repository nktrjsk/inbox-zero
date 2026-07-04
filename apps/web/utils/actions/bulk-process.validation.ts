import { z } from "zod";

export const startBulkProcessBody = z.object({
  after: z.coerce.date(),
  before: z.coerce.date().optional(),
  includeRead: z.boolean().default(false),
  maxEmails: z.number().int().positive().optional(),
});
export type StartBulkProcessBody = z.infer<typeof startBulkProcessBody>;

export const stopBulkProcessBody = z.object({
  jobId: z.string(),
});
