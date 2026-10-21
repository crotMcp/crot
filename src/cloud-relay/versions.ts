/** Admission only, never authorization. Unknown or prerelease versions fail closed when a floor is configured. */
export function versionAtLeast(actual: unknown, minimum?: string): boolean {
  if (minimum === undefined) return true;
  const parse = (v: unknown) =>
    typeof v === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)
      ? v.split(".").map(Number)
      : undefined;
  const a = parse(actual),
    b = parse(minimum);
  if (!a || !b || [...a, ...b].some((n) => !Number.isSafeInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}
export const MINIMUM_MAJOR_SUPPORT_MONTHS = 12;
