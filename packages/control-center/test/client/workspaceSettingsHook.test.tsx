// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  WorkspaceSettingsReadModel,
  WorkspaceSettingsRevision,
  workspaceSettingsEtag
} from "../../src/api/workspaceSettings.js"
import { useWorkspaceSettings } from "../../src/client/settings/useWorkspaceSettings.js"
import type { WorkspaceSettingsTransport } from "../../src/client/settings/workspaceSettingsTransport.js"
import { WorkspaceSettingsMutationId } from "../../src/domain/identifiers.js"
import { DEFAULT_WORKSPACE_SETTINGS } from "../../src/domain/workspaceSettings.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const mutationId = Schema.decodeSync(WorkspaceSettingsMutationId)("01890f6f-6d6a-7cc0-98d2-000000000201")
const initial = Schema.decodeSync(WorkspaceSettingsReadModel)({
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000202",
  revision: 1,
  etag: '"workspace-settings-v1-1"',
  settings: DEFAULT_WORKSPACE_SETTINGS,
  createdAt: "2026-07-30T09:00:00.000Z",
  updatedAt: "2026-07-30T09:00:00.000Z",
  updatedByPersonId: null
})
const savedRevision = WorkspaceSettingsRevision.make(2)
const saved = WorkspaceSettingsReadModel.make({
  ...initial,
  revision: savedRevision,
  etag: workspaceSettingsEtag(savedRevision),
  settings: {
    ...initial.settings,
    presentation: { ...initial.settings.presentation, density: "compact" }
  }
})

let mountedRoot: Root | undefined
const onSessionExpired = (): void => undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const Harness = ({ transport }: { readonly transport: WorkspaceSettingsTransport }): ReactElement => {
  const controller = useWorkspaceSettings("session-a", onSessionExpired, transport)
  if (controller.state._tag === "conflict-recovery-failed") {
    return (
      <div>
        <span>{`${controller.state._tag}:${controller.state.candidate.presentation.density}`}</span>
        <button onClick={controller.retryConflict} type="button">
          Retry conflict
        </button>
      </div>
    )
  }
  if (controller.state._tag === "conflict") {
    return <span>{`${controller.state._tag}:${controller.state.candidate.presentation.density}`}</span>
  }
  if (controller.state._tag !== "ready") {
    return <span>{controller.state._tag}</span>
  }
  const ready = controller.state
  return (
    <div>
      <span>{ready.status}</span>
      <span>{ready.draft.presentation.defaultLanding}</span>
      <button
        onClick={() =>
          controller.edit({
            ...ready.draft,
            presentation: {
              ...ready.draft.presentation,
              density: "compact"
            }
          })
        }
        type="button"
      >
        Edit
      </button>
      <button onClick={controller.save} type="button">
        Save
      </button>
      <button
        onClick={() =>
          controller.edit({
            ...ready.draft,
            presentation: {
              ...ready.draft.presentation,
              defaultLanding: "active-work"
            }
          })
        }
        type="button"
      >
        Edit landing
      </button>
    </div>
  )
}

const click = async (button: HTMLButtonElement): Promise<void> => {
  await act(async () => button.click())
  await act(async () => Promise.resolve())
}

describe("useWorkspaceSettings", () => {
  it("reuses the same mutation identity after an ambiguous save failure", async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(saved)
    const transport = {
      load: () => Promise.resolve(initial),
      makeMutationId: vi.fn(() => Promise.resolve(mutationId)),
      update
    } satisfies WorkspaceSettingsTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(<Harness transport={transport} />))
    await act(async () => Promise.resolve())
    const buttons = host.querySelectorAll("button")
    const edit = buttons.item(0)
    const save = buttons.item(1)

    await click(edit)
    await click(save)
    expect(host.textContent).toContain("failed")
    await click(save)

    expect(transport.makeMutationId).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[0]?.[0].mutationId).toBe(mutationId)
    expect(update.mock.calls[1]?.[0].mutationId).toBe(mutationId)
    expect(host.textContent).toContain("saved")
  })

  it("retains the losing draft when loading the conflict revision fails", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("latest unavailable"))
      .mockResolvedValueOnce(saved)
    const transport = {
      load,
      makeMutationId: vi.fn(() => Promise.resolve(mutationId)),
      update: vi.fn(() => Promise.reject({ _tag: "ConflictApiError" }))
    } satisfies WorkspaceSettingsTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(<Harness transport={transport} />))
    await act(async () => Promise.resolve())

    await click(host.querySelectorAll("button").item(0))
    await click(host.querySelectorAll("button").item(1))
    await act(async () => Promise.resolve())

    expect(host.textContent).toContain("conflict-recovery-failed:compact")
    await click(host.querySelector("button")!)
    await act(async () => Promise.resolve())
    expect(host.textContent).toContain("conflict:compact")
  })

  it("ignores form edits while a save is in flight", async () => {
    let resolvePending: (value: WorkspaceSettingsReadModel) => void = () => undefined
    const pending = new Promise<WorkspaceSettingsReadModel>((resolve) => {
      resolvePending = resolve
    })
    const transport = {
      load: () => Promise.resolve(initial),
      makeMutationId: vi.fn(() => Promise.resolve(mutationId)),
      update: vi.fn(() => pending)
    } satisfies WorkspaceSettingsTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(<Harness transport={transport} />))
    await act(async () => Promise.resolve())
    const buttons = host.querySelectorAll("button")

    await click(buttons.item(0))
    await click(buttons.item(1))
    await click(buttons.item(2))

    expect(host.textContent).toContain("saving")
    expect(host.textContent).toContain("overview")
    await act(async () => resolvePending(saved))
    expect(host.textContent).toContain("saved")
  })
})
