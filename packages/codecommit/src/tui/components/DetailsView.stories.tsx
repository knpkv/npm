import type { Meta, StoryObj } from "@storybook/react"
import { useEffect } from "react"
import { DetailsView } from "./DetailsView"
import { mockPR } from "../mocks"
import { selectedPrIdAtom } from "../atoms/ui"
import { useAtomSet } from "@effect-atom/atom-react"

const meta: Meta<typeof DetailsView> = {
  component: DetailsView,
  title: "Views/DetailsView"
}

export default meta
type Story = StoryObj<typeof DetailsView>

const PRDecorator = (Story: any, context: any) => {
  const setSelectedPrId = useAtomSet(selectedPrIdAtom)
  const { pr } = context.args

  useEffect(() => {
    // Force set the mock state using window global to avoid module duplication issues
    if (typeof window !== "undefined" && (window as any).__setMockState && pr) {
      ;(window as any).__setMockState({
        status: "idle",
        pullRequests: [pr],
        accounts: [],
        lastUpdated: new Date()
      })
    }

    if (pr) {
      setSelectedPrId(pr.id)
    } else {
      setSelectedPrId(null)
    }
  }, [pr, setSelectedPrId])

  return (<Story />) as any
}

export const Default: Story = {
  decorators: [PRDecorator],
  args: {
    // @ts-ignore
    pr: mockPR
  }
}

export const NoSelection: Story = {
  decorators: [PRDecorator],
  args: {
    // @ts-ignore
    pr: null
  }
}
