/** Pages13–16 supply motion and poses; the shipped character still owns identity, paint and framing. */
import type { AgentTaskKind } from "@knpkv/herdr-fleet/model"
import type { CreatureHueFamily } from "./character.js"
import type { CreaturePose } from "./creature-state.js"

export interface TaskPose extends CreaturePose {
  readonly flat?: boolean
  readonly ticks?: 0 | 1 | 2
  readonly halo?: readonly [number, number]
  readonly glint?: number
}
export interface TaskFrame {
  readonly pose: TaskPose
  readonly period: number
  readonly steps: 4 | 8 | 12 | 16 | 24
  readonly step: number
  readonly once?: number
  readonly after?: number
}
export type TaskMotionKind = Exclude<AgentTaskKind, "idle">

export interface TaskMotion {
  readonly kind: AgentTaskKind
  readonly base: TaskPose
  readonly settled: TaskPose
  readonly frames: ReadonlyArray<TaskFrame>
  readonly clock: string | undefined
  readonly period: number
  readonly restTransform?: string | undefined
  readonly oneShot?: number
}
const focused: TaskPose = {
  brow: "focus",
  lid: 0.3,
  lower: 0,
  eyeScale: 1,
  look: [0, 0.5],
  eyes: "open",
  mouth: "line",
  duration: 3600,
  loops: true,
  flat: true
}

/** Row reading drops the lean and keeps four gaze holds; stage keeps twelve, plus the shared slow blink. */
export const creatureTaskMotion = (kind: TaskMotionKind, stage: boolean): TaskMotion => {
  const window = (
    base: TaskPose,
    period: number,
    steps: TaskFrame["steps"],
    poses: ReadonlyArray<readonly [number, Partial<TaskPose>]>
  ): ReadonlyArray<TaskFrame> => poses.map(([step, pose]) => ({ pose: { ...base, ...pose }, period, steps, step }))
  if (kind === "writing") {
    const base = { ...focused, lid: 0.38, look: [0, 0.8], duration: 2400 } satisfies TaskPose
    return {
      kind,
      base,
      // Pages 13/14/15 settle rows on the stage rest (rowSp), tick included; only the row loop drops ticks.
      settled: { ...base, ticks: 1 },
      clock: "bob",
      period: 400,
      frames: stage
        ? window(base, 2400, 12, [[0, { ticks: 1 }], [2, { ticks: 2 }], [4, { ticks: 1 }], [6, { ticks: 2 }], [8, {
          ticks: 1
        }], [10, { look: [-0.4, 0.8] }]])
        : []
    }
  }
  if (kind === "testing") {
    const base = { ...focused, look: [0, 0.2], duration: 2400 } satisfies TaskPose
    return {
      kind,
      base,
      settled: base,
      clock: stage ? "test" : "test-row",
      period: 2400,
      restTransform: "scale(1.04, 0.95)",
      frames: window(base, 2400, 12, [[10, { brow: "up", lid: 0, flat: false, look: [0, 0] }]])
    }
  }
  if (kind === "waiting") {
    const base = { ...focused, brow: "rest", flat: false, lid: 0.45, look: [0, 0.1], duration: 4800 } satisfies TaskPose
    return {
      kind,
      base,
      settled: base,
      clock: stage ? "sway" : undefined,
      period: 4800,
      frames: window(base, 9600, 16, [[5, { look: [0.3, -0.9] }], [13, { look: [-0.9, 0.1] }]])
    }
  }
  if (kind === "blocked") {
    const base = {
      ...focused,
      brow: "up",
      flat: false,
      lid: 0,
      eyeScale: 1.04,
      look: [0, 0],
      duration: 4000
    } satisfies TaskPose
    return {
      kind,
      base,
      settled: base,
      clock: stage ? "nudge" : "nudge-row",
      period: 4000,
      frames: window(base, 4000, 16, [[15, { lid: 1 }]])
    }
  }
  if (kind === "failing") {
    const base = {
      ...focused,
      brow: "worried",
      flat: false,
      lid: 0.45,
      look: [0, 0.75],
      loops: false,
      duration: 560
    } satisfies TaskPose
    const frames: ReadonlyArray<TaskFrame> = [
      { pose: { ...base, eyes: "squeeze" }, period: 560, steps: 4, step: 0, once: 200 },
      ...(stage
        ? [
          {
            pose: { ...base, eyeScale: 1.06, lid: 0.25, look: [0, 0.3] },
            period: 560,
            steps: 4,
            step: 200,
            once: 200
          } satisfies TaskFrame
        ]
        : [])
    ]
    return {
      kind,
      base,
      settled: base,
      clock: "wince",
      period: 560,
      oneShot: 560,
      restTransform:
        "translateY(calc(3px * var(--connect-creature-pixel, 1) * var(--connect-task-travel))) rotate(calc(-3deg * var(--connect-task-amplitude))) scale(1.03, 0.95)",
      frames
    }
  }
  if (kind === "done") {
    const base = {
      ...focused,
      brow: "up",
      flat: false,
      lid: 0,
      lower: 0.3,
      look: [0, 0],
      duration: 900
    } satisfies TaskPose
    const happy = { ...base, eyes: "arc", lower: 0 } satisfies TaskPose
    return {
      kind,
      base,
      settled: base,
      clock: stage ? "done" : "done-row",
      period: 900,
      oneShot: 900,
      frames: [
        ...(stage ?
          [
            { pose: happy, period: 900, steps: 4, step: 0, once: 200 },
            { pose: { ...happy, halo: [0, 0.55], glint: 1.6 }, period: 900, steps: 4, step: 200, once: 280 },
            { pose: { ...happy, halo: [0.75, 0.22], glint: 0.9 }, period: 900, steps: 4, step: 480, once: 420 }
          ] satisfies ReadonlyArray<TaskFrame> :
          [{ pose: happy, period: 900, steps: 4, step: 0, once: 480 } satisfies TaskFrame]),
        ...window(base, 4800, 8, [[4, { eyes: "arc", lower: 0 }]]).map((frame) => ({ ...frame, after: 900 }))
      ]
    }
  }
  if (kind === "unknown") {
    const base = { ...focused, brow: "rest", flat: false, lid: 0, look: [0, 0], duration: 4800 } satisfies TaskPose
    return {
      kind,
      base,
      settled: base,
      clock: stage ? "quiet" : undefined,
      period: 4800,
      frames: window(base, 4800, 24, [
        [8, { lid: 1 }],
        ...(stage
          ? [[12, { look: [-0.5, 0] }], [13, { look: [-0.5, 0] }], [17, { look: [0.5, 0] }], [18, {
            look: [0.5, 0]
          }]] satisfies ReadonlyArray<readonly [number, Partial<TaskPose>]>
          : [])
      ])
    }
  }
  const base = focused
  const scan: ReadonlyArray<readonly [number, Partial<TaskPose>]> = stage
    ? [
      [0, { look: [-0.9, 0.5] }],
      [1, { look: [-0.6, 0.5] }],
      [2, { look: [-0.3, 0.5] }],
      [4, { look: [0.3, 0.5] }],
      [5, { look: [0.6, 0.5] }],
      [6, { look: [0.9, 0.5] }],
      [7, { look: [0.9, 0.5] }],
      [8, { look: [0.9, 0.5] }],
      [9, { lid: 0.55 }],
      [10, { look: [-0.9, 0.5] }],
      [11, { look: [-0.9, 0.5] }]
    ]
    : [[0, { look: [-0.9, 0.5] }], [2, { look: [0.9, 0.5] }], [3, { look: [0.9, 0.5], lid: 0.55 }]]
  return {
    kind,
    base,
    settled: { ...base, look: [0.6, 0.5] },
    period: 3600,
    clock: stage ? "lean" : undefined,
    // Pages 13/14 hand rows the stage rm, so a still row leans too.
    restTransform: "rotate(-3deg) translateY(calc(1px * var(--connect-creature-pixel, 1)))",
    frames: [
      ...scan.map((
        [step, pose]
      ) => ({ pose: { ...base, ...pose }, period: 3600, steps: stage ? 12 : 4, step } satisfies TaskFrame)),
      ...([[21, { look: [-0.9, 0.5], lid: 0.65 }], [22, { lid: 1 }], [23, {
        look: [-0.9, 0.5],
        lid: 0.65
      }]] satisfies ReadonlyArray<readonly [number, Partial<TaskPose>]>).map<TaskFrame>(
        ([step, pose]) => ({ pose: { ...base, ...pose }, period: 7200, steps: 24, step })
      )
    ]
  }
}

