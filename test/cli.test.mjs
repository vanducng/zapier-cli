import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { createProgram } from "../lib/cli.js";
import { redact } from "../lib/errors.js";
import { ledgerPath, recordOwned } from "../lib/ownership.js";

const USER = "5536860";
const MUTATING_SDK_METHODS = new Set(["createWorkflow", "importWorkflow", "updateWorkflow", "deleteWorkflow", "enableWorkflow", "disableWorkflow", "triggerWorkflow", "publishWorkflowVersion", "createWorkflowDraft", "updateWorkflowDraft", "discardWorkflowDraft", "runWorkflowDraft", "publishWorkflowDraft"]);

function fake(responses = {}) {
  const calls = [];
  const call = async (method, input) => {
    calls.push({ method, input });
    const response = responses[method];
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response(input) : (response ?? { data: {} });
  };
  return { call, calls };
}

async function run(args, responses) {
  const { call, calls } = fake(responses);
  const output = [];
  const program = createProgram("0.0.0", () => call, (value) => output.push(value));
  let error;
  try {
    await program.parseAsync(["node", "zap", ...args]);
  } catch (caught) {
    error = caught;
  }
  return { output, calls, error };
}

beforeEach(() => {
  process.env.ZAP_CLI_HOME = mkdtempSync(join(tmpdir(), "zap-cli-test-"));
});

const owned = (id, creator = USER, harness = "zap-cli") => ({ getWorkflow: { data: { id, created_by_user_id: creator, creation_client: { harness } } } });
const ledgerEntry = { name: "x", created_at: "now", created_by_user_id: USER, source: "create" };

test("every guarded write refuses a workflow missing from the ledger without calling a mutating method", async () => {
  const commands = [
    ["workflows", "update", "w1", "--name", "x", "--confirm"],
    ["workflows", "enable", "w1", "--confirm"],
    ["workflows", "disable", "w1", "--confirm"],
    ["workflows", "trigger", "w1", "--confirm"],
    ["workflows", "delete", "w1", "--confirm"],
    ["workflows", "publish", "w1", "package.json", "--confirm"],
    ["drafts", "create", "w1", "--confirm"],
    ["drafts", "update", "w1", "d1", "--source", "package.json", "--confirm"],
    ["drafts", "discard", "w1", "d1", "--confirm"],
    ["drafts", "run", "w1", "d1", "--revision", "1", "--confirm"],
    ["drafts", "publish", "w1", "d1", "--confirm"],
  ];
  for (const args of commands) {
    const { error, calls } = await run(args, owned("w1"));
    assert.equal(error?.code, "not_owned", args.join(" "));
    assert.equal(calls.filter(({ method }) => MUTATING_SDK_METHODS.has(method)).length, 0, args.join(" "));
  }
});

test("a ledger entry is not enough when the remote creator is another user", async () => {
  recordOwned("w1", ledgerEntry);
  const { error, calls } = await run(["workflows", "delete", "w1", "--confirm"], owned("w1", "someone-else"));
  assert.equal(error?.code, "not_owned");
  assert.ok(!calls.some(({ method }) => method === "deleteWorkflow"));
});

test("a workflow without the zap-cli harness stamp is refused even with a matching ledger entry", async () => {
  recordOwned("w1", ledgerEntry);
  const { error, calls } = await run(["workflows", "enable", "w1", "--confirm"], owned("w1", USER, "editor"));
  assert.equal(error?.code, "not_owned");
  assert.ok(!calls.some(({ method }) => method === "enableWorkflow"));
});

test("owned workflow delete runs and clears the ledger", async () => {
  recordOwned("w1", ledgerEntry);
  const { output, calls } = await run(["workflows", "delete", "w1", "--confirm"], owned("w1"));
  assert.deepEqual(output, [{ workflow: "w1", deleted: true }]);
  assert.ok(calls.some(({ method }) => method === "deleteWorkflow"));
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath(), "utf8")).workflows, {});
});

