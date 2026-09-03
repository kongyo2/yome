// localStorage access can throw (privacy modes, exhausted quota, sandboxed
// documents), so every read falls back and every write is best-effort: the
// UI must never depend on persistence being available.

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function readJsonStorage(key: string): unknown {
  const raw = readStorage(key);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  writeStorage(key, JSON.stringify(value));
}

// readStorageRecord returns the stored JSON object under key, or an empty
// record when nothing usable (missing, malformed, null, array) is stored.
export function readStorageRecord<T>(key: string): Record<string, T> {
  const parsed = readJsonStorage(key);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, T>;
  }
  return {};
}

// readStorageInt returns the stored integer when it lies within [min, max],
// otherwise the fallback.
export function readStorageInt(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseInt(readStorage(key) ?? "", 10);
  return n >= min && n <= max ? n : fallback;
}
