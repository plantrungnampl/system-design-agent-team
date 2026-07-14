import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

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

    const pluginAdapter = join(project, "plugin-adapter.mjs");
    await writeFile(pluginAdapter, `export default {
  async resolve(uri) {
    return { uri, publisher_identity: uri.slice(uri.lastIndexOf("@") + 1), status: "available" };
  },
  async verifySkill() { return true; },
  async invoke() { throw new Error("not used by lifecycle capability checks"); },
};\n`);
    await execFileAsync(process.execPath, [
      bin,
      "start",
      "legacy-assessment",
      "--operation-id", "PACKED-SMOKE-START",
      "--plugin-adapter", pluginAdapter,
    ], { cwd: project });
    const started = parse(await readFile(join(project, ".agent-team", "workflow-state.yaml"), "utf8"));
    assert.equal(started.phases["legacy-assessment"].status, "in_progress");

    const registryPath = join(project, ".agent-team", "artifact-registry.yaml");
    const registry = parse(await readFile(registryPath, "utf8"));
    const artifact = registry.artifacts.find(({ id }) => id === "LEGACY-ASSESSMENT");
    artifact.status = "in_review";
    const artifactText = [
      "---",
      "artifact_id: LEGACY-ASSESSMENT",
      "version: 1",
      "status: in_review",
      "owner: solution-architect",
      "reviewer: architecture-reviewer",
      "---",
      "# Legacy Assessment",
      "Verified source and target inventory are ready for independent review.",
    ].join("\n");
    artifact.checksum = `sha256:${createHash("sha256").update(artifactText).digest("hex")}`;
    await writeFile(registryPath, stringify(registry));
    await writeFile(join(project, ".agent-team", artifact.path), artifactText);
    await execFileAsync(process.execPath, [
      bin, "validate", "legacy-assessment", "--operation-id", "PACKED-SMOKE-VALIDATE",
    ], { cwd: project });
    await execFileAsync(process.execPath, [
      bin,
      "review", "legacy-assessment",
      "--reviewer", "architecture-reviewer",
      "--verdict", "approved",
      "--operation-id", "PACKED-SMOKE-REVIEW",
      "--plugin-adapter", pluginAdapter,
    ], { cwd: project });
    await execFileAsync(process.execPath, [
      bin, "approve", "G0", "--by", "project-owner", "--operation-id", "PACKED-SMOKE-APPROVE",
    ], { cwd: project });
    await execFileAsync(process.execPath, [
      bin, "handover", "legacy-assessment", "--operation-id", "PACKED-SMOKE-HANDOVER",
    ], { cwd: project });
    const handedOver = parse(await readFile(join(project, ".agent-team", "workflow-state.yaml"), "utf8"));
    assert.equal(handedOver.phases["legacy-assessment"].status, "handed_over");
    assert.equal(handedOver.phases["business-continuity"].status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
