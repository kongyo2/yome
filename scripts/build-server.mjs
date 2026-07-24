#!/usr/bin/env node
// Bundle the CLI + server into a small set of pre-linked ESM chunks.
//
// Compared to the previous per-module tsc emit, a bundled dist cuts CLI
// startup latency by more than half: Node no longer resolves and parses
// ~120 individual module files (plus node_modules subtrees) on every
// invocation. Code splitting keeps rarely-used paths (the HTTP server,
// chokidar, …) out of the hot CLI path — they are loaded on demand via
// dynamic import().
//
// Layout contract (relied upon by findFrontendDir/findEntryPoint):
//   dist/bin/yome.js      entry (shebang added by post-build.mjs)
//   dist/chunks/*.js      shared/lazy chunks
//   dist/frontend/        SPA assets (copied by post-build.mjs)
// Both bin/ and chunks/ sit exactly one level below dist/, so
// `resolve(moduleDir, "..", "frontend")` finds the SPA from any chunk.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

rmSync(distDir, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src", "bin", "yome.ts")],
  outdir: distDir,
  outbase: join(root, "src"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  // Keep identifiers so stack traces in the per-port log files stay readable;
  // syntax/whitespace minification still gives most of the parse-time win.
  minifySyntax: true,
  minifyWhitespace: true,
  minifyIdentifiers: false,
  legalComments: "none",
  banner: {
    // Bundled CJS dependencies (commander, picomatch, …) require() node
    // builtins at runtime; in ESM output esbuild routes those through a
    // `require` binding that must be provided per module scope.
    js: 'import { createRequire as __yomeCreateRequire } from "node:module"; const require = /* @__PURE__ */ __yomeCreateRequire(import.meta.url);',
  },
  // `open` resolves its bundled xdg-open helper relative to its own module
  // file at runtime, so it must stay external (it is dynamically imported
  // only when a browser is actually opened).
  external: ["open"],
  logLevel: "info",
});
