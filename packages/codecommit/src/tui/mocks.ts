import { Domain } from "@knpkv/codecommit-core"
import { Schema } from "effect"

const decodeAccount = Schema.decodeSync(Domain.Account)
const decodePullRequest = Schema.decodeSync(Domain.PullRequest)

export const mockAccount = decodeAccount({
  profile: "123456789012",
  region: "us-east-1"
})

export const mockPR = decodePullRequest({
  id: "pr-1",
  title: "Update README.md",
  description: "Fixing typos in documentation",
  author: "jdoe",
  repositoryName: "my-repo",
  creationDate: new Date("2023-10-25T10:00:00Z"),
  lastModifiedDate: new Date("2023-10-25T11:00:00Z"),
  link: "https://console.aws.amazon.com/codesuite/codecommit/repositories/my-repo/pull-requests/1",
  account: mockAccount,
  status: "OPEN",
  sourceBranch: "feature/docs",
  destinationBranch: "main",
  isMergeable: true,
  isApproved: false
})

export const mockPRConflict = decodePullRequest({
  ...mockPR,
  id: "pr-conflict",
  isMergeable: false
})

export const mockPRList: Array<Domain.PullRequest> = Array.from({ length: 10 }).map((_, i) =>
  decodePullRequest({
    ...mockPR,
    id: `pr-${i + 1}`,
    title: `Feature ${i + 1}`,
    author: i % 2 === 0 ? "jdoe" : "alice"
  })
)