export interface TaskEntry {
  readonly kind: AgentTaskKind
  readonly epoch: number
  readonly entered: boolean
}
export interface TaskPlayback {
  readonly current: TaskEntry
  readonly outgoing: TaskEntry | null
  readonly transition: "blend" | "hop" | "failing" | "done" | null
  readonly queued: AgentTaskKind | null
}

/** A mount is current evidence, not a newly observed completion/failure. */
export const startTaskPlayback = (kind: AgentTaskKind, epoch = 0): TaskPlayback => ({
  current: { kind, epoch, entered: false },
  outgoing: null,
  transition: null,
  queued: null
})

/** Page16: one-shots finish; intermediate observations collapse to the newest kind. No same-kind replay. */
export const updateTaskPlayback = (playback: TaskPlayback, kind: AgentTaskKind, still: boolean): TaskPlayback => {
  if (still) {
    if (playback.current.kind === kind && playback.transition === null) return playback
    return {
      current: { kind, epoch: playback.current.epoch + 1, entered: false },
      outgoing: null,
      transition: null,
      queued: null
    }
  }
  if (playback.transition !== null) {
    const queued = kind === playback.current.kind ? null : kind
    return playback.queued === queued ? playback : { ...playback, queued }
  }
  if (playback.current.kind === kind) return playback
  const transition = kind === "failing" || kind === "done" ?
    kind
    : playback.current.kind === "blocked" && (kind === "reading" || kind === "writing" || kind === "testing")
    ? "hop"
    : "blend"
  return {
    current: { kind, epoch: playback.current.epoch + 1, entered: true },
    outgoing: playback.current,
    transition,
    queued: null
  }
}

/** Epoch ownership makes late animation-end events harmless after identity or preference changes. */
export const finishTaskPlayback = (playback: TaskPlayback, epoch: number): TaskPlayback => {
  if (playback.current.epoch !== epoch || playback.transition === null) return playback
  const settled = {
    ...playback,
    current: { ...playback.current, entered: false },
    outgoing: null,
    transition: null,
    queued: null
  }
  return playback.queued === null ? settled : updateTaskPlayback(settled, playback.queued, false)
}

/** Page13 draw() uses p54 for typing ticks. These are its exported eight family tones, not body highlights. */
export const taskTickInk = {
  rose: "#bb3f5c",
  ember: "#b54e0b",
  amber: "#966700",
  lime: "#687c02",
  moss: "#1e874b",
  teal: "#00837e",
  sky: "#0d7aab",
  iris: "#5f64c7"
} satisfies Record<CreatureHueFamily, string>
