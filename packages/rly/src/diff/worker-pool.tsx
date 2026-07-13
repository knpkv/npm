/// <reference types="vite/client" />

"use client"

import { WorkerPoolContext } from "@pierre/diffs/react"
import { WorkerPoolManager } from "@pierre/diffs/worker"
// Vite's ?worker&url transform supplies this default export after static analysis.
// eslint-disable-next-line import-x/default
import defaultWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"
import { createContext, type ReactNode, useContext, useEffect, useState } from "react"
import { RLY_DIFF_THEMES, ensureRlyDiffThemes } from "./themes.js"

type RlyDiffWorkerStatus = "fallback" | "main-thread" | "worker"

interface RlyDiffWorkerState {
  readonly manager?: WorkerPoolManager
  readonly status: RlyDiffWorkerStatus
}

export interface DiffWorkerProviderProps {
  readonly children: ReactNode
  readonly poolSize?: number
  readonly workerFactory?: () => Worker
}

export interface CreateDiffWorkerFactoryOptions {
  readonly name?: string
  readonly workerUrl?: string | URL
}

const DiffWorkerStateContext = createContext<RlyDiffWorkerState>({ status: "main-thread" })

export const normalizeDiffWorkerPoolSize = (poolSize = 2): number => {
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 4) {
    throw new RangeError("Diff worker pool size must be an integer from 1 through 4")
  }
  return poolSize
}

export const createDiffWorkerFactory = ({
  name = "rly-diff-highlighter",
  workerUrl = defaultWorkerUrl
}: CreateDiffWorkerFactoryOptions = {}): (() => Worker) => {
  return () => {
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      throw new Error("Diff workers are available only in a browser")
    }
    return new Worker(workerUrl, { name, type: "module" })
  }
}

const DEFAULT_DIFF_WORKER_FACTORY = createDiffWorkerFactory()

const initializeWorkerState = (workerFactory: () => Worker, poolSize: number): RlyDiffWorkerState => {
  if (typeof window === "undefined") return { status: "main-thread" }

  try {
    const probe = workerFactory()
    probe.terminate()
    ensureRlyDiffThemes()
    return {
      manager: new WorkerPoolManager(
        { poolSize, workerFactory },
        { langs: ["text", "tsx", "typescript", "json", "yaml", "markdown"], theme: RLY_DIFF_THEMES }
      ),
      status: "worker"
    }
  } catch {
    return { status: "fallback" }
  }
}

export const DiffWorkerProvider = ({
  children,
  poolSize: requestedPoolSize,
  workerFactory = DEFAULT_DIFF_WORKER_FACTORY
}: DiffWorkerProviderProps): ReactNode => {
  const [state, setState] = useState<RlyDiffWorkerState>({ status: "main-thread" })

  useEffect(() => {
    let active = true
    const nextState = initializeWorkerState(workerFactory, normalizeDiffWorkerPoolSize(requestedPoolSize))
    const manager = nextState.manager
    const unsubscribe = manager?.subscribeToStatChanges((stats) => {
      if (active && stats.workersFailed) setState({ manager, status: "fallback" })
    })
    setState(nextState)

    return () => {
      active = false
      unsubscribe?.()
      manager?.terminate()
    }
  }, [requestedPoolSize, workerFactory])

  return (
    <DiffWorkerStateContext.Provider value={state}>
      <WorkerPoolContext.Provider value={state.manager}>{children}</WorkerPoolContext.Provider>
    </DiffWorkerStateContext.Provider>
  )
}

export const useDiffWorkerState = (): RlyDiffWorkerState => useContext(DiffWorkerStateContext)
