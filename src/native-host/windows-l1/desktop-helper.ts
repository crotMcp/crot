/** AD-24 fixed trusted helper. No user script, RPC or arbitrary operation. */
import { CrotError } from "../../core/errors.js";
import { bindOwnedUserObjects, type OwnedUserObjects } from "./user-objects.js";
async function main(): Promise<void> {
  if (
    process.platform !== "win32" ||
    !["x64", "arm64"].includes(process.arch) ||
    process.argv.length !== 6 ||
    process.argv[2] !== "--crot-owned-desktop"
  )
    throw new Error("Invalid owned desktop helper invocation.");
  const moduleName: string = "koffi";
  const module = await import(moduleName);
  let owned: OwnedUserObjects | undefined;
  try {
    owned = bindOwnedUserObjects(module.default ?? module)(process.argv[3]!, process.argv[4]!, process.argv[5]!);
    process.stdout.write(JSON.stringify({ desktop: owned.desktop }) + "\n");
    let command = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      command += String(chunk);
      if (command.length > 6 || !"close\n".startsWith(command))
        throw new Error("Invalid owned desktop helper command.");
    }
    if (command !== "close\n") throw new Error("Owned desktop helper control closed.");
  } finally {
    owned?.close();
  }
}
void main().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    // Only fixed stage/native code, never raw context, SIDs, paths or capabilities.
    if (
      error instanceof CrotError &&
      typeof error.details?.stage === "string" &&
      Number.isInteger(error.details.nativeCode)
    )
      process.stdout.write(
        JSON.stringify({
          error: {
            stage: error.details.stage,
            nativeCode: error.details.nativeCode,
            ...(typeof error.details.layout === "string" ? { layout: error.details.layout } : {}),
          },
        }) + "\n",
      );
    process.stderr.write("Owned desktop helper failed.\n");
    process.exitCode = 1;
  },
);
