import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "zap-cli-pack-"));
try {
  const tarball = execFileSync("npm", ["pack", "--pack-destination", work, "--silent"], { encoding: "utf8" }).trim().split("\n").at(-1);
  const prefix = join(work, "prefix");
  execFileSync("npm", ["install", "--global", "--prefix", prefix, join(work, tarball)], { stdio: "ignore" });
  const bin = join(prefix, "bin", "zap");
  const check = (args, expectCode, predicate, label) => {
    const result = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, ZAP_CLI_HOME: join(work, "home") } });
    if (result.status !== expectCode || !predicate(result)) throw new Error(`${label} failed: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  };
  check(["--version"], 0, (r) => /^\d+\.\d+\.\d+\n$/u.test(r.stdout) && r.stderr === "", "version");
  check(["--help"], 0, (r) => r.stdout.includes("workflows") && r.stderr === "", "help");
  check(["workflows", "enable", "w1"], 1, (r) => r.stdout === "" && JSON.parse(r.stderr).error.code === "confirmation_required", "confirm gate");
  check(["workflows", "delete", "w1", "--confirm"], 1, (r) => JSON.parse(r.stderr).error.code === "not_owned", "ownership gate");
  check(["nope"], 1, (r) => JSON.parse(r.stderr).error.code === "usage_error", "usage error");
  console.log(JSON.stringify({ ok: true, tarball }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
