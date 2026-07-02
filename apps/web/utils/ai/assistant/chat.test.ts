import { describe, expect, it, vi } from "vitest";
import { buildResolvedSystemPrompt } from "@/utils/ai/assistant/chat";

vi.mock("server-only", () => ({}));

describe("buildResolvedSystemPrompt", () => {
  it("uses Outlook category wording instead of label wording", () => {
    const prompt = buildResolvedSystemPrompt({
      emailSendToolsEnabled: true,
      draftReplyActionsEnabled: true,
      webhookActionsEnabled: true,
      provider: "microsoft",
      responseSurface: "web",
      userTimezone: "UTC",
    });

    expect(prompt).toContain("category");
    expect(prompt).not.toMatch(/\blabels?\b/i);
  });

  // A changing system prompt invalidates provider prompt caches on every
  // message, forcing a full prompt re-read per turn (very slow on local models).
  it("is byte-stable across calls with the same inputs", async () => {
    const build = () =>
      buildResolvedSystemPrompt({
        emailSendToolsEnabled: true,
        draftReplyActionsEnabled: true,
        webhookActionsEnabled: true,
        provider: "google",
        responseSurface: "web",
        userTimezone: "Europe/Prague",
      });

    const first = build();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(build()).toBe(first);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
