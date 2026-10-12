import type { ChromeApi, ChromeInjectionResult, ChromeTab } from "./chrome-api.js";
import { ExtensionError } from "./errors.js";
import { collectInputProbe, installInputProbe, pageVisibility, type PageOutcome } from "./page-functions.js";

/**
 * Input delivery (ARCHITECTURE.md §27, AD-16 points 6 and 7): no control
 * command reports success for input the page never received.
 *
 * - Visible page first. Browsers do not deliver trusted input to hidden
 *   pages: a background tab or a minimized window swallows mouse events
 *   (the browser waits about five seconds for each and drops it). Before
 *   acting, the extension makes the target tab the active tab of its window,
 *   restores a minimized window and, only if the page is still hidden (a
 *   window fully covered by others on Windows or macOS), focuses the window.
 *   If the page still is not visible the command fails and nothing is
 *   dispatched.
 * - Delivery check for clicks and drags: a probe in the extension's isolated
 *   world counts trusted pointer / mouse events that reach the tab's
 *   documents while the input is dispatched. If every probed document is
 *   still there and none saw an event (and the action neither navigated nor
 *   opened a tab), the command fails instead of reporting success.
 *
 * Page code cannot read, call or forge the probe (isolated world; only
 * isTrusted events count) and the probe keeps counts only.
 */

export const VISIBLE_WAIT_MS = 2_000;
const VISIBLE_POLL_MS = 50;

export const HIDDEN_MESSAGE =
  "The tab's page is not visible (the browser window may be minimized or hidden), and the browser does not deliver input to hidden pages. Show the browser window and try again.";
export const NOT_DELIVERED_MESSAGE =
  "The input was not delivered: no pointer event reached the page. Nothing changed on the page; take a new browser_snapshot and try again.";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Inject = <A extends unknown[], T>(
  tabId: number,
  func: (...args: A) => PageOutcome<T>,
  args: A,
  allFrames: boolean,
) => Promise<ChromeInjectionResult[] | undefined>;

/** executeScript in the isolated world; undefined when the page cannot be scripted (the check is then skipped). */
export function injector(api: ChromeApi): Inject {
  return async (tabId, func, args, allFrames) => {
    try {
      return await api.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        func,
        args,
        world: "ISOLATED",
      });
    } catch {
      return undefined;
    }
  };
}

const valueOf = <T>(result: ChromeInjectionResult | undefined): T | undefined => {
  const outcome = result?.result as Partial<{ ok: boolean; value: T }> | null | undefined;
  return typeof outcome === "object" && outcome !== null && outcome.ok === true ? (outcome.value as T) : undefined;
};

async function visibility(inject: Inject, tabId: number): Promise<string | undefined> {
  const results = await inject(tabId, pageVisibility, [], false);
  return valueOf<string>(results?.find((r) => r.frameId === 0) ?? results?.[0]);
}

async function waitVisible(inject: Inject, tabId: number, ms: number): Promise<"visible" | "hidden" | "unknown"> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await visibility(inject, tabId);
    if (state === undefined) return "unknown";
    if (state === "visible") return "visible";
    if (Date.now() >= deadline) return "hidden";
    await sleep(VISIBLE_POLL_MS);
  }
}

/**
 * Makes the tab's page visible for input. Returns whether the extension had
 * to change something (activate the tab, restore or focus its window).
 */
export async function ensureVisible(
  api: ChromeApi,
  inject: Inject,
  tab: ChromeTab & { readonly id: number },
  waitMs = VISIBLE_WAIT_MS,
): Promise<boolean> {
  let changed = false;
  if (!tab.active) {
    await api.tabs.update(tab.id, { active: true });
    changed = true;
  }
  let window: { state?: string } | undefined;
  try {
    window = await api.windows.get(tab.windowId);
  } catch {
    window = undefined;
  }
  if (window?.state === "minimized") {
    await api.windows.update(tab.windowId, { state: "normal" });
    changed = true;
  }
  let state = await waitVisible(inject, tab.id, changed ? waitMs : 0);
  if (state === "hidden") {
    await api.windows.update(tab.windowId, { focused: true });
    changed = true;
    state = await waitVisible(inject, tab.id, waitMs);
  }
  if (state === "hidden") throw new ExtensionError("OPERATION_FAILED", HIDDEN_MESSAGE);
  return changed;
}

/** A running delivery probe over all frames of a tab. */
export interface InputProbe {
  /** True: delivered or unknown; false: every probed document is still there and none saw input. */
  delivered(): Promise<boolean>;
}

let nonceCounter = 0;

export async function startInputProbe(inject: Inject, tabId: number): Promise<InputProbe> {
  const nonce =
    Date.now().toString(36) + "-" + (++nonceCounter).toString(36) + "-" + Math.random().toString(36).slice(2);
  const installed = await inject(tabId, installInputProbe, [nonce], true);
  const frames = new Set((installed ?? []).filter((r) => valueOf<boolean>(r) === true).map((r) => r.frameId));
  return {
    async delivered(): Promise<boolean> {
      const collected = await inject(tabId, collectInputProbe, [nonce], true);
      if (frames.size === 0 || !collected) return true;
      let total = 0;
      const seen = new Set<number>();
      for (const result of collected) {
        const count = valueOf<number | null>(result);
        if (typeof count === "number") {
          total += count;
          seen.add(result.frameId);
        }
      }
      // A probed document that is gone or was replaced: something happened; never claim "not delivered".
      for (const frameId of frames) if (!seen.has(frameId)) return true;
      return total > 0;
    },
  };
}
