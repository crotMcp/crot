import type { EnvironmentPolicy } from "./types.js";

/** Environment policy; `caseInsensitive` is true on Windows. */
export function createEnvironmentPolicy(caseInsensitive: boolean): EnvironmentPolicy {
  const key = (name: string) => (caseInsensitive ? name.toUpperCase() : name);
  return {
    caseInsensitive,
    merge(base, overrides = {}) {
      // Canonical key -> [name as spelled, value]
      const entries = new Map<string, [string, string]>();
      for (const [name, value] of Object.entries(base)) {
        if (value !== undefined) entries.set(key(name), [name, value]);
      }
      for (const [name, value] of Object.entries(overrides)) {
        const k = key(name);
        if (value === null) {
          entries.delete(k);
        } else {
          // Keep the existing spelling (e.g. Windows "Path") so the child sees one variable.
          const existing = entries.get(k);
          entries.set(k, [existing ? existing[0] : name, value]);
        }
      }
      return Object.fromEntries([...entries.values()]);
    },
    get(env, name) {
      if (!caseInsensitive) return env[name];
      const wanted = name.toUpperCase();
      for (const [n, v] of Object.entries(env)) if (n.toUpperCase() === wanted && v !== undefined) return v;
      return undefined;
    },
  };
}
