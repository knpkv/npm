import { Schema } from "effect"

/**
 * Reads the definition of `work_decision_handoffs_session`: no row when it is absent.
 * Both WorkStore and the SQL bridge run it before deciding whether to rebuild it.
 */
export const sessionIndexDefinitionQuery = `
  SELECT list."unique" AS "unique", list.partial AS partial,
    (SELECT group_concat(info.name) FROM pragma_index_info(list.name) AS info) AS columns
  FROM pragma_index_list('work_decision_handoffs') AS list
  WHERE list.name = 'work_decision_handoffs_session'
`

export const SessionIndexDefinition = Schema.Struct({
  columns: Schema.NullOr(Schema.String),
  partial: Schema.Number,
  unique: Schema.Number
})

/**
 * Only a unique, non-partial index on `session_id` alone enforces one handoff per
 * session. A composite or partial index under this name reports `unique = 1` too,
 * so the flag alone is not enough.
 */
export const enforcesOneHandoffPerSession = (definition: typeof SessionIndexDefinition.Type): boolean =>
  definition.unique === 1 && definition.partial === 0 && definition.columns === "session_id"
