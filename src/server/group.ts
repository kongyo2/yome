export const DefaultGroup = "default";

function normalizeGroupName(name: string): string {
  return name.replace(/^\/+/, "").replace(/\/+$/, "");
}

function validateGroupName(name: string): Error | null {
  if (name.trim() === "") {
    return new Error("group name must not be empty");
  }

  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return new Error("group name must not contain control characters");
    }
  }

  if (name.includes("?") || name.includes("#") || name.includes("\\")) {
    return new Error("group name must not contain '?', '#', or '\\'");
  }

  if (name.startsWith("_/") || name === "_") {
    return new Error(
      "group name must not start with '_/' (reserved for internal API)",
    );
  }

  if (name.includes("//")) {
    return new Error("group name must not contain consecutive slashes");
  }

  for (const seg of name.split("/")) {
    if (seg === "." || seg === "..") {
      return new Error("group name must not contain '.' or '..' path segments");
    }
  }

  return null;
}

export function resolveGroupName(name: string | null | undefined): {
  name: string;
  error: Error | null;
} {
  let resolved = normalizeGroupName(name ?? "");
  if (resolved === "") {
    return { name: DefaultGroup, error: null };
  }
  if (resolved !== DefaultGroup) {
    const err = validateGroupName(resolved);
    if (err) return { name: resolved, error: err };
  }
  return { name: resolved, error: null };
}
