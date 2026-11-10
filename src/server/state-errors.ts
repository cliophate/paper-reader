export class StateConflictError extends Error {
  constructor(readonly states: Record<string, { read: boolean; starred: boolean; revision: number }>) {
    super('Article state changed. Refresh and review its current state before retrying.')
  }
}
export class UndoExpiredError extends Error {
  constructor() { super('That undo has expired or belongs to another backend.') }
}
