import useSWR from "swr";
import type { BulkProcessStatusResponse } from "@/app/api/bulk-process/route";

/**
 * Status of the durable server-side "Process Past Emails" job for this account.
 * Polls faster while a run is in flight so progress and completion show promptly.
 */
export function useBulkProcess() {
  const { data, isLoading, mutate } = useSWR<BulkProcessStatusResponse>(
    "/api/bulk-process",
    {
      refreshInterval: (latest) =>
        latest?.job?.status === "RUNNING" ? 3000 : 0,
    },
  );

  return { job: data?.job ?? null, isLoading, mutate };
}
