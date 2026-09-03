import { describe, it, expect, beforeEach } from "vitest";
import {
  readJsonStorage,
  readStorage,
  readStorageInt,
  readStorageRecord,
  writeJsonStorage,
  writeStorage,
} from "./storage";

beforeEach(() => {
  localStorage.clear();
});

describe("storage helpers", () => {
  it("round-trips strings and JSON", () => {
    writeStorage("k", "v");
    expect(readStorage("k")).toBe("v");
    writeJsonStorage("j", { a: 1 });
    expect(readJsonStorage("j")).toEqual({ a: 1 });
  });

  it("returns undefined for missing or malformed JSON", () => {
    expect(readJsonStorage("missing")).toBeUndefined();
    localStorage.setItem("bad", "{not json");
    expect(readJsonStorage("bad")).toBeUndefined();
  });

  it("only accepts plain objects as records", () => {
    localStorage.setItem("r", JSON.stringify({ x: true }));
    expect(readStorageRecord<boolean>("r")).toEqual({ x: true });
    for (const raw of ["null", "[]", "42", '"s"', "oops"]) {
      localStorage.setItem("r", raw);
      expect(readStorageRecord("r"), raw).toEqual({});
    }
  });

  it("clamps stored integers to the accepted range", () => {
    expect(readStorageInt("w", 260, 180, 480)).toBe(260);
    localStorage.setItem("w", "300");
    expect(readStorageInt("w", 260, 180, 480)).toBe(300);
    localStorage.setItem("w", "9999");
    expect(readStorageInt("w", 260, 180, 480)).toBe(260);
    localStorage.setItem("w", "abc");
    expect(readStorageInt("w", 260, 180, 480)).toBe(260);
  });
});
