/** Product information architecture. Labels are canonical offline translation keys. */
export const SECTIONS = [
  "Home",
  "Chat",
  "Accounts",
  "Permissions",
  "Projects",
  "Agents",
  "Connectors",
  "MCP Servers",
  "Browser",
  "Files",
  "Terminal",
  "Git",
  "Docker",
  "Tasks",
  "Monitoring",
  "Settings",
] as const;
export const PROJECT_TABS = ["Overview", "Files", "Git", "Tasks", "Agents", "Connectors", "Settings"] as const;
export const SETTINGS = [
  "General",
  "Device & Account",
  "Remote Access",
  "Security",
  "Permissions",
  "Browser",
  "Network",
  "Integrations",
  "MCP",
  "Updates & Diagnostics",
  "About",
] as const;
export const CONNECTORS = [
  ["GitHub", "Development"],
  ["GitLab", "Development"],
  ["YouTube", "Video & Social"],
  ["TikTok", "Video & Social"],
  ["ElevenLabs", "AI & Media"],
  ["FFmpeg Media Pipeline", "AI & Media"],
  ["Notion", "Productivity"],
  ["Google Drive", "Productivity"],
  ["Slack", "Productivity"],
  ["Custom HTTP API", "Custom API"],
] as const;

/** Ten owner-requested destinations. Existing guarded tools remain contextual. */
export const PRIMARY_SECTIONS = [
  "Home",
  "Chat",
  "Agents",
  "Projects",
  "Connectors",
  "Accounts",
  "Permissions",
  "Browser",
  "Monitoring",
  "Settings",
] as const;
export const SECTION_LABELS: Readonly<Record<string, string>> = {
  Chat: "Unified Chat",
  Agents: "Agents & Tokens",
  Monitoring: "Journal",
};
