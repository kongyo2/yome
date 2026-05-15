import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  tmp = await mkdtemp(join(tmpdir(), "mo-http-"));
  state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
  server = createServer(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  state.closeAllSubscribers();
  state.closeBackup();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

async function get(
  path: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(baseURL + path);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const res = await fetch(baseURL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

async function deleteJson(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const res = await fetch(baseURL + path, {
    method: "DELETE",
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

async function putJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const res = await fetch(baseURL + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

describe("CSP header", () => {
  it("sets the Content-Security-Policy header on every response", async () => {
    const r = await get("/_/api/groups");
    expect(r.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
  });
});

describe("GET /_/api/version", () => {
  it("returns version info", async () => {
    const r = await get("/_/api/version");
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.version).toBe("1.5.5");
    expect(data.revision).toBe("HEAD");
  });
});

describe("GET /_/api/status", () => {
  it("returns version, pid, groups", async () => {
    const r = await get("/_/api/status");
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.version).toBe("1.5.5");
    expect(data.pid).toBe(process.pid);
    expect(Array.isArray(data.groups)).toBe(true);
  });
});

describe("POST /_/api/groups/:group/files", () => {
  it("adds a file and returns the entry", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A\n");
    const r = await postJson("/_/api/groups/default/files", { path });
    expect(r.status).toBe(200);
    const entry = JSON.parse(r.body);
    expect(entry.path).toBe(path);
    expect(entry.title).toBe("A");
  });

  it("returns 400 for missing file", async () => {
    const r = await postJson("/_/api/groups/default/files", {
      path: join(tmp, "missing.md"),
    });
    expect(r.status).toBe(400);
  });

  it("rejects binary files", async () => {
    const path = join(tmp, "bin");
    await writeFile(path, Buffer.from([0xff, 0x00, 0x01]));
    const r = await postJson("/_/api/groups/default/files", { path });
    expect(r.status).toBe(400);
    expect(r.body).toContain("binary");
  });

  it("rejects invalid group name", async () => {
    const r = await postJson("/_/api/groups/_/files", { path: tmp });
    expect(r.status).toBe(400);
  });
});

describe("POST /_/api/groups/:group/files/upload", () => {
  it("accepts uploaded content", async () => {
    const r = await postJson("/_/api/groups/default/files/upload", {
      name: "hello.md",
      content: "# Hello",
    });
    expect(r.status).toBe(200);
    const entry = JSON.parse(r.body);
    expect(entry.uploaded).toBe(true);
    expect(entry.name).toBe("hello.md");
  });

  it("rejects empty name", async () => {
    const r = await postJson("/_/api/groups/default/files/upload", {
      name: "",
      content: "hi",
    });
    expect(r.status).toBe(400);
  });
});

describe("GET /_/api/groups", () => {
  it("returns empty array initially", async () => {
    const r = await get("/_/api/groups");
    expect(JSON.parse(r.body)).toEqual([]);
  });
  it("includes added files", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    await postJson("/_/api/groups/default/files", { path });
    const r = await get("/_/api/groups");
    const groups = JSON.parse(r.body);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("default");
    expect(groups[0].files).toHaveLength(1);
  });
});

describe("GET /_/api/groups/:group/files/:id/content", () => {
  it("returns file content for a known ID", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# Hello\n");
    const addRes = await postJson("/_/api/groups/default/files", { path });
    const id = JSON.parse(addRes.body).id;
    const r = await get(`/_/api/groups/default/files/${id}/content`);
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.content).toBe("# Hello\n");
    expect(data.baseDir).toBe(tmp);
  });
  it("returns 404 for unknown file", async () => {
    const r = await get("/_/api/groups/default/files/deadbeef/content");
    expect(r.status).toBe(404);
  });
  it("removes entry and returns 404 when underlying file is missing", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    const addRes = await postJson("/_/api/groups/default/files", { path });
    const id = JSON.parse(addRes.body).id;
    await rm(path);
    const r = await get(`/_/api/groups/default/files/${id}/content`);
    expect(r.status).toBe(404);
    const groups = JSON.parse((await get("/_/api/groups")).body);
    expect(groups).toEqual([]);
  });
});

describe("DELETE /_/api/groups/:group/files/:id", () => {
  it("removes the file", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    const addRes = await postJson("/_/api/groups/default/files", { path });
    const id = JSON.parse(addRes.body).id;
    const r = await deleteJson(`/_/api/groups/default/files/${id}`);
    expect(r.status).toBe(204);
  });
  it("returns 404 when file is unknown", async () => {
    const r = await deleteJson("/_/api/groups/default/files/deadbeef");
    expect(r.status).toBe(404);
  });
});

