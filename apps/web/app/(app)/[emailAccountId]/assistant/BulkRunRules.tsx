"use client";

import { useState } from "react";
import { useQueryState } from "nuqs";
import { useAction } from "next-safe-action/hooks";
import { Loader2Icon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionDescription } from "@/components/Typography";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError } from "@/components/Toast";
import { PremiumAlertWithData } from "@/components/PremiumAlert";
import { usePremium } from "@/hooks/usePremium";
import { useBulkProcess } from "@/hooks/useBulkProcess";
import { SetDateDropdown } from "@/app/(app)/[emailAccountId]/assistant/SetDateDropdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAccount } from "@/providers/EmailAccountProvider";
import { Toggle } from "@/components/Toggle";
import { hasTierAccess } from "@/utils/premium";
import {
  startBulkProcessAction,
  stopBulkProcessAction,
} from "@/utils/actions/bulk-process";
import { getActionErrorMessage } from "@/utils/error";
import { useEndStripeTrial } from "@/hooks/useEndStripeTrial";

const TRIAL_BULK_PROCESS_EMAIL_LIMIT = 200;

export function BulkRunRules() {
  const { emailAccountId } = useAccount();

  // URL-driven so the sidebar agent-running indicator can deep-link here
  const [bulkProgress, setBulkProgress] = useQueryState("bulk-progress");
  const isOpen = bulkProgress === "open";
  const setIsOpen = (open: boolean) => setBulkProgress(open ? "open" : null);

  const { job, isLoading: isLoadingJob, mutate } = useBulkProcess();

  const {
    hasAiAccess,
    isLoading: isLoadingPremium,
    premium,
    tier,
  } = usePremium();
  const { loading: loadingEndTrial, endTrial } = useEndStripeTrial();

  const isBusinessPlusTier = hasTierAccess({
    tier: tier || null,
    minimumTier: "PROFESSIONAL_MONTHLY",
  });
  const isTrial = premium?.stripeSubscriptionStatus === "trialing";

  const [startDate, setStartDate] = useState<Date | undefined>();
  const [endDate, setEndDate] = useState<Date | undefined>();
  const [includeRead, setIncludeRead] = useState(false);

  const isRunning = job?.status === "RUNNING";

  const { execute: start, isExecuting: isStarting } = useAction(
    startBulkProcessAction.bind(null, emailAccountId),
    {
      onSuccess: () => mutate(),
      onError: ({ error }) => {
        toastError({
          title: "Failed to start",
          description: getActionErrorMessage(error),
        });
      },
    },
  );

  const { execute: stop } = useAction(
    stopBulkProcessAction.bind(null, emailAccountId),
    { onSettled: () => mutate() },
  );

  const handleStart = () => {
    if (!startDate) {
      toastError({ description: "Please select a start date" });
      return;
    }
    start({
      after: startDate,
      before: endDate,
      includeRead,
      maxEmails: isTrial ? TRIAL_BULK_PROCESS_EMAIL_LIMIT : undefined,
    });
  };

  const handleStop = () => {
    if (job) stop({ jobId: job.id });
  };

  return (
    <div>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            Process Past Emails
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bulk Process Emails</DialogTitle>
            <DialogDescription>
              Run your rules on emails in your inbox that haven't been handled
              yet. Processing continues on the server, so you can close this
              tab.
            </DialogDescription>
          </DialogHeader>

          <ProgressBanner job={job} />

          <LoadingContent loading={isLoadingPremium || isLoadingJob}>
            <div className="flex min-w-0 flex-col space-y-4 overflow-hidden">
              <PremiumAlertWithData className="mr-auto" />

              <div className="grid grid-cols-2 gap-2">
                <SetDateDropdown
                  onChange={setStartDate}
                  value={startDate}
                  placeholder="Set start date"
                  disabled={isRunning}
                />
                <SetDateDropdown
                  onChange={setEndDate}
                  value={endDate}
                  placeholder="Set end date (optional)"
                  disabled={isRunning}
                />
              </div>

              <Toggle
                name="include-read"
                label="Include read emails"
                enabled={includeRead}
                onChange={setIncludeRead}
                disabled={isRunning || !isBusinessPlusTier}
                disabledTooltipText={
                  !isBusinessPlusTier && hasAiAccess
                    ? "Including read emails is available on the Professional plan."
                    : undefined
                }
              />

              {isTrial && (
                <div className="flex flex-col gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    Trials can process up to {TRIAL_BULK_PROCESS_EMAIL_LIMIT}{" "}
                    past emails at a time.
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={loadingEndTrial}
                    onClick={endTrial}
                    className="self-start border-blue-300 bg-white text-blue-900 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100 dark:hover:bg-blue-900 sm:self-auto"
                  >
                    Start paid plan now
                  </Button>
                </div>
              )}

              {isRunning ? (
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={handleStop}>
                    <SquareIcon className="mr-1.5 h-3.5 w-3.5" />
                    Stop
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  loading={isStarting}
                  disabled={!startDate || !emailAccountId || !hasAiAccess}
                  onClick={handleStart}
                >
                  Process Emails
                </Button>
              )}
            </div>
          </LoadingContent>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProgressBanner({
  job,
}: {
  job: ReturnType<typeof useBulkProcess>["job"];
}) {
  if (!job) return null;

  if (job.status === "RUNNING") {
    return (
      <Banner className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
        <Loader2Icon className="h-4 w-4 animate-spin" />
        Processing… {job.processed} emails checked, {job.ruleRuns} matched by
        rules so far.
      </Banner>
    );
  }

  if (job.status === "COMPLETED") {
    return (
      <Banner className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
        Done. Checked {job.processed} emails and ran rules on {job.ruleRuns}.
      </Banner>
    );
  }

  if (job.status === "STOPPED") {
    return (
      <Banner className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950">
        Stopped after checking {job.processed} emails ({job.ruleRuns} matched).
      </Banner>
    );
  }

  return (
    <Banner className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
      Processing failed{job.error ? `: ${job.error}` : "."} Checked{" "}
      {job.processed} emails before stopping.
    </Banner>
  );
}

function Banner({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border px-2 py-1.5 ${className ?? ""}`}>
      <SectionDescription className="mt-0 flex items-center gap-2">
        {children}
      </SectionDescription>
    </div>
  );
}
