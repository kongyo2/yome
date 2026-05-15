import { createHash } from "node:crypto";
import { fstatSync, constants as fsConstants } from "node:fs";

const MAX_STDIN_SIZE = 10 << 20;

// Mirror Go's `(fi.Mode() & os.ModeCharDevice) == 0`. A TTY or /dev/null is a
// character device and is *not* considered redirected. Pipes and regular files
// are redirected.
export function isStdinRedirected(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const st = fstatSync(0);
    // Character devices include TTYs and /dev/null
    const isCharDevice = (st.mode & fsConstants.S_IFMT) === fsConstants.S_IFCHR;
    return !isCharDevice;
  } catch {
    return false;
  }
}

export async function readStdin(
  stream: NodeJS.ReadableStream,
): Promise<{ name: string; content: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf =
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_STDIN_SIZE) {
      throw new Error("stdin content too large (max 10MB)");
    }
    chunks.push(buf);
  }
  const content = Buffer.concat(chunks).toString("utf8");
  return { name: stdinName(content), content };
}

export function stdinName(content: string): string {
  const h = createHash("sha256");
  h.update(content);
  return "stdin-" + h.digest("hex").substring(0, 7) + ".md";
}
