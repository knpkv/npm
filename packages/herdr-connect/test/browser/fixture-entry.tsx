// The hub's stylesheet stack, in its order, and Connect's surface from source, mounted the way client-entry does.
import "@knpkv/rly/styles.css"
import "../../src/styles.css"
import "@knpkv/herdr-work/styles.css"
// The hub's own sheet styles Connect's header nav, so the fixture shows the header that ships.
import "../../../herdr-hub/src/styles.css"
import { RegistryProvider } from "@effect/atom-react"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ConnectSurface, makeConnectAtoms } from "../../src/client.js"
import { Creature, type CreatureHueFamily } from "../../src/creature.js"
import { mountLegacyFleetColumn } from "./legacy-fleet-fixture.js"

// `?embedded` protects the exported legacy FleetShell + embedded Connect composition.
// Canonical Home is covered by the hub module-shell fixture.
// `?brows` renders the 64-seed grid here, outside Playwright's component transform.
const root = document.querySelector<HTMLElement>("#fleet-connect-root")
const parameters = new URLSearchParams(location.search)

type DrawingMood =
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

type DrawingAccessory = "none" | "headphones" | "hard-hat" | "scarf" | "glasses"

interface DrawingOptions {
  closed: boolean
  stale: boolean
  talking: boolean
  accessory?: DrawingAccessory
  hueFamily?: CreatureHueFamily
  mood?: DrawingMood
  reaction?: "poke" | "listening"
  reactionKey?: number
}

/** Isolated drawing cases still use the production component and stylesheet. */
const DrawingFixture = () => {
  const [reactionKey, setReactionKey] = useState(0)
  const [state, setState] = useState(parameters.get("state") ?? "working")
  const moods: ReadonlyArray<DrawingMood> = [
    "happy",
    "focused",
    "worried",
    "sleepy",
    "excited",
    "waiting",
    "speaking",
    "thinking",
    "listening",
    "poke",
    "stuck",
    "done"
  ]
  const mood = moods.find((value) => value === parameters.get("mood"))
  const reactions: ReadonlyArray<"poke" | "listening"> = ["poke", "listening"]
  const reaction = reactions.find((value) => value === parameters.get("reaction"))
  const accessories: ReadonlyArray<DrawingAccessory> = ["none", "headphones", "hard-hat", "scarf", "glasses"]
  const accessory = accessories.find((value) => value === parameters.get("accessory"))
  const options: DrawingOptions = {
    closed: parameters.has("closed"),
    stale: parameters.has("stale"),
    talking: parameters.has("talking")
  }
  if (accessory !== undefined) options.accessory = accessory
  if (mood !== undefined) options.mood = mood
  if (reaction !== undefined) {
    options.reaction = reaction
    options.reactionKey = reactionKey
  }
  const families: ReadonlyArray<CreatureHueFamily> = ["rose", "ember", "amber", "lime", "moss", "teal", "sky", "iris"]
  const family = families.find((value) => value === parameters.get("family"))
  if (family !== undefined) options.hueFamily = family
  const size = parameters.get("size") === "row" ? "row" : parameters.get("size") === "cast" ? "cast" : "stage"
  const count = parameters.get("drawing") === "grid" ? 64 : 1
  return (
    <div data-drawing-fixture="">
      <button onClick={() => setReactionKey((key) => key + 1)} type="button">
        Replay reaction
      </button>
      <button onClick={() => setState("done")} type="button">
        Finish agent
      </button>
      {Array.from({ length: count }, (_, index) => (
        <div data-drawing-case={index} key={index}>
          <Creature
            {...{
              ...options,
              host: "fixture-host",
              id: parameters.get("id") ?? `drawing-${String(index)}`,
              size,
              state
            }}
          />
        </div>
      ))}
    </div>
  )
}

if (root !== null) {
  if (parameters.has("embedded")) mountLegacyFleetColumn(root)
  createRoot(root).render(
    <RegistryProvider>
      {parameters.has("drawing") ? (
        <DrawingFixture />
      ) : parameters.has("brows") ? (
        <div data-brow-grid="">
          {Array.from({ length: 64 }, (_, index) => (
            <Creature
              host={["nix", "mbp", "studio", "w24"][index % 4] ?? "nix"}
              id={String(index * 7 + 3)}
              key={index}
              size={parameters.get("size") === "row" ? "row" : parameters.get("size") === "cast" ? "cast" : "stage"}
              stale={parameters.has("stale")}
              state={parameters.get("state") ?? "working"}
            />
          ))}
        </div>
      ) : (
        <ConnectSurface atoms={makeConnectAtoms()} embedded={parameters.has("embedded")} />
      )}
    </RegistryProvider>
  )
}
