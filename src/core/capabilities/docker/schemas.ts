import { z } from "zod";

/**
 * Input and result schemas of the docker.use capability (ARCHITECTURE.md §27,
 * AD-3), owned by Core and reused by adapters.
 *
 * Every value an agent supplies is validated here before authorization. None
 * of them can be read as a Docker option: names never start with '-', and
 * they are passed after '--' where the Docker CLI accepts it.
 */

/** Container name or (full or abbreviated) container ID. */
export const CONTAINER_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
/** Compose project name, as Docker Compose normalizes it. */
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** Compose service name. */
export const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

const ContainerRef = z
  .string()
  .regex(CONTAINER_REF_PATTERN, "A container must be a container name or ID (letters, digits, '_', '.', '-').")
  .describe("Container name or ID.");
const ProjectName = z
  .string()
  .regex(PROJECT_NAME_PATTERN, "A project name consists of lower-case letters, digits, '_' and '-'.")
  .describe("Compose project name.");
const ServiceName = z
  .string()
  .regex(SERVICE_NAME_PATTERN, "A service name consists of letters, digits, '_', '.' and '-'.");
const TimeoutMs = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Timeout in milliseconds (bounded by the configured maximum).");

export const DockerPsInputSchema = z
  .object({
    scope: z
      .enum(["workspace", "all"])
      .default("workspace")
      .describe(
        "workspace: only Compose containers whose project directory is inside the workspace (docker.use); all: every container on the Docker host (also requires filesystem.full).",
      ),
    project: ProjectName.optional().describe("Only containers of this Compose project."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const DockerLogsInputSchema = z
  .object({
    container: ContainerRef,
    tail: z.number().int().positive().max(10_000).default(200).describe("Number of lines from the end of the logs."),
    timestamps: z.boolean().default(false).describe("Prefix every line with its timestamp."),
    timeoutMs: TimeoutMs,
  })
  .strict();

const ComposeFile = z
  .string()
  .min(1)
  .describe("Compose file: absolute, or relative to the workspace root (YAML or JSON).");

export const DockerComposeUpInputSchema = z
  .object({
    cwd: z.string().min(1).default(".").describe("Project directory: absolute, or relative to the workspace root."),
    files: z
      .array(ComposeFile)
      .min(1)
      .max(16)
      .optional()
      .describe(
        "Compose files, merged in order. Default: the first of compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml in the project directory.",
      ),
    projectName: ProjectName.optional().describe("Compose project name (default: the name Compose derives)."),
    services: z.array(ServiceName).max(100).default([]).describe("Services to start (default: all)."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const DockerComposeDownInputSchema = z
  .object({
    project: ProjectName,
    timeoutMs: TimeoutMs,
  })
  .strict();

export type DockerPsInput = z.input<typeof DockerPsInputSchema>;
export type DockerLogsInput = z.input<typeof DockerLogsInputSchema>;
export type DockerComposeUpInput = z.input<typeof DockerComposeUpInputSchema>;
export type DockerComposeDownInput = z.input<typeof DockerComposeDownInputSchema>;

export interface DockerContainer {
  readonly id: string;
  readonly names: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly createdAt: string;
  readonly ports: string;
  /** Compose project and service, when the container belongs to a Compose project. */
  readonly project: string | null;
  readonly service: string | null;
  /** Compose project directory (workspace-relative when inside the workspace). */
  readonly projectDirectory: string | null;
}

export interface DockerPsResult {
  readonly scope: "workspace" | "all";
  readonly containers: DockerContainer[];
  /** True when the Docker output exceeded the output limit and was cut off. */
  readonly truncated: boolean;
}

export interface DockerLogsResult {
  readonly container: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface DockerComposeUpResult {
  readonly project: string;
  readonly projectDirectory: string;
  readonly files: string[];
  readonly services: string[];
  /** Tail of Docker Compose's progress output. */
  readonly output: string;
}

export interface DockerComposeDownResult {
  readonly project: string;
  readonly projectDirectories: string[];
  readonly output: string;
}
