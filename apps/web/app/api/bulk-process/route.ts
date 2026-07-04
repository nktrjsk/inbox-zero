import { NextResponse } from "next/server";
import { BulkProcessJobStatus } from "@/generated/prisma/enums";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type BulkProcessStatusResponse = Awaited<ReturnType<typeof getStatus>>;

export const GET = withEmailAccount("bulk-process", async (request) => {
  const { emailAccountId } = request.auth;
  const status = await getStatus({ emailAccountId });
  return NextResponse.json(status);
});

const jobSelect = {
  id: true,
  status: true,
  processed: true,
  ruleRuns: true,
  error: true,
  updatedAt: true,
} as const;

async function getStatus({ emailAccountId }: { emailAccountId: string }) {
  // Prefer a live run; otherwise show the most recent finished one.
  const running = await prisma.bulkProcessJob.findFirst({
    where: { emailAccountId, status: BulkProcessJobStatus.RUNNING },
    orderBy: { updatedAt: "desc" },
    select: jobSelect,
  });
  if (running) return { job: running };

  const job = await prisma.bulkProcessJob.findFirst({
    where: { emailAccountId },
    orderBy: { updatedAt: "desc" },
    select: jobSelect,
  });

  return { job };
}
