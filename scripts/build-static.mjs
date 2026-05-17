import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "index.html"), join(dist, "index.html"));
await cp(join(root, "src"), join(dist, "src"), { recursive: true });
await writeFile(join(dist, ".nojekyll"), "");
await writeFile(join(dist, "README.txt"), [
  "LPR matGPR static deployment package",
  "",
  "Upload the contents of this dist folder to any static web host.",
  "Entry file: index.html"
].join("\n"));

console.log(`Static site built in ${dist}`);
