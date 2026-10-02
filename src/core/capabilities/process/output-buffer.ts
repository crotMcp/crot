/**
 * Bounded output capture that keeps the most recent `capacity` bytes while
 * tracking absolute byte offsets, so callers can poll incrementally.
 */
export class OutputBuffer {
  private chunks: Buffer[] = [];
  private retained = 0;
  /** Absolute offset of the first retained byte. */
  private start = 0;

  constructor(private readonly capacity: number) {}

  get totalBytes(): number {
    return this.start + this.retained;
  }

  get truncated(): boolean {
    return this.start > 0;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.retained += chunk.length;
    while (this.retained > this.capacity) {
      const first = this.chunks[0]!;
      const excess = this.retained - this.capacity;
      if (first.length <= excess) {
        this.chunks.shift();
        this.retained -= first.length;
        this.start += first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.retained -= excess;
        this.start += excess;
      }
    }
  }

  /** Read retained bytes from absolute `offset` onward. */
  readFrom(offset: number): { data: string; nextOffset: number; droppedBytes: number } {
    const all = Buffer.concat(this.chunks);
    const from = Math.max(offset, this.start);
    const data = all.subarray(Math.min(from - this.start, all.length)).toString("utf8");
    return { data, nextOffset: this.totalBytes, droppedBytes: Math.max(0, this.start - offset) };
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
