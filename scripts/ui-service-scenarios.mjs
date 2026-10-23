import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
export async function runServiceScenarios({ real, evaluate, until, size, screenshot, navigate, artifacts }) {
  const click = async (label, selector = "button") => {
    await until(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`,
    );
  };
  const fill = (label, value) =>
    evaluate(
      `(()=>{const el=Array.from(document.querySelectorAll('label')).find(l=>l.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input,textarea');if(!el)throw Error('Missing field');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const section = async (name) => {
    const slug = name.toLowerCase().replaceAll(" ", "-");
    if (await evaluate(`!!document.getElementById('nav-${slug}')`))
      await evaluate(`document.getElementById('nav-${slug}').click()`);
    else {
      if (!(await evaluate(`!!document.getElementById('tool-${slug}')`)))
        await evaluate("document.getElementById('nav-projects').click()");
      await evaluate(`document.getElementById('tool-${slug}').click()`);
    }
    await until(
      `(document.getElementById('tool-${slug}')||document.getElementById('nav-${slug}')).getAttribute('aria-current')==='page'`,
    );
  };
  const confirm = async () => {
    await click("Confirm", "dialog button");
    await until("!document.getElementById('action-dialog').open");
  };
  await size(1280, 960);
  await navigate("/control-center");
  await until("document.getElementById('auth-gate')&&!document.getElementById('auth-gate').hidden");
  await screenshot("01-auth-real-service");
  await click("Continue without an account");
  await click("Choose Free");
  await until("!document.getElementById('app').hidden");
  await until("document.querySelector('#project-select option')?.textContent");
  await screenshot("02-home-real-service");
  await section("Projects");
  await click("New Project");
  await fill("Project name", "Service E2E");
  await fill("Folder path", path.join(real.base, "second"));
  await click("Create project", "dialog button");
  await until("!document.getElementById('action-dialog').open");
  await until("document.body.textContent.includes('Service E2E')");
  const state = await real.verify();
  if (state.projects !== 2) throw Error("Real project was not persisted");
  await screenshot("03-projects-real-service");
  await section("Files");
  await fill("File path", path.join(real.base, "second", "proof.txt"));
  await fill("Content", "UI to real CrotService");
  await click("Save file");
  await confirm();
  await until("document.body.textContent.includes('proof.txt')");
  if ((await readFile(path.join(real.base, "second", "proof.txt"), "utf8")) !== "UI to real CrotService")
    throw Error("Workspace write failed");
  await click("Read file");
  await section("Terminal");
  await fill("Command", "git init");
  await click("Run");
  await until("document.body.textContent.includes('stdout')");
  await delay(1600);
  await section("Git");
  await click("Status");
  await until("document.querySelector('main pre')?.textContent.includes('proof.txt')");
  await screenshot("04-git-real-service");
  await section("Connectors");
  await until(
    "document.querySelectorAll('#content .panel').length>=10 || document.body.textContent.includes('Custom HTTP API')",
  );
  await evaluate(
    `(()=>{const p=Array.from(document.querySelectorAll('section')).find(p=>p.querySelector('h2')?.textContent==='Custom HTTP API');p.querySelector('button').click();})()`,
  );
  await fill("API key / OAuth token", "fixture-ui-secret");
  await fill("Endpoint", state.endpoint);
  await click("Connect", "dialog button");
  await until("!document.getElementById('action-dialog').open");
  await evaluate(
    `Array.from(document.querySelectorAll('section')).find(p=>p.querySelector('h2')?.textContent==='Custom HTTP API').querySelector('button').click()`,
  );
  await click("Test Connection", "dialog button");
  await until("document.querySelector('dialog pre')?.textContent.includes('Connected')");
  await screenshot("05-connector-real-service");
  await click("Close", "dialog button");
  await section("MCP Servers");
  await click("Add server");
  await fill("Server name", "Real fixture MCP");
  await fill("Command", process.execPath);
  await fill("Arguments (JSON array)", JSON.stringify([path.resolve("tests/fixtures/product-mcp.mjs")]));
  await click("Add server", "dialog button");
  await until("!document.getElementById('action-dialog').open");
  await click("Connect");
  await confirm();
  await until("document.body.textContent.includes('echo')");
  await screenshot("06-mcp-discovery-real-service");
  // Cancel/Escape and server refusals must leave the checkbox in the confirmed state.
  const policy = "document.querySelector('main input[type=checkbox]')";
  await evaluate(`${policy}.click()`);
  await until("document.getElementById('action-dialog').open");
  await click("Cancel", "dialog button");
  await until(`${policy}.checked===false&&!${policy}.disabled`);
  await evaluate(`${policy}.click()`);
  await until("document.getElementById('action-dialog').open");
  await evaluate(
    "document.getElementById('action-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));document.getElementById('action-dialog').close()",
  );
  await until(`${policy}.checked===false&&!${policy}.disabled`);
  await evaluate(`${policy}.click()`);
  await confirm();
  await until(`${policy}.checked===true&&!${policy}.disabled`);
  // Rename only the client-side identifier: the real service rejects this unknown server.
  await evaluate(
    "window.originalProduct=window.crot.product;window.crot.product=function(name,input){return window.originalProduct.call(this,name,name==='mcpServers.setToolPolicy'?{...input,id:'nonexistent-server'}:input)}",
  );
  await evaluate(`${policy}.click()`);
  await confirm();
  await until(`${policy}.checked===true&&!${policy}.disabled`);
  await until("document.getElementById('notice').textContent==='Operation failed. Check permissions and try again.'");
  await evaluate("window.crot.product=window.originalProduct;delete window.originalProduct");

  await section("Terminal");
  await fill("Command", `"${process.execPath}" -e "setInterval(()=>{},1000)"`);
  await click("Run");
  await until("document.querySelector('main pre')?.textContent.includes('id')");
  await section("Tasks");
  await until("document.body.textContent.includes('Running')");
  await click("Cancel");
  await confirm();
  await until("document.body.textContent.includes('Cancelled')");
  await screenshot("07-task-cancel-real-service");
  await section("Monitoring");
  await fill("Event type", "filesystem.write_file");
  await click("Apply filters");
  await until("document.body.textContent.includes('filesystem.write_file')");
  await screenshot("08-audit-real-service");
  if ((await evaluate("document.body.textContent")).includes("fixture-ui-secret"))
    throw Error("Credential leaked to UI");
  for (const name of ["Browser", "Settings"]) {
    await section(name);
    await screenshot(name.toLowerCase() + "-real-service");
  }
  await writeFile(
    path.join(artifacts, "verification.json"),
    JSON.stringify(
      {
        status: "passed",
        scope:
          "Shipped Chromium UI → test-only IPC bridge → real isolated CrotService; projects/files/git/terminal/connector HTTP/MCP stdio/tasks cancellation/real audit",
        ...(await real.verify()),
      },
      null,
      2,
    ),
  );
}
