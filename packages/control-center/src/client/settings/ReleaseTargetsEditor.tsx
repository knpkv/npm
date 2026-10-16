import { Button, StateLabel, StatePanel, Text } from "@knpkv/rly/primitives"
import { useId, useRef, type ReactElement } from "react"

import type {
  PipelineReleaseTarget,
  ReleaseEnvironmentRange,
  ReleaseTargetCatalog,
  ReleaseTargetConfigurationError
} from "../../domain/releaseTargets.js"
import styles from "./WorkspaceSettingsPage.module.css"
import { releaseTargetErrorMessage } from "./releaseTargetErrorMessage.js"
import { formatCheckTime } from "../formatTime.js"

export interface ReleaseTargetsEditorProps {
  readonly mappings: ReadonlyArray<PipelineReleaseTarget>
  readonly catalogue: ReleaseTargetCatalog | null
  readonly error: ReleaseTargetConfigurationError | null
  readonly disabled: boolean
  readonly onChange: (value: ReadonlyArray<PipelineReleaseTarget>) => void
  readonly onRefresh: () => void
}

/** Edit inclusive stage ranges using the same controls and governed save flow as workspace settings. */
export const ReleaseTargetsEditor = ({
  catalogue,
  disabled,
  error,
  mappings,
  onChange,
  onRefresh
}: ReleaseTargetsEditorProps): ReactElement => {
  const prefix = useId()
  const rangeKeys = useRef(new WeakMap<ReleaseEnvironmentRange, string>())
  const nextKey = useRef(0)
  const controls = useRef(new Map<string, HTMLElement>())
  const controlRef = (id: string) => (element: HTMLElement | null) => {
    if (element === null) controls.current.delete(id)
    else controls.current.set(id, element)
  }
  const rangeKey = (range: ReleaseEnvironmentRange) => {
    const existing = rangeKeys.current.get(range)
    if (existing !== undefined) return existing
    const key = `${prefix}-range-${nextKey.current++}`
    rangeKeys.current.set(range, key)
    return key
  }
  const choices = catalogue?.pipelines ?? []
  const mappingId = (mapping: PipelineReleaseTarget) =>
    `${prefix}-${mapping.pluginConnectionId}-${mapping.pipelineName}`
  const fieldId = (range: ReleaseEnvironmentRange, name: string) => `${rangeKey(range)}-${name}`
  const errorMapping = error === null ? undefined : mappings[error.mappingIndex]
  const errorRange =
    error?.environmentIndex === null || error === null ? undefined : errorMapping?.environments[error.environmentIndex]
  const errorTarget =
    errorRange !== undefined && error !== null
      ? fieldId(errorRange, error.field)
      : errorMapping === undefined
        ? undefined
        : mappingId(errorMapping)
  const message = error === null ? null : releaseTargetErrorMessage(error, mappings)
  const update = (index: number, next: PipelineReleaseTarget) =>
    onChange(mappings.map((mapping, mappingIndex) => (mappingIndex === index ? next : mapping)))
  return (
    <div className={styles.targetEditor} id="release-targets">
      <Text as="h3" variant="section-title">
        Release targets
      </Text>
      <div aria-live="polite">
        {message === null ? null : (
          <div className={styles.notice}>
            <Text as="p">Cannot save release targets. Review the marked field.</Text>
            <Button
              className={styles.targetAction}
              type="button"
              variant="quiet"
              size="default"
              onClick={() => {
                if (errorTarget !== undefined) controls.current.get(errorTarget)?.focus()
              }}
            >
              {`Review ${errorRange?.name.trim() || errorMapping?.pipelineName || "target configuration"}`}
            </Button>
          </div>
        )}
      </div>
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
      <Button
        className={styles.targetAction}
        size="default"
        onClick={onRefresh}
        disabled={disabled}
        type="button"
        variant="secondary"
      >
        Refresh pipeline catalogue
      </Button>
      {mappings.map((mapping, index) => {
        const pipeline = choices.find(
          (choice) =>
            choice.pluginConnectionId === mapping.pluginConnectionId && choice.pipelineName === mapping.pipelineName
        )
        const stale =
          pipeline === undefined || pipeline.state !== "current" || pipeline.topologyDigest !== mapping.topologyDigest
        const rangeDisabled = disabled || stale || catalogue?.complete !== true
        const stagePositions = new Map(pipeline?.stages.map((stage, stageIndex) => [stage.name, stageIndex]) ?? [])
        const state =
          pipeline === undefined || pipeline.state === "unavailable" ? "unavailable" : stale ? "stale" : "current"
        const stateLabel =
          state === "current"
            ? "Current"
            : state === "unavailable"
              ? "Unavailable"
              : pipeline?.observedAt === null || pipeline?.observedAt === undefined
                ? "Stale · observation time unavailable"
                : `Stale since ${formatCheckTime(pipeline.observedAt)}`
        const patchRange = (previous: ReleaseEnvironmentRange, range: ReleaseEnvironmentRange) => {
          rangeKeys.current.set(range, rangeKey(previous))
          update(index, {
            ...mapping,
            environments: mapping.environments.map((entry) => (entry === previous ? range : entry))
          })
        }
        const field = (rangeIndex: number, name: "key" | "name" | "firstStage" | "lastStage") => {
          const invalid = error?.mappingIndex === index && error.environmentIndex === rangeIndex && error.field === name
          const range = mapping.environments[rangeIndex]
          const id = range === undefined ? `${prefix}-${index}-${rangeIndex}-${name}` : fieldId(range, name)
          return {
            id,
            ref: controlRef(id),
            "aria-invalid": invalid,
            ...(invalid && { "aria-describedby": `${id}-error` })
          }
        }
        const fieldError = (rangeIndex: number, name: "key" | "name" | "firstStage" | "lastStage") => {
          const props = field(rangeIndex, name)
          return props["aria-invalid"] ? (
            <Text as="small" id={`${props.id}-error`} className={styles.targetError}>
              {message}
            </Text>
          ) : null
        }
        return (
          <fieldset
            className={styles.targetMapping}
            id={mappingId(mapping)}
            ref={controlRef(mappingId(mapping))}
            tabIndex={-1}
            key={`${mapping.pluginConnectionId}-${mapping.pipelineName}`}
            aria-describedby={
              error?.mappingIndex === index && error.environmentIndex === null
                ? `${mappingId(mapping)}-error`
                : undefined
            }
          >
            <legend>
              <Text as="span" variant="card-title">
                {mapping.pipelineName}
              </Text>{" "}
              <StateLabel label={stateLabel} tone={state === "current" ? "positive" : "caution"} size="compact" />
            </legend>
            <Text as="p" tone="secondary">
              {pipeline?.displayName ?? "Saved followed pipeline"}
            </Text>
            {stale ? (
              <StatePanel
                title={state === "unavailable" ? "Pipeline unavailable" : "Saved pipeline topology is stale"}
                description="This pipeline's range edits are disabled. Synchronize it, refresh its catalogue, then review the stage ranges. Other current pipelines remain editable; this mapping can still be removed."
                tone="caution"
              />
            ) : null}
            <Button
              className={styles.targetAction}
              size="default"
              onClick={() => onChange(mappings.filter((_, i) => i !== index))}
              disabled={disabled}
              type="button"
              variant="quiet"
            >{`Remove pipeline ${mapping.pipelineName}`}</Button>
            {pipeline !== undefined && pipeline.state === "current" && stale ? (
              <Button
                className={styles.targetAction}
                size="default"
                disabled={disabled}
                type="button"
                variant="secondary"
                onClick={() => update(index, { ...mapping, topologyDigest: pipeline.topologyDigest })}
              >
                Review current topology
              </Button>
            ) : null}
            {error?.mappingIndex === index && error.environmentIndex === null ? (
              <Text as="p" className={styles.targetError} id={`${mappingId(mapping)}-error`}>
                {message}
              </Text>
            ) : null}
            {pipeline === undefined ? null : (
              <div className={styles.targetPreview}>
                <Text as="p" variant="label">
                  Provider stage order
                </Text>
                <ol aria-label={`${mapping.pipelineName} provider stage order`} className={styles.targetStages}>
                  {pipeline.stages.map((stage, stageIndex) => {
                    const covered = mapping.environments.filter((range) => {
                      const start = stagePositions.get(range.firstStage)
                      const end = stagePositions.get(range.lastStage)
                      return start !== undefined && end !== undefined && start <= stageIndex && stageIndex <= end
                    })
                    return (
                      <li key={stage.name}>
                        <Text as="span" variant="label">
                          {stageIndex + 1}. {stage.name}
                        </Text>
                        <StateLabel
                          label={
                            covered.length === 0
                              ? "Gap · no environment"
                              : `${covered.length > 1 ? "Overlap · " : ""}${covered.map((range) => range.name.trim() || "Unnamed environment").join(" · ")}`
                          }
                          tone={covered.length === 1 ? "neutral" : "caution"}
                          size="compact"
                        />
                      </li>
                    )
                  })}
                </ol>
              </div>
            )}
            {mapping.environments.map((range, rangeIndex) => (
              <fieldset className={styles.targetRange} key={rangeKey(range)} disabled={rangeDisabled}>
                <legend>
                  <Text as="span" variant="card-title">
                    {range.name.trim() || "Unnamed environment"}
                  </Text>
                </legend>
                <div className={styles.targetPair}>
                  <div className={styles.field}>
                    <label htmlFor={field(rangeIndex, "key").id}>Environment key</label>
                    <input
                      {...field(rangeIndex, "key")}
                      className={styles.control}
                      disabled={rangeDisabled}
                      autoCapitalize="none"
                      spellCheck={false}
                      value={range.key}
                      onChange={(event) => patchRange(range, { ...range, key: event.currentTarget.value })}
                    />
                    {fieldError(rangeIndex, "key")}
                  </div>
                  <div className={styles.field}>
                    <label htmlFor={field(rangeIndex, "name").id}>Environment name</label>
                    <input
                      {...field(rangeIndex, "name")}
                      className={styles.control}
                      disabled={rangeDisabled}
                      value={range.name}
                      onChange={(event) => patchRange(range, { ...range, name: event.currentTarget.value })}
                    />
                    {fieldError(rangeIndex, "name")}
                  </div>
                </div>
                <div className={styles.targetPair}>
                  {(["firstStage", "lastStage"] satisfies ReadonlyArray<"firstStage" | "lastStage">).map((name) => (
                    <div className={styles.field} key={name}>
                      <label htmlFor={field(rangeIndex, name).id}>
                        {name === "firstStage" ? "First stage" : "Last stage"}
                      </label>
                      <select
                        {...field(rangeIndex, name)}
                        className={styles.control}
                        disabled={rangeDisabled}
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
                      {fieldError(rangeIndex, name)}
                    </div>
                  ))}
                </div>
                <label className={styles.checkbox}>
                  <input
                    checked={range.requiresManualGate}
                    disabled={rangeDisabled}
                    type="checkbox"
                    onChange={(event) =>
                      patchRange(range, { ...range, requiresManualGate: event.currentTarget.checked })
                    }
                  />
                  <span>Require manual approval gate</span>
                </label>
                <Button
                  className={styles.targetAction}
                  size="default"
                  disabled={rangeDisabled || mapping.environments.length === 1}
                  type="button"
                  variant="quiet"
                  onClick={() =>
                    update(index, { ...mapping, environments: mapping.environments.filter((_, i) => i !== rangeIndex) })
                  }
                >{`Remove environment ${range.name}`}</Button>
              </fieldset>
            ))}
            <Button
              className={styles.targetAction}
              size="default"
              disabled={rangeDisabled || mapping.environments.length >= 50}
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
          </fieldset>
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
    </div>
  )
}
