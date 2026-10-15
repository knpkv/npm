/** Visible sibling order owns de-synchronisation; identity, hue and the stored signature remain unchanged. */
import type { AgentTaskKind } from "@knpkv/herdr-fleet/model"
import { createContext, type ReactElement, type ReactNode, useContext } from "react"
import { creaturePalette, creatureSignature, guardCreatureNeighbours, type CreatureHueFamily } from "./character.js"

interface Neighbour {
  readonly host: string
  readonly id: string
  readonly name: string
  readonly hue?: CreatureHueFamily | undefined
  readonly taskKind?: AgentTaskKind | undefined
}

const phases = createContext<ReadonlyMap<string, number>>(new Map())
const key = (host: string, id: string): string => `${host.toLowerCase()}\u0000${id}`

/** Pass only siblings that are actually rendered, in their rendered order. */
export const CreatureNeighbours = ({
  agents,
  children
}: {
  readonly agents: ReadonlyArray<Neighbour>
  readonly children: ReactNode
}): ReactElement => {
  const signatures = guardCreatureNeighbours(
    agents.map((agent) => ({
      task: agent.taskKind ?? "unknown",
      signature: creatureSignature(agent.host, agent.id, creaturePalette(agent.host, agent.name, agent.hue).family)
    }))
  )
  const values = new Map(
    agents.flatMap((agent, index) => {
      const signature = signatures[index]
      return signature === undefined ? [] : [[key(agent.host, agent.id), signature.phase] satisfies [string, number]]
    })
  )
  return <phases.Provider value={values}>{children}</phases.Provider>
}

export const useCreatureNeighbourPhase = (host: string, id: string, fallback: number): number =>
  useContext(phases).get(key(host, id)) ?? fallback
