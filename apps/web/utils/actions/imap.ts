"use server";

import prisma from "@/utils/prisma";
import { actionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import { updateImapSettingsBody } from "@/utils/actions/imap.validation";

export const updateImapSettingsAction = actionClient
  .metadata({ name: "updateImapSettings" })
  .inputSchema(updateImapSettingsBody)
  .action(
    async ({
      parsedInput: { folderSortingEnabled },
      ctx: { emailAccountId },
    }) => {
      const credential = await prisma.imapCredential.findFirst({
        where: { account: { emailAccount: { id: emailAccountId } } },
        select: { id: true },
      });

      if (!credential) throw new SafeError("Not an IMAP account");

      await prisma.imapCredential.update({
        where: { id: credential.id },
        data: { folderSortingEnabled },
      });

      return { folderSortingEnabled };
    },
  );
