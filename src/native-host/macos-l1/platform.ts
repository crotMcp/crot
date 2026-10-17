/** AD-29 / AD-31 target matrix, not an assertion of CI coverage. */
export function macosPlatformSupported(arch: string, kernelRelease: string): boolean {
  const major = Number(/^(\d+)\./.exec(kernelRelease)?.[1]);
  // Darwin 24=macOS15, 25=macOS26, 26=macOS27. Intel is not an
  // Apple-shipped combination for macOS27; do not invent x64 support there.
  return arch === "arm64" ? [24, 25, 26].includes(major) : arch === "x64" && [24, 25].includes(major);
}
