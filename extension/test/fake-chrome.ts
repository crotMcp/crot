import type {
  ChromeApi,
  ChromeCaptureOptions,
  ChromeEvent,
  ChromeInjectionResult,
  ChromePort,
  ChromeScriptInjection,
  ChromeTab,
  ChromeTabQuery,
} from "../src/chrome-api.js";

/** In-memory stand-in for the parts of the chrome.* API the extension uses. */

export class FakeEvent<L extends (...args: never[]) => void> implements ChromeEvent<L> {
  readonly listeners = new Set<L>();
  addListener(listener: L): void {
    this.listeners.add(listener);
  }
  removeListener(listener: L): void {
    this.listeners.delete(listener);
  }
  emit(...args: Parameters<L>): void {
    for (const listener of [...this.listeners]) (listener as (...a: Parameters<L>) => void)(...args);
  }
}

export class FakePort implements ChromePort {
  readonly sent: unknown[] = [];
  disconnected = false;
  failPost = false;
  readonly onMessage = new FakeEvent<(message: unknown, port: ChromePort) => void>();
  readonly onDisconnect = new FakeEvent<(port: ChromePort) => void>();

  constructor(private readonly runtime: FakeRuntime) {}

  postMessage(message: unknown): void {
    if (this.disconnected || this.failPost) throw new Error("Attempting to use a disconnected port object");
    // Native messaging serializes to JSON.
    this.sent.push(JSON.parse(JSON.stringify(message)));
  }

  disconnect(): void {
    // Like Chrome: no onDisconnect event for the side that disconnects.
    this.disconnected = true;
  }

  /** The host sends a message. */
  deliver(message: unknown): void {
    this.onMessage.emit(message, this);
  }

  /** The host side goes away (relay exit). */
  hostDisconnect(error = "Native host has exited."): void {
    this.disconnected = true;
    this.runtime.lastError = { message: error };
    this.onDisconnect.emit(this);
    this.runtime.lastError = undefined;
  }
}

export class FakeRuntime {
  lastError: { message?: string } | undefined;
  readonly ports: FakePort[] = [];
  readonly hosts: string[] = [];
  failConnect = false;
  readonly onStartup = new FakeEvent<() => void>();
  readonly onInstalled = new FakeEvent<() => void>();

  connectNative(application: string): ChromePort {
    this.hosts.push(application);
    if (this.failConnect) throw new Error("Specified native messaging host not found.");
    const port = new FakePort(this);
    this.ports.push(port);
    return port;
  }

  getManifest(): { version: string } {
    return { version: "0.1.0" };
  }

  get lastPort(): FakePort {
    const port = this.ports[this.ports.length - 1];
    if (!port) throw new Error("no port");
    return port;
  }
}

type MutableTab = { -readonly [K in keyof ChromeTab]: ChromeTab[K] };

export interface FakeTabsOptions {
  /** Status of tabs right after create/update; "complete" means no load wait. */
  readonly loadStatus?: "loading" | "complete";
}

export class FakeChrome {
  readonly runtime = new FakeRuntime();
  readonly tabsById = new Map<number, MutableTab>();
  readonly focused: number[] = [];
  readonly injections: ChromeScriptInjection<unknown[], unknown>[] = [];
  readonly captures: { windowId: number; options: ChromeCaptureOptions }[] = [];
  /** What executeScript returns for the main frame; defaults to running the function locally. */
  scriptResult: ((injection: ChromeScriptInjection<unknown[], unknown>) => unknown) | undefined;
  scriptError: Error | undefined;
  captureResult: (windowId: number, options: ChromeCaptureOptions) => string = (_w, o) => "data:image/" + o.format + ";base64,iVBORw0KGgo=";
  captureError: Error | undefined;
  /** Called after captureVisibleTab resolves (to simulate a tab switch). */
  afterCapture: (() => void) | undefined;
  loadStatus: "loading" | "complete" = "complete";
  private nextId = 100;

