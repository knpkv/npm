import { PullRequest, Account } from "@knpkv/codecommit-core";

export const mockAccount: Account = {
  id: "123456789012",
  region: "us-east-1"
};

export const mockPR: PullRequest = {
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
};

export const mockPRList: PullRequest[] = Array.from({ length: 10 }).map((_, i) => ({
  ...mockPR,
  id: `pr-${i + 1}`,
  title: `Feature ${i + 1}`,
  author: i % 2 === 0 ? "jdoe" : "alice",
}));
