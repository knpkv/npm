/** Decorative agent identity; adjacent text carries state. Talking stages own mouths; typed idle evidence opts into seeded motion. */
import type { AgentTaskKind } from "@knpkv/herdr-fleet/model"
import { useCreatureNeighbourPhase } from "./creature-neighbours.js"
import { useCreatureVisibility } from "./creature-visibility.js"
import {
  type CSSProperties,
  type ReactElement,
  type RefObject,
  useCallback,
  useId,
  useRef,
  useState,
  useSyncExternalStore
} from "react"

import { CreatureAdornment } from "./creature-accessory.js"
import { agentStatePresentation } from "./agent-state.js"
import {
  agentCharacter,
  creatureBodySeed,
  creaturePalette,
  creatureSignature,
  FOOT,
  IRIS_SHARE,
  softBoxPath,
  type CreatureHueFamily
} from "./character.js"
import {
  browStroke,
  creatureAgentPose,
  creatureMood,
  creaturePose,
  mouthPath,
  type CreaturePose,
  type CreatureAccessory,
  type CreatureMood,
  type CreatureReaction
} from "./creature-state.js"

export type { CreatureHueFamily } from "./character.js"
export type { CreatureAccessory, CreatureMood, CreatureReaction } from "./creature-state.js"
export type CreatureSize = "row" | "cast" | "stage"
const pixels = { cast: 60, row: 36, stage: 240 } satisfies Record<CreatureSize, number>

export interface CreatureProps {
  readonly host: string
  readonly id: string
  /** Agent name for palette hashing. Defaults to id for standalone drawings. */
  readonly name?: string
  /** Optional served family; overrides hash(host,name). Only the eight agent families are accepted. */
  readonly hueFamily?: CreatureHueFamily | undefined
  readonly state: string
  /**
   * Defaults to absent, preserving legacy state motion. Explicit idle enables the seeded idle loops and
   * habit at every size, sampled from host/id and the rendered family. Same-kind updates retain phase;
   * another kind removes the idle layers. Closed, stale, reduced-motion and forced-colour views stay still.
   */
  readonly taskKind?: AgentTaskKind | undefined
  /** Home keeps unknown evidence neutral and uses its wider row frame with thin state rings; Fleet retains its needs-you fallback and fitted row track. */
  readonly statePolicy?: "fleet" | "home"
  readonly size: CreatureSize
  /** Stale hosts rest with half lids and stop motion; identity is retained. Default false. */
  readonly stale?: boolean
  /**
   * Defaults to false. In every size, closure keeps the seeded outline with a neutral tint, shut lids and
   * lowered brows, and removes rings and all creature motion for the lifetime of this prop. It is static
   * with either reduced-motion preference; clearing it resumes the current state's normal presentation.
   */
  readonly closed?: boolean
  /** Retained arrival marker; ordinary agents keep their true body on arrival. Default false. */
  readonly arrived?: boolean
  /** Default none. Optional neutral headphones, hard-hat, scarf or glasses. Agents never wear chef headwear. */
  readonly accessory?: CreatureAccessory
  /** Default false. Enables the expressive mouth and pose only at stage size; reduced motion holds the static pose. */
  readonly talking?: boolean
  /** Optional pose override. Otherwise state owns the mood; entering done plays once before happy. An already-done mount is happy. */
  readonly mood?: CreatureMood
  /** Stage-only, one-shot reaction. Listening lasts 720ms, poke 620ms; both settle to the true body. */
  readonly reaction?: CreatureReaction
  /** Stage-only. Increment to replay the same reaction. Identity and looping phases remain unchanged. Default 0. */
  readonly reactionKey?: number
}

/** Only an unsettled one-shot subscribes; both preference sources can stop an already-running celebration. */
const useReducedCreatureMotion = (root: RefObject<SVGSVGElement | null>, active: boolean): boolean => {
  const snapshot = useCallback(() => {
    const node = root.current
    if (!active || node === null) return false
    return (
      node.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches === true ||
      node.closest('[data-rly-reduced-motion="reduce"], [data-reduced-motion="reduce"]') !== null
    )
  }, [active, root])
  const subscribe = useCallback(
    (changed: () => void) => {
      const node = root.current
      const view = node?.ownerDocument.defaultView
      if (!active || node === null || view === null || view === undefined) return () => {}
      const media = view.matchMedia("(prefers-reduced-motion: reduce)")
      const observer = new MutationObserver(changed)
      media.addEventListener("change", changed)
      observer.observe(node.ownerDocument.documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ["data-rly-reduced-motion", "data-reduced-motion"]
      })
      return () => {
        media.removeEventListener("change", changed)
        observer.disconnect()
      }
    },
    [active, root]
  )
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

