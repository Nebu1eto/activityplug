interface ExpirationEntry {
  readonly key: string;
  readonly expiresAt: number;
}

/** An exact min-heap index that replaces entries instead of accumulating stale nodes. */
export class ExpirationIndex {
  readonly #heap: ExpirationEntry[] = [];
  readonly #positions = new Map<string, number>();

  public peek(): ExpirationEntry | undefined {
    return this.#heap[0];
  }

  public set(key: string, expiresAt: number): void {
    const position = this.#positions.get(key);
    if (position === undefined) {
      const nextPosition = this.#heap.length;
      this.#heap.push({ key, expiresAt });
      this.#positions.set(key, nextPosition);
      this.#bubbleUp(nextPosition);
      return;
    }

    const previous = this.#heap[position];
    if (previous === undefined || previous.expiresAt === expiresAt) return;
    this.#heap[position] = { key, expiresAt };
    if (expiresAt < previous.expiresAt) this.#bubbleUp(position);
    else this.#bubbleDown(position);
  }

  public delete(key: string): void {
    const position = this.#positions.get(key);
    if (position === undefined) return;
    const last = this.#heap.pop();
    this.#positions.delete(key);
    if (last === undefined || position === this.#heap.length) return;
    this.#heap[position] = last;
    this.#positions.set(last.key, position);
    const parent = Math.floor((position - 1) / 2);
    if (position > 0 && this.#less(position, parent)) this.#bubbleUp(position);
    else this.#bubbleDown(position);
  }

  #bubbleUp(start: number): void {
    let position = start;
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (!this.#less(position, parent)) return;
      this.#swap(position, parent);
      position = parent;
    }
  }

  #bubbleDown(start: number): void {
    let position = start;
    while (true) {
      const left = position * 2 + 1;
      const right = left + 1;
      let smallest = position;
      if (left < this.#heap.length && this.#less(left, smallest)) smallest = left;
      if (right < this.#heap.length && this.#less(right, smallest)) smallest = right;
      if (smallest === position) return;
      this.#swap(position, smallest);
      position = smallest;
    }
  }

  #less(left: number, right: number): boolean {
    const leftEntry = this.#heap[left];
    const rightEntry = this.#heap[right];
    if (leftEntry === undefined || rightEntry === undefined) return false;
    return (
      leftEntry.expiresAt < rightEntry.expiresAt ||
      (leftEntry.expiresAt === rightEntry.expiresAt && leftEntry.key < rightEntry.key)
    );
  }

  #swap(left: number, right: number): void {
    const leftEntry = this.#heap[left];
    const rightEntry = this.#heap[right];
    if (leftEntry === undefined || rightEntry === undefined) return;
    this.#heap[left] = rightEntry;
    this.#heap[right] = leftEntry;
    this.#positions.set(leftEntry.key, right);
    this.#positions.set(rightEntry.key, left);
  }
}
