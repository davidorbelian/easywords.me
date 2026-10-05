export type Clock = () => number;

export class WindowLimit {
  readonly #hits = new Map<string, number[]>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: Clock;

  constructor(max: number, windowMs: number, now: Clock = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Records a hit and returns 0, or returns the seconds to wait when the key is over the limit. */
  take(key: string): number {
    const now = this.#now();
    const hits = (this.#hits.get(key) ?? []).filter((time) => time > now - this.#windowMs);
    if (hits.length >= this.#max) {
      this.#hits.set(key, hits);
      return Math.max(1, Math.ceil((hits[0]! + this.#windowMs - now) / 1000));
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return 0;
  }

  sweep(): void {
    const oldest = this.#now() - this.#windowMs;
    for (const [key, hits] of this.#hits) {
      if (hits.at(-1)! <= oldest) this.#hits.delete(key);
    }
  }
}

export class DailyCap {
  readonly #max: number;
  readonly #now: Clock;
  #day = "";
  #count = 0;

  constructor(max: number, now: Clock = Date.now) {
    this.#max = max;
    this.#now = now;
  }

  take(): boolean {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#count = 0;
    }
    if (this.#count >= this.#max) return false;
    this.#count += 1;
    return true;
  }
}

export class Slots {
  readonly #size: number;
  readonly #maxWaiting: number;
  readonly #waitMs: number;
  readonly #waiting: Array<() => void> = [];
  #busy = 0;

  constructor(size: number, maxWaiting: number, waitMs: number) {
    this.#size = size;
    this.#maxWaiting = maxWaiting;
    this.#waitMs = waitMs;
  }

  /** Resolves to a release function, or to null when no slot frees up in time. */
  async acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (this.#busy < this.#size) {
      this.#busy += 1;
      return this.#release();
    }
    if (this.#waiting.length >= this.#maxWaiting) return null;
    return new Promise((resolve) => {
      const give = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", giveUp);
        resolve(this.#release());
      };
      const giveUp = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", giveUp);
        this.#waiting.splice(this.#waiting.indexOf(give), 1);
        resolve(null);
      };
      const timer = setTimeout(giveUp, this.#waitMs);
      signal.addEventListener("abort", giveUp, { once: true });
      this.#waiting.push(give);
    });
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#busy -= 1;
    };
  }
}
