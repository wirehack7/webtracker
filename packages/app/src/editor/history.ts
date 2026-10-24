/** One undoable step. */
export interface Change {
  label: string;
  undo(): void;
  redo(): void;
}

/** Undo/redo stack shared by all editors. */
export class History {
  private done: Change[] = [];
  private undone: Change[] = [];

  constructor(private readonly limit = 500) {}

  /** Records a change that has already been applied. */
  push(change: Change): void {
    this.done.push(change);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  undo(): Change | null {
    const change = this.done.pop();
    if (!change) return null;
    change.undo();
    this.undone.push(change);
    return change;
  }

  redo(): Change | null {
    const change = this.undone.pop();
    if (!change) return null;
    change.redo();
    this.done.push(change);
    return change;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }
}
