/** State poses use the reference's 32-unit coordinates; Creature scales them to its seeded body. */
import { type AgentBucket, agentStatePresentation } from "./agent-state-core.js"

export type CreatureMood =
  | "happy"
  | "focused"
  | "worried"
  | "sleepy"
  | "excited"
  | "waiting"
  | "speaking"
  | "thinking"
  | "listening"
  | "poke"
  | "stuck"
  | "done"
export type CreatureAccessory = "none" | "headphones" | "hard-hat" | "scarf" | "glasses"
export type CreatureReaction = "listening" | "poke"
type Brow = "rest" | "up" | "high" | "focus" | "worried" | "sleepy" | "think"
type Mouth = "smile" | "closed" | "line" | "hmm" | "wavy" | "small" | "open"

export interface CreaturePose {
  readonly brow: Brow
  readonly lid: number
  readonly lower: number
  readonly eyeScale: number
  readonly look: readonly [number, number]
  readonly eyes: "open" | "arc" | "squeeze"
  readonly mouth: Mouth
  readonly duration: number
  readonly loops: boolean
}

const poses = {
  happy: {
    brow: "up",
    lid: 0,
    lower: 0.32,
    eyeScale: 1,
    look: [0, 0],
    eyes: "open",
    mouth: "smile",
    duration: 1600,
    loops: true
  },
  focused: {
    brow: "focus",
    lid: 0.38,
    lower: 0,
    eyeScale: 1,
    look: [-0.2, 0.8],
    eyes: "open",
    mouth: "line",
    duration: 2400,
    loops: true
  },
  worried: {
    brow: "worried",
    lid: 0,
    lower: 0,
    eyeScale: 1.12,
    look: [0, 0],
    eyes: "open",
    mouth: "wavy",
    duration: 960,
    loops: false
  },
  sleepy: {
    brow: "sleepy",
    lid: 0.7,
    lower: 0,
    eyeScale: 1,
    look: [0, 0],
    eyes: "open",
    mouth: "closed",
    duration: 4800,
    loops: true
  },
  excited: {
    brow: "high",
    lid: 0,
    lower: 0,
    eyeScale: 1.12,
    look: [0, 0],
    eyes: "open",
    mouth: "open",
    duration: 640,
    loops: false
  },
  waiting: {
    brow: "rest",
    lid: 0,
    lower: 0,
    eyeScale: 1,
    look: [0, 0],
    eyes: "open",
    mouth: "closed",
    duration: 4800,
    loops: true
  },
  speaking: {
    brow: "rest",
    lid: 0,
    lower: 0,
    eyeScale: 1,
    look: [0, 0],
    eyes: "open",
    mouth: "small",
    duration: 420,
    loops: true
  },
  thinking: {
    brow: "think",
    lid: 0,
    lower: 0,
    eyeScale: 1,
    look: [0.75, -0.95],
    eyes: "open",
    mouth: "hmm",
    duration: 1500,
    loops: true
  },
  listening: {
    brow: "up",
    lid: 0,
    lower: 0,
    eyeScale: 1,
    look: [0, 0],
    eyes: "open",
    mouth: "smile",
    duration: 720,
    loops: false
  },
  poke: {
    brow: "high",
    lid: 0,
    lower: 0,
    eyeScale: 1,
    look: [0, 0],
    eyes: "squeeze",
    mouth: "open",
    duration: 620,
    loops: false
  },
  stuck: {
    brow: "worried",
    lid: 0,
    lower: 0,
    eyeScale: 1.1,
    look: [-0.9, 0.35],
    eyes: "open",
    mouth: "wavy",
    duration: 1000,
    loops: false
  },
  done: {
    brow: "up",
    lid: 0,
    lower: 0,
    eyeScale: 1,
    look: [0, 0],
    eyes: "arc",
    mouth: "smile",
    duration: 900,
    loops: false
  }
} satisfies Record<CreatureMood, CreaturePose>

/** Ordinary blocked/error agents look worried; talking stages retain the richer stuck reaction. */
export const creatureMood = (state: string, talking = false): CreatureMood => {
  const presentation = agentStatePresentation(state)
  if (presentation.word === "Idle") return "sleepy"
  if (presentation.tone === "critical") return talking ? "stuck" : "worried"
  const defaults = { working: "focused", finished: "done", ready: "happy", "needs-you": "waiting" } satisfies Record<
    AgentBucket,
    CreatureMood
  >
  return defaults[presentation.bucket]
}

/** Closed lids meet fully; stale lids rest halfway. Both retain identity and stop motion. */
export const creaturePose = (mood: CreatureMood, closed = false, stale = false): CreaturePose =>
  closed || stale ? { ...poses.sleepy, lid: closed ? 1 : 0.5, duration: 0, loops: false } : poses[mood]

/** Connect rev6 ordinary faces stay still; explicit talking moods keep their state-sheet poses. */
export const creatureAgentPose = (state: string): CreaturePose => {
  const mood = creatureMood(state)
  const rest = { ...poses.waiting, loops: false }
  if (mood === "waiting") return { ...rest, brow: "up", eyeScale: 1.08 }
  if (mood === "done") return { ...rest, brow: "up", eyes: "arc" }
  if (mood === "focused") return { ...poses.focused, lid: 0.36, look: [0, 0.6], loops: false }
  if (mood === "worried") return { ...poses.worried, eyeScale: 1.1, loops: false }
  return rest
}

export interface BrowStroke {
  readonly points: readonly [readonly [number, number], readonly [number, number], readonly [number, number]]
  readonly dy: number
}

export const browStroke = (brow: Brow): BrowStroke => {
  switch (brow) {
    case "rest":
      return { points: [[1.9, 0.35], [0.2, -1], [-1.7, 0.45]], dy: 0 }
    case "up":
      return { points: [[1.9, 0.35], [0.2, -1.1], [-1.7, 0.45]], dy: -0.8 }
    case "high":
      return { points: [[1.9, 0.1], [0.1, -1.7], [-1.7, 0.2]], dy: -1.5 }
    case "focus":
      return { points: [[1.6, 0.05], [-0.3, -0.35], [-2.1, 0.45]], dy: 0.55 }
    case "worried":
      return { points: [[1.8, 0.85], [0, -0.45], [-1.6, -1.15]], dy: -0.5 }
    case "sleepy":
      return { points: [[1.9, 0.15], [0.2, -0.45], [-1.7, 0.35]], dy: 0.45 }
    case "think":
      return { points: [[1.7, 0.35], [-0.1, -0.8], [-2, 0.6]], dy: 0.15 }
  }
}

export const mouthPath = (mouth: Mouth): string => {
  switch (mouth) {
    case "smile":
      return "M-1.6 -0.4Q0 1.3 1.6 -0.4"
    case "closed":
      return "M-1 -0.1Q0 0.5 1 -0.1"
    case "line":
      return "M-1.05 0.1H1.05"
    case "hmm":
      return "M-0.5 0.35Q0.5 -0.05 1.5 0.05"
    case "wavy":
      return "M-1.8 0.15Q-1.2 -0.55 -0.6 0.05Q0 0.65 0.6 0.05Q1.2 -0.55 1.8 0.15"
    case "small":
      return "M-0.9 0.2a0.9 0.65 0 1 0 1.8 0a0.9 0.65 0 1 0 -1.8 0Z"
    case "open":
      return "M-2 -0.6Q0 -0.2 2 -0.6Q1.8 2.4 0 2.4Q-1.8 2.4 -2 -0.6Z"
  }
}
