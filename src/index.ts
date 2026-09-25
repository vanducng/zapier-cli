#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { CommanderError } from "commander";
import { createProgram } from "./cli.ts";
import { createCall } from "./client.ts";
import { CliError, errorPayload } from "./errors.ts";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

try {
  await createProgram(packageJson.version, createCall).parseAsync();
} catch (error) {
  if (error instanceof CommanderError && (error.exitCode === 0 || error.code === "commander.help" || error.code === "commander.version" || error.code === "commander.helpDisplayed")) {
    process.exitCode = 0;
  } else {
    const safe = error instanceof CommanderError ? new CliError("usage_error", error.message.replace(/^error: /u, ""), { nextSteps: ["Run zap --help to list commands."] }) : error;
    process.stderr.write(`${JSON.stringify(errorPayload(safe))}\n`);
    process.exitCode = 1;
  }
}
