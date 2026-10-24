/* global document, window, innerWidth */
/** Chromium + axe under production CSP. Fixtures qualify presentation only. */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { TRAY_ASSETS } from "../../dist/tray/assets.js";
import { shim } from "./ui-fixture.mjs";
const output = new URL("../../artifacts/design/", import.meta.url);
await mkdir(output, { recursive: true });
const axe = await readFile(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
let origin;
const server = createServer((req, res) => {
  const key = new URL(req.url, origin).pathname;
  let asset =
    key === "/fixture.js"
      ? { body: shim, type: "text/javascript" }
      : key === "/axe.js"
        ? { body: axe, type: "text/javascript" }
        : TRAY_ASSETS[key === "/" ? "/index.html" : key];
  if (!asset) {
    res.writeHead(404).end();
    return;
  }
  let body = asset.body.replaceAll("crot-tray://app", origin);
  if (key === "/") body = body.replace("<head>", '<head><script src="/fixture.js"></script>');
  res.setHeader("content-type", asset.type);
  res.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const checks = [],
  errors = [],
  screenshots = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    assert(req.url().startsWith(origin) || req.url().startsWith("data:"), "Unexpected network " + req.url());
  });
  await page.goto(origin);
  await page.addScriptTag({ url: origin + "/axe.js" });
  const capture = async (name) => {
    await page.screenshot({ path: new URL(name + ".png", output).pathname, fullPage: true });
    screenshots.push(name);
  };
  const audit = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(80);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert(!overflow, name + " document overflow");
    const result = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      }));
    });
    checks.push({ name, violations: result });
    await writeFile(new URL("report.json", output), JSON.stringify({ checks, screenshots, errors }, null, 2));
  };
  for (const theme of ["light", "dark"])
    for (const language of ["ru", "en"]) {
      await page.evaluate(
        ({ theme, language }) => {
          window.CrotTheme.set(theme);
          window.CrotI18n.setLanguage(language);
        },
        { theme, language },
      );
      // Reload tests synchronous head theme restoration and initial gate.
      await page.reload();
      await page.addScriptTag({ url: origin + "/axe.js" });
      await page.waitForSelector("#auth-gate:not([hidden])");
      await audit(`auth-${theme}-${language}`);
      if ((language === "ru" && theme === "light") || (language === "en" && theme === "dark"))
        await capture(`01-login-${theme}-${language}`);
      await page.click("#local-mode");
      await page.waitForSelector("#plan-gate:not([hidden])");
      await audit(`plans-${theme}-${language}`);
      if ((language === "ru" && theme === "light") || (language === "en" && theme === "dark"))
        await capture(`02-plans-${theme}-${language}`);
      await page.click("#choose-free");
      await page.waitForSelector("#app:not([hidden])");
      for (const [slug, label] of [
        ["home", "03-home"],
        ["chat", "05-chat"],
        ["agents", "07-agents-tokens"],
        ["projects", "08-projects"],
        ["connectors", "10-connectors-web"],
        ["accounts", "11-accounts"],
        ["permissions", "12-permissions"],
        ["browser", "13-browser"],
        ["monitoring", "journal"],
        ["settings", "14-settings"],
      ]) {
        await page.click("#nav-" + slug);
        await page.waitForTimeout(140);
        await audit(`${slug}-${theme}-${language}`);
        if ((language === "ru" && theme === "light") || (language === "en" && theme === "dark"))
          await capture(`${label}-${theme}-${language}`);
        if (slug === "connectors") {
          await page
            .getByRole("button", { name: language === "ru" ? "Локальные инструменты" : "Local tools", exact: true })
            .click();
          await audit(`connectors-local-${theme}-${language}`);
          if ((language === "ru" && theme === "light") || (language === "en" && theme === "dark"))
            await capture(`09-connectors-local-${theme}-${language}`);
        }
      }
      for (const tool of ["files", "terminal", "git", "docker", "tasks", "mcp-servers"]) {
        await page.click("#tool-" + tool);
        await page.waitForTimeout(100);
        await audit(`${tool}-${theme}-${language}`);
      }
    }
  // Geometry and persisted/system theme behavior, without a remote browser.
  for (const width of [960, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (!(await page.locator("#nav-home").isVisible())) await page.locator(".mobile-menu").click();
    await page.click("#nav-home");
    await audit("home-width-" + width);
    await capture("home-width-" + width);
    if (width === 390) break;
  }
  await page.evaluate(() => window.CrotTheme.set("system"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.getAttribute("html", "data-theme"), "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert.equal(await page.getAttribute("html", "data-theme"), "light");
  checks.push({ name: "system-theme-live", violations: [] });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    window.fixture = { ...window.fixture, connection: "disconnected" };
    window.render(window.fixture);
  });
  await page.click("#nav-connectors");
  await audit("bridge-disconnected");
  assert.equal(errors.length, 0, "Browser errors: " + errors.join("; "));
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(new URL("report.json", output), JSON.stringify({ checks, screenshots, errors }, null, 2));
const failures = checks.filter((c) => c.violations.length);
console.log(
  JSON.stringify(
    { checks: checks.length, screenshots: screenshots.length, failures: failures.length, errors },
    null,
    2,
  ),
);
if (failures.length) {
  console.log(JSON.stringify(failures.slice(0, 6), null, 2));
  process.exitCode = 1;
}
