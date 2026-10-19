import { describe, expect, it } from "vitest";
import { createCommandHandlers, httpOrigin, type CommandContext } from "../src/commands.js";
import { ExtensionError } from "../src/errors.js";
import { FakeChrome } from "./fake-chrome.js";

const CONNECTION = "a".repeat(32);
const context = (...args: [] | [string | undefined]): CommandContext => {
  const id = args.length === 0 ? CONNECTION : args[0];
  return { connectionId: () => id };
};
const expected = (tabId: number | undefined, origin = "https://example.com") =>
  tabId === undefined ? { origin, connectionId: CONNECTION } : { tabId, origin, connectionId: CONNECTION };

function setup() {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://example.com/a", title: "A" });
  fake.addTab({ id: 2, windowId: 1, active: false, url: "https://example.org/b", title: "B" });
  fake.addTab({ id: 3, windowId: 2, active: true, url: "chrome://settings/", title: "Settings" });
  // Page functions need a DOM; the checks under test happen before injection.
  fake.scriptResult = () => ({ ok: true, value: { content: "", truncated: false } });
  const handlers = createCommandHandlers(fake.api, { loadWaitMs: 1000 });
  return { fake, handlers };
}

async function failure(promise: Promise<unknown>): Promise<ExtensionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExtensionError) return error;
    throw error;
  }
  throw new Error("expected the command to fail");
}

describe("tabs.resolve (AD-8)", () => {
  it("resolves the given tab or the active tab of the last focused window, without acting", async () => {
    const { fake, handlers } = setup();
    await expect(handlers["tabs.resolve"]({})).resolves.toEqual({ tabId: 1, url: "https://example.com/a" });
    await expect(handlers["tabs.resolve"]({ tabId: 2 })).resolves.toEqual({ tabId: 2, url: "https://example.org/b" });
    expect((await failure(handlers["tabs.resolve"]({ tabId: 99 }))).code).toBe("NOT_FOUND");
    expect((await failure(handlers["tabs.resolve"]({ tabId: 1, extra: 1 }))).code).toBe("INVALID_INPUT");
    expect(fake.injections).toHaveLength(0);
    expect(fake.focused).toHaveLength(0);
  });

  it("reports the committed URL, not a pending navigation", async () => {
    const { fake, handlers } = setup();
    const tab = fake.tabsById.get(1);
    if (tab) tab.pendingUrl = "https://elsewhere.example/";
    await expect(handlers["tabs.resolve"]({ tabId: 1 })).resolves.toEqual({ tabId: 1, url: "https://example.com/a" });
  });
});

