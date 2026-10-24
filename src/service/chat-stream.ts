/** Bounded SSE decoder for provider responses, including split UTF-8/CRLF frames. */
import { StringDecoder } from "node:string_decoder";
import { CrotError } from "../core/errors.js";
export class ChatEventStream {
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  private data: string[] = [];
  private event = "message";
  private bytes = 0;
  constructor(
    private readonly receive: (event: string, data: string) => void,
    private readonly limit = 1024 * 1024,
  ) {}
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) throw new CrotError("LIMIT_EXCEEDED", "Provider stream exceeds its limit");
    this.text(this.decoder.write(chunk));
  }
  end(): void {
    this.text(this.decoder.end());
    // SSE dispatch requires a blank line, not just EOF: don't accept a truncated tool call.
    if (this.line.trim() || this.data.length)
      throw new CrotError("OPERATION_FAILED", "Incomplete provider event stream");
  }
  private text(text: string): void {
    for (const char of text) {
      if (char !== "\n") {
        this.line += char;
        continue;
      }
      const line = this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line;
      this.line = "";
      if (line === "") {
        if (this.data.length) this.receive(this.event, this.data.join("\n"));
        this.event = "message";
        this.data = [];
      } else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) this.event = line.slice(6).trim();
    }
  }
}
