import { describe, expect, it } from "vitest";
import { OutputBuffer } from "../../src/core/capabilities/process/output-buffer.js";
import { createEncodingSupport } from "../../src/core/platform/encoding.js";

const posix = createEncodingSupport(null);
const windows850 = createEncodingSupport({ oem: 850, ansi: 1252 });
const bytes = (...b: number[]) => Buffer.from(b);

describe("OutputBuffer", () => {
  it("keeps the most recent bytes and tracks offsets", () => {
    const b = new OutputBuffer(4);
    b.append(Buffer.from("abc"));
    b.append(Buffer.from("def"));
    b.end();
    expect(b.readAll()).toEqual({
      data: "cdef",
      nextOffset: 6,
      droppedBytes: 2,
      encoding: { name: "utf-8", lossy: false },
    });
    expect(b.truncated).toBe(true);
    expect(b.totalBytes).toBe(6);
    expect(b.readFrom(5)).toMatchObject({ data: "f", nextOffset: 6, droppedBytes: 0 });
    expect(b.readFrom(6)).toMatchObject({ data: "", nextOffset: 6, droppedBytes: 0 });
  });

  it("holds back a UTF-8 character split across chunks until it is complete", () => {
    const b = new OutputBuffer(1024, posix.resolve("auto"));
    const euro = Buffer.from("€"); // e2 82 ac
    b.append(Buffer.concat([Buffer.from("a"), euro.subarray(0, 2)]));
    const first = b.readFrom(0);
    expect(first).toMatchObject({ data: "a", nextOffset: 1, encoding: { name: "utf-8", lossy: false } });
    b.append(euro.subarray(2));
    expect(b.readFrom(first.nextOffset)).toMatchObject({ data: "€", nextOffset: 4, encoding: { lossy: false } });
  });

  it("decodes an incomplete trailing character once the stream has ended", () => {
    const b = new OutputBuffer(1024);
    b.append(Buffer.from("€").subarray(0, 2));
    expect(b.readFrom(0)).toMatchObject({ data: "", nextOffset: 0 });
    b.end();
    expect(b.readFrom(0)).toMatchObject({ data: "\ufffd", nextOffset: 2, encoding: { name: "utf-8", lossy: true } });
  });

  it("skips a character cut in half by truncation instead of corrupting it", () => {
    const b = new OutputBuffer(5);
    b.append(Buffer.from("ab€€")); // 2 + 3 + 3 bytes; keeps "\xac€" + ...
    b.end();
    const all = b.readAll();
    expect(all.data).toBe("€");
    expect(all.encoding).toEqual({ name: "utf-8", lossy: false });
    expect(all.droppedBytes).toBe(5); // 3 dropped + 2 bytes of the partial character
  });

  it("auto: falls back to the Windows console code page for output that is not UTF-8", () => {
    const b = new OutputBuffer(1024, windows850.resolve("auto"));
    b.append(bytes(0x81, 0x20, 0xd5, 0x0d, 0x0a)); // "ü ı\r\n" in cp850
    b.end();
    expect(b.readAll()).toMatchObject({ data: "ü ı\r\n", encoding: { name: "cp850", lossy: false } });
  });

  it("auto: keeps valid UTF-8 as UTF-8 on Windows", () => {
    const b = new OutputBuffer(1024, windows850.resolve("auto"));
    b.append(Buffer.from("grüße ✓"));
    b.end();
    expect(b.readAll()).toMatchObject({ data: "grüße ✓", encoding: { name: "utf-8", lossy: false } });
  });

  it("auto: UTF-8 output cut off mid-character stays UTF-8 (lossy) instead of switching to the fallback", () => {
    const b = new OutputBuffer(1024, windows850.resolve("auto"));
    b.append(Buffer.concat([Buffer.from("grüße "), Buffer.from("€").subarray(0, 2)]));
    b.end();
    expect(b.readAll()).toMatchObject({ data: "grüße \ufffd", encoding: { name: "utf-8", lossy: true } });
  });

  it("auto: stays with the fallback once detected", () => {
    const b = new OutputBuffer(1024, windows850.resolve("auto"));
    b.append(bytes(0x81));
    expect(b.readFrom(0)).toMatchObject({ data: "ü", nextOffset: 1, encoding: { name: "cp850" } });
    b.append(Buffer.from("é")); // c3 a9 is "├®" in cp850
    expect(b.readFrom(1)).toMatchObject({ data: "├®", encoding: { name: "cp850" } });
  });

  it("auto without a fallback (POSIX): reports invalid UTF-8 as lossy instead of hiding it", () => {
    const b = new OutputBuffer(1024, posix.resolve("auto"));
    b.append(bytes(0x61, 0xff, 0x62));
    b.end();
    expect(b.readAll()).toMatchObject({ data: "a\ufffdb", encoding: { name: "utf-8", lossy: true } });
  });

  it("auto: detects UTF-16LE output by its byte-order mark", () => {
    const b = new OutputBuffer(1024, posix.resolve("auto"));
    b.append(Buffer.concat([bytes(0xff, 0xfe), Buffer.from("hi ü", "utf16le").subarray(0, 7)]));
    expect(b.readFrom(0)).toMatchObject({ data: "hi ", nextOffset: 8, encoding: { name: "utf-16le", lossy: false } });
    b.append(Buffer.from("hi ü", "utf16le").subarray(7));
    b.end();
    expect(b.readAll()).toMatchObject({ data: "hi ü", encoding: { name: "utf-16le", lossy: false } });
  });

  it("decodes with an explicit encoding and flags undecodable bytes", () => {
    const b = new OutputBuffer(1024, posix.resolve("windows-1252"));
    b.append(bytes(0x80, 0x20, 0xe9));
    b.end();
    expect(b.readAll()).toMatchObject({ data: "€ é", encoding: { name: "windows-1252", lossy: false } });

    const u = new OutputBuffer(1024, posix.resolve("utf-8"));
    u.append(bytes(0xe9));
    u.end();
    expect(u.readAll()).toMatchObject({ data: "\ufffd", encoding: { name: "utf-8", lossy: true } });
  });

  it("holds back incomplete multi-byte legacy characters (Shift_JIS)", () => {
    const b = new OutputBuffer(1024, posix.resolve("shift_jis"));
    b.append(bytes(0x61, 0x82)); // "a" + first byte of "あ" (82 a0)
    expect(b.readFrom(0)).toMatchObject({ data: "a", nextOffset: 1 });
    b.append(bytes(0xa0));
    expect(b.readFrom(1)).toMatchObject({ data: "あ", nextOffset: 3, encoding: { name: "shift_jis", lossy: false } });
  });

  it("flags replacement characters produced upstream as lossy", () => {
    const b = new OutputBuffer(1024);
    b.append(Buffer.from("bad \ufffd"));
    b.end();
    expect(b.readAll().encoding).toEqual({ name: "utf-8", lossy: true });
  });
});
