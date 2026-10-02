import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuthContext } from "../../core/auth/principal.js";
import {
  CreateDirectoryInputSchema,
  DeleteInputSchema,
  ListDirectoryInputSchema,
  MoveInputSchema,
  ReadFileInputSchema,
  StatInputSchema,
  WriteFileInputSchema,
} from "../../core/capabilities/filesystem/schemas.js";
import {
  ExecInputSchema,
  ProcessIdInputSchema,
  ReadOutputInputSchema,
  ShellInputSchema,
  StartProcessInputSchema,
  StopProcessInputSchema,
} from "../../core/capabilities/process/schemas.js";
import type { CrotCore } from "../../core/crot-core.js";

/**
 * MCP tool catalogue. Each tool is a declaration only: a Core-owned input
 * schema, MCP metadata and a one-line delegation to a Core service. No
 * business logic, path handling or authorization lives here.
 */
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations: ToolAnnotations;
  readonly call: (core: CrotCore, context: AuthContext, input: z.output<S>) => Promise<unknown>;
}

function tool<S extends z.ZodType>(definition: ToolDefinition<S>): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

const EmptyInputSchema = z.object({}).strict();
const local = { openWorldHint: false } as const;

export const TOOLS: readonly ToolDefinition[] = [
  tool({
    name: "crot_status",
    title: "CROT status",
    description:
      "Show the operating system, available shells, output encodings, process-control guarantees and PATH source, permission mode, workspace, granted capabilities, protected paths and limits of this CROT installation.",
    inputSchema: EmptyInputSchema,
    annotations: { ...local, readOnlyHint: true },
    call: async (core) => core.status(),
  }),

  // Filesystem
  tool({
    name: "fs_read_file",
    title: "Read file",
    description: "Read a file (utf8 or base64). Large files are returned in chunks: use offset/length and the 'truncated' flag.",
    inputSchema: ReadFileInputSchema,
    annotations: { ...local, readOnlyHint: true },
    call: (core, ctx, input) => core.filesystem.readFile(ctx, input),
  }),
  tool({
    name: "fs_write_file",
    title: "Write file",
    description: "Write a file. Modes: overwrite (default), create (fail if it exists), append. Creates parent directories by default.",
    inputSchema: WriteFileInputSchema,
    annotations: { ...local, readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    call: (core, ctx, input) => core.filesystem.writeFile(ctx, input),
  }),
  tool({
    name: "fs_list_directory",
    title: "List directory",
    description: "List a directory, optionally recursively (symlinks are reported, never followed).",
    inputSchema: ListDirectoryInputSchema,
    annotations: { ...local, readOnlyHint: true },
    call: (core, ctx, input) => core.filesystem.listDirectory(ctx, input),
  }),
  tool({
    name: "fs_stat",
    title: "Stat path",
    description: "Return whether a path exists and its type, size, modification time and symlink target.",
    inputSchema: StatInputSchema,
    annotations: { ...local, readOnlyHint: true },
    call: (core, ctx, input) => core.filesystem.stat(ctx, input),
  }),
  tool({
    name: "fs_create_directory",
    title: "Create directory",
    description: "Create a directory (and missing parents by default).",
    inputSchema: CreateDirectoryInputSchema,
    annotations: { ...local, readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    call: (core, ctx, input) => core.filesystem.createDirectory(ctx, input),
  }),
  tool({
    name: "fs_delete",
    title: "Delete path",
    description: "Delete a file, symlink or directory. Non-empty directories require recursive=true.",
    inputSchema: DeleteInputSchema,
    annotations: { ...local, readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    call: (core, ctx, input) => core.filesystem.delete(ctx, input),
  }),
  tool({
    name: "fs_move",
    title: "Move path",
    description: "Move or rename a file or directory. Fails if the destination exists unless overwrite=true.",
    inputSchema: MoveInputSchema,
    annotations: { ...local, readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    call: (core, ctx, input) => core.filesystem.move(ctx, input),
  }),

  // Processes
  tool({
    name: "process_exec",
    title: "Execute command",
    description:
      "Run an executable with arguments (no shell interpretation) and wait for it to finish. Resolves PATH (and PATHEXT/.cmd on Windows, e.g. npm). Returns exit code, the tail of stdout/stderr and the encoding used to decode them.",
    inputSchema: ExecInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    call: (core, ctx, input) => core.processes.exec(ctx, input),
  }),
  tool({
    name: "shell_run",
    title: "Run shell script",
    description:
      "Run a script through a shell (pipes, redirects, &&) and wait for it to finish. Choose 'shell' to match the script syntax; the default is sh on Linux/macOS and cmd on Windows.",
    inputSchema: ShellInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    call: (core, ctx, input) => core.processes.shell(ctx, input),
  }),
  tool({
    name: "process_start",
    title: "Start background process",
    description:
      "Start a long-running process (dev server, watcher) from either 'command'+'args' or a shell 'script'. Returns its id; poll with process_read_output.",
    inputSchema: StartProcessInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    call: (core, ctx, input) => core.processes.start(ctx, input),
  }),
  tool({
    name: "process_list",
    title: "List background processes",
    description: "List background processes started by CROT and their status.",
    inputSchema: EmptyInputSchema,
    annotations: { ...local, readOnlyHint: true },
    call: (core, ctx) => core.processes.list(ctx),
  }),
  tool({
    name: "process_read_output",
    title: "Read background process output",
    description: "Read stdout/stderr of a background process from the given offsets; pass back nextStdoutOffset/nextStderrOffset to poll.",
    inputSchema: ReadOutputInputSchema,
    annotations: { ...local, readOnlyHint: true },
    call: (core, ctx, input) => core.processes.readOutput(ctx, input),
  }),
  tool({
    name: "process_stop",
    title: "Stop background process",
    description: "Stop a background process and its children (graceful, or immediate with force=true).",
    inputSchema: StopProcessInputSchema,
    annotations: { ...local, readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    call: (core, ctx, input) => core.processes.stop(ctx, input),
  }),
  tool({
    name: "process_remove",
    title: "Remove background process record",
    description: "Forget an exited background process and its captured output.",
    inputSchema: ProcessIdInputSchema,
    annotations: { ...local, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    call: (core, ctx, input) => core.processes.remove(ctx, input),
  }),
];
