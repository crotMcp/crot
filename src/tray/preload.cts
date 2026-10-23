/**
 * Tray window preload (sandboxed, context-isolated). Exposes only fixed
 * functions to the page; nothing else from Electron or Node is reachable.
 * The page never receives or sends a subject digest.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require("electron");

electron.contextBridge.exposeInMainWorld("crot", {
  onView: (callback: (view: unknown) => void): void => {
    electron.ipcRenderer.on("view", (_event, view: unknown) => callback(view));
  },
  product: (name: string, input: unknown): Promise<unknown> => electron.ipcRenderer.invoke("product", name, input),
  tool: (name: string, input: unknown): Promise<unknown> => electron.ipcRenderer.invoke("tool", name, input),
  repairL1: (): Promise<unknown> => electron.ipcRenderer.invoke("repair-l1"),
  ready: (): void => electron.ipcRenderer.send("ready"),
  decide: (requestId: string, decision: string): Promise<unknown> =>
    electron.ipcRenderer.invoke("decide", requestId, decision),
  action: (name: string, params: unknown): Promise<unknown> => electron.ipcRenderer.invoke("action", name, params),
});
