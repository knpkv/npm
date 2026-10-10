import {
  ActivityHistory,
  AgentActivity,
  ApprovalsCountdown,
  DashboardView,
  type DashboardViewProps,
  HubRelay,
  NotificationPanel,
  RefreshStatus
} from "@knpkv/herdr-hub"
import * as Hub from "@knpkv/herdr-hub"
import type { ComponentProps } from "react"
import { expect, expectTypeOf, it } from "vitest"

it("exports the app UI and its named props without exposing runtime owners", () => {
  for (
    const component of [
      DashboardView,
      AgentActivity,
      ActivityHistory,
      NotificationPanel,
      ApprovalsCountdown,
      RefreshStatus,
      HubRelay
    ]
  ) {
    expect(component).toBeTypeOf("function")
  }
  expectTypeOf<DashboardViewProps>().toEqualTypeOf<ComponentProps<typeof DashboardView>>()
  expect(Hub).not.toHaveProperty("DashboardWorkPollOwner")
  expect(Hub).not.toHaveProperty("HostConversationLocator")
})
