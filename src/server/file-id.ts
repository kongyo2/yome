import { createHash } from "node:crypto";

export function fileID(absPath: string): string {
  const h = createHash("sha256");
  h.update(absPath);
  return h.digest("hex").substring(0, 8);
}

export function uploadedFileID(content: string): string {
  const h = createHash("sha256");
  h.update("upload:");
  h.update(content);
  return "u" + h.digest("hex").substring(0, 7);
}
