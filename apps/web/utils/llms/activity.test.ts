import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import prisma from "@/utils/__mocks__/prisma";
import {
  LLM_ACTIVITY_STALE_MS,
  withLlmActivityTracking,
} from "@/utils/llms/activity";

vi.mock("@/utils/prisma");

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeModel({
  doGenerate,
  doStream,
}: {
  doGenerate?: () => Promise<unknown>;
  doStream?: () => Promise<{ stream: ReadableStream }>;
} = {}): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: doGenerate ?? (async () => ({})),
    doStream:
      doStream ??
      (async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      })),
  } as unknown as LanguageModelV3;
}

function recordedTimestamps(): Date[] {
  return prisma.emailAccount.update.mock.calls.map(
    (call) => call[0].data.lastLlmActivityAt as Date,
  );
}

// Beats are fire-and-forget from inside the async middleware; yield so they land.
const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0);

describe("withLlmActivityTracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    prisma.emailAccount.update.mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records activity at call start and marks idle when the call finishes", async () => {
    const deferred = createDeferred<unknown>();
    const model = withLlmActivityTracking({
      model: fakeModel({ doGenerate: () => deferred.promise }),
      emailAccountId: "account-start-stop",
    });

    const callPromise = model.doGenerate({ prompt: [] } as never);
    await flushMicrotasks();

    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "account-start-stop" },
      data: { lastLlmActivityAt: new Date() },
    });

    deferred.resolve({});
    await callPromise;

    const timestamps = recordedTimestamps();
    const finalTimestamp = timestamps[timestamps.length - 1];
    expect(Date.now() - finalTimestamp.getTime()).toBeGreaterThanOrEqual(
      LLM_ACTIVITY_STALE_MS,
    );
  });

  it("keeps beating while a long call is in flight", async () => {
    const deferred = createDeferred<unknown>();
    const model = withLlmActivityTracking({
      model: fakeModel({ doGenerate: () => deferred.promise }),
      emailAccountId: "account-long-call",
    });

    const callPromise = model.doGenerate({ prompt: [] } as never);
    await flushMicrotasks();
    const beatsAtStart = prisma.emailAccount.update.mock.calls.length;

    await vi.advanceTimersByTimeAsync(65_000);

    expect(prisma.emailAccount.update.mock.calls.length).toBeGreaterThanOrEqual(
      beatsAtStart + 2,
    );
    // All beats so far are fresh (no idle backdate yet)
    for (const timestamp of recordedTimestamps()) {
      expect(Date.now() - timestamp.getTime()).toBeLessThan(
        LLM_ACTIVITY_STALE_MS,
      );
    }

    deferred.resolve({});
    await callPromise;
  });

  it("only marks idle after all concurrent calls finish", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    let call = 0;
    const model = withLlmActivityTracking({
      model: fakeModel({
        doGenerate: () => (++call === 1 ? first.promise : second.promise),
      }),
      emailAccountId: "account-concurrent",
    });

    const firstCall = model.doGenerate({ prompt: [] } as never);
    const secondCall = model.doGenerate({ prompt: [] } as never);
    await flushMicrotasks();

    first.resolve({});
    await firstCall;

    // No idle backdate yet: the second call is still running
    for (const timestamp of recordedTimestamps()) {
      expect(Date.now() - timestamp.getTime()).toBeLessThan(
        LLM_ACTIVITY_STALE_MS,
      );
    }

    second.resolve({});
    await secondCall;

    const timestamps = recordedTimestamps();
    const finalTimestamp = timestamps[timestamps.length - 1];
    expect(Date.now() - finalTimestamp.getTime()).toBeGreaterThanOrEqual(
      LLM_ACTIVITY_STALE_MS,
    );
  });

  it("stops the heartbeat when a call throws", async () => {
    const model = withLlmActivityTracking({
      model: fakeModel({
        doGenerate: () => Promise.reject(new Error("provider down")),
      }),
      emailAccountId: "account-throwing",
    });

    await expect(model.doGenerate({ prompt: [] } as never)).rejects.toThrow(
      "provider down",
    );

    const beatsAfterFailure = prisma.emailAccount.update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(prisma.emailAccount.update.mock.calls.length).toBe(
      beatsAfterFailure,
    );
  });

  it("marks idle when a stream completes", async () => {
    const model = withLlmActivityTracking({
      model: fakeModel(),
      emailAccountId: "account-stream",
    });

    const { stream } = await model.doStream({ prompt: [] } as never);

    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "account-stream" },
      data: { lastLlmActivityAt: new Date() },
    });

    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      // drain
    }

    const timestamps = recordedTimestamps();
    const finalTimestamp = timestamps[timestamps.length - 1];
    expect(Date.now() - finalTimestamp.getTime()).toBeGreaterThanOrEqual(
      LLM_ACTIVITY_STALE_MS,
    );
  });
});
