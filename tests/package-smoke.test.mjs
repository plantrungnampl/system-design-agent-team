import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32"
  ? [process.execPath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : ["npm"];
const execNpm = (args, options) => execFileAsync(npm[0], [...npm.slice(1), ...args], options);

test("packed workspaces install cleanly and the packed CLI initializes a project", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-design-team-pack-"));
  const tarballs = join(root, "tarballs");
  const consumer = join(root, "consumer");
  const project = join(root, "project");

  try {
    await Promise.all([tarballs, consumer, project].map((path) => mkdir(path)));
    const workspaceDirectories = (await readdir(join(repository, "packages"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repository, "packages", entry.name))
      .sort();
    const packed = [];
    for (const directory of workspaceDirectories) {
      const { stdout } = await execNpm([
        "pack", directory, "--json", "--pack-destination", tarballs,
      ], { cwd: repository });
      const [result] = JSON.parse(stdout);
      assert(result.files.every(({ path }) => !path.startsWith("node_modules/")));
      packed.push(join(tarballs, result.filename));
    }

    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true }, null, 2));
    await execNpm([
      "install", "--no-audit", "--no-fund", "--package-lock=false", ...packed,
    ], { cwd: consumer, timeout: 180_000 });

    const installedScope = join(consumer, "node_modules", "@system-design-team");
    assert.equal((await readdir(installedScope)).length, workspaceDirectories.length);
    for (const name of await readdir(installedScope)) {
      const installed = join(installedScope, name);
      assert.equal((await lstat(installed)).isSymbolicLink(), false);
      assert.equal(relative(consumer, await realpath(installed)).startsWith(".."), false);
    }

    await execFileAsync("git", ["init", "--quiet"], { cwd: project });
    const bin = join(installedScope, "cli", "dist", "bin.js");
    await execFileAsync(process.execPath, [
      bin,
      "init",
      "--id", "packed-smoke",
      "--name", "Packed Smoke",
      "--mode", "migration",
      "--profile", "standard",
      "--operation-id", "PACKED-SMOKE-INIT",
    ], { cwd: project });

    const config = parse(await readFile(join(project, ".agent-team", "project.yaml"), "utf8"));
    const workflow = parse(await readFile(join(project, ".agent-team", "workflow-state.yaml"), "utf8"));
    const agents = await readdir(join(project, ".codex", "agents"));
    assert.equal(config.project.mode, "migration");
    assert.equal(workflow.phases["legacy-assessment"].status, "ready");
    assert(agents.includes("solution-architect.md"));
    assert.match(
      await readFile(join(project, ".agent-team", "context", "legacy-assessment.md"), "utf8"),
      /Legacy Assessment/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
