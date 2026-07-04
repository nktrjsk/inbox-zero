"use server";

import { BulkProcessJobStatus } from "@/generated/prisma/enums";
import { actionClient } from "@/utils/actions/safe-action";
import {
  startBulkProcessBody,
  stopBulkProcessBody,
} from "@/utils/actions/bulk-process.validation";
import { enqueueBulkProcessPage } from "@/utils/bulk-process/execute";
import prisma from "@/utils/prisma";

export const startBulkProcessAction = actionClient
  .metadata({ name: "startBulkProcess" })
  .inputSchema(startBulkProcessBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { after, before, includeRead, maxEmails },
    }) => {
      // Reuse an in-flight job for this account rather than fanning out runs.
      const running = await prisma.bulkProcessJob.findFirst({
        where: { emailAccountId, status: BulkProcessJobStatus.RUNNING },
        select: { id: true },
      });
      if (running) return { jobId: running.id };

      const job = await prisma.bulkProcessJob.create({
        data: {
          emailAccountId,
          after,
          before,
          includeRead,
          maxEmails,
          status: BulkProcessJobStatus.RUNNING,
        },
        select: { id: true },
      });

      await enqueueBulkProcessPage({ jobId: job.id, logger });

      return { jobId: job.id };
    },
  );

export const stopBulkProcessAction = actionClient
  .metadata({ name: "stopBulkProcess" })
  .inputSchema(stopBulkProcessBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { jobId } }) => {
    await prisma.bulkProcessJob.updateMany({
      where: {
        id: jobId,
        emailAccountId,
        status: BulkProcessJobStatus.RUNNING,
      },
      data: { status: BulkProcessJobStatus.STOPPED },
    });

    return { success: true };
  });
