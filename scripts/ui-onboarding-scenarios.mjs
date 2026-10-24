/** Real Chromium viewport and state-machine checks. Account/entitlement events are explicitly IPC fixtures. */
export async function runOnboardingScenarios({ evaluate, until, size, screenshot, navigate, assert }) {
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const geometry = async (name, selector) => {
    const result = await evaluate(
      `(()=>{const d=document.documentElement;const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {scroll:d.scrollHeight<=d.clientHeight&&d.scrollWidth<=d.clientWidth,visible:b.top>=0&&b.left>=0&&b.bottom<=innerHeight+1&&b.right<=innerWidth+1, width:d.clientWidth,height:d.clientHeight};})()`,
    );
    assert(result.scroll && result.visible, name + ": viewport/essential content overflow " + JSON.stringify(result));
  };
  for (const [width, height] of [
    [1280, 820],
    [1180, 780],
  ]) {
    await size(width, height);
    await navigate("/control-center?launch=" + Math.random() + "#terminal");
    await until("document.querySelectorAll('#navigation>[data-section]').length===10");
    for (const lang of ["ru", "en"]) {
      await evaluate(`window.CrotI18n.setLanguage('${lang}')`);
      assert(
        await evaluate("!document.getElementById('auth-gate').hidden&&document.getElementById('app').hidden"),
        "old hash must not bypass auth",
      );
      await geometry("auth", ".auth-card");
      await screenshot(`onboarding-01-auth-${lang}-${width}x${height}`);
      await click("local-mode");
      assert(
        await evaluate("!document.getElementById('plan-gate').hidden&&document.getElementById('app').hidden"),
        "local must enter plans, not internal tools",
      );
      await geometry("plans", ".plan-layout");
      assert(
        await evaluate("document.querySelector('.plan-card.pro .price strong').textContent==='$3'"),
        "Pro must be $3",
      );
      await screenshot(`onboarding-02-plans-${lang}-${width}x${height}`);
      await click("start-trial");
      assert(
        await evaluate("!document.getElementById('plan-gate').hidden&&!actions.some(a=>a[0]==='ui.startTrial')"),
        "anonymous trial must not fake entitlement",
      );
      await evaluate("document.getElementById('action-dialog').close()");
      await click("choose-free");
      await until("document.querySelector('.home-dashboard')&&document.querySelectorAll('.recent-row').length>0");
      await geometry("home", ".home-overview");
      assert(
        await evaluate(
          "[...document.querySelectorAll('.home-overview button')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;})",
        ),
        "Home category actions clipped",
      );
      await screenshot(`onboarding-03-home-${lang}-${width}x${height}`);
      await navigate("/control-center?launch=" + Math.random() + "#terminal");
    }
  }
  await size(1280, 820);
  await navigate("/control-center");
  await evaluate("window.CrotI18n.setLanguage('en');document.getElementById('work-email').value='person@example.test'");
  for (const [id, provider] of [
    ["google", "GoogleOAuth"],
    ["github", "GitHubOAuth"],
    ["login", "authkit"],
  ]) {
    await click(id);
    assert(
      await evaluate(`actions.some(a=>a[0]==='pairing.start'&&a[1].provider==='${provider}')`),
      "provider routing " + provider,
    );
    assert(await evaluate("!document.getElementById('auth-gate').hidden"), "opening OAuth is not authentication");
  }
  await evaluate("fixture.accountSignedIn=true;render(fixture)");
  assert(await evaluate("!document.getElementById('plan-gate').hidden"), "verified pairing must enter plans");
  await click("start-trial");
  assert(
    await evaluate("actions.some(a=>a[0]==='ui.startTrial')&&document.getElementById('app').hidden"),
    "Checkout opening must not grant Pro",
  );
  await evaluate(
    "fixture.commercial={...fixture.commercial,plan:'trial',state:'current',entitled:false};render(fixture)",
  );
  assert(await evaluate("document.getElementById('app').hidden"), "unverified trial must not grant UI admission");
  await evaluate(
    "fixture.pairing.state='paired';fixture.commercial={...fixture.commercial,entitled:true};render(fixture)",
  );
  assert(await evaluate("!document.getElementById('app').hidden"), "verified entitlement must reach Home");
  // A new application launch must still start at the explicit auth gate.
  await navigate("/control-center?launch=" + Math.random() + "#files");
  assert(await evaluate("!document.getElementById('auth-gate').hidden"), "saved local mode must not bypass startup");
  await click("local-mode");
  await click("skip-plan");
}
