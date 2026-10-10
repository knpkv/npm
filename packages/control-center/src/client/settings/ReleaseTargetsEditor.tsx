import { Button, StatePanel, Text } from "@knpkv/rly/primitives"
import { useId, useRef, type ReactElement } from "react"

import type {
  PipelineReleaseTarget,
  ReleaseEnvironmentRange,
  ReleaseTargetCatalog,
  ReleaseTargetConfigurationError
} from "../../domain/releaseTargets.js"
import styles from "./WorkspaceSettingsPage.module.css"

/** Edit inclusive stage ranges using the same controls and governed save flow as workspace settings. */
export const ReleaseTargetsEditor = ({
  catalogue,
  disabled,
  error,
  mappings,
  onChange,
  onRefresh
}: {
  readonly mappings: ReadonlyArray<PipelineReleaseTarget>
  readonly catalogue: ReleaseTargetCatalog | null
  readonly error: ReleaseTargetConfigurationError | null
  readonly disabled: boolean
  readonly onChange: (value: ReadonlyArray<PipelineReleaseTarget>) => void
  readonly onRefresh: () => void
}): ReactElement => {
  const prefix = useId()
  const rangeKeys = useRef(new WeakMap<ReleaseEnvironmentRange, string>())
  const nextKey = useRef(0)
  const rangeKey = (range: ReleaseEnvironmentRange) => {
    const existing = rangeKeys.current.get(range)
    if (existing !== undefined) return existing
    const key = `${prefix}-range-${nextKey.current++}`
    rangeKeys.current.set(range, key)
    return key
  }
  const choices = catalogue?.pipelines ?? []
  const update = (index: number, next: PipelineReleaseTarget) =>
    onChange(mappings.map((mapping, mappingIndex) => (mappingIndex === index ? next : mapping)))
  return (
    <div className={styles.targetEditor} id="release-targets">
      <Text as="h3" variant="section-title">
        Release targets
      </Text>
      {mappings.length === 0 ? (
        <Text as="p" tone="secondary">
          No target environments configured. Select a followed pipeline after synchronization.
        </Text>
      ) : null}
      {catalogue === null ? (
        <StatePanel
          title="Pipeline catalogue unavailable"
          description="Refresh the catalogue to configure targets."
          tone="caution"
        />
      ) : null}
      <Button onClick={onRefresh} disabled={disabled} type="button" variant="secondary">
        Refresh pipeline catalogue
      </Button>
      {mappings.map((mapping, index) => {
        const pipeline = choices.find(
          (choice) =>
            choice.pluginConnectionId === mapping.pluginConnectionId && choice.pipelineName === mapping.pipelineName
        )
        const stale =
          pipeline === undefined || pipeline.state !== "current" || pipeline.topologyDigest !== mapping.topologyDigest
        const patchRange = (previous: ReleaseEnvironmentRange, range: ReleaseEnvironmentRange) => {
          rangeKeys.current.set(range, rangeKey(previous))
          update(index, {
            ...mapping,
            environments: mapping.environments.map((entry) => (entry === previous ? range : entry))
          })
        }
        const field = (rangeIndex: number, name: "key" | "name" | "firstStage" | "lastStage") => {
          const invalid = error?.mappingIndex === index && error.environmentIndex === rangeIndex && error.field === name
          return {
            id: `${prefix}-${index}-${rangeIndex}-${name}`,
            "aria-invalid": invalid,
            ...(invalid && { "aria-describedby": `${prefix}-error` })
          }
        }
        return (
          <div
            className={styles.targetMapping}
            key={`${mapping.pluginConnectionId}-${mapping.pipelineName}`}
            aria-describedby={
              error?.mappingIndex === index && error.environmentIndex === null ? `${prefix}-error` : undefined
            }
          >
            <Text as="h4">{mapping.pipelineName}</Text>
            <Text as="p" tone="secondary">
              {pipeline?.displayName ?? "Saved followed pipeline"}
            </Text>
            {stale ? (
              <StatePanel
                title="Saved pipeline topology is stale"
                description="Synchronize the pipeline, refresh its catalogue, then review the stage ranges."
                tone="caution"
              />
            ) : null}
            <Button
              onClick={() => onChange(mappings.filter((_, i) => i !== index))}
              disabled={disabled}
              type="button"
              variant="secondary"
            >{`Remove pipeline ${mapping.pipelineName}`}</Button>
            {pipeline !== undefined && pipeline.state === "current" && stale ? (
              <Button
                disabled={disabled}
                type="button"
                variant="secondary"
                onClick={() => update(index, { ...mapping, topologyDigest: pipeline.topologyDigest })}
              >
                Review current topology
              </Button>
            ) : null}
            {mapping.environments.map((range, rangeIndex) => (
              <div className={styles.targetRange} key={rangeKey(range)}>
                <Text as="p">Environment {rangeIndex + 1}</Text>
                <label className={styles.field}>
                  <span>Environment key</span>
                  <input
                    {...field(rangeIndex, "key")}
                    className={styles.control}
                    disabled={disabled}
                    value={range.key}
                    onChange={(event) => patchRange(range, { ...range, key: event.currentTarget.value })}
                  />
                </label>
                <label className={styles.field}>
                  <span>Environment name</span>
                  <input
                    {...field(rangeIndex, "name")}
                    className={styles.control}
                    disabled={disabled}
                    value={range.name}
                    onChange={(event) => patchRange(range, { ...range, name: event.currentTarget.value })}
                  />
                </label>
                {(["firstStage", "lastStage"] satisfies ReadonlyArray<"firstStage" | "lastStage">).map((name) => (
                  <label className={styles.field} key={name}>
                    <span>{name === "firstStage" ? "First stage" : "Last stage"}</span>
                    <select
                      {...field(rangeIndex, name)}
                      className={styles.control}
                      disabled={disabled}
                      value={range[name]}
                      onChange={(event) => patchRange(range, { ...range, [name]: event.currentTarget.value })}
                    >
                      {pipeline?.stages.some((stage) => stage.name === range[name]) !== true ? (
                        <option value={range[name]}>{range[name]} (unavailable)</option>
                      ) : null}
                      {pipeline?.stages.map((stage) => (
                        <option key={stage.name} value={stage.name}>
                          {stage.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label className={styles.checkbox}>
                  <input
                    checked={range.requiresManualGate}
                    disabled={disabled}
                    type="checkbox"
                    onChange={(event) =>
                      patchRange(range, { ...range, requiresManualGate: event.currentTarget.checked })
                    }
                  />
                  <span>Require manual approval gate</span>
                </label>
                <Button
                  disabled={disabled || mapping.environments.length === 1}
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    update(index, { ...mapping, environments: mapping.environments.filter((_, i) => i !== rangeIndex) })
                  }
                >{`Remove environment ${range.name}`}</Button>
              </div>
            ))}
            <Button
              disabled={disabled || mapping.environments.length >= 50 || pipeline === undefined}
              type="button"
              variant="secondary"
              onClick={() => {
                const firstStage = pipeline?.stages[0]?.name
                const lastStage = pipeline?.stages.at(-1)?.name
                if (firstStage === undefined || lastStage === undefined) return
                let count = mapping.environments.length + 1
                while (mapping.environments.some((range) => range.key === `environment-${count}`)) count++
                update(index, {
                  ...mapping,
                  environments: [
                    ...mapping.environments,
                    {
                      key: `environment-${count}`,
                      name: `Environment ${count}`,
                      firstStage,
                      lastStage,
                      requiresManualGate: true
                    }
                  ]
                })
              }}
            >
              Add environment range
            </Button>
          </div>
        )
      })}
      <label className={styles.field}>
        <span>Add followed pipeline</span>
        <select
          className={styles.control}
          disabled={disabled || catalogue === null || !catalogue.complete || mappings.length >= 50}
          value=""
          onChange={(event) => {
            const choice = choices.find(
              (pipeline) => `${pipeline.pluginConnectionId}:${pipeline.pipelineName}` === event.currentTarget.value
            )
            const firstStage = choice?.stages[0]?.name
            const lastStage = choice?.stages.at(-1)?.name
            if (choice === undefined || firstStage === undefined || lastStage === undefined) return
            onChange([
              ...mappings,
              {
                pluginConnectionId: choice.pluginConnectionId,
                pipelineName: choice.pipelineName,
                topologyDigest: choice.topologyDigest,
                environments: [
                  { key: "production", name: "Production", firstStage, lastStage, requiresManualGate: true }
                ]
              }
            ])
          }}
        >
          <option value="">Select pipeline</option>
          {choices
            .filter(
              (choice) =>
                choice.state === "current" &&
                !mappings.some(
                  (mapping) =>
                    mapping.pluginConnectionId === choice.pluginConnectionId &&
                    mapping.pipelineName === choice.pipelineName
                )
            )
            .map((choice) => (
              <option
                key={`${choice.pluginConnectionId}:${choice.pipelineName}`}
                value={`${choice.pluginConnectionId}:${choice.pipelineName}`}
              >
                {choice.displayName}: {choice.pipelineName}
              </option>
            ))}
        </select>
      </label>
      <p aria-live="polite" id={`${prefix}-error`}>
        {error === null ? "" : `Cannot save target configuration: ${error.reason.replaceAll("-", " ")}.`}
      </p>
    </div>
  )
}
