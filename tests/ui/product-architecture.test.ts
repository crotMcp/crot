import { describe, expect, it } from "vitest";
import { SECTIONS, PROJECT_TABS, SETTINGS, CONNECTORS, PRIMARY_SECTIONS } from "../../src/tray/product.js";
import { TRAY_ASSETS, TRAY_CSP } from "../../src/tray/assets.js";
import { UI_TOOLS, validateUiTool } from "../../src/tray/tool-client.js";
import { TOOLS } from "../../src/adapters/mcp/tools.js";

describe("Control Center product architecture", () => {
  it("has thirteen distinct sections, seven project tabs and eleven settings sections", () => {
    expect(PRIMARY_SECTIONS).toEqual(["Home", "Projects", "Agents", "Connectors", "Permissions"]);
    expect(SECTIONS).toHaveLength(13);
    expect(new Set(SECTIONS).size).toBe(13);
    expect(PROJECT_TABS).toHaveLength(7);
    expect(SETTINGS).toHaveLength(11);
    expect(SECTIONS.indexOf("Agents")).not.toBe(SECTIONS.indexOf("MCP Servers"));
    expect(CONNECTORS).toHaveLength(10);
  });
  it("ships an auth gate with local admission and no SSO", () => {
    const html = TRAY_ASSETS["/index.html"]!.body;
    expect(html).toContain('id="auth-gate"');
    expect(html).toContain('type="email"');
    expect(html).toContain('autocomplete="email"');
    for (const label of ["Continue without an account", "Continue with Google", "Continue with GitHub", "Free (Local)"])
      expect(html).toContain(label);
    expect(html).not.toMatch(/Single Sign-On|SSO|TARIF|UNKNOWN|tab-dashboard/);
    expect(TRAY_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https:/);
    expect(TRAY_CSP).toContain("connect-src 'none'");
    expect(TRAY_CSP).toContain("img-src data:");
    expect(() => new Function(TRAY_ASSETS["/renderer.js"]!.body)).not.toThrow();
    expect(TRAY_ASSETS["/renderer.js"]!.body).not.toMatch(/innerHTML|insertAdjacentHTML|eval\(/);
  });
  it("ships three startup stages with bounded desktop geometry and offline branding", () => {
    const html = TRAY_ASSETS["/index.html"]!.body,
      css = TRAY_ASSETS["/app.css"]!.body;
    for (const id of ["auth-gate", "plan-gate"]) expect(html).toContain('id="' + id + '"');
    expect(TRAY_ASSETS["/renderer.js"]!.body).toContain("choose-free");
    expect(css).toContain("html,body,#app{width:100vw;height:100vh;overflow:hidden}");
    expect(html).toContain("data:image/svg+xml,");
    expect(html).not.toContain('class="brand-mark" aria-hidden="true">C');
  });
  it("allows only fixed Core tool names and reuses Core schemas", () => {
    for (const name of UI_TOOLS) expect(TOOLS.some((t) => t.name === name)).toBe(true);
    expect(validateUiTool("fs_list_directory", { path: "." })).toMatchObject({
      name: "fs_list_directory",
      arguments: { path: ".", recursive: false },
    });
    for (const name of ["exec", "shutdown", "network_request", "__proto__", "git_push"])
      expect(() => validateUiTool(name, {})).toThrow();
    expect(() => validateUiTool("fs_read_file", { path: ".", bypass: true })).toThrow();
    expect(() => validateUiTool("process_stop", { id: 1 })).toThrow();
    expect(() => validateUiTool("fs_write_file", { path: "a", content: "x".repeat(300000) })).toThrow();
    // Core, not this adapter, owns path confinement and permission decisions.
    expect(validateUiTool("fs_read_file", { path: "../outside" }).arguments.path).toBe("../outside");
  });
});
