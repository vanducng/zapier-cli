import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Call } from "./client.ts";
import { CliError } from "./errors.ts";

export const HARNESS = "zap-cli";

type Entry = { name: string; created_at: string; created_by_user_id: string; source: "create" | "convert"; source_zap_id?: string };
type Ledger = { version: 1; workflows: Record<string, Entry> };

export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.ZAP_CLI_HOME ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "zap-cli"), "owned.json");
}

export function readLedger(env: NodeJS.ProcessEnv = process.env): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(env), "utf8")) as Ledger;
    if (parsed?.version === 1 && parsed.workflows && typeof parsed.workflows === "object") return parsed;
  } catch {}
  return { version: 1, workflows: {} };
}

function writeLedger(ledger: Ledger, env: NodeJS.ProcessEnv): void {
  const file = ledgerPath(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function recordOwned(id: string, entry: Entry, env: NodeJS.ProcessEnv = process.env): void {
  const ledger = readLedger(env);
  ledger.workflows[id] = entry;
  writeLedger(ledger, env);
}

export function forgetOwned(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const ledger = readLedger(env);
  delete ledger.workflows[id];
  writeLedger(ledger, env);
}

function notOwned(id: string, reason: string): CliError {
  return new CliError("not_owned", `Workflow ${id} was not created by zap on this machine (${reason}); zap only modifies workflows it created.`, {
    nextSteps: ["Use zap workflows create or zap zaps convert to make a workflow zap can manage.", "Modify other workflows in the Zapier editor."],
    details: { workflow: id },
  });
}

type RemoteWorkflow = { created_by_user_id?: unknown; creation_client?: { harness?: unknown } | null; source_zap_id?: unknown };

// Every mutating command must pass here: a ledger entry written at create/convert time AND server-recorded provenance that matches it.
export async function assertOwned(call: Call, id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const entry = readLedger(env).workflows[id];
  if (!entry?.created_by_user_id) throw notOwned(id, "not in the local ledger");
  const workflow = (await call("getWorkflow", { workflow: id })).data as RemoteWorkflow;
  if (workflow?.created_by_user_id == null || String(workflow.created_by_user_id) !== entry.created_by_user_id) throw notOwned(id, "remote creator does not match the ledger");
  if (entry.source === "create" && workflow.creation_client?.harness !== HARNESS) throw notOwned(id, `not stamped with harness ${HARNESS}`);
  if (entry.source === "convert" && workflow.source_zap_id != null && String(workflow.source_zap_id) !== entry.source_zap_id) throw notOwned(id, "source Zap does not match the ledger");
}
