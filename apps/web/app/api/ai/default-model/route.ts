import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { getConfiguredRolePrimaryModelEntry } from "@/utils/llms/model";

export type GetDefaultModelResponse = Awaited<
  ReturnType<typeof getDefaultModel>
>;

async function getDefaultModel() {
  const defaultModel = getConfiguredRolePrimaryModelEntry("default");

  return {
    provider: defaultModel?.provider ?? null,
    modelName: defaultModel?.modelName ?? null,
  };
}

export const GET = withAuth("api/ai/default-model", async () => {
  const result = await getDefaultModel();

  return NextResponse.json(result);
});
