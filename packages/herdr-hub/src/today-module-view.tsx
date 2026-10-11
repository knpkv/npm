import { Clock, Effect, Exit, Fiber, Schedule, Schema } from "effect"
import { useEffect, useState, type ReactElement, type ReactNode } from "react"
import { todayModule, type ModuleViews, type NeedsYouResult } from "./modules.js"
import { TodayView, type TodayReadState } from "./today-view.js"

export class TodayReadFailed extends Schema.TaggedError<TodayReadFailed>()("TodayReadFailed", {
  reason: Schema.Literals(["network", "status", "invalid_json", "timeout"])
}) {}

interface TodayModuleContent {
  readonly read: Effect.Effect<NeedsYouResult, TodayReadFailed>
  readonly now: number
  readonly agents: ReactNode
  readonly history: ReactNode
}

/** One serial poll only while Today is active and visible; interruption aborts an in-flight read. */
const TodayPage = ({
  active,
  content
}: {
  readonly active: boolean
  readonly content: TodayModuleContent
}): ReactElement => {
  const [state, setState] = useState<TodayReadState>({ reading: null, failed: false })
  const [visible, setVisible] = useState(() => document.visibilityState === "visible")
  useEffect(() => {
    const changed = (): void => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", changed)
    return () => document.removeEventListener("visibilitychange", changed)
  }, [])
  useEffect(() => {
    if (!active || !visible) return
    let current = true
    const poll = Effect.gen(function* () {
      const result = yield* Effect.exit(content.read)
      if (!current) return
      const checkedAt = yield* Clock.currentTimeMillis
      yield* Effect.sync(() =>
        setState((previous) =>
          Exit.isSuccess(result)
            ? { reading: { result: result.value, checkedAt }, failed: false }
            : { reading: previous.reading, failed: true }
        )
      )
    }).pipe(Effect.repeat(Schedule.spaced("5 seconds")))
    const fiber = Effect.runFork(poll)
    return () => {
      current = false
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [active, visible, content.read])
  return <TodayView state={state} now={content.now} agents={content.agents} history={content.history} />
}

/** The shell retains the page's last reading while another module is selected. */
export const makeTodayModuleViews = (content: TodayModuleContent): ModuleViews<typeof todayModule> => ({
  descriptor: todayModule,
  pages: { overview: (_search, mount) => <TodayPage active={mount.active} content={content} /> }
})
