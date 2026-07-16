interface RelationshipClosureIdentity {
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly evidenceClaimIds: ReadonlyArray<string>
}

/** Deterministic complete prefix whose expanded node and evidence closure stays bounded. */
export const selectBoundedRelationshipClosure = <Relationship extends RelationshipClosureIdentity>(
  relationships: ReadonlyArray<Relationship>,
  limits: { readonly relationships: number; readonly nodes: number; readonly evidenceClaims: number }
): { readonly relationships: ReadonlyArray<Relationship>; readonly truncated: boolean } => {
  const nodes = new Set<string>()
  const evidenceClaims = new Set<string>()
  const selected: Array<Relationship> = []

  for (const relationship of relationships) {
    if (selected.length >= limits.relationships) {
      return { relationships: selected, truncated: true }
    }
    const nextNodes = new Set(nodes)
    nextNodes.add(relationship.sourceNodeId)
    nextNodes.add(relationship.targetNodeId)
    const nextEvidenceClaims = new Set(evidenceClaims)
    for (const claimId of relationship.evidenceClaimIds) nextEvidenceClaims.add(claimId)
    if (nextNodes.size > limits.nodes || nextEvidenceClaims.size > limits.evidenceClaims) {
      return { relationships: selected, truncated: true }
    }
    selected.push(relationship)
    nextNodes.forEach((nodeId) => nodes.add(nodeId))
    nextEvidenceClaims.forEach((claimId) => evidenceClaims.add(claimId))
  }

  return { relationships: selected, truncated: false }
}
