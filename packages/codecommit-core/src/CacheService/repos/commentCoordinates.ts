import type * as SqlClient from "effect/sql/SqlClient"

/** Legacy comments belong to a target only when the owner's unique cached PR has those coordinates. */
export const commentCoordinatePredicate = (
  sql: SqlClient.SqlClient,
  target: { readonly accountId: string; readonly id: string; readonly repository: string; readonly region: string }
) =>
  sql`(
  (repository_name = ${target.repository} AND account_region = ${target.region})
  OR (
    repository_name = '' AND account_region = ''
    AND (SELECT count(*) FROM pull_requests WHERE aws_account_id = ${target.accountId} AND id = ${target.id}) = 1
    AND EXISTS (SELECT 1 FROM pull_requests WHERE aws_account_id = ${target.accountId} AND id = ${target.id}
      AND repository_name = ${target.repository} AND account_region = ${target.region})
  )
)`