  readonly tabsOnUpdated = new FakeEvent<(tabId: number, changeInfo: { status?: string }, tab: ChromeTab) => void>();
  readonly tabsOnRemoved = new FakeEvent<(tabId: number) => void>();
  readonly alarmsOnAlarm = new FakeEvent<(alarm: { name: string }) => void>();

  addTab(tab: Partial<MutableTab> & { id: number }): MutableTab {
    const full: MutableTab = { windowId: 1, active: false, url: "https://example.com/", title: "Example", status: "complete", ...tab };
    this.tabsById.set(tab.id, full);
    return full;
  }

  /** Finish loading a tab (fires tabs.onUpdated). */
  complete(tabId: number, url?: string): void {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new Error("no tab");
    tab.status = "complete";
    if (url !== undefined || tab.pendingUrl !== undefined) tab.url = url ?? tab.pendingUrl;
    delete tab.pendingUrl;
    this.tabsOnUpdated.emit(tabId, { status: "complete" }, { ...tab });
  }

  private tab(tabId: number): MutableTab {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new Error("No tab with id: " + tabId + ".");
    return tab;
  }

  private navigateTab(tab: MutableTab, url: string): void {
    if (this.loadStatus === "complete") {
      tab.url = url;
      tab.status = "complete";
    } else {
      tab.pendingUrl = url;
      tab.status = "loading";
    }
  }

  private activate(tab: MutableTab): void {
    for (const other of this.tabsById.values()) if (other.windowId === tab.windowId) other.active = false;
    tab.active = true;
  }

  get api(): ChromeApi {
    const self = this;
    return {
      runtime: this.runtime,
      tabs: {
        async query(query: ChromeTabQuery): Promise<ChromeTab[]> {
          return [...self.tabsById.values()]
            .filter((t) => query.active === undefined || t.active === query.active)
            .filter((t) => query.windowId === undefined || t.windowId === query.windowId)
            .filter((t) => !query.lastFocusedWindow || t.windowId === 1)
            .map((t) => ({ ...t }));
        },
        async get(tabId: number): Promise<ChromeTab> {
          return { ...self.tab(tabId) };
        },
        async create(properties: { url: string; active: boolean }): Promise<ChromeTab> {
          const tab = self.addTab({ id: self.nextId++, url: "", title: "", status: "loading" });
          self.navigateTab(tab, properties.url);
          if (properties.active) self.activate(tab);
          return { ...tab };
        },
        async update(tabId: number, properties: { url?: string; active?: boolean }): Promise<ChromeTab | undefined> {
          const tab = self.tab(tabId);
          if (properties.url !== undefined) self.navigateTab(tab, properties.url);
          if (properties.active) self.activate(tab);
          return { ...tab };
        },
        async remove(tabId: number): Promise<void> {
          self.tab(tabId);
          self.tabsById.delete(tabId);
          self.tabsOnRemoved.emit(tabId);
        },
        async captureVisibleTab(windowId: number, options: ChromeCaptureOptions): Promise<string> {
          self.captures.push({ windowId, options });
          if (self.captureError) throw self.captureError;
          const result = self.captureResult(windowId, options);
          self.afterCapture?.();
          return result;
        },
        onUpdated: this.tabsOnUpdated,
        onRemoved: this.tabsOnRemoved,
      },
      windows: {
        async update(windowId: number): Promise<unknown> {
          self.focused.push(windowId);
          return {};
        },
      },
      scripting: {
        async executeScript<A extends unknown[], R>(injection: ChromeScriptInjection<A, R>): Promise<ChromeInjectionResult[]> {
          const generic = injection as unknown as ChromeScriptInjection<unknown[], unknown>;
          self.injections.push(generic);
          self.tab(injection.target.tabId);
          if (self.scriptError) throw self.scriptError;
          const result = self.scriptResult ? self.scriptResult(generic) : injection.func(...injection.args);
          // Results are structured-cloned.
          return [{ frameId: 0, result: result === undefined ? undefined : structuredClone(result) }];
        },
      },
      alarms: {
        async create(): Promise<void> {},
        onAlarm: this.alarmsOnAlarm,
      },
    };
  }
}

/** Let pending promise callbacks run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
