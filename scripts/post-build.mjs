#!/usr/bin/env node
import {
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const frontendSrc = join(root, "frontend", "dist");
const frontendDest = join(distDir, "frontend");

if (existsSync(frontendSrc)) {
  mkdirSync(frontendDest, { recursive: true });
  cpSync(frontendSrc, frontendDest, { recursive: true });
}

const binPath = join(distDir, "bin", "mo.js");
if (existsSync(binPath)) {
  const content = readFileSync(binPath, "utf8");
  if (!content.startsWith("#!")) {
    writeFileSync(binPath, "#!/usr/bin/env node\n" + content);
  }
  chmodSync(binPath, 0o755);
}
