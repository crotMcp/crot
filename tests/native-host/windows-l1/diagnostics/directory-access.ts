/** Fixed native probe schema. An open is not a read/write operation or a grant. */
export const directoryProbeMasks = [128, 32, 1, 2, 4, 65536, 262144, 524288] as const;
export type DirectoryAccess = {
  depth: number;
  attributeError: number;
  opens: { mask: number; error: number; closeError: number }[];
};
function uint32(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}
export function parseDirectoryAccess(text: string): DirectoryAccess[] {
  const value = JSON.parse(text) as { directoryAccess?: unknown };
  const rows = value.directoryAccess;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64) throw new Error("Directory probe count");
  for (const [depth, row] of rows.entries()) {
    if (row?.depth !== depth || !uint32(row.attributeError) || !Array.isArray(row.opens))
      throw new Error("Directory probe row");
    if (row.opens.length !== directoryProbeMasks.length) throw new Error("Directory probe masks");
    for (const [i, open] of row.opens.entries()) {
      if (open?.mask !== directoryProbeMasks[i] || !uint32(open.error) || !uint32(open.closeError))
        throw new Error("Directory probe result");
    }
  }
  return rows as DirectoryAccess[];
}
