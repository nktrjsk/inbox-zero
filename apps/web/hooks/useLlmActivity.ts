import useSWR from "swr";
import type { LlmActivityResponse } from "@/app/api/user/llm-activity/route";

/**
 * Whether the server is currently making LLM calls for this email account
 * (e.g. automatic rule runs on incoming mail). Polls faster while active so
 * the indicator turns off promptly.
 */
export function useLlmActivity() {
  const { data } = useSWR<LlmActivityResponse>("/api/user/llm-activity", {
    refreshInterval: (latest) => (latest?.running ? 5000 : 15_000),
  });

  return { serverRunning: data?.running ?? false };
}
