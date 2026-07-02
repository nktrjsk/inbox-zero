"use client";

import { useAction } from "next-safe-action/hooks";
import useSWR from "swr";
import type { GetImapSettingsResponse } from "@/app/api/user/imap-settings/route";
import { Switch } from "@/components/ui/switch";
import { LoadingContent } from "@/components/LoadingContent";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemSeparator,
} from "@/components/ui/item";
import { updateImapSettingsAction } from "@/utils/actions/imap";
import { toastError, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { BRAND_NAME } from "@/utils/branding";

export function ImapSettingsSection({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  const { data, isLoading, error, mutate } = useSWR<GetImapSettingsResponse>(
    emailAccountId ? ["/api/user/imap-settings", emailAccountId] : null,
  );

  const { execute, isExecuting } = useAction(
    updateImapSettingsAction.bind(null, emailAccountId),
    {
      onSuccess: (res) => {
        if (!res.data) return;
        mutate({ folderSortingEnabled: res.data.folderSortingEnabled }, false);
        toastSuccess({
          description: res.data.folderSortingEnabled
            ? "Label rules will now move emails into IMAP folders."
            : `Label rules will now only be tracked inside ${BRAND_NAME}.`,
        });
      },
      onError: (error) => {
        toastError({ description: getActionErrorMessage(error.error) });
      },
    },
  );

  return (
    <LoadingContent loading={isLoading} error={error}>
      {data && (
        <>
          <ItemSeparator />
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Sort into IMAP folders</ItemTitle>
              <ItemDescription>
                {`When enabled, label rules move emails into real folders in your mailbox. When disabled, sorting is only tracked inside ${BRAND_NAME} and your mailbox is left untouched.`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Toggle IMAP folder sorting"
                checked={data.folderSortingEnabled}
                disabled={isExecuting}
                onCheckedChange={(checked) =>
                  execute({ folderSortingEnabled: checked })
                }
              />
            </ItemActions>
          </Item>
        </>
      )}
    </LoadingContent>
  );
}
