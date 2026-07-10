import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AddressInfo } from "node:net";
import { State } from "./state.js";
import { createServer } from "./http.js";

let tmp: string;
let state: State;
let baseURL: string;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "yome-sse-"));
  state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
  server = createServer(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  state.closeAllSubscribers();
  await state.closeBackup();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

async function consumeEvents(timeoutMs: number): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: string[] = [];
  try {
    const res = await fetch(baseURL + "/_/events", {
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        events.push(block);
      }
    }
  } catch {
    // aborted
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe("GET /_/events", () => {
  it("sends a started event with pid as the first frame", async () => {
    const events = await consumeEvents(200);
    expect(events.length).toBeGreaterThan(0);
    const first = events[0]!;
    expect(first).toContain("event: started");
    expect(first).toContain(`"pid":${process.pid}`);
  });

  it("streams update events when state changes", async () => {
    const consumer = consumeEvents(600);
    await new Promise((r) => setTimeout(r, 80));
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    state.addFile(path, "default");
    const events = await consumer;
    const updateEvents = events.filter((e) => e.startsWith("event: update"));
    expect(updateEvents.length).toBeGreaterThanOrEqual(1);
  });
});
