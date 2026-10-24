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
            const defaultCell = id0(panel, selector("defaultButtonCell"));
            const defaultButton = defaultCell ? id0(defaultCell, selector("controlView")) : null;
            const defaultIsButton = defaultButton && kind(defaultButton, selector("isKindOfClass:"), cls("NSButton"));
            const defaultTitle = defaultIsButton
              ? text(id0(defaultButton, selector("title")), selector("UTF8String"))
              : null;
            if (input.operation === "cancel") schedule(panel, "cancel:", null);
            else if (input.operation === "navigate") {
              const name = string(cls("NSString"), selector("stringWithUTF8String:"), input.selected);
              const url = id1(cls("NSURL"), selector("fileURLWithPath:"), name);
              schedule(panel, "setDirectoryURL:", url);
            } else if (input.operation === "choose") {
              if (directory !== input.selected)
                throw Error("Native folder chooser has not navigated to the selected directory");
              if (defaultIsButton && boolean(defaultButton, selector("isEnabled"))) {
                schedule(defaultButton, "performClick:", null);
              } else {
                // Since macOS 10.15 NSOpenPanel draws controls in an XPC service;
                // its proxy window need not have a local defaultButtonCell.
                // Deliver native Return to this panel's real window, not a
                // guessed private selector or a synthesized modal return value.
                const point = koffi.struct({ x: "double", y: "double" });
                const keyEvent = objc.func("void *", "objc_msgSend", [
                  "void *",
                  "void *",
                  "unsigned long",
                  point,
                  "unsigned long",
                  "double",
                  "long",
                  "void *",
                  "void *",
                  "void *",
                  "bool",
                  "unsigned short",
                ]);
                const characters = string(cls("NSString"), selector("stringWithUTF8String:"), "\r");
                const windowNumber = count(panel, selector("windowNumber"));
                const timestamp = objc.func("double objc_msgSend(void *, void *)")(
                  id0(cls("NSProcessInfo"), selector("processInfo")),
                  selector("systemUptime"),
                );
                for (const type of [10, 11]) {
                  const event = keyEvent(
                    cls("NSEvent"),
                    selector(
                      "keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:",
                    ),
                    type,
                    { x: 0, y: 0 },
                    0,
                    timestamp,
                    windowNumber,
                    null,
                    characters,
                    characters,
                    false,
                    36,
                  );
                  if (!event) throw Error("AppKit did not create the native Return event");
                  schedule(app, "sendEvent:", event);
                }
              }
            }
            return { visible: true, found, directory, mainThread, defaultTitle };
          },
          { operation, selected },
        )
        .then((result) => {
          lastObservation = { operation, ...result };
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
    // Bind native ownership to Electron's actual main PID, not a launcher handle.
    const pid = await electron.evaluate(() => process.pid);
    let lastObservation;
    const action = async (operation, selected = "") => {
      const encoded = Buffer.from(selected, "utf8").toString("base64");
      const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class NativePickerWindow {
 public delegate bool EnumCallback(IntPtr h,IntPtr p);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
  public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr h,ref ProcessEntry p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr h,ref ProcessEntry p);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static HashSet<uint> Family(uint root) {
  var h=CreateToolhelp32Snapshot(2,0); if(h==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
  var parents=new Dictionary<uint,uint>();
  try {
   var p=new ProcessEntry();p.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
   if(!Process32FirstW(h,ref p))throw new Win32Exception(Marshal.GetLastWin32Error());
   do {if(parents.Count>=16384)throw new InvalidOperationException("Process inventory bound exceeded");parents[p.pid]=p.parent;}while(Process32NextW(h,ref p));
   int error=Marshal.GetLastWin32Error();if(error!=18)throw new Win32Exception(error);
  }finally{CloseHandle(h);}
  var family=new HashSet<uint>();family.Add(root);
  for(int i=0;i<6;i++)foreach(var p in parents)if(family.Contains(p.Value))family.Add(p.Key);
  return family;
 }
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint cmd);
}
'@
$script:owned=@()
$script:visibleDialogs=@()
# Electron's file dialog may be hosted by a child utility process. Restrict the
# family to descendants of this exact live Electron main process, never title alone.
$family=[NativePickerWindow]::Family([uint32]${pid})
$callback=[NativePickerWindow+EnumCallback]{param([IntPtr]$h,[IntPtr]$unused)
 if(-not [NativePickerWindow]::IsWindowVisible($h)){return $true}
 [uint32]$ownerPid=0;[uint32]$windowPid=0
 [void][NativePickerWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
 $owner=[NativePickerWindow]::GetWindow($h,2)
 if($owner -ne [IntPtr]::Zero){[void][NativePickerWindow]::GetWindowThreadProcessId($owner,[ref]$ownerPid)}
 $name=[System.Text.StringBuilder]::new(512);$class=[System.Text.StringBuilder]::new(128)
 [void][NativePickerWindow]::GetWindowText($h,$name,512);[void][NativePickerWindow]::GetClassName($h,$class,128)
 if($class.ToString() -eq '#32770'){$script:visibleDialogs+=@{process=$windowPid;ownerProcess=$ownerPid}}
 if(-not $family.Contains($windowPid) -and -not $family.Contains($ownerPid)){return $true}
 $script:owned+=@{handle=$h;title=$name.ToString();class=$class.ToString();process=$windowPid;ownerProcess=$ownerPid}
 return $true
}
[void][NativePickerWindow]::EnumWindows($callback,[IntPtr]::Zero)
$candidates=@($script:owned | Where-Object {$_.class -eq '#32770'})
if($candidates.Count -eq 0){
 'no-dialog';'main|${pid}';'family|'+(($family | Sort-Object) -join ',')
 $script:owned | Select-Object -First 16 | ForEach-Object {'owned|{0}|{1}|{2}|{3}' -f $_.class,$_.title,$_.process,$_.ownerProcess}
 $script:visibleDialogs | Select-Object -First 16 | ForEach-Object {'dialog-process|{0}|{1}' -f $_.process,$_.ownerProcess}
 exit 0
}
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
      let stdout;
      try {
        ({ stdout } = await exec(
          powershell,
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { timeout: 10000, maxBuffer: 65536, windowsHide: true },
        ));
      } catch (error) {
        // Node's default message embeds the whole encoded script, exhausting
        // GitHub's 4 KiB annotation before the useful native error appears.
        const failure = {
          operation,
          mainPid: pid,
          code: error.code,
          killed: error.killed,
          signal: error.signal,
          stderr: String(error.stderr || "").slice(-2200),
          stdout: String(error.stdout || "").slice(-600),
        };
        lastObservation = failure;
        throw Error("Native Windows picker driver: " + JSON.stringify(failure));
      }
      lastObservation = { operation, mainPid: pid, native: stdout.trim() };
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
      async diagnostics() {
        try {
          return await action("inspect");
        } catch (error) {
          return { lastObservation, error: String(error) };
        }
      },
    };
  }
  throw Error("Unsupported native picker host");
}
