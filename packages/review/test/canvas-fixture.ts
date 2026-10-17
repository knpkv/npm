/** A synthetic 14-file change in four modules, shaped like the design's canvas example. @module */
import type { CanvasFinding } from "../src/canvas/derive.js"
import type { CanvasGraph, CanvasPart, CanvasReviewContext } from "../src/canvas/model.js"

const part = (
  name: string,
  kind: CanvasPart["kind"],
  start: number | null,
  end: number | null,
  added: number,
  removed: number,
  movedPath: string | null = null
): CanvasPart => ({
  name,
  kind,
  movedPath,
  lines: start === null || end === null ? null : { start, end },
  added,
  removed
})

const file = (
  path: string,
  added: number,
  removed: number,
  parts: ReadonlyArray<CanvasPart> | null = null
): CanvasGraph["files"][number] => ({
  path,
  status: removed === 0 ? "added" : "modified",
  previousPath: null,
  added,
  removed,
  parts: parts === null ? { _tag: "NotRecorded" } : { _tag: "Recorded", items: parts }
})

export const sampleGraph: CanvasGraph = {
  headRevision: "e81f0c9",
  files: [
    file("stage/useStageSocket.ts", 24, 118, [
      part("useStageSocket()", "modified", 10, 27, 18, 18),
      part("sendFrame()", "modified", 30, 35, 6, 6),
      part("openSocket()", "moved_to", null, null, 0, 118, "sync-worker/socket.ts")
    ]),
    file("stage/StageProvider.tsx", 31, 40),
    file("stage/reconnect.ts", 18, 36),
    file("sync-worker/worker.ts", 96, 0),
    file("sync-worker/protocol.ts", 48, 0),
    file("sync-worker/socket.ts", 142, 0, [
      part("connect()", "added", 14, 59, 46, 0),
      part("onMessage()", "added", 61, 98, 38, 0),
      part("reconnect()", "moved_from", 100, 133, 34, 0, "stage/reconnect.ts"),
      part("close()", "added", 135, 146, 12, 0),
      part("imports and types", "added", 1, 12, 12, 0)
    ]),
    file("stage/StageView.tsx", 12, 0),
    file("sync-worker/drafts.ts", 64, 0),
    file("composer/useDraft.ts", 52, 14),
    file("composer/Composer.tsx", 22, 10),
    file("composer/draftStore.ts", 40, 6),
    file("tests/reconnect.test.ts", 9, 16),
    file("tests/socket.test.ts", 30, 0),
    file("tests/drafts.test.ts", 24, 0)
  ],
  dependencies: {
    _tag: "Recorded",
    edges: [
      ["stage/StageProvider.tsx", "stage/useStageSocket.ts", "calls"],
      ["stage/useStageSocket.ts", "sync-worker/worker.ts", "calls"],
      ["sync-worker/worker.ts", "sync-worker/socket.ts", "calls"],
      ["sync-worker/worker.ts", "sync-worker/protocol.ts", "imports"],
      ["stage/reconnect.ts", "sync-worker/socket.ts", "moved_from"],
      ["sync-worker/socket.ts", "sync-worker/drafts.ts", "calls"],
      ["stage/StageView.tsx", "composer/useDraft.ts", "imports"],
      ["composer/Composer.tsx", "composer/useDraft.ts", "calls"],
      ["composer/useDraft.ts", "sync-worker/drafts.ts", "calls"],
      ["composer/useDraft.ts", "composer/draftStore.ts", "imports"],
      ["tests/reconnect.test.ts", "stage/reconnect.ts", "imports"],
      ["tests/socket.test.ts", "sync-worker/socket.ts", "imports"],
      ["tests/drafts.test.ts", "sync-worker/drafts.ts", "imports"]
    ].map(([from, to, relation]) => ({
      from: from ?? "",
      to: to ?? "",
      relation: relation === "calls" ? "calls" : relation === "imports" ? "imports" : "moved_from",
      fromPart: null,
      toPart: null
    }))
  },
  partitions: {
    _tag: "Recorded",
    items: [
      {
        id: "A",
        title: "Worker owns the socket",
        why: "Every edit here touches the socket’s def-use chain.",
        files: [
          "stage/useStageSocket.ts",
          "stage/StageProvider.tsx",
          "stage/reconnect.ts",
          "sync-worker/worker.ts",
          "sync-worker/protocol.ts",
          "sync-worker/socket.ts"
        ]
      },
      {
        id: "B",
        title: "Composer reads drafts from the worker",
        why: "Every edit here touches the draft’s def-use chain.",
        files: [
          "stage/StageView.tsx",
          "sync-worker/drafts.ts",
          "composer/useDraft.ts",
          "composer/Composer.tsx",
          "composer/draftStore.ts"
        ]
      }
    ]
  }
}

export const noContext: CanvasReviewContext = {
  lastLook: { _tag: "NotRecorded" },
  readingPath: { _tag: "NotRecorded" },
  findings: { _tag: "NotRecorded" },
  tests: { _tag: "NotRecorded" }
}

export const sampleContext: CanvasReviewContext = {
  lastLook: {
    _tag: "Recorded",
    at: Date.UTC(2026, 9, 16, 13, 20),
    head: "7d2e1b4",
    commitsSince: 2,
    changedFiles: ["stage/useStageSocket.ts", "sync-worker/socket.ts", "sync-worker/drafts.ts", "tests/socket.test.ts"]
  },
  readingPath: {
    _tag: "Recorded",
    chapters: [
      {
        partition: "A",
        title: "Worker owns the socket",
        why: "Riskiest: the P1, the failing test and the widest blast radius",
        files: [
          "sync-worker/socket.ts",
          "stage/useStageSocket.ts",
          "sync-worker/worker.ts",
          "sync-worker/protocol.ts",
          "stage/reconnect.ts",
          "stage/StageProvider.tsx"
        ]
      },
      {
        partition: "B",
        title: "Composer reads drafts from the worker",
        why: "1 P2 on the draft write",
        files: [
          "sync-worker/drafts.ts",
          "composer/useDraft.ts",
          "composer/draftStore.ts",
          "composer/Composer.tsx",
          "stage/StageView.tsx"
        ]
      },
      {
        partition: null,
        title: "Tests",
        why: "Test-only, 1 failing",
        files: ["tests/socket.test.ts", "tests/reconnect.test.ts", "tests/drafts.test.ts"]
      }
    ],
    read: [],
    current: null
  },
  findings: { _tag: "NotRecorded" },
  tests: {
    _tag: "Recorded",
    failing: [{ check: "unit-tests", file: "tests/socket.test.ts", test: "opens one socket for two tabs" }]
  }
}

export const sampleFindings: ReadonlyArray<CanvasFinding> = [
  {
    id: "F1",
    severity: "P1",
    title: "Two tabs opening at once get two sockets",
    body: "Line 16 only returns an open socket.",
    path: "sync-worker/socket.ts",
    line: 16
  },
  {
    id: "F2",
    severity: "P2",
    title: "Frames sent before the port is ready are dropped",
    body: "",
    path: "stage/useStageSocket.ts",
    line: 32
  },
  {
    id: "F3",
    severity: "P2",
    title: "Draft write isn’t awaited before the ack",
    body: "",
    path: "sync-worker/drafts.ts",
    line: null
  },
  {
    id: "F4",
    severity: "P3",
    title: "Frame type names collide with stage events",
    body: "",
    path: "sync-worker/protocol.ts",
    line: null
  }
]
