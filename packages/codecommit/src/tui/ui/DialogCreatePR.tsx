import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { Effect } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import type { Account } from "../@knpkv/codecommit-core/Domain"
import { appStateAtom } from "../atoms/app.js"
import { createPrAtom, listBranchesAtom, type CreatePRInput } from "../atoms/actions.js"
import { creatingPrAtom } from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { getCurrentBranch, scanPRTemplates, type PRTemplate } from "../utils/prTemplates.js"

type Step = "repo" | "source" | "dest" | "template" | "details" | "preview"

interface RepoOption {
  readonly name: string
  readonly account: Account
}

const defaultState = {
  status: "loading" as const,
  pullRequests: [],
  accounts: []
}

export function DialogCreatePR() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const appStateResult = useAtomValue(appStateAtom)
  const appState = Result.getOrElse(appStateResult, () => defaultState)
  const createPr = useAtomSet(createPrAtom)
  const setCreatingPr = useAtomSet(creatingPrAtom)
  const fetchBranches = useAtomSet(listBranchesAtom)
  const branchesResult = useAtomValue(listBranchesAtom)

  const [step, setStep] = useState<Step>("repo")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const visibleHeight = 10

  // Form state
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null)
  const [repoFilter, setRepoFilter] = useState("")
  const [branches, setBranches] = useState<string[]>([])
  const [branchFilter, setBranchFilter] = useState("")
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [sourceBranch, setSourceBranch] = useState("")
  const [destBranch, setDestBranch] = useState("")
  const [currentGitBranch, setCurrentGitBranch] = useState("")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [focusedField, setFocusedField] = useState<"title" | "desc">("title")

  // Template state
  const [templates, setTemplates] = useState<PRTemplate[]>([])
  const [templatesLoaded, setTemplatesLoaded] = useState(false)

  // Get unique repos from PRs
  const repos = useMemo(() => {
    const seen = new Map<string, RepoOption>()
    for (const pr of appState.pullRequests) {
      const key = `${pr.account.id}:${pr.repositoryName}`
      if (!seen.has(key)) {
        seen.set(key, { name: pr.repositoryName, account: pr.account })
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [appState.pullRequests])

  // Filter repos by search text
  const filteredRepos = useMemo(() => {
    if (!repoFilter) return repos
    const filter = repoFilter.toLowerCase()
    return repos.filter((r) => r.name.toLowerCase().includes(filter) || r.account.id.toLowerCase().includes(filter))
  }, [repos, repoFilter])

  // Filter branches by search text
  const filteredBranches = useMemo(() => {
    if (!branchFilter) return branches
    const filter = branchFilter.toLowerCase()
    return branches.filter((b) => b.toLowerCase().includes(filter))
  }, [branches, branchFilter])

  // Load current git branch and templates on mount
  useEffect(() => {
    Effect.runPromise(getCurrentBranch)
      .then(setCurrentGitBranch)
      .catch(() => setCurrentGitBranch(""))

    Effect.runPromise(scanPRTemplates)
      .then((t) => {
        setTemplates(t)
        setTemplatesLoaded(true)
      })
      .catch(() => setTemplatesLoaded(true))
  }, [])

  // Update branches when result changes
  useEffect(() => {
    if (Result.isInitial(branchesResult)) return
    const value = Result.getOrElse(branchesResult, () => [])
    setBranches(value)
    setBranchesLoading(false)
  }, [branchesResult])

  // Scroll management
  useEffect(() => {
    if (!scrollRef.current) return
    let newOffset = scrollOffset
    if (selectedIndex < scrollOffset + 1) {
      newOffset = Math.max(0, selectedIndex - 1)
    } else if (selectedIndex > scrollOffset + visibleHeight - 2) {
      newOffset = selectedIndex - visibleHeight + 2
    }
    if (newOffset !== scrollOffset) {
      setScrollOffset(newOffset)
      scrollRef.current.scrollTo({ x: 0, y: newOffset })
    }
  }, [selectedIndex, scrollOffset])

  const handleSubmit = () => {
    if (!selectedRepo || !title.trim() || !sourceBranch.trim() || !destBranch.trim()) return

    const trimmedDesc = description.trim()
    const input: CreatePRInput = {
      repositoryName: selectedRepo.name,
      title: title.trim(),
      ...(trimmedDesc && { description: trimmedDesc }),
      sourceBranch: sourceBranch.trim(),
      destinationBranch: destBranch.trim(),
      account: selectedRepo.account
    }

    setCreatingPr(`${input.title}...`)
    createPr(input)
    dialog.hide()
  }

  // Find default branch (main or master)
  const findDefaultBranch = (branchList: string[]) => {
    if (branchList.includes("main")) return "main"
    if (branchList.includes("master")) return "master"
    return branchList[0] ?? ""
  }

  useKeyboard((key: { name: string; char?: string; shift?: boolean }) => {
    if (key.name === "escape") {
      if (step === "repo") {
        dialog.hide()
      } else if (step === "source") {
        setStep("repo")
        setSelectedIndex(0)
      } else if (step === "dest") {
        setStep("source")
        setSelectedIndex(0)
      } else if (step === "template") {
        setStep("dest")
        setSelectedIndex(0)
      } else if (step === "details") {
        setStep("template")
        setSelectedIndex(0)
      } else if (step === "preview") {
        setStep("details")
        setSelectedIndex(0)
      }
      return
    }

    // Step: Repository selection
    if (step === "repo") {
      if (key.name === "down") {
        setSelectedIndex((i) => Math.min(i + 1, filteredRepos.length - 1))
      } else if (key.name === "up") {
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (key.name === "return") {
        const repo = filteredRepos[selectedIndex]
        if (repo) {
          setSelectedRepo(repo)
          setRepoFilter("")
          setBranchesLoading(true)
          setBranches([])
          fetchBranches({ repositoryName: repo.name, account: repo.account })
          setStep("source")
          setSelectedIndex(0)
        }
      } else if (key.name === "backspace") {
        setRepoFilter((s) => s.slice(0, -1))
        setSelectedIndex(0)
      } else {
        const char = key.char || (key.name?.length === 1 ? key.name : null)
        if (char && char.length === 1) {
          setRepoFilter((s) => s + char)
          setSelectedIndex(0)
        }
      }
      return
    }

    // Step: Source branch selection
    if (step === "source") {
      if (branchesLoading) return
      if (key.name === "down") {
        setSelectedIndex((i) => Math.min(i + 1, filteredBranches.length - 1))
      } else if (key.name === "up") {
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (key.name === "return") {
        const branch = filteredBranches[selectedIndex]
        if (branch) {
          setSourceBranch(branch)
          setBranchFilter("")
          setStep("dest")
          // Pre-select default branch for destination
          const defaultIdx = branches.indexOf(findDefaultBranch(branches))
          setSelectedIndex(defaultIdx >= 0 ? defaultIdx : 0)
          setScrollOffset(0)
        }
      } else if (key.name === "backspace") {
        setBranchFilter((s) => s.slice(0, -1))
        setSelectedIndex(0)
      } else {
        const char = key.char || (key.name?.length === 1 ? key.name : null)
        if (char && char.length === 1) {
          setBranchFilter((s) => s + char)
          setSelectedIndex(0)
        }
      }
      return
    }

    // Step: Destination branch selection
    if (step === "dest") {
      if (key.name === "down") {
        setSelectedIndex((i) => Math.min(i + 1, filteredBranches.length - 1))
      } else if (key.name === "up") {
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (key.name === "return") {
        const branch = filteredBranches[selectedIndex]
        if (branch) {
          setDestBranch(branch)
          setBranchFilter("")
          setStep("template")
          setSelectedIndex(0)
          setScrollOffset(0)
        }
      } else if (key.name === "backspace") {
        setBranchFilter((s) => s.slice(0, -1))
        setSelectedIndex(0)
      } else {
        const char = key.char || (key.name?.length === 1 ? key.name : null)
        if (char && char.length === 1) {
          setBranchFilter((s) => s + char)
          setSelectedIndex(0)
        }
      }
      return
    }

    // Step: Template selection
    if (step === "template") {
      const options = [...templates, { filename: "__manual__", title: "Manual entry", content: "" }]
      if (key.name === "down") {
        setSelectedIndex((i) => Math.min(i + 1, options.length - 1))
      } else if (key.name === "up") {
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (key.name === "return") {
        const opt = options[selectedIndex]
        if (opt) {
          if (opt.filename !== "__manual__") {
            const lines = opt.content.split("\n")
            const firstLine = lines[0]?.trim() ?? ""
            if (firstLine.startsWith("# ")) {
              setTitle(firstLine.slice(2))
              setDescription(lines.slice(1).join("\n").trim())
            } else {
              setTitle(opt.title)
              setDescription(opt.content)
            }
          }
          setStep("details")
          setFocusedField("title")
          setSelectedIndex(0)
        }
      }
      return
    }

    // Step: Details entry
    if (step === "details") {
      if (key.name === "tab") {
        setFocusedField(focusedField === "title" ? "desc" : "title")
      } else if (key.name === "return" && !key.shift) {
        if (focusedField === "title" && title.trim()) {
          setFocusedField("desc")
        } else if (focusedField === "desc" && title.trim()) {
          setStep("preview")
        }
      } else if (key.name === "backspace") {
        if (focusedField === "title") {
          setTitle((s) => s.slice(0, -1))
        } else {
          setDescription((s) => s.slice(0, -1))
        }
      } else {
        const char = key.char || (key.name?.length === 1 ? key.name : null)
        if (char) {
          if (focusedField === "title") {
            setTitle((s) => s + char)
          } else {
            setDescription((s) => s + char)
          }
        }
      }
      return
    }

    // Step: Preview
    if (step === "preview") {
      if (key.name === "return") {
        handleSubmit()
      }
    }
  })

  const stepTitles: Record<Step, string> = {
    repo: "Select Repository",
    source: "Select Source Branch",
    dest: "Select Destination Branch",
    template: "Select Template",
    details: "Enter Details",
    preview: "Confirm"
  }

  const stepNumber = { repo: 1, source: 2, dest: 3, template: 4, details: 5, preview: 6 }[step]

  // Pre-select current git branch in source list
  useEffect(() => {
    if (step === "source" && filteredBranches.length > 0 && currentGitBranch && !branchFilter) {
      const idx = filteredBranches.indexOf(currentGitBranch)
      if (idx >= 0) {
        setSelectedIndex(idx)
      }
    }
  }, [step, filteredBranches, currentGitBranch, branchFilter])

  const listHeight =
    step === "details"
      ? 12
      : step === "preview"
        ? 14
        : Math.min(
            step === "repo"
              ? filteredRepos.length + 5
              : step === "source" || step === "dest"
                ? filteredBranches.length + 6
                : templates.length + 5,
            15
          )

  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: "15%",
        width: "70%",
        height: listHeight,
        backgroundColor: theme.backgroundElement,
        borderStyle: "rounded",
        borderColor: theme.primary,
        flexDirection: "column"
      }}
    >
      <box
        style={{
          height: 1,
          width: "100%",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: theme.backgroundHeader
        }}
      >
        <text fg={theme.primary}>{`CREATE PR - Step ${stepNumber}/6: ${stepTitles[step]}`}</text>
      </box>

      {step === "repo" && (
        <scrollbox ref={scrollRef} style={{ flexGrow: 1, width: "100%" }}>
          <box style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}>
            <text fg={theme.text}>{`Filter: ${repoFilter}`}</text>
            <text fg={theme.primary}>|</text>
            <text fg={theme.textMuted}>{` (${filteredRepos.length}/${repos.length})`}</text>
          </box>
          {repos.length === 0 ? (
            <box style={{ height: 1, paddingLeft: 1 }}>
              <text fg={theme.textMuted}>No repositories found. Load PRs first.</text>
            </box>
          ) : filteredRepos.length === 0 ? (
            <box style={{ height: 1, paddingLeft: 1 }}>
              <text fg={theme.textMuted}>No matches.</text>
            </box>
          ) : (
            filteredRepos.map((repo, i) => (
              <box
                key={`${repo.account.id}:${repo.name}`}
                style={{
                  height: 1,
                  width: "100%",
                  paddingLeft: 1,
                  ...(i === selectedIndex && { backgroundColor: theme.primary })
                }}
              >
                <text fg={i === selectedIndex ? theme.selectedText : theme.text}>
                  {`${repo.name} (${repo.account.id})`}
                </text>
              </box>
            ))
          )}
        </scrollbox>
      )}

      {(step === "source" || step === "dest") && (
        <scrollbox ref={scrollRef} style={{ flexGrow: 1, width: "100%" }}>
          <box style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}>
            <text fg={theme.textMuted}>
              {`Repo: ${selectedRepo?.name}${step === "dest" ? ` | Source: ${sourceBranch}` : ""}`}
            </text>
          </box>
          <box style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}>
            <text fg={theme.text}>{`Filter: ${branchFilter}`}</text>
            <text fg={theme.primary}>|</text>
            <text fg={theme.textMuted}>{` (${filteredBranches.length}/${branches.length})`}</text>
          </box>
          {branchesLoading ? (
            <box style={{ height: 1, paddingLeft: 1 }}>
              <text fg={theme.textMuted}>Loading branches...</text>
            </box>
          ) : filteredBranches.length === 0 ? (
            <box style={{ height: 1, paddingLeft: 1 }}>
              <text fg={theme.textMuted}>{branches.length === 0 ? "No branches found." : "No matches."}</text>
            </box>
          ) : (
            filteredBranches.map((branch, i) => (
              <box
                key={branch}
                style={{
                  height: 1,
                  width: "100%",
                  paddingLeft: 1,
                  ...(i === selectedIndex && { backgroundColor: theme.primary })
                }}
              >
                <text fg={i === selectedIndex ? theme.selectedText : theme.text}>
                  {branch}
                  {step === "source" && branch === currentGitBranch ? " (current)" : ""}
                  {step === "dest" && (branch === "main" || branch === "master") ? " (default)" : ""}
                </text>
              </box>
            ))
          )}
        </scrollbox>
      )}

      {step === "template" && (
        <scrollbox ref={scrollRef} style={{ flexGrow: 1, width: "100%" }}>
          {!templatesLoaded ? (
            <box style={{ height: 1, paddingLeft: 1 }}>
              <text fg={theme.textMuted}>Loading templates...</text>
            </box>
          ) : templates.length === 0 ? (
            <>
              <box style={{ height: 1, paddingLeft: 1 }}>
                <text fg={theme.textMuted}>No .prs/*.md templates found in repo root.</text>
              </box>
              <box
                style={{
                  height: 1,
                  paddingLeft: 1,
                  ...(selectedIndex === 0 && { backgroundColor: theme.primary })
                }}
              >
                <text fg={selectedIndex === 0 ? theme.selectedText : theme.text}>Manual entry</text>
              </box>
            </>
          ) : (
            [...templates, { filename: "__manual__", title: "Manual entry", content: "" }].map((t, i) => (
              <box
                key={t.filename}
                style={{
                  height: 1,
                  width: "100%",
                  paddingLeft: 1,
                  ...(i === selectedIndex && { backgroundColor: theme.primary })
                }}
              >
                <text fg={i === selectedIndex ? theme.selectedText : theme.text}>
                  {t.filename === "__manual__" ? "Manual entry" : `${t.title} (${t.filename})`}
                </text>
              </box>
            ))
          )}
        </scrollbox>
      )}

      {step === "details" && (
        <box style={{ flexDirection: "column", padding: 1 }}>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={theme.text}>{"Title: "}</text>
            <box style={{ flexGrow: 1, ...(focusedField === "title" && { backgroundColor: theme.primary }) }}>
              <text fg={focusedField === "title" ? theme.selectedText : theme.text}>
                {`${title}${focusedField === "title" ? "|" : ""}`}
              </text>
            </box>
          </box>
          <box style={{ height: 1, marginTop: 1 }}>
            <text fg={theme.text}>Description:</text>
          </box>
          <box
            style={{
              height: 4,
              width: "100%",
              ...(focusedField === "desc" && { backgroundColor: theme.backgroundPanel })
            }}
          >
            <text fg={focusedField === "desc" ? theme.text : theme.textMuted}>
              {description || (focusedField === "desc" ? "|" : "(empty)")}
            </text>
          </box>
          <box style={{ height: 1, marginTop: 1 }}>
            <text fg={theme.textMuted}>[Tab] Switch [Enter] Next</text>
          </box>
        </box>
      )}

      {step === "preview" && (
        <box style={{ flexDirection: "column", padding: 1 }}>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={theme.textMuted}>{"Repository: "}</text>
            <text fg={theme.text}>{selectedRepo?.name ?? ""}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={theme.textMuted}>{"Account:    "}</text>
            <text fg={theme.text}>{selectedRepo?.account.id ?? ""}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={theme.textMuted}>{"Source:     "}</text>
            <text fg={theme.primary}>{sourceBranch}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={theme.textMuted}>{"Dest:       "}</text>
            <text fg={theme.primary}>{destBranch}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row", marginTop: 1 }}>
            <text fg={theme.textMuted}>{"Title:      "}</text>
            <text fg={theme.text}>{title}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={theme.textMuted}>{"Description:"}</text>
          </box>
          <box style={{ height: 3 }}>
            <text fg={theme.text}>{description || "(empty)"}</text>
          </box>
          <box style={{ height: 1, marginTop: 1 }}>
            <text fg={theme.textMuted}>[Enter] Create PR [Esc] Back</text>
          </box>
        </box>
      )}
    </box>
  )
}
