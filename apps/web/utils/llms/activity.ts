import { wrapLanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("llm-activity");

// Readers treat the account as running while lastLlmActivityAt is fresher
// than this. Must comfortably exceed HEARTBEAT_INTERVAL_MS so a slow beat
// doesn't flicker the indicator off mid-call.
export const LLM_ACTIVITY_STALE_MS = 75_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
// Safety cap: if a call never settles (lost stream, hung provider), stop
// beating so the indicator can't stay on forever.
const MAX_TRACKED_CALL_MS = 15 * 60_000;

// One heartbeat per account per process, shared by concurrent calls.
const activeCalls = new Map<
  string,
  { count: number; interval: NodeJS.Timeout }
>();

/**
 * Wraps a model so every generate/stream call maintains a heartbeat on
 * EmailAccount.lastLlmActivityAt while in flight. Covers retries and
 * fallbacks since it sits at the model layer. Crash-safe: readers apply a
 * staleness cutoff, so a missed stop only lingers for LLM_ACTIVITY_STALE_MS.
 */
export function withLlmActivityTracking({
  model,
  emailAccountId,
}: {
  model: LanguageModelV3;
  emailAccountId: string;
}): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const stop = trackCallStart(emailAccountId);
        try {
          return await doGenerate();
        } finally {
          stop();
        }
      },
      wrapStream: async ({ doStream }) => {
        const stop = trackCallStart(emailAccountId);
        try {
          const { stream, ...rest } = await doStream();
          // `cancel` (consumer aborts the stream) is supported by Node but
          // missing from TS lib.dom's Transformer type, hence the intersection.
          const stopWhenStreamEnds: Transformer<
            LanguageModelV3StreamPart,
            LanguageModelV3StreamPart
          > & { cancel: () => void } = {
            flush: () => stop(),
            cancel: () => stop(),
          };
          return {
            ...rest,
            stream: stream.pipeThrough(new TransformStream(stopWhenStreamEnds)),
          };
        } catch (error) {
          stop();
          throw error;
        }
      },
    },
  });
}

function trackCallStart(emailAccountId: string): () => void {
  const entry = activeCalls.get(emailAccountId);
  if (entry) {
    entry.count++;
  } else {
    recordActivity(emailAccountId, new Date());
    const interval = setInterval(
      () => recordActivity(emailAccountId, new Date()),
      HEARTBEAT_INTERVAL_MS,
    );
    interval.unref?.();
    activeCalls.set(emailAccountId, { count: 1, interval });
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(safetyTimeout);
    const active = activeCalls.get(emailAccountId);
    if (!active) return;
    active.count--;
    if (active.count <= 0) {
      clearInterval(active.interval);
      activeCalls.delete(emailAccountId);
      // Backdate past the staleness cutoff so the indicator turns off
      // immediately instead of lingering for LLM_ACTIVITY_STALE_MS.
      recordActivity(
        emailAccountId,
        new Date(Date.now() - LLM_ACTIVITY_STALE_MS),
      );
    }
  };
  const safetyTimeout = setTimeout(stop, MAX_TRACKED_CALL_MS);
  safetyTimeout.unref?.();
  return stop;
}

// Fire-and-forget; must never break the LLM call it instruments.
function recordActivity(emailAccountId: string, timestamp: Date) {
  try {
    Promise.resolve(
      prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: { lastLlmActivityAt: timestamp },
      }),
    ).catch((error) => {
      logger.warn("Failed to record LLM activity heartbeat", {
        emailAccountId,
        error,
      });
    });
  } catch (error) {
    logger.warn("Failed to record LLM activity heartbeat", {
      emailAccountId,
      error,
    });
  }
}
