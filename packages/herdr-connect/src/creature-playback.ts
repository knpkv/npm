/** Task identity owns transitions; the Fleet service already owns the 500ms evidence debounce. */
import type { AgentTaskKind } from "@knpkv/herdr-fleet/model"
import { type RefObject, useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react"
import { finishTaskPlayback, startTaskPlayback, updateTaskPlayback } from "./creature-task.js"

interface PreferenceOwner {
  readonly reduced: MediaQueryList
  readonly forced: MediaQueryList
  readonly observer: MutationObserver
  readonly changed: () => void
  readonly subscribers: Set<() => void>
}
const preferenceOwners = new WeakMap<Document, PreferenceOwner>()

/** One document owns native subscriptions; roots still evaluate their own inherited app preferences. */
const preferenceOwner = (document: Document): PreferenceOwner | undefined => {
  const existing = preferenceOwners.get(document)
  if (existing !== undefined) return existing
  const view = document.defaultView
  if (view === null) return undefined
  const subscribers = new Set<() => void>()
  const changed = () => {
    for (const subscriber of subscribers) subscriber()
  }
  const reduced = view.matchMedia("(prefers-reduced-motion: reduce)")
  const forced = view.matchMedia("(forced-colors: active)")
  const observer = new view.MutationObserver(changed)
  reduced.addEventListener("change", changed)
  forced.addEventListener("change", changed)
  observer.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: [
      "data-rly-reduced-motion",
      "data-reduced-motion",
      "data-rly-forced-colors",
      "data-forced-colors"
    ]
  })
  const owner = { reduced, forced, observer, changed, subscribers }
  preferenceOwners.set(document, owner)
  return owner
}

/** Both preference boundaries settle one-shots, including ones paused offscreen. Restoring motion never replays them. */
const useStillTaskMotion = (root: RefObject<SVGSVGElement | null>, active: boolean): boolean => {
  const snapshot = useCallback(() => {
    const node = root.current
    const view = node?.ownerDocument.defaultView
    if (!active || node === null || view === null || view === undefined) return false
    const owner = preferenceOwners.get(node.ownerDocument)
    return (
      (owner?.reduced ?? view.matchMedia("(prefers-reduced-motion: reduce)")).matches ||
      (owner?.forced ?? view.matchMedia("(forced-colors: active)")).matches ||
      node.closest(
          "[data-rly-reduced-motion=\"reduce\"], [data-reduced-motion=\"reduce\"], [data-rly-forced-colors=\"active\"], [data-forced-colors=\"active\"]"
        ) !== null
    )
  }, [active, root])
  const subscribe = useCallback((changed: () => void) => {
    const node = root.current
    if (!active || node === null) return () => {}
    const document = node.ownerDocument
    const owner = preferenceOwner(document)
    if (owner === undefined) return () => {}
    owner.subscribers.add(changed)
    return () => {
      owner.subscribers.delete(changed)
      if (owner.subscribers.size !== 0) return
      owner.observer.disconnect()
      owner.reduced.removeEventListener("change", owner.changed)
      owner.forced.removeEventListener("change", owner.changed)
      preferenceOwners.delete(document)
    }
  }, [active, root])
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

/** A superseded loop remains mounted until its frozen frame is covered; only its own epoch can finish it. */
export const useTaskPlayback = (
  root: RefObject<SVGSVGElement | null>,
  identity: string,
  kind: AgentTaskKind | undefined
) => {
  const still = useStillTaskMotion(root, kind !== undefined)
  const [owner, setOwner] = useState({
    identity,
    active: kind !== undefined,
    playback: startTaskPlayback(kind ?? "unknown")
  })
  const reset = owner.identity !== identity || owner.active !== (kind !== undefined)
  const next = reset
    ? startTaskPlayback(kind ?? "unknown", owner.playback.current.epoch + 1)
    : kind === undefined
    ? owner.playback
    : updateTaskPlayback(owner.playback, kind, still)
  if (reset || next !== owner.playback) setOwner({ identity, active: kind !== undefined, playback: next })
  const playback = next
  const epoch = playback.current.epoch
  const finish = useCallback(
    () =>
      setOwner((current) =>
        !current.active || current.identity !== identity
          ? current
          : { ...current, playback: finishTaskPlayback(current.playback, epoch) }
      ),
    [epoch, identity]
  )
  const outgoing = playback.outgoing?.epoch
  useLayoutEffect(() => {
    const node = root.current
    if (node === null || outgoing === undefined || still) return
    const content = node.querySelector(`[data-task-epoch="${String(outgoing)}"] .connect-creature-task-content`)
    if (content === null) return
    for (const animation of content.getAnimations({ subtree: true })) animation.pause()
    const bodies = playback.transition === "blend"
      ? [
        ...content.querySelectorAll<SVGElement>(
          "[data-task-body], .connect-creature-idle-habit, .connect-creature-idle-fidget, .connect-creature-idle-breath"
        )
      ]
      : []
    const previous = bodies.map((body) => {
      const original = body.style.cssText
      const paint = getComputedStyle(body)
      body.style.setProperty("--connect-task-from-transform", paint.transform)
      body.style.setProperty("--connect-task-from-translate", paint.translate)
      body.style.setProperty("--connect-task-from-rotate", paint.rotate)
      body.style.setProperty("--connect-task-from-scale", paint.scale)
      body.classList.add("connect-creature-task-relax")
      return { body, original }
    })
    return () => {
      for (const { body, original } of previous) {
        body.style.cssText = original
        body.classList.remove("connect-creature-task-relax")
      }
    }
  }, [outgoing, playback.transition, root, still])
  return { playback, finish, still }
}
