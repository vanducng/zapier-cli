import assert from "node:assert/strict";
import { test } from "node:test";
import { getZapConfiguration, listZapConfigurations } from "../lib/workflow-api.js";

const TOKEN = "workflow-token-value";

function page(zaps, { offset = 0, count = zaps.length, limit = zaps.length, next = null } = {}) {
  return { links: { next, prev: null }, meta: { count, offset, limit }, data: zaps };
}

function mockFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const result = await handler(new URL(String(url)), requests.length);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: result.headers });
  };
  return { fetchImpl, requests };
}

test("list sends the bearer token and expand, and never echoes the token", async () => {
  const { fetchImpl, requests } = mockFetch(async () => ({ body: [page([{ id: "zap-1", steps: [{ inputs: { name: "A" } }] }])] }));
  const result = await listZapConfigurations({ expand: "steps.action", limit: 5, offset: 0 }, { env: { ZAP_WORKFLOW_ACCESS_TOKEN: TOKEN }, fetch: fetchImpl });
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(new URL(requests[0].url).searchParams.get("expand"), "steps.action");
  assert.equal(new URL(requests[0].url).searchParams.get("include_shared"), null);
  assert.equal(result.data[0].id, "zap-1");
  assert.equal(result.page.next_offset, null);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("a bare page object is accepted", async () => {
  const { fetchImpl } = mockFetch(async () => ({ body: page([{ id: "zap-1", steps: [] }]) }));
  const result = await listZapConfigurations({}, { env: { ZAP_WORKFLOW_ACCESS_TOKEN: TOKEN }, fetch: fetchImpl });
  assert.equal(result.data[0].id, "zap-1");
});

test("a later page sets next_offset from the reported count", async () => {
  const { fetchImpl, requests } = mockFetch(async () => ({ body: page([{ id: "zap-1" }, { id: "zap-2" }], { offset: 0, count: 3, limit: 2 }) }));
  const result = await listZapConfigurations({ includeShared: true }, { env: { ZAP_WORKFLOW_ACCESS_TOKEN: TOKEN }, fetch: fetchImpl });
  assert.equal(result.page.next_offset, 2);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get("expand"), "steps.action");
  assert.equal(url.searchParams.get("include_shared"), "true");
});

test("get walks pages until the Zap id is found", async () => {
  const { fetchImpl, requests } = mockFetch(async (url) => {
    const offset = url.searchParams.get("offset");
    if (offset === "2") return { body: page([{ id: "zap-3", steps: [{ inputs: { full_name: "{{customer__full_name}}" } }] }], { offset: 2, count: 3, limit: 1 }) };
    return { body: page([{ id: "zap-1" }, { id: "zap-2" }], { offset: 0, count: 3, limit: 2 }) };
  });
  const result = await getZapConfiguration({ id: "zap-3" }, { env: { ZAP_WORKFLOW_ACCESS_TOKEN: TOKEN }, fetch: fetchImpl });
  assert.equal(requests.length, 2);
  assert.equal(result.data.steps[0].inputs.full_name, "{{customer__full_name}}");
});

test("get reports a missing Zap without calling Zapier Manager", async () => {
  const { fetchImpl } = mockFetch(async () => ({ body: page([{ id: "other" }], { count: 1 }) }));
  await assert.rejects(getZapConfiguration({ id: "missing" }, { env: { ZAP_WORKFLOW_ACCESS_TOKEN: TOKEN }, fetch: fetchImpl }), (error) => error.code === "not_found" && !String(error.message).includes(TOKEN));
});

test("missing token fails before any request", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(listZapConfigurations({}, { env: {}, fetch: fetchImpl }), (error) => error.code === "auth_required");
  assert.equal(called, false);
});

test("an error body that contains the token is redacted", async () => {
  const { fetchImpl } = mockFetch(async () => ({ status: 401, body: { errors: [{ detail: `rejected ${TOKEN}` }] } }));
  await assert.rejects(listZapConfigurations({}, { env: { ZAP_WORKFLOW_ACCESS_TOKEN: TOKEN }, fetch: fetchImpl }), (error) => {
    assert.equal(error.code, "auth_required");
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test("rate limits are retryable", async () => {
  const { fetchImpl } = mockFetch(async () => ({ status: 429, headers: { "retry-after": "2" }, body: { errors: [{ detail: "slow down" }] } }));
  await assert.rejects(listZapConfigurations({}, { env: { ZAP_WORKFLOW_ACCESS_TOKEN: TOKEN }, fetch: fetchImpl }), (error) => error.code === "rate_limited" && error.retryable === true && error.details.retry_after_seconds === 2);
});
