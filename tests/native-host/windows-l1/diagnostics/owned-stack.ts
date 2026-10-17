/** Test-only call-site extraction. Never publish raw debugger output or frame arguments. */
export function ownedStackNames(text: string): { native: string[]; managed: string[] } {
  const native: string[] = [];
  const managed: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // k (not kv/kp): retain the symbolic call site only, not addresses/stack words.
    const symbol = line.match(/\b([A-Za-z0-9_.-]+![A-Za-z0-9_.$:<>~`+?-]+)/)?.[1];
    if (symbol && native.length < 180) native.push(symbol.slice(0, 160));
    // clrstack without -a/-p: cut at '(' before any parameter type/value text.
    const method = line.match(/\b((?:System\.|Microsoft\.PowerShell\.)[A-Za-z0-9_.$+<>`]+)\(/)?.[1];
    if (method && managed.length < 100) managed.push(method.slice(0, 200));
  }
  return { native, managed };
}
