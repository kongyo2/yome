#!/usr/bin/env node
import { runCli } from "../cli/index.js";

async function main(): Promise<void> {
  try {
    const code = await runCli();
    process.exitCode = code;
  } catch (err: unknown) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

void main();