describe("expected browser subject (AD-11)", () => {
  it("acts when tab, origin and connection match", async () => {
    const { fake, handlers } = setup();
    await expect(
      handlers["page.click"]({ tabId: 1, selector: "body", expect: expected(1) }, context()),
    ).resolves.toMatchObject({ tabId: 1 });
    expect(fake.injections).toHaveLength(1);
  });

  it.each([
    ["another tab id", { tabId: 1, expect: expected(2, "https://example.org") }],
    ["a missing tab id", { expect: expected(1) }],
    ["another origin", { tabId: 1, expect: expected(1, "https://example.org") }],
    ["a non-normalized origin", { tabId: 1, expect: expected(1, "https://EXAMPLE.com:443") }],
    ["a closed tab", { tabId: 42, expect: expected(42) }],
    ["a non-http page", { tabId: 3, expect: expected(3, "chrome://settings") }],
  ])("refuses %s with PERMISSION_DENIED without acting", async (_name, params) => {
    const { fake, handlers } = setup();
    for (const command of ["page.click", "page.read", "page.type"] as const) {
      const full = {
        ...params,
        ...(command === "page.read" ? { format: "text", maxBytes: 100 } : { selector: "body" }),
        ...(command === "page.type" ? { text: "x", clear: false } : {}),
      };
      expect((await failure(handlers[command](full, context()))).code).toBe("PERMISSION_DENIED");
    }
    expect(fake.injections).toHaveLength(0);
  });

  it("refuses a different or unknown connection", async () => {
    const { fake, handlers } = setup();
    const params = { tabId: 1, selector: "body", expect: expected(1) };
    expect((await failure(handlers["page.click"](params, context("b".repeat(32))))).code).toBe("PERMISSION_DENIED");
    expect((await failure(handlers["page.click"](params, context(undefined)))).code).toBe("PERMISSION_DENIED");
    expect((await failure(handlers["page.click"](params))).code).toBe("PERMISSION_DENIED");
    expect(fake.injections).toHaveLength(0);
  });

  it("treats a pending navigation to another origin as a mismatch", async () => {
    const { fake, handlers } = setup();
    const tab = fake.tabsById.get(1);
    if (tab) tab.pendingUrl = "https://evil.example/";
    const error = await failure(handlers["page.click"]({ tabId: 1, selector: "body", expect: expected(1) }, context()));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(fake.injections).toHaveLength(0);
  });

  it("checks tab commands before navigating, activating or closing", async () => {
    const { fake, handlers } = setup();
    const wrong = expected(2, "https://example.com");
    expect(
      (await failure(handlers["tabs.navigate"]({ tabId: 2, url: "https://x.example/", expect: wrong }, context())))
        .code,
    ).toBe("PERMISSION_DENIED");
    expect((await failure(handlers["tabs.activate"]({ tabId: 2, expect: wrong }, context()))).code).toBe(
      "PERMISSION_DENIED",
    );
    expect((await failure(handlers["tabs.close"]({ tabId: 2, expect: wrong }, context()))).code).toBe(
      "PERMISSION_DENIED",
    );
    expect(fake.tabsById.get(2)?.url).toBe("https://example.org/b");
    expect(fake.tabsById.has(2)).toBe(true);
    expect(fake.focused).toHaveLength(0);

    await expect(
      handlers["tabs.close"]({ tabId: 2, expect: expected(2, "https://example.org") }, context()),
    ).resolves.toEqual({ tabId: 2, closed: true });
  });

  it("binds tabs.open to the origin of the URL", async () => {
    const { fake, handlers } = setup();
    const before = fake.tabsById.size;
    expect(
      (
        await failure(
          handlers["tabs.open"](
            { url: "https://other.example/", active: false, expect: expected(undefined) },
            context(),
          ),
        )
      ).code,
    ).toBe("PERMISSION_DENIED");
    expect(
      (
        await failure(
          handlers["tabs.open"]({ url: "https://example.com/", active: false, expect: expected(1) }, context()),
        )
      ).code,
    ).toBe("PERMISSION_DENIED");
    expect(fake.tabsById.size).toBe(before);
    await expect(
      handlers["tabs.open"]({ url: "https://EXAMPLE.com/x", active: false, expect: expected(undefined) }, context()),
    ).resolves.toMatchObject({ tabId: expect.any(Number) });
  });

  it("checks the approved tab origin after CDP screenshot capture", async () => {
    const { fake, handlers } = setup();
    fake.debugger.respond = (_id, method) => {
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (method === "Page.captureScreenshot") {
        fake.tabsById.get(1)!.url = "https://changed.example/";
        return { data: "AAAA" };
      }
      return {};
    };
    expect(
      (await failure(handlers["page.screenshot"]({ tabId: 1, format: "png", expect: expected(1) }, context()))).code,
    ).toBe("PERMISSION_DENIED");
  });

  it("rejects a malformed expected subject as invalid input", async () => {
    const { handlers } = setup();
    for (const bad of [null, [], "x", { origin: "https://example.com" }, { ...expected(1), extra: 1 }]) {
      expect((await failure(handlers["page.click"]({ tabId: 1, selector: "a", expect: bad }, context()))).code).toBe(
        "INVALID_INPUT",
      );
    }
  });

  it("normalizes origins like Core", () => {
    expect(httpOrigin("HTTPS://Bücher.Example:443/x")).toBe("https://xn--bcher-kva.example");
    expect(httpOrigin("file:///x")).toBeUndefined();
    expect(httpOrigin("about:blank")).toBeUndefined();
  });
});
