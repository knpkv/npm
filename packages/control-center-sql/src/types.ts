/** SQL text and bound parameters ready for an Effect SQL client. */
export interface RenderedSql {
  readonly params: ReadonlyArray<unknown>
  readonly sql: string
}
