import { describe, it, expect } from "vitest";
import { fileID, uploadedFileID } from "./file-id.js";

describe("fileID", () => {
  it("returns 8 hex chars", () => {
    const id = fileID("/foo/bar.md");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });
  it("is deterministic", () => {
    expect(fileID("/foo/bar.md")).toBe(fileID("/foo/bar.md"));
  });
  it("differs for different paths", () => {
    expect(fileID("/foo/a.md")).not.toBe(fileID("/foo/b.md"));
  });
});

describe("uploadedFileID", () => {
  it("starts with u", () => {
    expect(uploadedFileID("hi")).toMatch(/^u[0-9a-f]{7}$/);
  });
  it("differs from path-based ID with same content", () => {
    const a = uploadedFileID("content");
    const b = fileID("content");
    expect(a).not.toBe(b);
  });
});
