import {
  CheckCircle2Icon,
  Loader2Icon,
  WandSparklesIcon,
  XCircleIcon,
} from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ParsedMessage } from "@/utils/types";
import type { RunRulesResult } from "@/utils/ai/choose-rule/run-rules";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { LoadingContent } from "@/components/LoadingContent";
import { useRules } from "@/hooks/useRules";
import { useModal } from "@/hooks/useModal";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  NEW_RULE_ID,
  NONE_RULE_ID,
} from "@/app/(app)/[emailAccountId]/assistant/consts";
import { Label } from "@/components/Input";
import { ButtonList } from "@/components/ButtonList";
import type { RulesResponse } from "@/app/api/user/rules/route";
import { ResultsDisplay } from "@/app/(app)/[emailAccountId]/assistant/ResultDisplay";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toastError } from "@/components/Toast";
import { runRulesAction } from "@/utils/actions/ai-rule";
import { fixRuleForMessageAction } from "@/utils/actions/fix-rule";
import {
  computeMatchesExpected,
  type MatchedRuleSummary,
} from "@/utils/ai/choose-rule/matches-expected";
import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";
import type { SerializedMatchReason } from "@/utils/ai/choose-rule/types";

type FixRuleResult = RunRulesResult & {
  matchMetadata?: SerializedMatchReason[] | null;
};

type WizardStep = "select" | "explain" | "verify";

// The email currently classifies wrong; the wizard makes the rule change,
// then INDEPENDENTLY re-classifies it and checks the result against the rule
// the user picked. Exactly one correction attempt — no runaway loop.
type VerifyPhase =
  | "fixing"
  | "verifying"
  | "correcting"
  | "applying"
  | "matched"
  | "unresolved"
  | "error";

type VerifyState = {
  phase: VerifyPhase;
  assessment: string | null;
  independentOutcome: string | null;
  reason: string | null;
  changedRuleName: string | null;
  errorMessage: string | null;
};

export function FixRule({
  message,
  results,
  onApplied,
}: {
  message: ParsedMessage;
  results: FixRuleResult[];
  onApplied?: () => void;
}) {
  const { emailAccountId } = useAccount();
  const { data, isLoading, error, mutate: mutateRules } = useRules();
  const { isModalOpen, setIsModalOpen } = useModal();

  const [step, setStep] = useState<WizardStep>("select");
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [explanation, setExplanation] = useState("");
  const [verifyState, setVerifyState] = useState<VerifyState | null>(null);

  const selectedRuleName = useMemo(() => {
    if (!data) return null;
    if (selectedRuleId === NEW_RULE_ID) return "New rule";
    if (selectedRuleId === NONE_RULE_ID) return "None";
    return data.find((r) => r.id === selectedRuleId)?.name ?? null;
  }, [data, selectedRuleId]);

  const resetState = () => {
    setStep("select");
    setSelectedRuleId(null);
    setExplanation("");
    setVerifyState(null);
  };

  const handleClose = (open: boolean) => {
    setIsModalOpen(open);
    if (!open) resetState();
  };

  const handleRuleSelect = (ruleId: string | null) => {
    setSelectedRuleId(ruleId);
    setStep("explain");
  };

  const handleStartFix = () => {
    if (!selectedRuleId) return;
    setStep("verify");
    runFixFlow({
      emailAccountId,
      message,
      results,
      selectedRuleId,
      selectedRuleName,
      explanation,
      setVerifyState,
      onResolved: () => {
        mutateRules();
        onApplied?.();
      },
    }).catch(() => {
      // runFixFlow surfaces its own errors via toast + verify state.
    });
  };

  return (
    <Dialog open={isModalOpen} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <WandSparklesIcon className="mr-2 size-4" />
          Fix
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fix classification</DialogTitle>
        </DialogHeader>

        <LoadingContent loading={isLoading} error={error}>
          {data && step === "select" ? (
            <RuleMismatch
              results={results}
              rules={data}
              onSelectExpectedRuleId={handleRuleSelect}
            />
          ) : data && step === "explain" ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">You picked:</span>
                <Badge variant="secondary">
                  {expectedLabel(selectedRuleId, selectedRuleName)}
                </Badge>
              </div>

              <div>
                <Label
                  name="explanation"
                  label="Why should it be classified this way? (optional)"
                />
                <Textarea
                  id="explanation"
                  name="explanation"
                  className="mt-1"
                  rows={2}
                  value={explanation}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                    setExplanation(e.target.value)
                  }
                  autoFocus
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The assistant will change your rules, then independently
                  re-check that this email lands where you picked.
                </p>
              </div>

              <div className="flex justify-between gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep("select");
                    setSelectedRuleId(null);
                    setExplanation("");
                  }}
                >
                  Back
                </Button>
                <Button onClick={handleStartFix}>Fix &amp; verify</Button>
              </div>
            </div>
          ) : step === "verify" && verifyState ? (
            <VerifyStep
              expectedLabelText={expectedLabel(
                selectedRuleId,
                selectedRuleName,
              )}
              state={verifyState}
              onRetry={handleStartFix}
              onDone={() => handleClose(false)}
            />
          ) : null}
        </LoadingContent>
      </DialogContent>
    </Dialog>
  );
}

