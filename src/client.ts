import { CORE_OPTIONS_ID, SDK_OPTIONS_ID, zapierCoreOptions } from "@zapier/zapier-sdk";
import { createSdk, zapierExperimentalSdkPlugin } from "@zapier/zapier-sdk/experimental";

export type Result = { data: unknown; nextCursor?: string };
export type Call = (method: string, input?: Record<string, unknown>) => Promise<Result>;

export function createCall(): Call {
  // Experimental methods would otherwise print a stability notice to stderr on every run.
  const sdk = createSdk(zapierExperimentalSdkPlugin, {
    configuration: { [SDK_OPTIONS_ID]: {}, [CORE_OPTIONS_ID]: { ...zapierCoreOptions, logStabilityNotice: () => {} } },
  }) as unknown as Record<string, (input?: Record<string, unknown>) => Promise<Result>>;
  return async (method, input) => {
    const fn = sdk[method];
    if (typeof fn !== "function") throw new Error(`Unknown SDK method: ${method}`);
    const clean = input ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) : undefined;
    return fn.call(sdk, clean);
  };
}