describe("PUT /_/api/groups/:group/reorder", () => {
  it("reorders files", async () => {
    const p1 = join(tmp, "a.md");
    const p2 = join(tmp, "b.md");
    await writeFile(p1, "# A");
    await writeFile(p2, "# B");
    const e1 = JSON.parse(
      (await postJson("/_/api/groups/default/files", { path: p1 })).body,
    );
    const e2 = JSON.parse(
      (await postJson("/_/api/groups/default/files", { path: p2 })).body,
    );
    const r = await putJson("/_/api/groups/default/reorder", {
      fileIds: [e2.id, e1.id],
    });
    expect(r.status).toBe(204);
    const groups = JSON.parse((await get("/_/api/groups")).body);
    expect(groups[0].files.map((f: { id: string }) => f.id)).toEqual([
      e2.id,
      e1.id,
    ]);
  });
  it("returns 400 when IDs mismatch", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    await postJson("/_/api/groups/default/files", { path });
    const r = await putJson("/_/api/groups/default/reorder", {
      fileIds: ["deadbeef"],
    });
    expect(r.status).toBe(400);
  });
});

describe("PUT /_/api/groups/:group/files/:id/group", () => {
  it("moves a file between groups", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    const e = JSON.parse(
      (await postJson("/_/api/groups/src/files", { path })).body,
    );
    const r = await putJson(`/_/api/groups/src/files/${e.id}/group`, {
      group: "dst",
    });
    expect(r.status).toBe(204);
    const groups = JSON.parse((await get("/_/api/groups")).body);
    const dst = groups.find((g: { name: string }) => g.name === "dst");
    expect(dst.files).toHaveLength(1);
  });
});

describe("POST /_/api/patterns / DELETE", () => {
  it("registers and removes a glob pattern", async () => {
    await writeFile(join(tmp, "a.md"), "# A");
    await writeFile(join(tmp, "b.md"), "# B");
    const add = await postJson("/_/api/patterns", {
      pattern: join(tmp, "*.md"),
      group: "default",
    });
    expect(add.status).toBe(200);
    expect(JSON.parse(add.body).matched).toBe(2);
    const remove = await deleteJson("/_/api/patterns", {
      pattern: join(tmp, "*.md"),
      group: "default",
    });
    expect(remove.status).toBe(204);
  });
});

describe("GET /_/api/search", () => {
  it("finds matches across files", async () => {
    const p1 = join(tmp, "a.md");
    await writeFile(p1, "# Title\nhello world");
    await postJson("/_/api/groups/default/files", { path: p1 });
    const r = await get("/_/api/search?q=hello");
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.total).toBe(1);
    expect(data.results[0].fileName).toBe("a.md");
  });
  it("returns 400 when q is missing", async () => {
    const r = await get("/_/api/search");
    expect(r.status).toBe(400);
  });
});

describe("GET /_/api/groups/:group/files/:id/raw/:path", () => {
  it("serves sibling assets", async () => {
    const dir = join(tmp, "doc");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.md"), "# A");
    await writeFile(join(dir, "image.png"), Buffer.from("PNG"));
    const e = JSON.parse(
      (
        await postJson("/_/api/groups/default/files", {
          path: join(dir, "a.md"),
        })
      ).body,
    );
    const r = await get(`/_/api/groups/default/files/${e.id}/raw/image.png`);
    expect(r.status).toBe(200);
    expect(r.body).toBe("PNG");
  });
  it("rejects path traversal", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    const e = JSON.parse(
      (await postJson("/_/api/groups/default/files", { path })).body,
    );
    const r = await get(`/_/api/groups/default/files/${e.id}/raw/..%2Fsecret`);
    expect([400, 403, 404]).toContain(r.status);
  });
});

describe("404 for unknown API route", () => {
  it("returns 404", async () => {
    const r = await get("/_/api/unknown");
    expect(r.status).toBe(404);
  });
});
