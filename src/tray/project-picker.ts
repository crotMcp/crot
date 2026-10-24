import path from "node:path";

interface FolderChoice {
  canceled: boolean;
  filePaths: string[];
}
interface ProjectPickerDependencies {
  choose(): Promise<FolderChoice>;
  product(method: "projects.open" | "projects.select", params: Record<string, string>): Promise<unknown>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Native owner choice only. No renderer-supplied path; service owns canonicalization and switching. */
export class ProjectFolderPicker {
  private busy = false;

  async open(deps: ProjectPickerDependencies): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const choice = await deps.choose();
      if (choice.canceled || choice.filePaths.length !== 1) return false;
      const chosen = choice.filePaths[0]!;
      if (!path.isAbsolute(chosen) || chosen.includes("\0")) return false;
      const opened = await deps.product("projects.open", { path: chosen });
      if (!record(opened) || opened.ok !== true || !record(opened.project) || typeof opened.project.id !== "string")
        return false;
      const selected = await deps.product("projects.select", { id: opened.project.id });
      return (
        record(selected) &&
        selected.ok === true &&
        record(selected.project) &&
        selected.project.id === opened.project.id
      );
    } finally {
      this.busy = false;
    }
  }
}