function VerifyStep({
  expectedLabelText,
  state,
  onRetry,
  onDone,
}: {
  expectedLabelText: string;
  state: VerifyState;
  onRetry: () => void;
  onDone: () => void;
}) {
  const busy =
    state.phase === "fixing" ||
    state.phase === "verifying" ||
    state.phase === "correcting" ||
    state.phase === "applying";

  return (
    <div className="space-y-4">
      <dl className="space-y-3 text-sm">
        <FactRow label="Assistant thinks">
          {state.assessment ? (
            <span>
              {state.assessment}{" "}
              <span className="text-muted-foreground">(you decide)</span>
            </span>
          ) : (
            <PhaseSpinner text="Reviewing the email…" />
          )}
        </FactRow>

        <FactRow label="You picked">
          <Badge variant="secondary">{expectedLabelText}</Badge>
        </FactRow>

        <FactRow label="Independent check">
          <IndependentCheck state={state} />
        </FactRow>
      </dl>

      {state.phase === "matched" ? (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">
          Applied — this email is now handled as you picked
          {state.changedRuleName ? ` (rule "${state.changedRuleName}")` : ""}.
        </p>
      ) : null}

      {state.phase === "unresolved" ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          I changed the rule but the independent classifier still doesn&apos;t
          agree, so I stopped rather than loop.
          {state.reason ? ` Why: ${state.reason}` : ""}
        </p>
      ) : null}

      {state.phase === "error" ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {state.errorMessage ?? "Something went wrong."}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        {!busy && state.phase !== "matched" ? (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <Button onClick={onDone} disabled={busy}>
          {state.phase === "matched" ? "Done" : "Close"}
        </Button>
      </div>
    </div>
  );
}

function IndependentCheck({ state }: { state: VerifyState }) {
  if (state.phase === "fixing") {
    return <PhaseSpinner text="Updating your rules…" />;
  }
  if (state.phase === "verifying" || state.phase === "correcting") {
    return (
      <PhaseSpinner
        text={
          state.phase === "correcting"
            ? "Didn't match — correcting once and re-checking…"
            : "Re-classifying independently…"
        }
      />
    );
  }
  if (state.phase === "applying") {
    return <PhaseSpinner text="Match confirmed — applying…" />;
  }
  if (state.phase === "matched") {
    return (
      <span className="inline-flex items-center gap-1.5 text-green-700 dark:text-green-400">
        <CheckCircle2Icon className="size-4" />
        Matches your pick
      </span>
    );
  }
  if (state.phase === "unresolved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <XCircleIcon className="size-4" />
        Classifier says{" "}
        {state.independentOutcome
          ? `"${state.independentOutcome}"`
          : "no match"}
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function PhaseSpinner({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      {text}
    </span>
  );
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="w-36 shrink-0 font-medium text-muted-foreground">
        {label}
      </dt>
      <dd className="flex-1">{children}</dd>
    </div>
  );
}

function RuleMismatch({
  results,
  rules,
  onSelectExpectedRuleId,
}: {
  results: FixRuleResult[];
  rules: RulesResponse;
  onSelectExpectedRuleId: (ruleId: string | null) => void;
}) {
  return (
    <div>
      <Label name="matchedRule" label="Matched:" />
      <div className="mt-1">
        {results.length > 0 ? (
          <ResultsDisplay results={results} />
        ) : (
          <p>No rule matched</p>
        )}
      </div>
      <div className="mt-4">
        <ButtonList
          title="Which rule did you expect it to match?"
          emptyMessage="You haven't created any rules yet!"
          items={[
            { id: NONE_RULE_ID, name: "❌ None" },
            { id: NEW_RULE_ID, name: "✨ New rule" },
            ...rules,
          ]}
          onSelect={onSelectExpectedRuleId}
          itemClassName="h-auto min-h-10 justify-start whitespace-normal text-wrap py-2 text-left"
        />
      </div>
    </div>
  );
}

function expectedLabel(
  selectedRuleId: string | null,
  selectedRuleName: string | null,
) {
  if (selectedRuleId === NEW_RULE_ID) return "✨ New rule";
  if (selectedRuleId === NONE_RULE_ID) return "❌ None (no rule should match)";
  return selectedRuleName || "Unknown";
}

async function runFixFlow({
  emailAccountId,
  message,
  results,
  selectedRuleId,
  selectedRuleName,
  explanation,
  setVerifyState,
  onResolved,
}: {
  emailAccountId: string;
  message: ParsedMessage;
  results: FixRuleResult[];
  selectedRuleId: string;
  selectedRuleName: string | null;
  explanation: string;
  setVerifyState: (state: VerifyState) => void;
  onResolved: () => void;
}) {
  const base: VerifyState = {
    phase: "fixing",
    assessment: null,
    independentOutcome: null,
    reason: null,
    changedRuleName: null,
    errorMessage: null,
  };
  let current = base;
  const update = (patch: Partial<VerifyState>) => {
    current = { ...current, ...patch };
    setVerifyState(current);
  };
  update({});

  const expectedForMatch = toExpectedForMatch(selectedRuleId, selectedRuleName);
  const expectedForAction = toExpectedForAction(
    selectedRuleId,
    selectedRuleName,
  );
  const matchedRuleIds = results
    .map((r) => r.rule?.id)
    .filter((id): id is string => !!id);
  const trimmedExplanation = explanation.trim() || undefined;

  try {
    const runFix = async (verifierFeedback?: string) => {
      const result = await fixRuleForMessageAction(emailAccountId, {
        messageId: message.id,
        threadId: message.threadId,
        expected: expectedForAction,
        explanation: trimmedExplanation,
        matchedRuleIds,
        verifierFeedback,
      });
      if (result?.serverError) throw new Error(result.serverError);
      return result?.data ?? null;
    };

    const verify = async () => {
      const result = await runRulesAction(emailAccountId, {
        messageId: message.id,
        threadId: message.threadId,
        isTest: true,
      });
      if (result?.serverError) throw new Error(result.serverError);
      return summarizeVerification(result?.data ?? []);
    };

    let fix = await runFix();
    update({
      assessment: fix?.assessment ?? null,
      changedRuleName: fix?.ruleName ?? null,
    });

    update({ phase: "verifying" });
    let verification = await verify();
    let matches = computeMatchesExpected({
      expected: expectedForMatch,
      status: verification.status,
      matchedRules: verification.matchedRules,
    });

    if (!matches) {
      update({ phase: "correcting" });
      fix = await runFix(verification.reason ?? undefined);
      update({
        assessment: fix?.assessment ?? current.assessment,
        changedRuleName: fix?.ruleName ?? current.changedRuleName,
        phase: "verifying",
      });
      verification = await verify();
      matches = computeMatchesExpected({
        expected: expectedForMatch,
        status: verification.status,
        matchedRules: verification.matchedRules,
      });
    }

    if (!matches) {
      update({
        phase: "unresolved",
        reason: verification.reason,
        independentOutcome: verification.primaryRuleName,
      });
      return;
    }

    update({ phase: "applying" });
    const applyResult = await runRulesAction(emailAccountId, {
      messageId: message.id,
      threadId: message.threadId,
      isTest: false,
      rerun: true,
    });
    if (applyResult?.serverError) throw new Error(applyResult.serverError);

    update({ phase: "matched" });
    onResolved();
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Failed to fix the rule.";
    toastError({ title: "Couldn't fix the rule", description: errorMessage });
    update({ phase: "error", errorMessage });
  }
}

function summarizeVerification(results: RunRulesResult[]) {
  const matchedRules: MatchedRuleSummary[] = results
    .filter((r) => !!r.rule)
    .map((r) => ({
      ruleId: r.rule?.id ?? null,
      ruleName: r.rule?.name ?? null,
      systemType: r.rule?.systemType ?? null,
    }));
  return {
    status: matchedRules.length ? ("matched" as const) : ("no_match" as const),
    matchedRules,
    reason: results[0]?.reason ?? null,
    primaryRuleName: matchedRules[0]?.ruleName ?? null,
  };
}

function toExpectedForMatch(
  selectedRuleId: string,
  selectedRuleName: string | null,
): NonNullable<MessageContext["expected"]> {
  if (selectedRuleId === NEW_RULE_ID) return "new";
  if (selectedRuleId === NONE_RULE_ID) return "none";
  return { id: selectedRuleId, name: selectedRuleName || "Unknown" };
}

function toExpectedForAction(
  selectedRuleId: string,
  selectedRuleName: string | null,
) {
  if (selectedRuleId === NEW_RULE_ID) return { kind: "new" as const };
  if (selectedRuleId === NONE_RULE_ID) return { kind: "none" as const };
  return {
    kind: "rule" as const,
    id: selectedRuleId,
    name: selectedRuleName || "Unknown",
  };
}
