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

/** Reduce provider health output to the opaque identity fields allowed in CI logs. */
export const opaqueProviderIdentityEvidence = (
  result: HealthyProviderIdentity | FailedProviderIdentity
): {
  readonly providerId: string
  readonly kind: string
  readonly providerImmutableId: string
} =>
  result._tag === "healthy"
    ? {
      providerId: result.providerId,
      kind: result.identity.kind,
      providerImmutableId: result.identity.providerImmutableId
    }
    : {
      providerId: result.providerId,
      kind: "failed",
      providerImmutableId: result.failureClass
    }

/** Reduce account/resource bindings to non-personal provider taxonomy. */
export const opaqueProviderBindingEvidence = (
  binding: ProviderBinding
): {
  readonly providerFamily: string
  readonly resources: ReadonlyArray<{ readonly providerId: string }>
} => ({
  providerFamily: binding.providerFamily,
  resources: binding.resources.map(({ providerId }) => ({ providerId }))
})
