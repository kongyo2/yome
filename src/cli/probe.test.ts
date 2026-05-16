import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type AddressInfo } from "node:net";
import { type Server } from "node:http";
import { State } from "../server/state.js";
import { createServer } from "../server/http.js";
import { Version } from "../version.js";
import {
  httpGetJson,
  httpRequestJson,
  probeServer,
  waitForReady,
  waitForServerDown,
} from "./probe.js";

let state: State;
let server: Server;
let addr: string;

beforeEach(async () => {
  state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
  server = createServer(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = server.address() as AddressInfo;
  addr = `127.0.0.1:${a.port}`;
});

afterEach(async () => {
  state.closeAllSubscribers();
  state.closeBackup();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("probeServer", () => {
  it("returns status when server is running", async () => {
    const r = await probeServer(addr, 2000);
    expect(r.status.version).toBe(Version);
    expect(Array.isArray(r.groups)).toBe(true);
  });
  it("rejects when nothing is listening", async () => {
    await expect(probeServer("127.0.0.1:1", 200)).rejects.toThrow();
  });
});

describe("httpGetJson", () => {
  it("fetches JSON from an endpoint", async () => {
    const data = await httpGetJson<{ version: string }>(
      `http://${addr}/_/api/version`,
      2000,
    );
    expect(data.version).toBe(Version);
  });
});

describe("httpRequestJson", () => {
  it("POSTs body and returns status + body", async () => {
    const r = await httpRequestJson(
      "POST",
      `http://${addr}/_/api/shutdown`,
      {},
      2000,
    );
    expect(r.status).toBe(202);
  });
});

describe("waitForReady", () => {
  it("resolves immediately when server is up", async () => {
    const status = await waitForReady(addr, 2000);
    expect(status?.version).toBe(Version);
  });
});

describe("waitForServerDown", () => {
  it("rejects when the server stays up", async () => {
    await expect(waitForServerDown(addr, 200)).rejects.toThrow(
      /did not shut down/,
    );
  });
});
