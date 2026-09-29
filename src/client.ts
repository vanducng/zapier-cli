import { CORE_OPTIONS_ID, SDK_OPTIONS_ID, zapierCoreOptions } from "@zapier/zapier-sdk";
import { createSdk, zapierExperimentalSdkPlugin } from "@zapier/zapier-sdk/experimental";
import { getZapConfiguration, listZapConfigurations } from "./workflow-api.ts";

export type PageInfo = { count: number | null; offset: number | null; limit: number | null; next_offset: number | null };
export type Result = { data: unknown; nextCursor?: string; page?: PageInfo };
export type Call = (method: string, input?: Record<string, unknown>) => Promise<Result>;

const WORKFLOW_READS: Record<string, (input: Record<string, unknown>) => Promise<Result>> = {
  listZapConfigurations,
  getZapConfiguration,
};

export function createCall(): Call {
  // Experimental methods would otherwise print a stability notice to stderr on every run.
  const sdk = createSdk(zapierExperimentalSdkPlugin, {
    configuration: { [SDK_OPTIONS_ID]: {}, [CORE_OPTIONS_ID]: { ...zapierCoreOptions, logStabilityNotice: () => {} } },
  }) as unknown as Record<string, (input?: Record<string, unknown>) => Promise<Result>>;
  return async (method, input) => {
    const clean = input ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) : undefined;
    const workflowRead = WORKFLOW_READS[method];
    if (workflowRead) return workflowRead(clean ?? {});
    const fn = sdk[method];
    if (typeof fn !== "function") throw new Error(`Unknown SDK method: ${method}`);
    return fn.call(sdk, clean);
  };
}
