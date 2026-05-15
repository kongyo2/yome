import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stateHome } from "../xdg/index.js";

const LOG_FILE_PREFIX = "mo-";
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_BACKUPS = 3;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function logDir(): string {
  return join(stateHome(), "mo", "log");
}

function cleanOldLogs(dir: string, ageMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(LOG_FILE_PREFIX)) continue;
    const p = join(dir, name);
    try {
      const info = statSync(p);
      if (info.isDirectory()) continue;
      if (now - info.mtimeMs > ageMs) {
        unlinkSync(p);
      }
    } catch {
      // best-effort
    }
  }
}

class RotatingWriter {
  filename: string;
  maxSize: number;
  maxBackups: number;
  private size: number;
  private closed = false;

  constructor(filename: string, maxSize: number, maxBackups: number) {
    this.filename = filename;
    this.maxSize = maxSize;
    this.maxBackups = maxBackups;
    if (!existsSync(filename)) {
      try {
        writeFileSync(filename, "", { mode: 0o644, flag: "a" });
      } catch {
        // ignore
      }
    }
    this.size = this.statSize();
  }

  private statSize(): number {
    try {
      return statSync(this.filename).size;
    } catch {
      return 0;
    }
  }

  private backupName(i: number): string {
    return `${this.filename}.${i}`;
  }

  write(chunk: string | Buffer): void {
    if (this.closed) return;
    const len = Buffer.byteLength(chunk);
    if (this.size + len > this.maxSize) {
      this.rotate();
    }
    try {
      appendFileSync(this.filename, chunk, { mode: 0o644 });
      this.size += len;
    } catch {
      // best-effort
    }
  }

  private rotate(): void {
    try {
      unlinkSync(this.backupName(this.maxBackups));
    } catch {
      // best-effort
    }
    for (let i = this.maxBackups - 1; i >= 1; i--) {
      try {
        renameSync(this.backupName(i), this.backupName(i + 1));
      } catch {
        // ignore non-existent
      }
    }
    try {
      renameSync(this.filename, this.backupName(1));
    } catch {
      // ignore
    }
    try {
      const fd = openSync(this.filename, "a", 0o644);
      closeSync(fd);
    } catch {
      // ignore
    }
    this.size = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }
}

let activeWriter: RotatingWriter | null = null;
let originalStderr: typeof process.stderr.write | null = null;
let originalStdout: typeof process.stdout.write | null = null;

export function setup(port: number): () => void {
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  cleanOldLogs(dir, MAX_AGE_MS);

  const filename = join(dir, `mo-${port}.log`);
  const writer = new RotatingWriter(filename, MAX_SIZE, MAX_BACKUPS);
  activeWriter = writer;

  return () => {
    if (activeWriter === writer) activeWriter = null;
    writer.close();
  };
}

export function getWriter(): RotatingWriter | null {
  return activeWriter;
}

export interface LogFields {
  [key: string]: unknown;
}

function writeJson(
  level: string,
  msg: string,
  fields: LogFields | undefined,
): void {
  if (process.env["MO_LOG_SILENT"] === "1" && !activeWriter) return;
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const k of Object.keys(fields)) {
      entry[k] = fields[k];
    }
  }
  const line = JSON.stringify(entry) + "\n";
  if (activeWriter) {
    activeWriter.write(line);
  } else {
    process.stderr.write(line);
  }
}

export const logger = {
  info(msg: string, fields?: LogFields): void {
    writeJson("INFO", msg, fields);
  },
  warn(msg: string, fields?: LogFields): void {
    writeJson("WARN", msg, fields);
  },
  error(msg: string, fields?: LogFields): void {
    writeJson("ERROR", msg, fields);
  },
  debug(msg: string, fields?: LogFields): void {
    writeJson("DEBUG", msg, fields);
  },
};

export function redirectStdio(): void {
  if (originalStderr || originalStdout) return;
  originalStderr = process.stderr.write.bind(process.stderr);
  originalStdout = process.stdout.write.bind(process.stdout);
}

export function restoreStdio(): void {
  if (originalStderr) {
    process.stderr.write = originalStderr;
    originalStderr = null;
  }
  if (originalStdout) {
    process.stdout.write = originalStdout;
    originalStdout = null;
  }
}
