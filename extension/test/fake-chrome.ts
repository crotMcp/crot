import type {
  ChromeApi,
  ChromeDebuggee,
  ChromeCaptureOptions,
  ChromeEvent,
  ChromeInjectionResult,
  ChromePort,
  ChromeScriptInjection,
  ChromeTab,
  ChromeWindow,
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

/** Fake chrome.debugger: records attaches and commands; tests answer commands through `respond`. */
export class FakeDebugger {
  readonly attached = new Set<number>();
  readonly attachCalls: number[] = [];
  readonly sent: { tabId: number; method: string; params: unknown; sessionId?: string }[] = [];
  attachError: Error | undefined;
  /** `sessionId`: a child session (out-of-process frame) of the tab. */
  respond: (tabId: number, method: string, params: unknown, sessionId?: string) => unknown = () => ({});
  readonly onDetach = new FakeEvent<(source: ChromeDebuggee, reason: string) => void>();
  readonly onEvent = new FakeEvent<(source: ChromeDebuggee, method: string, params?: unknown) => void>();

  async attach(target: ChromeDebuggee, version: string): Promise<void> {
    if (version !== "1.3") throw new Error("Requested protocol version is not supported");
    const tabId = target.tabId as number;
    this.attachCalls.push(tabId);
    if (this.attachError) throw this.attachError;
    if (this.attached.has(tabId)) throw new Error("Another debugger is already attached to the tab with id: " + tabId);
    this.attached.add(tabId);
  }

  async detach(target: ChromeDebuggee): Promise<void> {
    const tabId = target.tabId as number;
    if (!this.attached.delete(tabId)) throw new Error("Debugger is not attached to the tab with id: " + tabId);
  }

  async sendCommand(target: ChromeDebuggee, method: string, params?: object): Promise<unknown> {
    const tabId = target.tabId as number;
    if (!this.attached.has(tabId)) throw new Error("Debugger is not attached to the tab with id: " + tabId);
    const sessionId = target.sessionId;
    this.sent.push(sessionId === undefined ? { tabId, method, params } : { tabId, method, params, sessionId });
    return this.respond(tabId, method, params, sessionId);
  }

  /** The user or the browser detaches (for example the "Cancel" button of the notice). */
  userDetach(tabId: number): void {
    this.attached.delete(tabId);
    this.onDetach.emit({ tabId }, "canceled_by_user");
  }

  event(tabId: number, method: string, params: unknown = {}): void {
    this.onEvent.emit({ tabId }, method, params);
  }

  /** An event from a child session (out-of-process frame) of the tab. */
  sessionEvent(tabId: number, sessionId: string, method: string, params: unknown = {}): void {
    this.onEvent.emit({ tabId, sessionId }, method, params);
  }

  /** Chromium auto-attaches an out-of-process frame (Target.setAutoAttach with flatten). */
  attachFrame(tabId: number, sessionId: string, frameId: string, parentSessionId?: string): void {
    const params = { sessionId, targetInfo: { targetId: frameId, type: "iframe", url: "https://frame.example/" } };
    this.onEvent.emit(
      parentSessionId === undefined ? { tabId } : { tabId, sessionId: parentSessionId },
      "Target.attachedToTarget",
      params,
    );
  }
}

export class FakeChrome {
  readonly debugger = new FakeDebugger();
  readonly runtime = new FakeRuntime();
  readonly tabsById = new Map<number, MutableTab>();
  readonly focused: number[] = [];
  readonly restored: number[] = [];
  readonly windowStates = new Map<number, string>();
  readonly injections: ChromeScriptInjection<unknown[], unknown>[] = [];
  readonly groups = new Map<number, { id: number; title: string; windowId: number }>();
  readonly captures: { windowId: number; options: ChromeCaptureOptions }[] = [];
  /** What executeScript returns for the main frame; defaults to running the function locally. */
  scriptResult: ((injection: ChromeScriptInjection<unknown[], unknown>) => unknown) | undefined;
  scriptError: Error | undefined;
  captureResult: (windowId: number, options: ChromeCaptureOptions) => string = (_w, o) =>
    "data:image/" + o.format + ";base64,iVBORw0KGgo=";
  captureError: Error | undefined;
  /** Called after captureVisibleTab resolves (to simulate a tab switch). */
  afterCapture: (() => void) | undefined;
  loadStatus: "loading" | "complete" = "complete";
  /** document.visibilityState of every page (the visibility check before input). */
  visibility: (tabId: number) => string = (tabId) => (this.tabsById.get(tabId)?.active ? "visible" : "hidden");
  /** Trusted pointer events the page sees while an input probe runs (0: input not delivered). */
  inputEvents = 1;
  /** Override activation count to model down/up arriving without a click. */
  activationEvents: number | undefined;
  private probeCompletion: unknown;
  private probeNonce: string | undefined;
  private nextId = 100;

  readonly tabsOnUpdated = new FakeEvent<(tabId: number, changeInfo: { status?: string }, tab: ChromeTab) => void>();
  readonly tabsOnRemoved = new FakeEvent<(tabId: number) => void>();
  readonly tabsOnCreated = new FakeEvent<(tab: ChromeTab) => void>();
  readonly history: { tabId: number; action: "back" | "forward" | "reload" }[] = [];
  readonly alarmsOnAlarm = new FakeEvent<(alarm: { name: string }) => void>();

  addTab(tab: Partial<MutableTab> & { id: number }): MutableTab {
    const full: MutableTab = {
      windowId: 1,
      active: false,
      url: "https://example.com/",
      title: "Example",
      status: "complete",
      ...tab,
    };
    this.tabsById.set(tab.id, full);
    return full;
  }

  /** A page opens a new tab (window.open / target=_blank). */
  openPopup(openerTabId: number, url: string): MutableTab {
    const tab = this.addTab({ id: this.nextId++, url, title: "", openerTabId });
    this.tabsOnCreated.emit({ ...tab });
    return tab;
  }

  /** Start a navigation of a tab (fires tabs.onUpdated with status loading). */
  startLoading(tabId: number, url: string): void {
    const tab = this.tab(tabId);
    tab.pendingUrl = url;
    tab.status = "loading";
    this.tabsOnUpdated.emit(tabId, { status: "loading" }, { ...tab });
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

  /** Answers of the delivery page functions (delivery.ts); undefined for every other function. */
  private pageModel(injection: ChromeScriptInjection<unknown[], unknown>): unknown {
    switch (injection.func.name) {
      case "pageVisibility":
        return { ok: true, value: this.visibility(injection.target.tabId) };
      case "installInputProbe":
        this.probeNonce = injection.args[0] as string;
        this.probeCompletion = injection.args[1];
        return { ok: true, value: true };
      case "collectInputProbe": {
        const match = this.probeNonce === injection.args[0];
        this.probeNonce = undefined;
        return {
          ok: true,
          value: match
            ? this.probeCompletion === "activation"
              ? (this.activationEvents ?? this.inputEvents)
              : this.inputEvents
            : null,
        };
      }
      default:
        return undefined;
    }
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the methods of the returned object literal need this FakeChrome
    const self = this;
    return {
      runtime: this.runtime,
      tabGroups: {
        async query(query) {
          return [...self.groups.values()].filter((g) => g.windowId === query.windowId && g.title === query.title);
        },
        async update(id, props) {
          const group = self.groups.get(id);
          if (group) Object.assign(group, props);
          return group;
        },
      },
      tabs: {
        async group(props) {
          const id = props.groupId ?? self.groups.size + 1;
          if (!self.groups.has(id))
            self.groups.set(id, { id, title: "", windowId: props.createProperties?.windowId ?? 1 });
          for (const tabId of props.tabIds) self.tab(tabId).groupId = id;
          return id;
        },
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
        onCreated: this.tabsOnCreated,
        async goBack(tabId: number): Promise<void> {
          self.tab(tabId);
          self.history.push({ tabId, action: "back" });
        },
        async goForward(tabId: number): Promise<void> {
          self.tab(tabId);
          self.history.push({ tabId, action: "forward" });
        },
        async reload(tabId: number): Promise<void> {
          self.tab(tabId);
          self.history.push({ tabId, action: "reload" });
        },
      },
      windows: {
        async get(windowId: number): Promise<ChromeWindow> {
          return { id: windowId, focused: true, state: self.windowStates.get(windowId) ?? "normal" };
        },
        async update(windowId: number, properties: { focused?: boolean; state?: "normal" }): Promise<unknown> {
          if (properties.focused) self.focused.push(windowId);
          if (properties.state) {
            self.windowStates.set(windowId, properties.state);
            self.restored.push(windowId);
          }
          return {};
        },
      },
      scripting: {
        async executeScript<A extends unknown[], R>(
          injection: ChromeScriptInjection<A, R>,
        ): Promise<ChromeInjectionResult[]> {
          const generic = injection as unknown as ChromeScriptInjection<unknown[], unknown>;
          self.injections.push(generic);
          self.tab(injection.target.tabId);
          if (self.scriptError) throw self.scriptError;
          const builtIn = self.pageModel(generic);
          const result = self.scriptResult
            ? self.scriptResult(generic)
            : builtIn !== undefined
              ? builtIn
              : injection.func(...injection.args);
          // Results are structured-cloned.
          return [{ frameId: 0, result: result === undefined ? undefined : structuredClone(result) }];
        },
      },
      debugger: {
        attach: (target, version) => self.debugger.attach(target, version),
        detach: (target) => self.debugger.detach(target),
        sendCommand: (target, method, params) => self.debugger.sendCommand(target, method, params),
        onDetach: self.debugger.onDetach,
        onEvent: self.debugger.onEvent,
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
