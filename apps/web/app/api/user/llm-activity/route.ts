import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { LLM_ACTIVITY_STALE_MS } from "@/utils/llms/activity";

export type LlmActivityResponse = Awaited<ReturnType<typeof getData>>;

async function getData({ emailAccountId }: { emailAccountId: string }) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { lastLlmActivityAt: true },
  });

  const lastActivityAt = emailAccount?.lastLlmActivityAt ?? null;
  const running =
    !!lastActivityAt &&
    Date.now() - lastActivityAt.getTime() < LLM_ACTIVITY_STALE_MS;

  return { running };
}

export const GET = withEmailAccount("user/llm-activity", async (request) => {
  const emailAccountId = request.auth.emailAccountId;

  const result = await getData({ emailAccountId });
  return NextResponse.json(result);
});
