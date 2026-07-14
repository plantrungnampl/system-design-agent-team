import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "packages/cli/dist/assets");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const directory of ["agents", "workflows", "templates"]) {
  await cp(join(root, directory), join(destination, directory), { recursive: true });
}
