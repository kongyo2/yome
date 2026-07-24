#!/usr/bin/env node
import { Version, Revision } from "../version.js";

// Exit quietly when the read end of stdout/stderr goes away mid-write
// (e.g. `yome --help | head`). Node otherwise turns the EPIPE into an
// unhandled 'error' event and a crash with a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

async function main(): Promise<void> {
  // Fast path for the exact `yome --version` / `yome -V` invocation: print
  // the same string commander would and skip loading the CLI entirely.
  // Anything else (extra flags, other args) goes through commander so error
  // and precedence behavior stay identical.
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    process.stdout.write(`${Version} ${Revision}\n`);
    return;
  }
  try {
    const { runCli } = await import("../cli/index.js");
    const code = await runCli();
    process.exitCode = code;
  } catch (err: unknown) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

void main();
