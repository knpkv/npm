// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AuthorizedShareSummary } from "../../src/api/shares.js"
import { AuthorizedSharePanel } from "../../src/client/items/AuthorizedSharePanel.js"
import type {
  AuthorizedShareTransport,
  CreateAuthorizedShareTransportInput
} from "../../src/client/items/authorizedShareTransport.js"
import { PersonId, ShareId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
const entityId = releaseWorksetFixture.entityProjections[0]?.projection.entityId
if (entityId === undefined) throw new Error("Expected an item fixture")
const personId = Schema.decodeUnknownSync(PersonId)("01890f6f-6d6a-7cc0-98d2-0000000000a1")
const firstShareId = Schema.decodeUnknownSync(ShareId)("01890f6f-6d6a-7cc0-98d2-0000000000a2")
const secondShareId = Schema.decodeUnknownSync(ShareId)("01890f6f-6d6a-7cc0-98d2-0000000000a3")
const firstExpiry = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-18T10:00:00.000Z")
const secondExpiry = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-24T10:00:00.000Z")

const intent = (
  shareId: ShareId,
  expiresAt: UtcTimestamp,
  lifetime: CreateAuthorizedShareTransportInput["lifetime"]
): CreateAuthorizedShareTransportInput => ({ entityId, expiresAt, granteePersonId: personId, lifetime, shareId })

const summary = (createIntent: CreateAuthorizedShareTransportInput) =>
  AuthorizedShareSummary.make({
    shareId: createIntent.shareId,
    entityId: createIntent.entityId,
    granteePersonId: createIntent.granteePersonId,
    createdAt: Schema.decodeUnknownSync(UtcTimestamp)("2026-07-17T10:00:00.000Z"),
    expiresAt: createIntent.expiresAt,
    revokedAt: null
  })

const renderPanel = async (transport: AuthorizedShareTransport): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  await act(async () =>
    mountedRoot?.render(
      <MemoryRouter>
        <AuthorizedSharePanel
          currentPersonId={personId}
          entityId={entityId}
          grantees={[]}
          transport={transport}
          workspaceId={WORKSET_WORKSPACE_ID}
        />
      </MemoryRouter>
    )
  )
  return host
}

const createButton = (host: HTMLElement): HTMLButtonElement => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    ({ textContent }) => textContent === "Create authorized link"
  )
  if (button === undefined) throw new Error("Expected share creation action")
  return button
}

const submit = async (host: HTMLElement): Promise<void> => {
  await act(async () => {
    createButton(host).click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

describe("AuthorizedSharePanel", () => {
  it("reuses the original share identity and expiry after a lost create response", async () => {
    const createIntent = intent(firstShareId, firstExpiry, "day")
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockResolvedValueOnce(summary(createIntent))
    const prepareCreate = vi.fn(() => Promise.resolve(createIntent))
    const transport = {
      create,
      prepareCreate,
      resolve: vi.fn(() => Promise.reject(new Error("not used"))),
      revoke: vi.fn(() => Promise.reject(new Error("not used")))
    } satisfies AuthorizedShareTransport
    const host = await renderPanel(transport)

    await submit(host)
    await vi.waitFor(() => expect(host.textContent).toContain("Could not create the link"))
    await submit(host)
    await vi.waitFor(() => expect(host.textContent).toContain("Authorized link ready"))

    expect(prepareCreate).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]?.[0]).toBe(createIntent)
    expect(create.mock.calls[1]?.[0]).toBe(createIntent)
  })

  it("prepares a distinct identity and expiry after the owner changes lifetime", async () => {
    const firstIntent = intent(firstShareId, firstExpiry, "day")
    const secondIntent = intent(secondShareId, secondExpiry, "week")
    const prepareCreate = vi.fn().mockResolvedValueOnce(firstIntent).mockResolvedValueOnce(secondIntent)
    const create = vi.fn((_input: CreateAuthorizedShareTransportInput, _signal: AbortSignal) =>
      Promise.reject(new Error("keep the form available"))
    )
    const transport = {
      create,
      prepareCreate,
      resolve: vi.fn(() => Promise.reject(new Error("not used"))),
      revoke: vi.fn(() => Promise.reject(new Error("not used")))
    } satisfies AuthorizedShareTransport
    const host = await renderPanel(transport)

    await submit(host)
    await vi.waitFor(() => expect(host.textContent).toContain("Could not create the link"))
    const lifetime = [...host.querySelectorAll<HTMLSelectElement>("select")].find(
      (select) => select.parentElement?.textContent?.startsWith("Expires") === true
    )
    if (lifetime === undefined) throw new Error("Expected share lifetime selector")
    await act(async () => {
      lifetime.value = "week"
      lifetime.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await submit(host)

    expect(prepareCreate).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]?.[0]).toBe(firstIntent)
    expect(create.mock.calls[1]?.[0]).toBe(secondIntent)
    expect(firstIntent.shareId).not.toBe(secondIntent.shareId)
    expect(firstIntent.expiresAt).not.toBe(secondIntent.expiresAt)
  })
})
