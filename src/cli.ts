import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { Command, Option } from "commander";
import type { Call, Result } from "./client.ts";
import { CliError } from "./errors.ts";
import { assertOwned, forgetOwned, HARNESS, readLedger, recordOwned } from "./ownership.ts";

type Options = Record<string, unknown>;
type Write = (value: unknown) => void;

const MANAGER_APP = "ZapierManagerCLIAPI";
const ACTION_TYPES = ["read", "read_bulk", "write", "search", "search_or_write", "search_and_write", "filter"];

function validation(message: string): CliError {
  return new CliError("validation_error", message, { nextSteps: ["Correct the input and retry."] });
}

export function parseJson(source: unknown, flag: string): unknown {
  if (source === undefined) return undefined;
  const text = String(source);
  try {
    return JSON.parse(text.startsWith("@") ? readFileSync(text.slice(1), "utf8") : text) as unknown;
  } catch {
    throw validation(`${flag} must be JSON or @file containing JSON.`);
  }
}

function parseObject(source: unknown, flag: string): Record<string, unknown> | undefined {
  const value = parseJson(source, flag);
  if (value === undefined) return undefined;
  if (!value || Array.isArray(value) || typeof value !== "object") throw validation(`${flag} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function parsePositive(source: unknown, flag: string): number | undefined {
  if (source === undefined) return undefined;
  const value = Number(source);
  if (!Number.isInteger(value) || value <= 0) throw validation(`${flag} must be a positive integer.`);
  return value;
}

function collectFiles(path: string, root: string, files: Record<string, string>): void {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      collectFiles(join(path, name), root, files);
    }
    return;
  }
  files[root === path ? basename(path) : relative(root, path)] = readFileSync(path, "utf8");
}

export function loadSourceFiles(paths: string[]): Record<string, string> {
  if (!paths.length) throw validation("Provide at least one source file or directory.");
  const files: Record<string, string> = {};
  for (const path of paths) {
    try {
      collectFiles(path, path, files);
    } catch {
      throw validation(`Cannot read source path: ${path}.`);
    }
  }
  if (!Object.keys(files).length) throw validation("No source files found.");
  return files;
}

function requireConfirm(options: Options): void {
  if (options.confirm !== true) throw new CliError("confirmation_required", "This command changes Zapier state and requires --confirm.", { nextSteps: ["Review the request, then rerun with --confirm."] });
}

function list(result: Result): object {
  return { data: result.data, next_cursor: result.nextCursor ?? null };
}

function paging(options: Options): Record<string, unknown> {
  return { pageSize: parsePositive(options.pageSize, "--page-size"), cursor: options.cursor as string | undefined };
}

function withPaging(command: Command): Command {
  return command.option("--page-size <n>", "items per page").option("--cursor <cursor>", "cursor from a previous next_cursor");
}

async function managerConnection(call: Call, options: Options): Promise<string> {
  if (typeof options.connection === "string") return options.connection;
  const { data } = await call("findFirstConnection", { app: MANAGER_APP, owner: "me" });
  const id = (data as { id?: unknown } | undefined)?.id;
  if (!id) throw new CliError("connection_required", "No Zapier Manager connection found for this account.", { nextSteps: ["Connect Zapier Manager at https://zapier.com/app/assets/connections.", "Or pass --connection <id>."] });
  return String(id);
}

function zapSummary(zap: Record<string, unknown>): Record<string, unknown> {
  const id = zap.root_id ?? zap.id ?? null;
  return { id: id === null ? null : String(id), title: zap.title ?? null, state: zap.state ?? null, paused: zap.paused ?? null, last_live_at: zap.last_live_at ?? null, last_paused_at: zap.last_paused_at ?? null, last_edited_by: zap.last_edited_by ?? null, editor_url: zap.zap_link ?? null };
}

export function createProgram(version: string, getCall: () => Call, write: Write = (value) => console.log(JSON.stringify(value))): Command {
  let cached: Call | undefined;
  const call: Call = (method, input) => (cached ??= getCall())(method, input);
  const program = new Command().name("zap").description("Inspect Zaps and manage Zapier code workflows created by zap").version(version).exitOverride().configureOutput({ writeErr: () => {} });
  const action = (command: Command, handler: (...args: never[]) => Promise<unknown>) => {
    command.exitOverride().action(async (...args: unknown[]) => write(await (handler as (...values: unknown[]) => Promise<unknown>)(...args)));
    return command;
  };

  const auth = program.command("auth").description("Zapier login state (login itself: zapier-sdk login)");
  action(auth.command("status").description("Show the logged-in Zapier user"), async () => {
    const { data } = await call("getProfile", {});
    const profile = data as Record<string, unknown>;
    return { logged_in: true, profile: { id: profile.id, email: profile.email, full_name: profile.full_name, timezone: profile.timezone } };
  });

  const apps = program.command("apps").description("Zapier app catalog");
  action(withPaging(apps.command("list").description("List or search apps").option("--search <term>", "search term")), async (options: Options) => list(await call("listApps", { search: options.search, ...paging(options) })));
  action(apps.command("get").description("Get one app").argument("<app>", "app key, e.g. slack"), async (app: string) => (await call("getApp", { app })).data);

  const actions = program.command("actions").description("App actions: discover, inspect, run");
  const typeOption = () => new Option("--type <type>", "action type").choices(ACTION_TYPES);
  action(withPaging(actions.command("list").description("List actions for an app").argument("<app>").addOption(typeOption())), async (app: string, options: Options) => list(await call("listActions", { app, actionType: options.type, ...paging(options) })));
  action(actions.command("get").description("Get one action").argument("<app>").argument("<type>").argument("<action>"), async (app: string, actionType: string, key: string) => (await call("getAction", { app, actionType, action: key })).data);
  action(
    withPaging(actions.command("inputs").description("List input fields an action needs").argument("<app>").argument("<type>").argument("<action>").option("--connection <id>", "connection id").option("--inputs <json|@file>", "known inputs for dependent fields")),
    async (app: string, actionType: string, key: string, options: Options) => list(await call("listActionInputFields", { app, actionType, action: key, connection: options.connection, inputs: parseObject(options.inputs, "--inputs"), ...paging(options) })),
  );
  action(
    withPaging(actions.command("choices").description("List choices for a dynamic input field").argument("<app>").argument("<type>").argument("<action>").argument("<field>").option("--connection <id>", "connection id").option("--inputs <json|@file>", "known inputs")),
    async (app: string, actionType: string, key: string, inputField: string, options: Options) =>
      list(await call("listActionInputFieldChoices", { app, actionType, action: key, inputField, connection: options.connection, inputs: parseObject(options.inputs, "--inputs"), ...paging(options) })),
  );
  action(
    withPaging(actions.command("run").description("Run an action; write actions require --confirm").argument("<app>").argument("<type>").argument("<action>").option("--connection <id>", "connection id").option("--inputs <json|@file>", "action inputs").option("--timeout <seconds>", "action timeout").option("--confirm", "confirm a write action")),
    async (app: string, actionType: string, key: string, options: Options) => {
      if (app.split("@")[0] === MANAGER_APP && actionType !== "read" && actionType !== "search") {
        throw new CliError("blocked_action", "zap never runs Zapier Manager write actions; they change existing Zaps or account state.", { nextSteps: ["Make that change in the Zapier UI."] });
      }
      if (actionType.includes("write")) requireConfirm(options);
      return list(await call("runAction", { app, actionType, action: key, connection: options.connection, inputs: parseObject(options.inputs, "--inputs"), timeoutSeconds: parsePositive(options.timeout, "--timeout"), ...paging(options) }));
    },
  );

  const connections = program.command("connections").description("Authenticated app connections");
  action(
    withPaging(connections.command("list").description("List connections").option("--app <app>", "filter by app key").option("--search <term>", "search title").option("--owner <owner>", "owner filter, e.g. me").option("--shared", "include shared connections")),
    async (options: Options) => list(await call("listConnections", { app: options.app, search: options.search, owner: options.owner, includeShared: options.shared === true ? true : undefined, ...paging(options) })),
  );
  action(connections.command("get").description("Get one connection").argument("<id>"), async (connection: string) => (await call("getConnection", { connection })).data);

  const folders = program.command("folders").description("Zap folders (read-only, via Zapier Manager)");
  action(withPaging(folders.command("list").description("List Zap folders").option("--account <id>", "Zapier account id").option("--connection <id>", "Zapier Manager connection id")), async (options: Options) =>
    list(await call("runAction", { app: MANAGER_APP, actionType: "read", action: "list_folders", connection: await managerConnection(call, options), inputs: { account: options.account }, ...paging(options) })),
  );

  const zaps = program.command("zaps").description("Classic Zaps: read-only, plus convert into a new code workflow");
  action(withPaging(zaps.command("list").description("List Zaps").option("--folder <id>", "folder id").option("--account <id>", "Zapier account id").option("--connection <id>", "Zapier Manager connection id")), async (options: Options) => {
    const result = await call("runAction", { app: MANAGER_APP, actionType: "read", action: "list_zaps", connection: await managerConnection(call, options), inputs: { account: options.account, folder: options.folder }, ...paging(options) });
    return { data: (result.data as Record<string, unknown>[]).map(zapSummary), next_cursor: result.nextCursor ?? null };
  });
  action(zaps.command("search").description("Find Zaps by title").requiredOption("--title <title>", "title to search").option("--account <id>", "Zapier account id").option("--connection <id>", "Zapier Manager connection id"), async (options: Options) => {
    const result = await call("runAction", { app: MANAGER_APP, actionType: "search", action: "zap", connection: await managerConnection(call, options), inputs: { title: options.title, account: options.account } });
    return { data: (result.data as Record<string, unknown>[]).map(zapSummary) };
  });
  action(zaps.command("convert").description("Create a new disabled code workflow from a Zap; the Zap is untouched").argument("<zap>", "Zap id").option("--name <name>", "workflow name").option("--private", "private to the creating user").option("--confirm", "confirm creating the workflow"), async (zap: string, options: Options) => {
    requireConfirm(options);
    const { data } = await call("importWorkflow", { zap, name: options.name, private: options.private === true ? true : undefined });
    const workflow = (data as { workflow?: { id?: string; name?: string; created_by_user_id?: unknown } }).workflow;
    if (workflow?.id && workflow.created_by_user_id != null) {
      recordOwned(workflow.id, { name: workflow.name ?? "", created_at: new Date().toISOString(), created_by_user_id: String(workflow.created_by_user_id), source: "convert", source_zap_id: zap });
    }
    return data;
  });

  const workflows = program.command("workflows").description("Zapier code workflows; writes are limited to workflows zap created");
  action(withPaging(workflows.command("list").description("List workflows").option("--owned", "only workflows zap created")), async (options: Options) => {
    const result = await call("listWorkflows", paging(options));
    const owned = readLedger().workflows;
    const data = (result.data as Record<string, unknown>[]).map((workflow) => ({ ...workflow, owned_by_zap: Boolean(owned[String(workflow.id)]) }));
    return { data: options.owned === true ? data.filter((workflow) => workflow.owned_by_zap) : data, next_cursor: result.nextCursor ?? null };
  });
  action(workflows.command("get").description("Get a workflow").argument("<workflow>"), async (workflow: string) => ({ ...((await call("getWorkflow", { workflow })).data as object), owned_by_zap: Boolean(readLedger().workflows[workflow]) }));
  action(withPaging(workflows.command("versions").description("List published versions").argument("<workflow>")), async (workflow: string, options: Options) => list(await call("listWorkflowVersions", { workflow, ...paging(options) })));
  action(workflows.command("version").description("Get one version with its source").argument("<workflow>").argument("<version>"), async (workflow: string, version: string) => (await call("getWorkflowVersion", { workflow, version })).data);
  action(workflows.command("validate").description("Validate workflow source without saving").argument("<paths...>", "files or directories").option("--entrypoint <file>", "entrypoint file name"), async (paths: string[], options: Options) => (await call("validateWorkflow", { sourceFiles: loadSourceFiles(paths), entrypointFile: options.entrypoint })).data);
  action(workflows.command("create").description("Create an empty disabled workflow").requiredOption("--name <name>", "workflow name").option("--description <text>", "description").option("--private", "private to the creating user").option("--confirm", "confirm the write"), async (options: Options) => {
    requireConfirm(options);
    const { data } = await call("createWorkflow", { name: options.name, description: options.description, private: options.private === true ? true : undefined, creationHarness: HARNESS, creationAccessMethod: "sdk_cli" });
    const created = data as { id: string; name: string; created_by_user_id?: unknown };
    if (created.created_by_user_id != null) recordOwned(created.id, { name: created.name, created_at: new Date().toISOString(), created_by_user_id: String(created.created_by_user_id), source: "create" });
    return data;
  });
  const guarded = (name: string, description: string, method: string, extra: (command: Command) => Command = (command) => command, input: (options: Options) => Record<string, unknown> = () => ({})) =>
    action(extra(workflows.command(name).description(description).argument("<workflow>").option("--confirm", "confirm the write")), async (workflow: string, options: Options) => {
      requireConfirm(options);
      await assertOwned(call, workflow);
      return (await call(method, { workflow, ...input(options) })).data ?? { workflow, ok: true };
    });
  guarded("update", "Rename or re-describe an owned workflow", "updateWorkflow", (command) => command.option("--name <name>").option("--description <text>"), (options) => ({ name: options.name, description: options.description }));
  guarded("enable", "Enable an owned workflow", "enableWorkflow");
  guarded("disable", "Disable an owned workflow", "disableWorkflow");
  guarded("trigger", "Trigger a live run of an owned workflow", "triggerWorkflow", (command) => command.option("--input <json|@file>", "run input"), (options) => ({ input: parseJson(options.input, "--input") }));
  action(workflows.command("delete").description("Delete an owned workflow").argument("<workflow>").option("--confirm", "confirm the delete"), async (workflow: string, options: Options) => {
    requireConfirm(options);
    await assertOwned(call, workflow);
    await call("deleteWorkflow", { workflow });
    forgetOwned(workflow);
    return { workflow, deleted: true };
  });
  action(
    workflows
      .command("publish")
      .description("Publish source files as a new version of an owned workflow")
      .argument("<workflow>")
      .argument("<paths...>", "files or directories")
      .option("--dependencies <json|@file>", "npm dependencies map")
      .option("--durable-version <version>", "@zapier/zapier-durable version")
      .option("--trigger <json|@file>", "trigger config")
      .option("--connections <json|@file>", "connection alias map")
      .option("--enabled", "enable after publishing")
      .option("--confirm", "confirm the write"),
    async (workflow: string, paths: string[], options: Options) => {
      requireConfirm(options);
      const sourceFiles = loadSourceFiles(paths);
      await assertOwned(call, workflow);
      return (await call("publishWorkflowVersion", { workflow, sourceFiles, dependencies: parseObject(options.dependencies, "--dependencies"), zapierDurableVersion: options.durableVersion, trigger: parseObject(options.trigger, "--trigger"), connections: parseObject(options.connections, "--connections"), enabled: options.enabled === true ? true : undefined })).data;
    },
  );

  const drafts = program.command("drafts").description("Workflow drafts; writes are limited to workflows zap created");
  action(withPaging(drafts.command("list").description("List drafts").argument("<workflow>").option("--status <status>", "open or discarded")), async (workflow: string, options: Options) => list(await call("listWorkflowDrafts", { workflow, status: options.status, ...paging(options) })));
  action(drafts.command("get").description("Get a draft with its source").argument("<workflow>").argument("<draft>"), async (workflow: string, draft: string) => (await call("getWorkflowDraft", { workflow, draft })).data);
  const draftWrite = (name: string, description: string, build: (command: Command) => Command, run: (workflow: string, draft: string | undefined, options: Options) => Promise<unknown>, needsDraft = true) =>
    action(build(drafts.command(name).description(description).argument("<workflow>")).option("--confirm", "confirm the write"), async (workflow: string, ...rest: unknown[]) => {
      const options = rest.findLast((value) => value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Command)) as Options;
      requireConfirm(options);
      await assertOwned(call, workflow);
      return run(workflow, needsDraft ? String(rest[0]) : undefined, options);
    });
  draftWrite("create", "Open a new draft", (command) => command.option("--slug <slug>"), async (workflow, _draft, options) => (await call("createWorkflowDraft", { workflow, slug: options.slug })).data, false);
  draftWrite(
    "update",
    "Replace a draft's source",
    (command) => command.argument("<draft>").option("--source <paths...>", "files or directories").option("--revision <n>", "expected draft revision").option("--dependencies <json|@file>").option("--durable-version <version>").option("--trigger <json|@file>").option("--connections <json|@file>"),
    async (workflow, draft, options) =>
      (await call("updateWorkflowDraft", { workflow, draft, sourceFiles: loadSourceFiles((options.source as string[] | undefined) ?? []), draftRevision: parsePositive(options.revision, "--revision"), dependencies: parseObject(options.dependencies, "--dependencies"), zapierDurableVersion: options.durableVersion, trigger: parseObject(options.trigger, "--trigger"), connections: parseObject(options.connections, "--connections") })).data,
  );
  draftWrite("discard", "Discard a draft", (command) => command.argument("<draft>"), async (workflow, draft) => (await call("discardWorkflowDraft", { workflow, draft })).data ?? { workflow, draft, discarded: true });
  draftWrite("run", "Test-run a draft without publishing (free, rate limited)", (command) => command.argument("<draft>").requiredOption("--revision <n>", "draft revision from drafts get").option("--input <json|@file>", "run input"), async (workflow, draft, options) =>
    (await call("runWorkflowDraft", { workflow, draft, draftRevision: parsePositive(options.revision, "--revision"), input: parseJson(options.input, "--input") })).data,
  );
  draftWrite("publish", "Publish a draft as the live version", (command) => command.argument("<draft>").option("--revision <n>", "expected draft revision").option("--enabled", "enable after publishing"), async (workflow, draft, options) =>
    (await call("publishWorkflowDraft", { workflow, draft, draftRevision: parsePositive(options.revision, "--revision"), enabled: options.enabled === true ? true : undefined })).data,
  );

  const runs = program.command("runs").description("Workflow runs for debugging");
  action(withPaging(runs.command("list").description("List runs of a workflow").argument("<workflow>").addOption(new Option("--kind <kind>").choices(["live", "draft"]))), async (workflow: string, options: Options) => list(await call("listWorkflowRuns", { workflow, kind: options.kind, ...paging(options) })));
  action(runs.command("get").description("Get one run").argument("<run>").option("--workflow <id>", "workflow id"), async (run: string, options: Options) => (await call("getWorkflowRun", { run, workflow: options.workflow })).data);
  action(runs.command("trigger").description("Get the trigger event behind a run").argument("<trigger>"), async (trigger: string) => (await call("getTriggerRun", { trigger })).data);

  const durable = program.command("durable").description("Durable (ad hoc) runs for debugging");
  action(withPaging(durable.command("list").description("List durable runs")), async (options: Options) => list(await call("listDurableRuns", paging(options))));
  action(durable.command("get").description("Get a durable run").argument("<run>"), async (run: string) => (await call("getDurableRun", { run })).data);

  return program;
}
