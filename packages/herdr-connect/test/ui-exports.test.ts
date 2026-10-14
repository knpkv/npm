import {
  AgentCast,
  AgentStage,
  ConnectLimits,
  Creature,
  type CreatureProps,
  PinnedAgents,
  UsageTab,
  type UsageTabProps
} from "@knpkv/herdr-connect"
import * as Connect from "@knpkv/herdr-connect"
import type {
  CreatureAccessory,
  CreatureHueFamily,
  CreatureMood,
  CreatureProps as SurfaceCreatureProps,
  CreatureReaction
} from "@knpkv/herdr-connect/surface"
import type { ComponentProps } from "react"
import { expect, expectTypeOf, it } from "vitest"

it("exports the app UI and its named props without exposing polling or terminal internals", () => {
  for (const component of [Creature, AgentCast, AgentStage, PinnedAgents, ConnectLimits, UsageTab]) {
    expect(component).toBeTypeOf("function")
  }
  expectTypeOf<CreatureProps>().toEqualTypeOf<ComponentProps<typeof Creature>>()
  expectTypeOf<UsageTabProps>().toEqualTypeOf<ComponentProps<typeof UsageTab>>()
  expect(Connect).not.toHaveProperty("WorkPollMount")
  expect(Connect).not.toHaveProperty("TerminalTextLayer")
})

/** Browser consumers can name each appearance prop without importing the server root. */
it("exports named creature appearance types from the browser surface", () => {
  expectTypeOf<SurfaceCreatureProps>().toEqualTypeOf<CreatureProps>()
  expectTypeOf<CreatureAccessory>().toEqualTypeOf<NonNullable<CreatureProps["accessory"]>>()
  expectTypeOf<CreatureHueFamily>().toEqualTypeOf<NonNullable<CreatureProps["hueFamily"]>>()
  expectTypeOf<CreatureMood>().toEqualTypeOf<NonNullable<CreatureProps["mood"]>>()
  expectTypeOf<CreatureReaction>().toEqualTypeOf<NonNullable<CreatureProps["reaction"]>>()
})
