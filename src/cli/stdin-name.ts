import { createHash } from "node:crypto";

// Kept in its own module (dynamically imported by readStdin) so that
// node:crypto — which Node compiles lazily and not cheaply — stays out of
// the CLI's static import graph for invocations without piped stdin.
export function stdinName(content: string): string {
  const h = createHash("sha256");
  h.update(content);
  return "stdin-" + h.digest("hex").substring(0, 7) + ".md";
}
