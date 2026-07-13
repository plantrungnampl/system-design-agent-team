import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documents = [
  "README.md",
  "docs/getting-started.md",
  "docs/architecture.md",
  "docs/operations.md",
  "docs/security.md",
  "docs/upgrade.md",
  "docs/troubleshooting.md",
];

function helpCommands(help) {
  const signatures = help.split(/\r?\n/).slice(3).filter((line) => /^  \S/.test(line));
  const commands = new Map();
  for (const signature of signatures) {
    const words = signature.trim().split(/\s+/);
    const name = ["artifact", "trace", "stale", "change", "gate", "issue", "secrets", "cache", "glossary", "evidence"]
      .includes(words[0]) ? `${words[0]} ${words[1]}` : words[0];
    const options = commands.get(name) ?? new Set();
    for (const match of signature.matchAll(/--([\w-]+)/g)) options.add(match[1]);
    commands.set(name, options);
  }
  return commands;
}

function documentedInvocations(text) {
  return [
    ...text.matchAll(/^system-design-team ([^\r\n]+)$/gm),
    ...text.matchAll(/`system-design-team ([^`]+)`/g),
  ];
}

test("documentation uses only implemented CLI commands and options", async () => {
  const bin = join(repository, "packages", "cli", "dist", "bin.js");
  const commands = helpCommands((await execFileAsync(process.execPath, [bin, "--help"])).stdout);
  for (const path of documents) {
    const text = await readFile(join(repository, path), "utf8");
    for (const match of documentedInvocations(text)) {
      const words = match[1].trim().split(/\s+/);
      const name = commands.has(`${words[0]} ${words[1]}`) ? `${words[0]} ${words[1]}` : words[0];
      assert(commands.has(name), `${path} documents unimplemented command: ${name}`);
      for (const option of [...match[1].matchAll(/--([\w-]+)/g)].map((item) => item[1])) {
        assert(commands.get(name).has(option), `${path} documents invalid --${option} for ${name}`);
      }
    }
  }
});

test("CI runs the complete check on every supported OS and Node version", async () => {
  const workflow = parse(await readFile(join(repository, ".github", "workflows", "ci.yml"), "utf8"));
  assert.deepEqual(workflow.jobs.check.strategy.matrix.os, [
    "ubuntu-latest", "windows-latest", "macos-latest",
  ]);
  assert.deepEqual(workflow.jobs.check.strategy.matrix.node, [20, 22]);
  assert.deepEqual(
    workflow.jobs.check.steps.filter((step) => step.run).map((step) => step.run),
    ["npm ci", "npm run check"],
  );
  const scripts = JSON.parse(await readFile(join(repository, "package.json"), "utf8")).scripts;
  assert.equal(scripts.test, "node --test");
  await Promise.all([
    "package-smoke.test.mjs",
    "e2e-greenfield.test.mjs",
    "e2e-existing-system.test.mjs",
    "e2e-migration.test.mjs",
  ].map((path) => access(join(repository, "tests", path))));
});

test("documentation links resolve and claims match V1 boundaries", async () => {
  const combined = [];
  for (const path of documents) {
    const text = await readFile(join(repository, path), "utf8");
    combined.push(text);
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(target)) continue;
      await access(resolve(repository, dirname(path), target.split("#")[0]));
    }
  }
  const text = combined.join("\n");
  for (const staleClaim of [
    /first V1 vertical slice/i,
    /first slice/i,
    /JSON (?:cache|index)/i,
    /built-in SQLite/i,
    /automatically deploys? (?:to )?production/i,
    /invokes? third-party plugins?/i,
  ]) assert.doesNotMatch(text, staleClaim);
  for (const uri of [
    "plugin://superpowers@openai-curated-remote",
    "plugin://code-craftsmanship@wondelai-skills",
    "plugin://systems-architecture@wondelai-skills",
    "plugin://ux-design@wondelai-skills",
    "plugin://codex-security@openai-curated-remote",
  ]) assert.match(text, new RegExp(uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /does not prove (?:a )?plugin invocation/i);
  assert.match(text, /does not deploy to production/i);
});