/** SVG coordinates use a square row frame, including both stroke edges at the smallest 28px crew track. */
export const Creature = ({
  accessory = "none",
  arrived = false,
  closed = false,
  host,
  hueFamily,
  id,
  name = id,
  mood: override,
  reaction: requestedReaction,
  reactionKey: requestedReactionKey = 0,
  size,
  stale = false,
  state,
  statePolicy = "fleet",
  taskKind,
  talking = false
}: CreatureProps): ReactElement => {
  const reaction = size === "stage" ? requestedReaction : undefined
  const reactionKey = size === "stage" ? requestedReactionKey : 0
  const character = agentCharacter(host, id)
  const presentation = agentStatePresentation(state, statePolicy)
  const talkPose = talking && size === "stage"
  const root = useRef<SVGSVGElement>(null)
  const identity = `${host.toLowerCase()}\u0000${id}`
  const alreadyDone = override === undefined && creatureMood(state, talkPose) === "done"
  const [completion, setCompletion] = useState({
    identity,
    state,
    override,
    complete: alreadyDone
  })
  // A new identity starts at its current pose; only a transition of the same agent celebrates.
  if (completion.identity !== identity || completion.state !== state || completion.override !== override) {
    setCompletion({ identity, state, override, complete: completion.identity !== identity && alreadyDone })
  }
  const settled =
    completion.identity === identity &&
    completion.state === state &&
    completion.override === override &&
    completion.complete
  const selected = override ?? creatureMood(state, talkPose)
  const reduced = useReducedCreatureMotion(root, selected === "done" && !settled && reaction === undefined)
  // Persist the skipped completion so restoring motion cannot replay this transition.
  if (reduced && !settled && selected === "done" && reaction === undefined) {
    setCompletion({ identity, state, override, complete: true })
  }
  const ordinary = !talkPose && override === undefined && reaction === undefined
  const mood = reaction !== undefined ? reaction : selected === "done" && (settled || reduced) ? "happy" : selected
  const shut = closed || stale
  const expressive = talking && size === "stage" && !shut
  // Lifecycle urgency takes precedence while the server debounces a new task kind.
  const resting = presentation.bucket !== "needs-you" && presentation.bucket !== "finished"
  const idle = taskKind === "idle" && ordinary && !shut && resting
  useCreatureVisibility(root, idle)
  const basePose =
    !shut && !talkPose && override === undefined && reaction === undefined
      ? creatureAgentPose(state)
      : creaturePose(mood, closed, stale)
  const pose: CreaturePose = idle
    ? { ...basePose, brow: "rest", lid: 0.12, lower: 0, eyeScale: 1, look: [0, 0], eyes: "open" }
    : basePose
  const palette = creaturePalette(host, name, hueFamily, closed ? 0.1 : 1)
  const signature = creatureSignature(host, id, palette.family)
  const phase = useCreatureNeighbourPhase(host, id, signature.phase)
  const ew = character.eye[0] * pose.eyeScale
  const eh = character.eye[1] * pose.eyeScale
  const [left, top, width, height] = character.bounds
  const unit = character.unit
  const seed = creatureBodySeed(character.bodyKind)
  const referenceWidth = seed.width * unit
  const referenceHeight = seed.height * unit
  const referenceTop = character.eyeY - referenceHeight * seed.eyeY
  const referenceLeft = 50 - referenceWidth / 2
  const row = size === "row"
  const homeRow = row && statePolicy === "home"
  const rowTrack = 28
  const rowStroke = 2
  const baseRx = (width / 2) * character.ringScale
  const baseRy = (height / 2) * character.ringScale
  const rowCy = character.ringCy
  // Keep body framing independent of mood. Overlays may paint outside this slot; screenshot masks include SVG paint bounds.
  const overlayTop = top - (4 + (accessory === "hard-hat" ? 2.5 : accessory === "headphones" ? 1.5 : 0)) * unit
  // Reserve both 2px stroke edges at the 28px crew minimum; accessories and marks do not change body sizing.
  const frameEdge = (2 * Math.max(baseRx, baseRy)) / (1 - (2 * rowStroke) / rowTrack)
  const strokeHalf = frameEdge / rowTrack
  // Home export 66 maps -6 -6 44 44 to the seeded body and uses a one-unit circular state ring.
  const radius = homeRow
    ? (Math.max(seed.width, seed.height) / 2 + 2.25) * unit
    : row
      ? Math.max(baseRx, baseRy) + strokeHalf
      : 46
  const ring = { cy: homeRow ? FOOT - referenceHeight / 2 : row ? rowCy : 55, rx: radius, ry: radius }
  const frameLeft = homeRow ? 50 - 22 * unit : 50 - frameEdge / 2
  const frameTop = homeRow ? FOOT - 36.75 * unit : rowCy - frameEdge / 2
  const fixed = (value: number): string => value.toFixed(3)
  const dropRadius = row ? 1.4 : 1.05
  // Fleet closed archive rows have no track: map the reference's 0 2 32 32 frame onto this scaled body.
  const viewBox = homeRow
    ? [frameLeft, frameTop, 44 * unit, 44 * unit].map(fixed).join(" ")
    : row && closed
      ? [50 - 16 * unit, FOOT - 28.75 * unit, 32 * unit, 32 * unit].map(fixed).join(" ")
      : row
        ? [frameLeft, frameTop, frameEdge, frameEdge].map(fixed).join(" ")
        : "0 0 100 100"
  const eyeY = character.eyeY
  const eyes = [50 - character.eyeGap, 50 + character.eyeGap]
  const iris = character.eye[0] * IRIS_SHARE
  const sag = mood === "focused" ? 0 : eh * 0.3
  const shutY = eyeY + eh * 0.25
  const socket = 0.2 * unit
  const upperRest = eyeY - eh - socket
  const lowerRest = eyeY + eh + socket
  const reach = ew + (idle ? 0 : socket) + unit
  const lashReach = idle ? ew + 0.5 * unit : reach
  type Rig = Record<
    `--connect-creature-${"duration" | "phase" | "unit" | "ink" | "open" | "lower" | "lid" | "lid-low" | "origin-x" | "origin-y" | "row-stroke" | "gaze-x" | "gaze-y" | "iterations" | "lever" | "ring" | "eye-span" | "eye-socket"}`,
    string
  >
  const idleRig = {
    "--connect-creature-idle-tempo": String(signature.tempo),
    "--connect-creature-idle-amplitude": String(signature.amplitude),
    "--connect-creature-idle-phase": `${String(-Math.round(13000 * phase))}ms`,
    "--connect-creature-habit-phase": `${String(-Math.round(8000 * phase))}ms`,
    "--connect-creature-idle-travel": size === "stage" ? "1" : "0.5",
    "--connect-creature-squint-open": String((eh * 2 * 0.6 + socket) / (shutY - upperRest))
  }
  const rig: CSSProperties & Rig = {
    "--connect-creature-duration": `${String(pose.duration)}ms`,
    "--connect-creature-phase": `${String(pose.duration * character.phase)}ms`,
    "--connect-creature-unit": String(unit),
    "--connect-creature-ink": palette.p26,
    "--connect-creature-ring": palette.ring,
    "--connect-creature-open": String(closed ? 1 : (eh * 2 * pose.lid + socket) / (shutY - upperRest)),
    "--connect-creature-lower": String((pose.lower * 2 * eh) / (lowerRest - shutY)),
    "--connect-creature-lid": String(shutY - upperRest),
    "--connect-creature-eye-span": String(2 * eh),
    "--connect-creature-eye-socket": String(socket),
    "--connect-creature-lid-low": String(shutY - lowerRest),
    "--connect-creature-lever": String(FOOT - eyeY),
    "--connect-creature-origin-x": `${fixed(row ? 50 - frameLeft : 50)}px`,
    "--connect-creature-origin-y": `${fixed(row ? FOOT - frameTop : 88)}px`,
    "--connect-creature-row-stroke": String(homeRow ? unit : (frameEdge * rowStroke) / rowTrack),
    "--connect-creature-gaze-x": `${String(pose.look[0] * ew * 0.4)}px`,
    "--connect-creature-gaze-y": `${String(0.08 * eh * 2 + pose.look[1] * eh * 0.34)}px`,
    "--connect-creature-iterations": pose.loops ? "infinite" : "1"
  }
  const ref = `connect-creature-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const eyePath = (x: number): string => softBoxPath(x - ew, eyeY - eh, ew * 2, eh * 2, 2.4)
  const lid = (x: number, edge: number, above: boolean, flat = false): string => {
    const far = above ? edge - eh * 4 : edge + eh * 4
    if (idle) {
      const curve = flat ? 0 : 0.5 * unit
      return `M${fixed(x - reach)} ${fixed(far)}V${fixed(edge)}Q${fixed(x)} ${fixed(edge + curve)} ${fixed(x + reach)} ${fixed(edge)}V${fixed(far)}Z`
    }
    const curve = flat ? 0 : sag
    return `M${fixed(x - reach)} ${fixed(far)}V${fixed(edge - curve)}Q${fixed(x)} ${fixed(edge + curve)} ${fixed(x + reach)} ${fixed(edge - curve)}V${fixed(far)}Z`
  }
  const star = (x: number, y: number, radius: number): string =>
    `M${fixed(x)} ${fixed(y - radius)}Q${fixed(x + radius * 0.24)} ${fixed(y - radius * 0.24)} ${fixed(x + radius)} ${fixed(y)}Q${fixed(x + radius * 0.24)} ${fixed(y + radius * 0.24)} ${fixed(x)} ${fixed(y + radius)}Q${fixed(x - radius * 0.24)} ${fixed(y + radius * 0.24)} ${fixed(x - radius)} ${fixed(y)}Q${fixed(x - radius * 0.24)} ${fixed(y - radius * 0.24)} ${fixed(x)} ${fixed(y - radius)}Z`
  const browPath = (x: number, side: number, squint = false): string => {
    const brow = browStroke(squint ? "focus" : pose.brow)
    const y =
      eyeY - 4.6 * unit + brow.dy * unit - (pose.eyeScale - 1) * 2.5 * unit - (accessory === "glasses" ? 0.7 * unit : 0)
    const points = brow.points.map(([dx, dy]) => `${fixed(x + dx * unit * side)} ${fixed(y + dy * unit)}`)
    return `M${points[0] ?? ""}Q${points[1] ?? ""} ${points[2] ?? ""}`
  }
  const face = (frame: "base" | "squint" | "blink"): ReactElement => {
    const squint = frame === "squint"
    const blink = frame === "blink"
    return (
      <g
        className={
          squint
            ? "connect-creature-face connect-creature-idle-squint"
            : blink
              ? "connect-creature-face connect-creature-idle-blink"
              : "connect-creature-face"
        }
      >
        <g className="connect-creature-bob" clipPath={`url(#${ref}-skin)`}>
          {eyes.map((x, index) => (
            <g className="connect-creature-eye" key={x}>
              <ellipse
                className="connect-creature-blush"
                cx={x + (index === 0 ? -3.75 : 3.75) * unit}
                cy={eyeY + 3.4 * unit}
                rx={1.8 * unit}
                ry={unit}
                fill={palette.blush}
                fillOpacity="0.5"
              />
              <g className="connect-creature-open-eye" data-eyes={pose.eyes}>
                {blink ? null : (
                  <g clipPath={idle ? undefined : `url(#${ref}-${squint ? "squint" : "upper"}-${String(index)})`}>
                    <g clipPath={idle ? undefined : `url(#${ref}-lower-${String(index)})`}>
                      <path className="connect-creature-socket" d={eyePath(x)} />
                      <path className="connect-creature-white" d={eyePath(x)} fill={palette.sclera} />
                      <g clipPath={`url(#${ref}-eye-${String(index)})`}>
                        <g className="connect-creature-gaze">
                          <circle className="connect-creature-iris" cx={x} cy={eyeY} r={iris} fill={palette.p46} />
                          <circle
                            className="connect-creature-pupil"
                            cx={x}
                            cy={eyeY + iris * 0.06}
                            r={iris * 0.52}
                            fill={palette.p26}
                          />
                          {mood === "excited" ? (
                            <path
                              className="connect-creature-glint"
                              d={star(x - iris * 0.3, eyeY - iris * 0.36, iris * 0.66)}
                              fill="white"
                            />
                          ) : (
                            <circle
                              className="connect-creature-glint"
                              cx={x - iris * 0.36}
                              cy={eyeY - iris * 0.4}
                              r={iris * 0.36}
                              fill="white"
                            />
                          )}
                          <circle
                            className="connect-creature-glint"
                            data-small=""
                            cx={x + iris * 0.42}
                            cy={eyeY + iris * 0.38}
                            r={iris * 0.14}
                            fill="white"
                          />
                        </g>
                      </g>
                    </g>
                  </g>
                )}
                {closed || blink ? (
                  <path
                    className="connect-creature-lash"
                    data-shut=""
                    d={`M${fixed(x - ew)} ${fixed(eyeY)}Q${fixed(x)} ${fixed(eyeY + 1.3 * unit)} ${fixed(x + ew)} ${fixed(eyeY)}`}
                  />
                ) : (
                  <g clipPath={`url(#${ref}-${idle ? "eye" : "socket"}-${String(index)})`}>
                    <g className={squint ? "connect-creature-squint-lid" : "connect-creature-lid"}>
                      {idle ? (
                        <path
                          className="connect-creature-idle-lid-fill"
                          d={lid(x, upperRest, true, squint)}
                          fill={palette.p58}
                        />
                      ) : null}
                      <path
                        className="connect-creature-lash"
                        d={`M${fixed(x - lashReach)} ${fixed(upperRest + (idle ? 0.05 * unit : -sag))}Q${fixed(x)} ${fixed(upperRest + (idle ? (squint ? 0.05 : 0.55) * unit : sag))} ${fixed(x + lashReach)} ${fixed(upperRest + (idle ? 0.05 * unit : -sag))}`}
                      />
                    </g>
                  </g>
                )}
              </g>
              <path
                className="connect-creature-eye-mark"
                data-eyes={pose.eyes}
                d={
                  pose.eyes === "squeeze"
                    ? `M${fixed(x + (index === 0 ? -1 : 1) * (ew - 0.4 * unit))} ${fixed(eyeY - 1.5 * unit)}L${fixed(x + (index === 0 ? 1 : -1) * (ew - 0.4 * unit))} ${fixed(eyeY)}L${fixed(x + (index === 0 ? -1 : 1) * (ew - 0.4 * unit))} ${fixed(eyeY + 1.5 * unit)}`
                    : `M${fixed(x - ew + 0.2 * unit)} ${fixed(eyeY + 0.9 * unit)}Q${fixed(x)} ${fixed(eyeY - 2.1 * unit)} ${fixed(x + ew - 0.2 * unit)} ${fixed(eyeY + 0.9 * unit)}`
                }
              />
            </g>
          ))}
          {eyes.map((x, index) => (
            <path
              className="connect-creature-brow"
              data-side={index === 0 ? "l" : "r"}
              d={browPath(x, index === 0 ? -1 : 1, squint)}
              key={x}
            />
          ))}
          {expressive ? (
            <g
              className="connect-creature-mouth"
              data-filled={pose.mouth === "small" || pose.mouth === "open" ? "" : undefined}
              transform={`translate(50 ${String(eyeY + 4.8 * unit)}) scale(${String(unit)})`}
            >
              <path d={mouthPath(pose.mouth)} />
            </g>
          ) : null}
        </g>
      </g>
    )
  }
  // Full pose-frame overlays in pages15/17 carry their own translucent ground shadow.
  const shadow = (overlay?: "blink" | "squint"): ReactElement => (
    <ellipse
      className={
        overlay === undefined
          ? "connect-creature-shadow"
          : `connect-creature-shadow connect-creature-idle-${overlay}-shadow`
      }
      cx="50"
      cy={FOOT}
      fill={palette.p26}
      fillOpacity="0.16"
      rx={referenceWidth * 0.36}
      ry={unit}
    />
  )
  const drawing = (
    <g
      className="connect-creature-lean"
      key={idle ? `idle:${identity}` : `${mood}:${String(reactionKey)}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "connect-creature-done-face" && selected === "done" && reaction === undefined) {
          setCompletion({ identity, state, override, complete: true })
        }
      }}
    >
      <g className="connect-creature-squash">
        <g className="connect-creature-breath">
          <path className="connect-creature-body" d={character.body} fill={palette.p46} />
          <g clipPath={`url(#${ref}-skin)`}>
            <path
              className="connect-creature-lit"
              d={character.body}
              fill={palette.p58}
              transform={`translate(${-1.25 * unit} ${-1.5 * unit}) translate(${String(referenceLeft)} ${String(referenceTop)}) scale(.99) translate(${String(-referenceLeft)} ${String(-referenceTop)})`}
            />
            <rect
              className="connect-creature-highlight"
              x={-2.5 * unit}
              y={-0.8 * unit}
              width={5 * unit}
              height={1.6 * unit}
              rx={0.8 * unit}
              transform={`translate(${String(referenceLeft + seed.highlightX * unit)} ${String(referenceTop + referenceHeight * 0.47)}) rotate(${String(seed.highlightRotation)})`}
              fill={palette.p70}
            />
          </g>
        </g>
      </g>
      {idle ? (
        <g className="connect-creature-idle-base-face">
          <g className="connect-creature-idle-open-face">{face("base")}</g>
          {face("blink")}
        </g>
      ) : (
        face("base")
      )}
      {idle && signature.habit === "squint" ? face("squint") : null}
      {idle ? (
        <g className="connect-creature-idle-forced-face" fill="none" stroke="CanvasText" strokeLinecap="round">
          {eyes.map((x, index) => (
            <g key={x}>
              <ellipse cx={x} cy={eyeY} rx={2.1 * unit} ry={2.5 * unit} fill="Canvas" strokeWidth={0.8 * unit} />
              <circle cx={x} cy={eyeY + 0.3 * unit} r={1.2 * unit} fill="CanvasText" stroke="none" />
              <path d={browPath(x, index === 0 ? -1 : 1)} strokeWidth={1.1 * unit} />
            </g>
          ))}
        </g>
      ) : null}
      <CreatureAdornment
        accessory={accessory}
        bodyKind={character.bodyKind}
        unit={unit}
        top={top}
        foot={FOOT}
        eyeY={eyeY}
        eyeWidth={ew}
        eyeHeight={eh}
        eyeGap={character.eyeGap}
        skin={`${ref}-skin`}
      />
    </g>
  )
  return (
    <svg
      aria-hidden="true"
      className="connect-creature"
      data-creature=""
      data-idle-motion={idle ? "" : undefined}
      data-idle-habit={idle ? signature.habit : undefined}
      data-idle-phase={idle ? String(phase) : undefined}
      ref={root}
      data-arrived={arrived ? "" : undefined}
      data-bucket={presentation.bucket}
      data-size={size}
      data-row-presentation={homeRow ? "home" : undefined}
      data-stale={stale ? "" : undefined}
      data-closed={closed ? "" : undefined}
      data-tone={presentation.tone}
      data-mood={idle ? "idle" : mood}
      data-lidded={pose.lid > 0 ? "" : undefined}
      data-talking={expressive ? "" : undefined}
      data-loop={pose.loops ? "" : undefined}
      focusable="false"
      height={pixels[size]}
      width={pixels[size]}
      style={idle ? { ...rig, ...idleRig } : rig}
      viewBox={viewBox}
    >
      <defs>
        <clipPath id={`${ref}-skin`}>
          <path d={character.body} />
        </clipPath>
        {eyes.map((x, index) => (
          <g key={x}>
            <clipPath id={`${ref}-eye-${String(index)}`}>
              <path d={eyePath(x)} />
            </clipPath>
            <clipPath id={`${ref}-socket-${String(index)}`}>
              <path d={eyePath(x)} />
            </clipPath>
            <clipPath id={`${ref}-upper-${String(index)}`}>
              <path className="connect-creature-lid" d={lid(x, upperRest, false)} />
            </clipPath>
            {idle && signature.habit === "squint" ? (
              <clipPath id={`${ref}-squint-${String(index)}`}>
                <path className="connect-creature-squint-lid" d={lid(x, upperRest, false, true)} />
              </clipPath>
            ) : null}
            <clipPath id={`${ref}-lower-${String(index)}`}>
              <path className="connect-creature-lid" data-low="" d={lid(x, lowerRest, true)} />
            </clipPath>
          </g>
        ))}
      </defs>
      {idle ? null : shadow()}
      <ellipse className="connect-creature-halo" cx="50" cy={ring.cy} rx={ring.rx} ry={ring.ry} />
      <ellipse className="connect-creature-orbit" cx="50" cy={ring.cy} pathLength="100" rx={ring.rx} ry={ring.ry} />
      {idle ? (
        <g className="connect-creature-idle-habit">
          <g className="connect-creature-idle-fidget">
            <g className="connect-creature-idle-breath">
              {shadow()}
              {shadow("blink")}
              {signature.habit === "squint" ? shadow("squint") : null}
              {drawing}
            </g>
          </g>
        </g>
      ) : (
        drawing
      )}
      {!shut && mood === "stuck" ? (
        <>
          <g
            className="connect-creature-sweat"
            transform={`translate(${String(referenceLeft + referenceWidth * 0.8)} ${String(top + height * 0.4)}) scale(${String(unit)})`}
          >
            <path
              d={`M0 ${fixed(-2.2 * dropRadius)}Q${fixed(dropRadius)} ${fixed(-0.6 * dropRadius)} ${fixed(dropRadius)} 0A${fixed(dropRadius)} ${fixed(dropRadius)} 0 0 1 ${fixed(-dropRadius)} 0Q${fixed(-dropRadius)} ${fixed(-0.6 * dropRadius)} 0 ${fixed(-2.2 * dropRadius)}Z`}
              fill="white"
              fillOpacity="1"
              stroke={palette.p26}
              strokeOpacity=".5"
              strokeWidth=".3"
            />
            {row ? null : <circle cx="-.3675" cy="-.315" r=".2625" fill={palette.p70} fillOpacity=".6" />}
          </g>
          <g
            className="connect-creature-question"
            transform={`translate(${String(50 + 8.5 * unit)} ${String(overlayTop - 0.5 * unit)}) scale(${String(unit)})`}
          >
            <path d="M-1.4 -1.3Q-1.4 -2.9 0 -2.9Q1.5 -2.9 1.5 -1.45Q1.5 -.5 .45 0Q0 .25 0 1" />
            <circle cy="2.5" r=".55" />
          </g>
        </>
      ) : null}
      {!shut && !ordinary && mood === "sleepy" ? (
        <path
          className="connect-creature-z"
          d={`M${fixed(50 + 9 * unit)} ${fixed(overlayTop + 1.5 * unit)}h${fixed(2 * unit)}l${fixed(-2 * unit)} ${fixed(2 * unit)}h${fixed(2 * unit)}`}
        />
      ) : null}
      {!shut && mood === "thinking" ? (
        <g className="connect-creature-dots">
          {[0, 1, 2].map((index) => (
            <circle
              key={index}
              cx={50 + ([8.5, 11.75, 15.25][index] ?? 8.5) * unit}
              cy={overlayTop + ([0.25, -2.75, -6.25][index] ?? 0.25) * unit}
              r={(0.9 + index * 0.3) * unit}
              fill={palette.p58}
            />
          ))}
        </g>
      ) : null}
      {!shut && mood === "done" ? (
        <g className="connect-creature-celebration">
          <ellipse
            cx="50"
            cy={row ? rowCy : 55}
            rx={row ? baseRx : 44}
            ry={row ? baseRy : 44}
            fill="none"
            stroke={palette.p70}
            strokeWidth={0.6 * unit}
            opacity=".35"
          />
          <path d={star(50 + 10 * unit, overlayTop + 0.75 * unit, 1.6 * unit)} fill={palette.p70} />
        </g>
      ) : null}
      {!shut && mood === "poke" ? (
        <g
          className="connect-creature-tap"
          key={`tap:${mood}:${String(reactionKey)}`}
          transform={`translate(${String(referenceLeft - 1.75 * unit)} ${String(top + height * 0.55)}) scale(${String(unit)})`}
        >
          <circle r="1.6" fill="none" stroke={palette.p70} strokeWidth=".55" />
          <circle r=".75" fill={palette.p70} />
          <path
            d="M-3.6 0H-2.6M-2.6 -2.6L-1.9 -1.9M-2.6 2.6L-1.9 1.9"
            fill="none"
            stroke={palette.p70}
            strokeWidth=".55"
            strokeLinecap="round"
          />
        </g>
      ) : null}
      {!shut && mood === "poke" ? (
        <g className="connect-creature-ticks" key={`ticks:${mood}:${String(reactionKey)}`}>
          <path
            d={`M${fixed(left + width + unit)} ${fixed(top + 3.5 * unit)}l${fixed(1.5 * unit)} ${fixed(-unit)}M${fixed(left + width + unit)} ${fixed(top + 6.75 * unit)}h${fixed(1.8 * unit)}M${fixed(left - unit)} ${fixed(top + 3.5 * unit)}l${fixed(-1.5 * unit)} ${fixed(-unit)}`}
          />
        </g>
      ) : null}
    </svg>
  )
}
