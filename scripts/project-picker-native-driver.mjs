/** Test-only native dialog drivers. Never replace Electron's dialog API or its return value. */
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function nativePickerDriver(electron, output, until) {
  if (process.platform === "linux") {
    const xdo = (...args) => exec("xdotool", args, { timeout: 5000, maxBuffer: 65536 });
    let chooserId;
    return {
      async wait() {
        await until(async () => {
          try {
            const { stdout } = await xdo("search", "--onlyvisible", "--name", "^Open project folder$");
            chooserId = stdout.trim().split("\n")[0];
            return /^\d+$/.test(chooserId);
          } catch {
            return false;
          }
        }, "native GTK folder chooser");
        await xdo("windowfocus", "--sync", chooserId);
        await delay(500);
      },
      async cancel() {
        await xdo("key", "--clearmodifiers", "Escape");
        await until(async () => {
          try {
            await xdo("search", "--onlyvisible", "--name", "^Open project folder$");
            return false;
          } catch {
            return true;
          }
        }, "native dialog cancellation");
      },
      async choose(selected) {
        await xdo("key", "--clearmodifiers", "ctrl+l");
        await xdo("type", "--clearmodifiers", "--delay", "1", selected);
        await exec("magick", ["import", "-window", "root", output + ".native-chooser.png"], { timeout: 5000 }).catch(
          () => {},
        );
        const geometry = (await xdo("getwindowgeometry", "--shell", chooserId)).stdout;
        const width = Number(/^WIDTH=(\d+)$/m.exec(geometry)?.[1]);
        const height = Number(/^HEIGHT=(\d+)$/m.exec(geometry)?.[1]);
        if (!(width > 200 && height > 200)) throw Error("Invalid native chooser geometry");
        await xdo("mousemove", "--sync", "--window", chooserId, String(width - 50), String(height - 24));
        await xdo("click", "--clearmodifiers", "1");
      },
      async diagnostics() {
        await exec("magick", ["import", "-window", "root", output + ".failure.png"], { timeout: 5000 }).catch(() => {});
        return (await xdo("search", "--onlyvisible", "--name", ".").catch(() => ({ stdout: "" }))).stdout;
      },
    };
  }
  if (process.platform === "darwin") {
    // AppKit in this test's Electron main process. No System Events/TCC bypass,
    // external accessibility privileges, synthetic dialog or canned filePaths.
    let lastObservation;
    const action = (operation, selected) =>
      electron
        .evaluate(
          async (_electron, input) => {
            // Playwright evaluates this function in Node's inspector VM, which
            // has no dynamic-import callback. Use Electron's real builtin loader.
            const { createRequire } = process.getBuiltinModule("module");
            const koffi = createRequire(process.cwd() + "/package.json")("koffi");
            const objc = koffi.load("/usr/lib/libobjc.A.dylib");
            const cls = objc.func("void *objc_getClass(const char *)");
            const selector = objc.func("void *sel_registerName(const char *)");
            const id0 = objc.func("void *objc_msgSend(void *, void *)");
            const id1 = objc.func("void *objc_msgSend(void *, void *, void *)");
            const string = objc.func("void *objc_msgSend(void *, void *, const char *)");
            const text = objc.func("const char *objc_msgSend(void *, void *)");
            const boolean = objc.func("bool objc_msgSend(void *, void *)");
            const kind = objc.func("bool objc_msgSend(void *, void *, void *)");
            const count = objc.func("unsigned long objc_msgSend(void *, void *)");
            const item = objc.func("void *objc_msgSend(void *, void *, unsigned long)");
            const onMain = objc.func("void objc_msgSend(void *, void *, void *, void *, bool)");
            const schedule = (target, method, value) =>
              onMain(
                target,
                selector("performSelectorOnMainThread:withObject:waitUntilDone:"),
                selector(method),
                value,
                false,
              );
            const mainThread = boolean(cls("NSThread"), selector("isMainThread"));
            const app = id0(cls("NSApplication"), selector("sharedApplication"));
            const windows = id0(app, selector("windows"));
            let panel;
            const found = [];
            for (let i = 0; i < Math.min(Number(count(windows, selector("count"))), 64); i++) {
              const candidate = item(windows, selector("objectAtIndex:"), i);
              if (
                kind(candidate, selector("isKindOfClass:"), cls("NSOpenPanel")) &&
                boolean(candidate, selector("isVisible"))
              ) {
                const title = text(id0(candidate, selector("title")), selector("UTF8String"));
                found.push(title);
                if (title === "Open project folder") panel = candidate;
              }
            }
            if (!panel) return { visible: false, found, mainThread };
            const directory = text(id0(id0(panel, selector("directoryURL")), selector("path")), selector("UTF8String"));
            if (input.operation === "cancel") schedule(panel, "cancel:", null);
            else if (input.operation === "navigate") {
              const name = string(cls("NSString"), selector("stringWithUTF8String:"), input.selected);
              const url = id1(cls("NSURL"), selector("fileURLWithPath:"), name);
              schedule(panel, "setDirectoryURL:", url);
            } else if (input.operation === "choose") {
              if (directory !== input.selected)
                throw Error("Native folder chooser has not navigated to the selected directory");
              schedule(panel, "ok:", null);
            }
            return { visible: true, found, directory, mainThread };
          },
          { operation, selected },
        )
        .then((result) => {
          lastObservation = result;
          return result;
        });
    return {
      wait: () => until(async () => (await action("inspect")).visible, "actual AppKit NSOpenPanel"),
      async cancel() {
        await action("cancel");
        await until(async () => !(await action("inspect")).visible, "AppKit cancellation");
      },
      async choose(selected) {
        if (!(await action("navigate", selected)).visible) throw Error("Native NSOpenPanel disappeared");
        await until(async () => (await action("inspect")).directory === selected, "AppKit directory navigation");
        if (!(await action("choose", selected)).visible) throw Error("Native NSOpenPanel disappeared");
      },
      async diagnostics() {
        try {
          return await action("inspect");
        } catch (error) {
          return { lastObservation, error: String(error) };
        }
      },
    };
  }
  if (process.platform === "win32") {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const pid = electron.process().pid;
    const action = async (operation, selected = "") => {
      const encoded = Buffer.from(selected, "utf8").toString("base64");
      const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativePickerWindow {
 public delegate bool EnumCallback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint cmd);
}
'@
$script:owned=@()
$callback=[NativePickerWindow+EnumCallback]{param([IntPtr]$h,[IntPtr]$unused)
 if(-not [NativePickerWindow]::IsWindowVisible($h)){return $true}
 [uint32]$ownerPid=0;[uint32]$windowPid=0
 [void][NativePickerWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
 $owner=[NativePickerWindow]::GetWindow($h,2)
 if($owner -ne [IntPtr]::Zero){[void][NativePickerWindow]::GetWindowThreadProcessId($owner,[ref]$ownerPid)}
 if($windowPid -ne ${pid} -and $ownerPid -ne ${pid}){return $true}
 $name=[System.Text.StringBuilder]::new(512);$class=[System.Text.StringBuilder]::new(128)
 [void][NativePickerWindow]::GetWindowText($h,$name,512);[void][NativePickerWindow]::GetClassName($h,$class,128)
 $script:owned+=@{handle=$h;title=$name.ToString();class=$class.ToString();process=$windowPid;ownerProcess=$ownerPid}
 return $true
}
[void][NativePickerWindow]::EnumWindows($callback,[IntPtr]::Zero)
$candidates=@($script:owned | Where-Object {$_.class -eq '#32770'})
if($candidates.Count -eq 0){'no-dialog';$script:owned | ForEach-Object {'owned|{0}|{1}' -f $_.class,$_.title};exit 0}
if($candidates.Count -ne 1){throw 'Ambiguous native chooser windows'}
$dialog=[System.Windows.Automation.AutomationElement]::FromHandle($candidates[0].handle)
if($null -eq $dialog){throw 'Owned native chooser has no automation provider'}
$all=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
if('${operation}' -eq 'inspect') {
 'visible'; foreach($c in $all){ if($c.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $c.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button){'{0}|{1}|{2}' -f $c.Current.AutomationId,$c.Current.Name,$c.Current.ControlType.ProgrammaticName} };exit 0
}
$id=if('${operation}' -eq 'cancel'){'2'}else{'1'}
$button=$null
foreach($c in $all){if($c.Current.AutomationId -eq $id -and $c.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button){$button=$c;break}}
if($null -eq $button){throw 'Native dialog button unavailable'}
if('${operation}' -eq 'choose'){
 $edit=$null
 foreach($c in $all){if($c.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and ($c.Current.AutomationId -in @('1148','1152') -or $c.Current.Name -match '^(Folder|File name):?$')){$edit=$c;break}}
 if($null -eq $edit){throw 'Native folder path edit unavailable'}
 $value=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
 $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value)
}
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
'invoked'
`;
      const { stdout } = await exec(
        powershell,
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { timeout: 10000, maxBuffer: 65536, windowsHide: true },
      );
      return stdout.trim();
    };
    return {
      wait: () => until(async () => (await action("inspect")).startsWith("visible"), "actual Windows folder dialog"),
      async cancel() {
        await action("cancel");
        await until(async () => (await action("inspect")).startsWith("no-dialog"), "Windows dialog cancellation");
      },
      async choose(selected) {
        if ((await action("choose", selected)) !== "invoked") throw Error("Native Windows folder chooser disappeared");
        // Common dialogs may first navigate to the typed folder. Confirm that
        // same owned native chooser once more if it remains, never another UI.
        await delay(500);
        if ((await action("inspect")).startsWith("visible")) await action("accept");
      },
      diagnostics: () => action("inspect"),
    };
  }
  throw Error("Unsupported native picker host");
}
