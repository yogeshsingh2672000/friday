/**
 * Lock-free single-producer/single-consumer ring buffer for Int16 PCM frames.
 * Used to buffer audio between capture/playback callbacks and async consumers
 * without allocating per-frame.
 */
export class Int16RingBuffer {
  private buf: Int16Array;
  private readonly capacity: number;
  private writePos = 0;
  private readPos = 0;
  private _size = 0;

  constructor(capacitySamples: number) {
    this.capacity = capacitySamples;
    this.buf = new Int16Array(capacitySamples);
  }

  get size(): number {
    return this._size;
  }
  get free(): number {
    return this.capacity - this._size;
  }

  write(chunk: Int16Array): number {
    const writable = Math.min(chunk.length, this.free);
    if (writable === 0) return 0;
    const first = Math.min(writable, this.capacity - this.writePos);
    this.buf.set(chunk.subarray(0, first), this.writePos);
    if (writable > first) {
      this.buf.set(chunk.subarray(first, writable), 0);
    }
    this.writePos = (this.writePos + writable) % this.capacity;
    this._size += writable;
    return writable;
  }

  read(out: Int16Array): number {
    const readable = Math.min(out.length, this._size);
    if (readable === 0) return 0;
    const first = Math.min(readable, this.capacity - this.readPos);
    out.set(this.buf.subarray(this.readPos, this.readPos + first), 0);
    if (readable > first) {
      out.set(this.buf.subarray(0, readable - first), first);
    }
    this.readPos = (this.readPos + readable) % this.capacity;
    this._size -= readable;
    return readable;
  }

  reset(): void {
    this.writePos = 0;
    this.readPos = 0;
    this._size = 0;
  }
}
