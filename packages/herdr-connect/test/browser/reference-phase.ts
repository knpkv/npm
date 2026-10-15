import type { Locator } from "@playwright/test"
import { Data } from "effect"

export const phaseLabels: ReadonlyArray<string> = [
  "connect--2i--390-light",
  "connect--2i--390-dark",
  "connect--2i--1280-light",
  "connect--2i--1280-dark"
]
export const futureSurfaceLabels: ReadonlyArray<string> = [
  "connect--2i-v4--390-light",
  "connect--2i-v4--390-dark",
  "connect--2i-v4--1280-light",
  "connect--2i-v4--1280-dark"
]

// Playwright serializes this callback. Keep it independent of module closures.
async function pauseOrbit(element: HTMLElement | SVGElement) {
  const animations = element.getAnimations({ subtree: true })
  const animation = animations[0]
  if (
    animations.length !== 1 || animation === undefined ||
    !("animationName" in animation) || animation.animationName !== "relay-orbit"
  ) {
    return { element, animation: null }
  }
  animation.pause()
  animation.currentTime = 0
  await animation.ready
  return { element, animation }
}

// Retain the object across the shot; a same-name replacement is different evidence.
function sampleOrbit({ animation, element }: Awaited<ReturnType<typeof pauseOrbit>>) {
  const current = element.getAnimations({ subtree: true })
  const effect = animation?.effect
  // Bind the actual effect target to one typed circle, rather than assuming an AnimationEffect is a KeyframeEffect.
  const targets = Array.from(element.querySelectorAll("circle")).filter((circle) =>
    effect !== null && effect !== undefined && "target" in effect && effect.target === circle
  )
  const target = targets.length === 1 ? targets[0] : undefined
  const box = target?.getBoundingClientRect()
  const timing = effect?.getComputedTiming()
  return {
    animationCount: current.length,
    sameAnimation: current.length === 1 && current[0] === animation,
    name: animation?.animationName ?? null,
    currentTime: animation?.currentTime ?? null,
    playState: animation?.playState ?? null,
    pending: animation?.pending ?? null,
    duration: timing?.duration ?? null,
    localTime: timing?.localTime ?? null,
    progress: timing?.progress ?? null,
    targetTag: target?.tagName.toLowerCase() ?? null,
    targetInFigure: target !== undefined && element.contains(target),
    targetRect: box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height }
  }
}

export type OrbitSample = ReturnType<typeof sampleOrbit>

/** A reference needs the retained orbit object paused at its first frame, including its target. */
export const phaseKnown = (sample: OrbitSample) =>
  sample.animationCount === 1 && sample.sameAnimation && sample.name === "relay-orbit" &&
  sample.currentTime === 0 && sample.playState === "paused" && sample.pending === false &&
  sample.duration === 3500 && sample.localTime === 0 && sample.progress === 0 &&
  sample.targetTag === "circle" && sample.targetInFigure && sample.targetRect !== null

/** Only a stable before/after sample can accompany an adopted comparison reference. */
export const referencePhase = (before: OrbitSample, after: OrbitSample) => {
  const a = before.targetRect
  const b = after.targetRect
  const targetRectStable = a !== null && b !== null &&
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  return {
    _tag: phaseKnown(before) && phaseKnown(after) && targetRectStable ? "Pinned" : "Uncertain",
    sameAnimationAcrossCapture: before.sameAnimation && after.sameAnimation,
    targetRectStable
  } satisfies {
    readonly _tag: "Pinned" | "Uncertain"
    readonly sameAnimationAcrossCapture: boolean
    readonly targetRectStable: boolean
  }
}

export class ReferencePhaseError extends Data.TaggedError("ReferencePhaseError")<{
  readonly reason: "OutsidePhaseCaptureScope" | "OrbitPhaseNotPinned" | "OrbitPhaseChangedBeforeShot"
  readonly evidence: OrbitSample | { readonly label: string }
}> {}

/** Capture only the four adopted 2i cells. Uncertain shots remain available for diagnosis. */
export async function capturePinnedReference(
  figure: Locator,
  label: string,
  onPinned: () => Promise<void> = async () => {}
) {
  if (!phaseLabels.includes(label)) {
    throw new ReferencePhaseError({ reason: "OutsidePhaseCaptureScope", evidence: { label } })
  }
  const handle = await figure.evaluateHandle(pauseOrbit)
  try {
    const initial = await handle.evaluate(sampleOrbit)
    if (!phaseKnown(initial)) throw new ReferencePhaseError({ reason: "OrbitPhaseNotPinned", evidence: initial })
    await onPinned()
    const before = await handle.evaluate(sampleOrbit)
    if (!phaseKnown(before)) throw new ReferencePhaseError({ reason: "OrbitPhaseChangedBeforeShot", evidence: before })
    // `disabled` resets or fast-forwards animations; `allow` preserves our paused object and time.
    const png = await figure.screenshot({ animations: "allow" })
    const after = await handle.evaluate(sampleOrbit)
    return { label, png, before, after, phaseEvidence: referencePhase(before, after) }
  } finally {
    await handle.dispose()
  }
}

/** Phase evidence cannot map a future goals board to today's ordinary agent stage. */
export function comparisonEligibility(label: string, evidence: ReturnType<typeof referencePhase> | null) {
  if (futureSurfaceLabels.includes(label)) return { _tag: "Unmapped", reason: "FutureGoalsBoard" }
  if (!phaseLabels.includes(label)) return { _tag: "OutsideScope" }
  return evidence?._tag === "Pinned"
    ? { _tag: "PhaseRecorded" }
    : { _tag: "Uncertain", reason: "ReferenceAnimationPhaseUnknown" }
}
