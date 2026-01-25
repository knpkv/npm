import type { Meta, StoryObj } from "@storybook/react"
import { useEffect } from "react"
import { MainList } from "./MainList"
import { mockPRList, mockAccount } from "../mocks"
import { type AppState } from "../atoms/app"

const meta: Meta<typeof MainList> = {
  component: MainList,
  title: "Views/MainList"
}

export default meta
type Story = StoryObj<typeof MainList>

const StateDecorator = (Story: any, context: any) => {
  const { appState } = context.args

  useEffect(() => {
    if (appState) {
      import("../atoms/runtime").then((mod: any) => {
        if (mod.setMockState) {
          mod.setMockState(appState)
        }
      })
    }
  }, [appState])

  return (<Story />) as any
}

export const Default: Story = {
  decorators: [StateDecorator],
  args: {
    // @ts-ignore
    appState: {
      status: "idle",
      pullRequests: mockPRList,
      accounts: [{ ...mockAccount, enabled: true }]
    } as AppState,
    onSelectPR: () => console.log("Selected PR")
  }
}

export const Empty: Story = {
  decorators: [StateDecorator],
  args: {
    // @ts-ignore
    appState: {
      status: "idle",
      pullRequests: [],
      accounts: [{ ...mockAccount, enabled: true }]
    } as AppState,
    onSelectPR: () => console.log("Selected PR")
  }
}
