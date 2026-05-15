#!/usr/bin/env node
import { runCli } from "../cli/index.js";

runCli()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
