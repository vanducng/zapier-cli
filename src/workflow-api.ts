import type { PageInfo, Result } from "./client.ts";
import { CliError, redact } from "./errors.ts";

const ENDPOINT = "https://api.zapier.com/v2/zaps";
const TOKEN_ENV = "ZAP_WORKFLOW_ACCESS_TOKEN";
const MAX_PAGES = 100;

type Deps = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch };

function validation(message: string): CliError {
  return new CliError("validation_error", message, { nextSteps: ["Correct the input and retry."] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw validation("limit must be a positive integer.");
  return value;
}

function optionalOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw validation("offset must be a non-negative integer.");
  return value;
}

function accessToken(env: NodeJS.ProcessEnv): string {
  const token = env[TOKEN_ENV]?.trim();
  if (!token) {
    throw new CliError("auth_required", "A Workflow API user access token is required to read Zap configuration.", {
      nextSteps: [
        `Set ${TOKEN_ENV} to a user access token with scope zap:all.`,
        "Create that token with the Workflow API user access-token flow, not zapier-sdk login.",
        "Docs: https://docs.zapier.com/powered-by-zapier/authentication/methods/user-access-token",
      ],
    });
  }
  return token;
}

function scrub(text: string, token: string): string {
  return redact(token ? text.split(token).join("[redacted]") : text).slice(0, 500);
}

function errorDetail(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.errors) || !isRecord(body.errors[0])) return undefined;
  const detail = body.errors[0].detail;
  return typeof detail === "string" && detail.trim() ? detail.trim() : undefined;
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function httpError(status: number, body: unknown, token: string, retryAfter: string | null): CliError {
  const message = scrub(errorDetail(body) ?? `Workflow API request failed (${status}).`, token);
  const retry = retryAfterSeconds(retryAfter);
  const details = { status, ...(retry !== undefined ? { retry_after_seconds: retry } : {}) };
  if (status === 401) {
    return new CliError("auth_required", message, { nextSteps: [`Check ${TOKEN_ENV}.`, "The token needs scope zap, zap:all, or zap:account:all."], details });
  }
  if (status === 403) return new CliError("forbidden", message, { nextSteps: ["Request scope zap:all, or zap:account:all for shared Zaps."], details });
  if (status === 404) return new CliError("not_found", message, { nextSteps: ["Check the Zap id, then retry."], details });
  if (status === 409) return new CliError("conflict", message, { nextSteps: ["Read the Zap again, then retry."], details });
  if (status === 429) return new CliError("rate_limited", message, { retryable: true, nextSteps: ["Wait for the retry window, then repeat the same read."], details });
  if (status === 400 || status === 422) return new CliError("validation_error", message, { nextSteps: ["Correct the input and retry."], details });
  if (status >= 500) return new CliError("provider_unavailable", message, { retryable: true, nextSteps: ["Retry the same read."], details });
  return new CliError("provider_error", message, { nextSteps: ["Retry the same read."], details });
}

function requestUrl(query: { expand: string; includeShared: boolean; limit?: number; offset?: number }): URL {
  const url = new URL(ENDPOINT);
  url.searchParams.set("expand", query.expand);
  if (query.includeShared) url.searchParams.set("include_shared", "true");
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
  if (query.offset !== undefined) url.searchParams.set("offset", String(query.offset));
  return url;
}

function queryFrom(input: Record<string, unknown>, fallbackLimit?: number): { expand: string; includeShared: boolean; limit?: number; offset?: number } {
  const expand = typeof input.expand === "string" ? input.expand.trim() : "steps.action";
  if (!expand) throw validation("--expand must list at least one field.");
  if (input.includeShared !== undefined && typeof input.includeShared !== "boolean") throw validation("includeShared must be a boolean.");
  return { expand, includeShared: input.includeShared === true, limit: optionalLimit(input.limit) ?? fallbackLimit, offset: optionalOffset(input.offset) };
}

// The published schema types a successful body as a one-element array of page objects.
function parsePage(body: unknown, requested: { limit?: number; offset?: number }): PageInfo & { data: unknown[] } {
  const page = Array.isArray(body) ? body[0] : body;
  if (!isRecord(page) || !Array.isArray(page.data)) {
    throw new CliError("provider_error", "Workflow API returned an unexpected payload.", { nextSteps: ["Retry the same read."] });
  }
  const meta = isRecord(page.meta) ? page.meta : {};
  const links = isRecord(page.links) ? page.links : {};
  const offset = asNumber(meta.offset) ?? requested.offset ?? 0;
  const count = asNumber(meta.count);
  const limit = asNumber(meta.limit) ?? requested.limit ?? null;
  const nextLink = typeof links.next === "string" && links.next.length > 0;
  const moreByCount = count !== null && offset + page.data.length < count;
  const nextOffset = page.data.length > 0 && (moreByCount || (count === null && nextLink)) ? offset + page.data.length : null;
  return { data: page.data, count, offset, limit, next_offset: nextOffset };
}

export async function listZapConfigurations(input: Record<string, unknown> = {}, deps: Deps = {}): Promise<Result> {
  const env = deps.env ?? process.env;
  const token = accessToken(env);
  const query = queryFrom(input);
  const url = requestUrl(query);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : "Workflow API request failed.", token);
    throw new CliError("provider_unavailable", message || "Workflow API request failed.", { retryable: true, nextSteps: ["Retry the same read."] });
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw httpError(response.status, body, token, response.headers.get("retry-after"));
  const page = parsePage(body, query);
  return { data: page.data, page: { count: page.count, offset: page.offset, limit: page.limit, next_offset: page.next_offset } };
}

export async function getZapConfiguration(input: Record<string, unknown> = {}, deps: Deps = {}): Promise<Result> {
  if (typeof input.id !== "string" || !input.id.trim()) throw validation("Zap id is required.");
  const id = input.id.trim();
  const rest: Record<string, unknown> = { ...input };
  delete rest.id;
  let offset = optionalOffset(rest.offset) ?? 0;
  const limit = optionalLimit(rest.limit) ?? 100;
  for (let scanned = 0; scanned < MAX_PAGES; scanned += 1) {
    const page = await listZapConfigurations({ ...rest, limit, offset }, deps);
    const found = (page.data as unknown[]).find((row) => isRecord(row) && String(row.id) === id);
    if (found) return { data: found };
    const next = page.page?.next_offset ?? null;
    if (next === null || next <= offset) {
      throw new CliError("not_found", `Zap ${id} was not found.`, {
        nextSteps: ["Run zap zaps config to list Workflow API ids.", "The numeric id from zap zaps list is a different id."],
        details: { zap: id },
      });
    }
    offset = next;
  }
  throw new CliError("not_found", `Zap ${id} was not found in the scanned pages.`, {
    nextSteps: ["Rerun with a larger --offset to continue the scan.", "Run zap zaps config without an id to page through Zaps."],
    details: { zap: id, pages_scanned: MAX_PAGES },
  });
}
