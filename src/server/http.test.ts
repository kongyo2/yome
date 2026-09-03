import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo, type Socket } from "node:net";
import { State } from "./state.js";
import { createServer } from "./http.js";
import { Version } from "../version.js";

let tmp: string;
let state: State;
let baseURL: string;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "yome-http-"));
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
    expect(data.version).toBe(Version);
    expect(data.revision).toBe("HEAD");
  });
});

describe("GET /_/api/status", () => {
  it("returns version, pid, groups", async () => {
    const r = await get("/_/api/status");
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.version).toBe(Version);
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

  it("rejects missing content with a 400 (not a 500)", async () => {
    const r = await postJson("/_/api/groups/default/files/upload", {
      name: "x.md",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/content/i);
  });

  it("rejects non-string content with a 400", async () => {
    const r = await postJson("/_/api/groups/default/files/upload", {
      name: "x.md",
      content: 12345,
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
    expect(groups[0].patterns).toEqual([]);
  });
  it("includes watch patterns registered for the group", async () => {
    await mkdir(join(tmp, "docs"));
    const pattern = join(tmp, "docs", "*.md");
    const add = await postJson("/_/api/patterns", {
      pattern,
      group: "default",
    });
    expect(add.status).toBe(200);
    const groups = JSON.parse((await get("/_/api/groups")).body);
    const def = groups.find((g: { name: string }) => g.name === "default");
    expect(def.patterns).toEqual([pattern]);
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
  it("rejects non-integer, zero, or negative limit / context values", async () => {
    const p1 = join(tmp, "a.md");
    await writeFile(p1, "hello");
    await postJson("/_/api/groups/default/files", { path: p1 });
    for (const q of ["limit=0.5", "limit=0", "limit=-1", "limit=abc"]) {
      const r = await get(`/_/api/search?q=hello&${q}`);
      expect(r.status, q).toBe(400);
    }
    for (const q of ["context=1.5", "context=-1", "context=x"]) {
      const r = await get(`/_/api/search?q=hello&${q}`);
      expect(r.status, q).toBe(400);
    }
    const zeroCtx = await get("/_/api/search?q=hello&context=0");
    expect(zeroCtx.status).toBe(200);
  });
  it("clamps limit and context to their maximums", async () => {
    const p1 = join(tmp, "a.md");
    await writeFile(p1, "hello");
    await postJson("/_/api/groups/default/files", { path: p1 });
    const r = await get("/_/api/search?q=hello&limit=99999&context=50");
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.limit).toBe(200);
    expect(data.context).toBe(5);
  });
});

describe("request body validation", () => {
  it("answers 400 (not 500) when the JSON body is not an object", async () => {
    for (const body of ["null", "[]", "42", '"str"']) {
      const res = await fetch(baseURL + "/_/api/groups/default/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });
  it("answers 400 when reorder fileIds is missing or not a string array", async () => {
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    await postJson("/_/api/groups/default/files", { path });
    const missing = await putJson("/_/api/groups/default/reorder", {});
    expect(missing.status).toBe(400);
    const wrongType = await putJson("/_/api/groups/default/reorder", {
      fileIds: [1, 2],
    });
    expect(wrongType.status).toBe(400);
  });
  it("answers 400 when a pattern request has no pattern", async () => {
    const add = await postJson("/_/api/patterns", { group: "default" });
    expect(add.status).toBe(400);
    expect(add.body).toMatch(/pattern/);
    const del = await deleteJson("/_/api/patterns", { group: "default" });
    expect(del.status).toBe(400);
  });
  it("answers 400 when open request lacks fileId or path", async () => {
    const r1 = await postJson("/_/api/groups/default/files/open", {
      path: "x.md",
    });
    expect(r1.status).toBe(400);
    const r2 = await postJson("/_/api/groups/default/files/open", {
      fileId: "deadbeef",
    });
    expect(r2.status).toBe(400);
  });
  it("delivers a 413 for an oversized upload instead of dropping the connection", async () => {
    // 12MB body limit for the JSON envelope; send comfortably more.
    const content = "x".repeat(13 * 1024 * 1024);
    const res = await fetch(baseURL + "/_/api/groups/default/files/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "big.md", content }),
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("too large");
    expect(res.headers.get("connection")).toBe("close");
    // The server keeps serving afterwards.
    expect((await get("/_/api/version")).status).toBe(200);
  });
  it("keeps reading an oversized body after answering 413 so a client still uploading is not reset", async () => {
    // Send most of an oversized body, wait for the 413, then send the tail:
    // a client whose upload is still in flight when the server answers. The
    // server has to consume that tail before closing the socket. Closing
    // with unread bytes makes the kernel reset the connection, and the
    // client can then lose the 413 behind an EPIPE / ECONNRESET.
    const body = JSON.stringify({
      name: "big.md",
      content: "x".repeat(13 * 1024 * 1024),
    });
    const { port } = server.address() as AddressInfo;
    const head =
      "POST /_/api/groups/default/files/upload HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    const serverSockets: Socket[] = [];
    server.on("connection", (s) => serverSockets.push(s));
    const client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    const errors: Error[] = [];
    client.on("error", (err) => errors.push(err));
    let received = "";
    client.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    await once(client, "connect");
    const tail = 256 * 1024;
    client.write(head + body.slice(0, body.length - tail));
    await vi.waitFor(() => expect(received).toMatch(/^HTTP\/1\.1 413 /), {
      timeout: 5000,
      interval: 5,
    });
    client.write(body.slice(body.length - tail));
    client.end();
    await once(client, "close");
    expect(errors).toEqual([]);
    expect(received).toContain("too large");
    expect(received.toLowerCase()).toContain("connection: close");
    // The socket was closed only after the whole request had been read.
    expect(serverSockets).toHaveLength(1);
    expect(serverSockets[0].bytesRead).toBe(
      Buffer.byteLength(head) + Buffer.byteLength(body),
    );
    // The server keeps serving afterwards.
    expect((await get("/_/api/version")).status).toBe(200);
  });

  it("rejects binary uploaded content with a 400", async () => {
    const r = await postJson("/_/api/groups/default/files/upload", {
      name: "image.png",
      content: "PNG  ",
    });
    expect(r.status).toBe(400);
    expect(r.body).toContain("binary");
    expect(JSON.parse((await get("/_/api/groups")).body)).toEqual([]);
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
  it("sends validators and answers 304 to a matching conditional request", async () => {
    const dir = join(tmp, "doc");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.md"), "# A");
    await writeFile(join(dir, "pic.png"), Buffer.from("PNGDATA"));
    const e = JSON.parse(
      (
        await postJson("/_/api/groups/default/files", {
          path: join(dir, "a.md"),
        })
      ).body,
    );
    const url = `${baseURL}/_/api/groups/default/files/${e.id}/raw/pic.png`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag");
    const lastModified = first.headers.get("last-modified");
    expect(etag).toMatch(/^W\/"/);
    expect(lastModified).toBeTruthy();
    await first.arrayBuffer();

    const byEtag = await fetch(url, { headers: { "if-none-match": etag! } });
    expect(byEtag.status).toBe(304);
    expect(await byEtag.text()).toBe("");

    const byDate = await fetch(url, {
      headers: { "if-modified-since": lastModified! },
    });
    expect(byDate.status).toBe(304);

    const stale = await fetch(url, { headers: { "if-none-match": '"nope"' } });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("PNGDATA");

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("7");
    expect(await head.text()).toBe("");
  });
  it("changes the validator when an asset is replaced by rename with the same size and mtime", async () => {
    const dir = join(tmp, "doc");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.md"), "# A");
    const pic = join(dir, "pic.png");
    const stamp = new Date("2026-01-02T03:04:05.000Z");
    await writeFile(pic, "AAAAAAA");
    await utimes(pic, stamp, stamp);
    const e = JSON.parse(
      (
        await postJson("/_/api/groups/default/files", {
          path: join(dir, "a.md"),
        })
      ).body,
    );
    const url = `${baseURL}/_/api/groups/default/files/${e.id}/raw/pic.png`;
    const first = await fetch(url);
    const etag = first.headers.get("etag")!;
    expect(await first.text()).toBe("AAAAAAA");

    // A generator that preserves timestamps writes the same number of
    // bytes to a temp file and renames it over the original.
    const tmpPic = join(dir, ".pic.png.tmp");
    await writeFile(tmpPic, "BBBBBBB");
    await utimes(tmpPic, stamp, stamp);
    await rename(tmpPic, pic);

    const second = await fetch(url, { headers: { "if-none-match": etag } });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    expect(await second.text()).toBe("BBBBBBB");
  });

  it("answers 404 for a directory under the document's folder", async () => {
    const dir = join(tmp, "doc");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.md"), "# A");
    const e = JSON.parse(
      (
        await postJson("/_/api/groups/default/files", {
          path: join(dir, "a.md"),
        })
      ).body,
    );
    const r = await get(`/_/api/groups/default/files/${e.id}/raw/sub`);
    expect(r.status).toBe(404);
  });
});

describe("404 for unknown API route", () => {
  it("returns 404", async () => {
    const r = await get("/_/api/unknown");
    expect(r.status).toBe(404);
  });
});

describe("malformed percent-encoding", () => {
  it("does not crash the server when the route path has invalid encoding", async () => {
    const r = await get("/_/api/groups/%E0%A4%A/files/abc/content");
    // Should be a 404 (treated as non-match) and the server must keep running.
    expect(r.status).toBe(404);
    // Server is still alive: subsequent valid request still works.
    const ok = await get("/_/api/version");
    expect(ok.status).toBe(200);
  });

  it("returns 400 for malformed SPA paths instead of crashing", async () => {
    const r = await get("/%E0%A4%A");
    expect(r.status).toBe(400);
    // Server is still alive.
    const ok = await get("/_/api/version");
    expect(ok.status).toBe(200);
  });
});

describe("raw asset path boundary", () => {
  it("rejects sibling-directory traversal that startsWith() would accept", async () => {
    const appDir = join(tmp, "app");
    const siblingDir = join(tmp, "app2");
    await mkdir(appDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(appDir, "doc.md"), "# A");
    await writeFile(join(siblingDir, "secret.txt"), "SECRET");
    const e = JSON.parse(
      (
        await postJson("/_/api/groups/default/files", {
          path: join(appDir, "doc.md"),
        })
      ).body,
    );
    const r = await get(
      `/_/api/groups/default/files/${e.id}/raw/${encodeURIComponent("../app2/secret.txt")}`,
    );
    expect([403, 404]).toContain(r.status);
    if (r.status === 200) expect(r.body).not.toContain("SECRET");
  });
});

describe("uploaded content is not leaked in list / status responses", () => {
  it("strips content from GET /_/api/groups", async () => {
    await postJson("/_/api/groups/default/files/upload", {
      name: "secret.md",
      content: "very confidential",
    });
    const r = await get("/_/api/groups");
    expect(r.body).not.toContain("very confidential");
    const data = JSON.parse(r.body) as Array<{
      files: Array<Record<string, unknown>>;
    }>;
    for (const g of data) {
      for (const f of g.files) {
        expect(f).not.toHaveProperty("content");
      }
    }
  });

  it("strips content from GET /_/api/status", async () => {
    await postJson("/_/api/groups/default/files/upload", {
      name: "secret.md",
      content: "very confidential",
    });
    const r = await get("/_/api/status");
    expect(r.body).not.toContain("very confidential");
  });
});

describe("Non-ASCII / percent-encoded paths", () => {
  it("POST /_/api/groups/:group/files/open resolves percent-encoded non-ASCII relative paths", async () => {
    const src = join(tmp, "index.md");
    const target = join(tmp, "日本語ファイル.md");
    await writeFile(src, "# Index");
    await writeFile(target, "# Japanese");
    const e = JSON.parse(
      (await postJson("/_/api/groups/default/files", { path: src })).body,
    );
    const encoded = encodeURIComponent("日本語ファイル.md");
    const r = await postJson("/_/api/groups/default/files/open", {
      fileId: e.id,
      path: encoded,
    });
    expect(r.status).toBe(200);
    const opened = JSON.parse(r.body);
    expect(opened.path).toBe(target);
  });

  it("GET /raw/:path serves percent-encoded non-ASCII asset names", async () => {
    const mdPath = join(tmp, "index.md");
    const assetPath = join(tmp, "画像.txt");
    await writeFile(mdPath, "# Index");
    await writeFile(assetPath, "asset content");
    const e = JSON.parse(
      (await postJson("/_/api/groups/default/files", { path: mdPath })).body,
    );
    const r = await get(
      `/_/api/groups/default/files/${e.id}/raw/${encodeURIComponent("画像.txt")}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe("asset content");
  });
});

describe("SPA fallback", () => {
  it("serves index.html for / when the frontend is built", async () => {
    const r = await get("/");
    // Either index.html (if frontend dist exists) or some response — accept 200 or 404.
    expect([200, 404]).toContain(r.status);
    if (r.status === 200) {
      expect(r.headers.get("Content-Type")).toMatch(/text\/html/);
    }
  });
  it("falls back to index.html for unknown SPA routes when frontend exists", async () => {
    const r = await get("/some/spa/route");
    expect([200, 404]).toContain(r.status);
  });
});

describe("CSRF protection on control-plane endpoints", () => {
  it("rejects POST /_/api/shutdown when Sec-Fetch-Site is cross-site", async () => {
    const res = await fetch(baseURL + "/_/api/shutdown", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST /_/api/restart when Sec-Fetch-Site is cross-site", async () => {
    const res = await fetch(baseURL + "/_/api/restart", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST /_/api/shutdown when Origin does not match Host", async () => {
    const res = await fetch(baseURL + "/_/api/shutdown", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts POST /_/api/shutdown without Origin / Sec-Fetch-Site headers (CLI client)", async () => {
    const res = await fetch(baseURL + "/_/api/shutdown", { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("accepts POST /_/api/shutdown with same-origin Sec-Fetch-Site", async () => {
    const res = await fetch(baseURL + "/_/api/shutdown", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(202);
  });

  it("rejects POST /_/api/shutdown when Sec-Fetch-Site is same-site (sibling subdomain)", async () => {
    const res = await fetch(baseURL + "/_/api/shutdown", {
      method: "POST",
      headers: { "sec-fetch-site": "same-site" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST /_/api/shutdown when Origin is null (opaque origin)", async () => {
    const res = await fetch(baseURL + "/_/api/shutdown", {
      method: "POST",
      headers: { origin: "null" },
    });
    expect(res.status).toBe(403);
  });
});

describe("CSRF protection on state-mutating endpoints", () => {
  const crossSite = { "sec-fetch-site": "cross-site" } as const;

  it("rejects cross-site POST /_/api/groups/:group/files", async () => {
    const res = await fetch(baseURL + "/_/api/groups/default/files", {
      method: "POST",
      headers: crossSite,
      body: JSON.stringify({ path: join(tmp, "x.md") }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects cross-site POST /_/api/groups/:group/files/upload", async () => {
    const res = await fetch(baseURL + "/_/api/groups/default/files/upload", {
      method: "POST",
      headers: crossSite,
      body: JSON.stringify({ name: "a.md", content: "# A" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects cross-site DELETE /_/api/groups/:group/files/:id", async () => {
    const res = await fetch(baseURL + "/_/api/groups/default/files/deadbeef", {
      method: "DELETE",
      headers: crossSite,
    });
    expect(res.status).toBe(403);
  });

  it("rejects cross-site PUT /_/api/groups/:group/files/:id/group", async () => {
    const res = await fetch(
      baseURL + "/_/api/groups/default/files/deadbeef/group",
      {
        method: "PUT",
        headers: crossSite,
        body: JSON.stringify({ group: "other" }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects cross-site PUT /_/api/groups/:group/reorder", async () => {
    const res = await fetch(baseURL + "/_/api/groups/default/reorder", {
      method: "PUT",
      headers: crossSite,
      body: JSON.stringify({ fileIds: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects cross-site POST /_/api/groups/:group/files/open", async () => {
    const res = await fetch(baseURL + "/_/api/groups/default/files/open", {
      method: "POST",
      headers: crossSite,
      body: JSON.stringify({ fileId: "deadbeef", path: "other.md" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects cross-site POST and DELETE /_/api/patterns", async () => {
    const post = await fetch(baseURL + "/_/api/patterns", {
      method: "POST",
      headers: crossSite,
      body: JSON.stringify({ pattern: join(tmp, "*.md"), group: "default" }),
    });
    expect(post.status).toBe(403);
    const del = await fetch(baseURL + "/_/api/patterns", {
      method: "DELETE",
      headers: crossSite,
      body: JSON.stringify({ pattern: join(tmp, "*.md"), group: "default" }),
    });
    expect(del.status).toBe(403);
  });

  it("rejects cross-origin POST with text/plain content type (no-preflight form)", async () => {
    const res = await fetch(baseURL + "/_/api/groups/default/files", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ path: join(tmp, "x.md") }),
    });
    expect(res.status).toBe(403);
  });

  it("still accepts header-less requests (CLI client) on mutating endpoints", async () => {
    await writeFile(join(tmp, "cli.md"), "# CLI\n");
    const res = await postJson("/_/api/groups/default/files", {
      path: join(tmp, "cli.md"),
    });
    expect(res.status).toBe(200);
  });

  it("still accepts same-origin browser requests on mutating endpoints", async () => {
    const res = await fetch(baseURL + "/_/api/groups/default/files/upload", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "ok.md", content: "# OK" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("Debounced file change", () => {
  it("collapses repeated scheduleFileChanged calls into one SSE event", async () => {
    const debouncedState = new State({
      fileChangeDebounceMs: 30,
      disableWatcher: true,
    });
    const events: string[] = [];
    debouncedState.subscribe((e) => {
      if (e.name === "file-changed") events.push(e.data);
    });
    const path = join(tmp, "x.md");
    await writeFile(path, "# X\n");
    debouncedState.addFile(path, "default");
    // private method; cast to access
    (
      debouncedState as unknown as { scheduleFileChanged: (p: string) => void }
    ).scheduleFileChanged(path);
    (
      debouncedState as unknown as { scheduleFileChanged: (p: string) => void }
    ).scheduleFileChanged(path);
    (
      debouncedState as unknown as { scheduleFileChanged: (p: string) => void }
    ).scheduleFileChanged(path);
    await new Promise((r) => setTimeout(r, 80));
    expect(events.length).toBe(1);
    debouncedState.closeAllSubscribers();
    await debouncedState.closeBackup();
  });
});
