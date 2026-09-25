import { useSyncExternalStore } from "react";

/** Hash-based routing for the standalone demo (#portfolio → "/portfolio"). */
export function currentPath(): string {
  const h = typeof location === "undefined" ? "" : location.hash.replace(/^#/, "");
  return h ? `/${h}` : "/";
}

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, currentPath, () => "/");
}