test("writes require --confirm before any network call", async () => {
  for (const args of [["workflows", "create", "--name", "x"], ["zaps", "convert", "123"], ["workflows", "enable", "w1"], ["actions", "run", "slack", "write", "send"]]) {
    const { error, calls } = await run(args, {});
    assert.equal(error?.code, "confirmation_required", args.join(" "));
    assert.equal(calls.length, 0);
  }
});

test("Zapier Manager write actions are always blocked", async () => {
  for (const type of ["write", "search_or_write"]) {
    const { error, calls } = await run(["actions", "run", "ZapierManagerCLIAPI", type, "toggle_zap", "--confirm"], {});
    assert.equal(error?.code, "blocked_action");
    assert.equal(calls.length, 0);
  }
});

test("create tags attribution and records the workflow as owned", async () => {
  const { output, calls } = await run(["workflows", "create", "--name", "scratch", "--confirm"], { createWorkflow: { data: { id: "w9", name: "scratch", created_by_user_id: 5536860 } } });
  assert.equal(output[0].id, "w9");
  assert.deepEqual(calls[0], { method: "createWorkflow", input: { name: "scratch", description: undefined, private: undefined, creationHarness: "zap-cli", creationAccessMethod: "sdk_cli" } });
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath(), "utf8")).workflows.w9.created_by_user_id, USER);
});

test("convert records the imported workflow with its source zap", async () => {
  await run(["zaps", "convert", "374", "--confirm"], { importWorkflow: { data: { workflow: { id: "w5", name: "imported", created_by_user_id: USER }, draft: {}, issues: [] } } });
  assert.equal(JSON.parse(readFileSync(ledgerPath(), "utf8")).workflows.w5.source_zap_id, "374");
});

test("zaps config reads Workflow API configuration and does not call Zapier Manager", async () => {
  const { output, calls } = await run(["zaps", "config", "--limit", "5", "--offset", "10", "--include-shared"], {
    listZapConfigurations: { data: [{ id: "zap-1", steps: [{ inputs: { stage: "CLOSED_WON" } }] }], page: { count: 11, offset: 10, limit: 5, next_offset: null } },
  });
  assert.deepEqual(calls, [{ method: "listZapConfigurations", input: { expand: "steps.action", includeShared: true, limit: 5, offset: 10 } }]);
  assert.equal(output[0].data[0].steps[0].inputs.stage, "CLOSED_WON");
  assert.equal(output[0].next_offset, null);
  assert.equal(output[0].count, 11);
});

test("zaps config with an id returns one Zap", async () => {
  const { output, calls } = await run(["zaps", "config", "zap-9"], { getZapConfiguration: { data: { id: "zap-9", steps: [] } } });
  assert.equal(calls[0].method, "getZapConfiguration");
  assert.equal(calls[0].input.id, "zap-9");
  assert.deepEqual(output[0], { id: "zap-9", steps: [] });
});

test("zaps config rejects a bad offset before any call", async () => {
  const { error, calls } = await run(["zaps", "config", "--offset", "-1"], {});
  assert.equal(error?.code, "validation_error");
  assert.equal(calls.length, 0);
});

test("zaps list resolves the manager connection and normalizes ids", async () => {
  const { output, calls } = await run(["zaps", "list", "--folder", "f1"], {
    findFirstConnection: { data: { id: "c1" } },
    runAction: { data: [{ root_id: 42, title: "Z", state: "on", paused: false, zap_link: "https://zapier.com/editor/42" }] },
  });
  assert.equal(calls[1].input.connection, "c1");
  assert.deepEqual(calls[1].input.inputs, { account: undefined, folder: "f1" });
  assert.equal(output[0].data[0].id, "42");
  assert.equal(output[0].data[0].editor_url, "https://zapier.com/editor/42");
});

test("redact strips tokens and credential fields", () => {
  const text = redact('Bearer abc.def-123 {"api_key":"k"} key_abcdefgh1234 authorization=xyz');
  assert.ok(!/abc\.def|key_abcdefgh1234|"k"|xyz/u.test(text), text);
});
