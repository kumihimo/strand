/**
 * A byte buffer that keeps the newest `maxBytes` and drops the oldest.
 * One preallocated circular buffer: data is copied in, so many tiny chunks pin nothing.
 */
export class Ring {
  readonly #max: number;
  readonly #buf: Buffer;
  /** Where the next byte is written. When the ring is full this is also where the oldest byte sits. */
  #head = 0;
  #size = 0;

  constructor(maxBytes: number) {
    this.#max = Math.max(0, Math.floor(maxBytes));
    this.#buf = Buffer.allocUnsafeSlow(this.#max);
  }

  get bytes(): number {
    return this.#size;
  }

  push(chunk: Buffer): void {
    const max = this.#max;
    if (chunk.length === 0 || max === 0) return;
    if (chunk.length >= max) {
      chunk.copy(this.#buf, 0, chunk.length - max);
      this.#head = 0;
      this.#size = max;
      return;
    }
    const first = Math.min(chunk.length, max - this.#head);
    chunk.copy(this.#buf, this.#head, 0, first);
    if (first < chunk.length) chunk.copy(this.#buf, 0, first);
    this.#head = (this.#head + chunk.length) % max;
    this.#size = Math.min(max, this.#size + chunk.length);
  }

  /** A new buffer with the kept bytes, oldest first. */
  snapshot(): Buffer {
    const out = Buffer.allocUnsafe(this.#size);
    if (this.#size === 0) return out;
    const start = (this.#head - this.#size + this.#max) % this.#max;
    const first = Math.min(this.#size, this.#max - start);
    this.#buf.copy(out, 0, start, start + first);
    if (first < this.#size) this.#buf.copy(out, first, 0, this.#size - first);
    return out;
  }
}
