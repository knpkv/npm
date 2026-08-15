interface HealthyProviderIdentity {
  readonly _tag: "healthy"
  readonly providerId: string
  readonly identity: {
    readonly kind: string
    readonly displayName: string
    readonly providerImmutableId: string
  }
}

interface FailedProviderIdentity {
  readonly _tag: "failed"
  readonly providerId: string
  readonly safeMessage: string
  readonly failureClass: string
}

interface ProviderBinding {
  readonly displayName: string
  readonly providerFamily: string
  readonly resources: ReadonlyArray<{
    readonly displayName: string
    readonly providerId: string
  }>
}

/** Reduce provider health output to provider taxonomy and success state for CI logs. */
export const opaqueProviderIdentityEvidence = (
  result: HealthyProviderIdentity | FailedProviderIdentity
): {
  readonly providerId: string
  readonly status: "healthy" | "failed"
  readonly kind: string
} =>
  result._tag === "healthy"
    ? {
      providerId: result.providerId,
      status: "healthy",
      kind: result.identity.kind
    }
    : {
      providerId: result.providerId,
      status: "failed",
      kind: "unknown"
    }

/** Reduce account/resource bindings to non-personal provider taxonomy. */
export const opaqueProviderBindingEvidence = (
  binding: ProviderBinding
) => ({
  providerFamily: binding.providerFamily,
  resources: binding.resources.map(({ providerId }) => ({ providerId }))
})
