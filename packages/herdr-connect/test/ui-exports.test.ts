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
