// Binary detection shared by the server (file heads, uploads) and the CLI
// (piped stdin). Kept dependency-free so the CLI can import it without
// dragging the server subtree into its startup path.

export function isBinaryBuffer(buf: Buffer): boolean {
  return buf.indexOf(0) !== -1;
}

// isBinaryText mirrors isBinaryBuffer for already-decoded content: a NUL
// character never appears in genuine text.
export function isBinaryText(content: string): boolean {
  return content.includes("\0");
}
