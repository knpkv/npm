import type { PipelineReleaseTarget, ReleaseTargetConfigurationError } from "../../domain/releaseTargets.js"

/** Explain the field-addressed policy error using the operator's environment and stage names. */
export const releaseTargetErrorMessage = (
  error: ReleaseTargetConfigurationError,
  mappings: ReadonlyArray<PipelineReleaseTarget>
): string => {
  const mapping = mappings[error.mappingIndex]
  const range = error.environmentIndex === null ? undefined : mapping?.environments[error.environmentIndex]
  const previous = error.environmentIndex === null ? undefined : mapping?.environments[error.environmentIndex - 1]
  const environment = range?.name || "This environment"
  const pipeline = mapping?.pipelineName ?? "This pipeline"
  switch (error.reason) {
    case "overlapping-range":
      return `${environment} starts at ${range?.firstStage ?? "this stage"}, which ${
        previous?.name ?? "the preceding environment"
      } already covers.`
    case "out-of-order-range":
      return `${environment} starts before ${
        previous?.name ?? "the preceding environment"
      } in the provider stage order.`
    case "reversed-range":
      return `${environment} ends at ${range?.lastStage ?? "this stage"} before it starts at ${
        range?.firstStage ?? "its first stage"
      }.`
    case "unknown-stage":
      return `${environment}: ${
        range?.[error.field === "lastStage" ? "lastStage" : "firstStage"] ?? "this stage"
      } is absent from the current pipeline.`
    case "duplicate-environment":
      return `${environment} uses an environment key already assigned in ${pipeline}.`
    case "environment-name-conflict":
      return `${environment} must use the same name as other mappings with this environment key.`
    case "duplicate-pipeline":
      return `${pipeline} is already configured for this connection.`
    case "unknown-pipeline":
      return `${pipeline} is absent from the followed pipeline catalogue.`
    case "stale-topology":
      return `${pipeline} has stale topology. Synchronize it, refresh the catalogue, then review its ranges.`
    case "pipeline-unavailable":
      return `${pipeline} is unavailable. Existing mappings can be kept or removed.`
    case "catalogue-incomplete":
      return "The pipeline catalogue is incomplete. Refresh it before adding or editing targets."
    case "too-many-environments":
      return "A workspace can configure at most 50 distinct target environments."
    default: {
      const exhaustive: never = error.reason
      return exhaustive
    }
  }
}
