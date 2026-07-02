import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withEmailAccount } from "@/utils/middleware";
import { SafeError } from "@/utils/error";

export type GetImapSettingsResponse = Awaited<
  ReturnType<typeof getImapSettings>
>;

async function getImapSettings({ emailAccountId }: { emailAccountId: string }) {
  const credential = await prisma.imapCredential.findFirst({
    where: { account: { emailAccount: { id: emailAccountId } } },
    select: { folderSortingEnabled: true },
  });

  if (!credential) throw new SafeError("Not an IMAP account");

  return { folderSortingEnabled: credential.folderSortingEnabled };
}

export const GET = withEmailAccount("user/imap-settings", async (request) => {
  const result = await getImapSettings({
    emailAccountId: request.auth.emailAccountId,
  });

  return NextResponse.json(result);
});
