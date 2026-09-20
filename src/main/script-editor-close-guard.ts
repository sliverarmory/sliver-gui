/** Tracks dirty editor documents without initiating teardown before close succeeds. */
export class ScriptEditorCloseGuard {
  private readonly dirty = new Set<number>();
  private readonly approved = new Set<number>();
  private quitting = false;

  constructor(private readonly confirmDiscard: (contentsIds: readonly number[]) => boolean) {}

  get isQuitRequested(): boolean { return this.quitting; }

  cancelQuit(): void {
    this.quitting = false;
    this.approved.clear();
  }

  setDirty(contentsId: number, isDirty: boolean): void {
    this.approved.delete(contentsId);
    if (isDirty) this.dirty.add(contentsId);
    else this.dirty.delete(contentsId);
  }

  allowClose(contentsId: number, beforeUnload = false): boolean {
    if (this.approved.has(contentsId) || (!beforeUnload && !this.dirty.has(contentsId))) return true;
    if (!this.confirmDiscard([contentsId])) {
      this.cancelQuit();
      return false;
    }
    this.approved.add(contentsId);
    return true;
  }

  allowQuit(): boolean {
    const pending = [...this.dirty].filter((id) => !this.approved.has(id));
    if (pending.length > 0 && !this.confirmDiscard(pending)) {
      this.cancelQuit();
      return false;
    }
    for (const id of pending) this.approved.add(id);
    this.quitting = true;
    return true;
  }

  forget(contentsId: number): void {
    this.dirty.delete(contentsId);
    this.approved.delete(contentsId);
  }
}
