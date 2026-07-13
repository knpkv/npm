import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Actor, derivePersonInitials, Person, RoleAssignment } from "../../src/domain/actors.js"

const WORKSPACE_ID = "01912345-6789-7abc-8def-0123456789ab"
const PERSON_ID = "01912345-6789-7abc-9def-0123456789ab"
const AGENT_ID = "01912345-6789-7abc-adef-0123456789ab"
const RELEASE_ID = "01912345-6789-7abc-bdef-0123456789ab"
const ENTITY_ID = "01912345-6789-7abd-8def-0123456789ab"
const ENVIRONMENT_ID = "01912345-6789-7abd-9def-0123456789ab"
const PLUGIN_CONNECTION_ID = "01912345-6789-7abd-adef-0123456789ab"
const ROLE_ASSIGNMENT_ID = "01912345-6789-7abd-bdef-0123456789ab"

const person = {
  avatar: {
    _tag: "initials",
    text: "MC"
  },
  displayName: "Maya Chen",
  isActive: true,
  personId: PERSON_ID,
  sourceIdentities: [
    {
      pluginConnectionId: PLUGIN_CONNECTION_ID,
      providerId: "jira",
      vendorPersonId: "account-1042"
    }
  ]
}

describe("people and actors", () => {
  it("derives stable initials from one or multiple display-name tokens", () => {
    expect(derivePersonInitials("  Maya   Chen ")).toBe("MC")
    expect(derivePersonInitials("Plato")).toBe("P")
    expect(derivePersonInitials("Ada María Lovelace")).toBe("AL")
  })

  it.effect("roundtrips a canonical person and provider identity", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(Person)(person)
      const encoded = yield* Schema.encodeUnknownEffect(Person)(decoded)

      expect(decoded.displayName).toBe("Maya Chen")
      expect(encoded).toEqual(person)
    }))

  it.effect("accepts an opaque avatar reference without treating it as an external URL", () =>
    Effect.gen(function*() {
      const referencedPerson = {
        ...person,
        avatar: {
          _tag: "reference",
          reference: "media/avatar/sha256-18d8"
        }
      }

      const decoded = yield* Schema.decodeUnknownEffect(Person)(referencedPerson)
      const encoded = yield* Schema.encodeUnknownEffect(Person)(decoded)

      expect(encoded).toEqual(referencedPerson)
    }))

  it("rejects initials that do not match the deterministic fallback", () => {
    const result = Schema.decodeUnknownResult(Person)({
      ...person,
      avatar: {
        _tag: "initials",
        text: "XX"
      }
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects untrimmed display names and avatar fallback values", () => {
    const untrimmedName = Schema.decodeUnknownResult(Person)({
      ...person,
      displayName: " Maya Chen"
    })
    const untrimmedInitials = Schema.decodeUnknownResult(Person)({
      ...person,
      avatar: {
        _tag: "initials",
        text: "MC "
      }
    })

    expect(Result.isFailure(untrimmedName)).toBe(true)
    expect(Result.isFailure(untrimmedInitials)).toBe(true)
  })

  it("rejects duplicate provider identities", () => {
    const duplicateIdentity = person.sourceIdentities.at(0)
    const result = Schema.decodeUnknownResult(Person)({
      ...person,
      sourceIdentities: duplicateIdentity === undefined ? [] : [duplicateIdentity, duplicateIdentity]
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("retains full provider names and rejects planned package abbreviations", () => {
    const result = Schema.decodeUnknownResult(Person)({
      ...person,
      sourceIdentities: [
        {
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          providerId: "jr",
          vendorPersonId: "account-1042"
        }
      ]
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("keeps human and agent identities in distinct tagged actor variants", () => {
    const human = Schema.decodeUnknownResult(Actor)({
      _tag: "human",
      personId: PERSON_ID
    })
    const agent = Schema.decodeUnknownResult(Actor)({
      _tag: "agent",
      agentId: AGENT_ID
    })
    const confusedHuman = Schema.decodeUnknownResult(Actor)({
      _tag: "human",
      agentId: AGENT_ID
    })

    expect(Result.isSuccess(human)).toBe(true)
    expect(Result.isSuccess(agent)).toBe(true)
    expect(Result.isFailure(confusedHuman)).toBe(true)
  })
})

describe("role assignments", () => {
  it.effect("roundtrips a human reviewer assigned to an exact entity", () =>
    Effect.gen(function*() {
      const encodedAssignment = {
        actor: {
          _tag: "human",
          personId: PERSON_ID
        },
        assignmentId: ROLE_ASSIGNMENT_ID,
        lifecycle: {
          _tag: "active",
          assignedAt: "2026-07-13T08:00:00.000Z"
        },
        role: "reviewer",
        scope: {
          _tag: "entity",
          entityId: ENTITY_ID,
          workspaceId: WORKSPACE_ID
        }
      }

      const assignment = yield* Schema.decodeUnknownEffect(RoleAssignment)(encodedAssignment)
      const encoded = yield* Schema.encodeUnknownEffect(RoleAssignment)(assignment)

      expect(encoded).toEqual(encodedAssignment)
    }))

  it.effect("roundtrips an agent operator scoped to one release environment", () =>
    Effect.gen(function*() {
      const encodedAssignment = {
        actor: {
          _tag: "agent",
          agentId: AGENT_ID
        },
        assignmentId: ROLE_ASSIGNMENT_ID,
        lifecycle: {
          _tag: "ended",
          assignedAt: "2026-07-13T08:00:00.000Z",
          endedAt: "2026-07-13T09:00:00.000Z"
        },
        role: "operator",
        scope: {
          _tag: "environment",
          environmentId: ENVIRONMENT_ID,
          releaseId: RELEASE_ID,
          workspaceId: WORKSPACE_ID
        }
      }

      const assignment = yield* Schema.decodeUnknownEffect(RoleAssignment)(encodedAssignment)
      const encoded = yield* Schema.encodeUnknownEffect(RoleAssignment)(assignment)

      expect(encoded).toEqual(encodedAssignment)
    }))

  it("rejects an assignment that ends before it starts", () => {
    const result = Schema.decodeUnknownResult(RoleAssignment)({
      actor: {
        _tag: "human",
        personId: PERSON_ID
      },
      assignmentId: ROLE_ASSIGNMENT_ID,
      lifecycle: {
        _tag: "ended",
        assignedAt: "2026-07-13T09:00:00.000Z",
        endedAt: "2026-07-13T08:00:00.000Z"
      },
      role: "reviewer",
      scope: {
        _tag: "release",
        releaseId: RELEASE_ID,
        workspaceId: WORKSPACE_ID
      }
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects an assignment revoked before it starts", () => {
    const result = Schema.decodeUnknownResult(RoleAssignment)({
      actor: {
        _tag: "agent",
        agentId: AGENT_ID
      },
      assignmentId: ROLE_ASSIGNMENT_ID,
      lifecycle: {
        _tag: "revoked",
        assignedAt: "2026-07-13T09:00:00.000Z",
        revokedAt: "2026-07-13T08:00:00.000Z"
      },
      role: "deployment-approver",
      scope: {
        _tag: "workspace",
        workspaceId: WORKSPACE_ID
      }
    })

    expect(Result.isFailure(result)).toBe(true)
  })
})
