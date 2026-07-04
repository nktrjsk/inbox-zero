import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";
import {
  executeBulkProcessBody,
  executeBulkProcessPage,
} from "@/utils/bulk-process/execute";

export const maxDuration = 300;

export const POST = withError(
  "bulk-process/execute",
  withQstashOrInternal(async (request) => {
    const logger = request.logger;

    const rawPayload = await request.json();
    const validation = executeBulkProcessBody.safeParse(rawPayload);

    if (!validation.success) {
      logger.error("Invalid bulk process execute payload", {
        errors: validation.error.issues,
      });
      return new Response("Invalid payload", { status: 400 });
    }

    await executeBulkProcessPage({ jobId: validation.data.jobId, logger });

    return new Response("OK", { status: 200 });
  }),
);
