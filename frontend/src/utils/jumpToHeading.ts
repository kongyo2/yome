export function headingIdFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function scrollToHeading(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  return true;
}

// Scroll to a heading by id and reflect it in the URL hash so the location can
// be copied as a deep link, matching how in-document anchor links behave.
export function jumpToHeading(id: string): boolean {
  if (!scrollToHeading(id)) return false;
  window.history.pushState(null, "", `#${id}`);
  return true;
}
