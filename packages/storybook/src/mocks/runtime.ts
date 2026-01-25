import { Atom } from "@effect-atom/atom-react";
import { Layer, SubscriptionRef, Effect } from "effect";
import { type AppState, PRService } from "@knpkv/codecommit-tui/PRService";
import { NotificationsService, type NotificationsState } from "@knpkv/codecommit-tui/NotificationsService";
import { FileSystem } from "@effect/platform";
// @ts-ignore
import { ConfigServiceLive } from "./ConfigService";

// Global ref for control from stories
let globalStateRef: SubscriptionRef.SubscriptionRef<AppState> | null = null;

export const setMockState = (state: AppState) => {
  if (globalStateRef) {
    Effect.runSync(SubscriptionRef.set(globalStateRef, state));
  }
};

// Expose on window for Storybook stories to access reliably
if (typeof window !== 'undefined') {
  (window as any).__setMockState = setMockState;
}

// Hardcoded mock data
const hardcodedPRs = [
  {
    id: "pr-1",
    title: "Update README.md",
    description: "Fixing typos in documentation",
    author: "jdoe",
    repositoryName: "my-repo",
    creationDate: new Date("2023-10-25T10:00:00Z"),
    lastModifiedDate: new Date("2023-10-25T11:00:00Z"),
    link: "https://example.com/pr/1",
    account: { id: "123", region: "us-east-1" },
    status: "OPEN",
    sourceBranch: "feature/docs",
    destinationBranch: "main",
    isMergeable: true,
    isApproved: false
  }
] as any[];

// Mock PR Service
export const makeMockPRService = Effect.gen(function*() {
  const state = yield* SubscriptionRef.make<AppState>({
    status: "idle",
    pullRequests: hardcodedPRs,
    accounts: [],
    // @ts-ignore
    lastUpdated: new Date()
  });
  
  globalStateRef = state;

  return PRService.of({
    state,
    refresh: Effect.void,
    toggleAccount: () => Effect.void,
    setAllAccounts: () => Effect.void,
    clearNotifications: Effect.void,
    addNotification: () => Effect.void
  });
});

export const MockPRServiceLayer = Layer.effect(PRService, makeMockPRService);

// Mock Notifications Service
export const makeMockNotificationsService = Effect.gen(function*() {
  const state = yield* SubscriptionRef.make<NotificationsState>({ items: [] });
  return NotificationsService.of({
    state,
    add: () => Effect.void,
    clear: Effect.void
  });
});

export const MockNotificationsServiceLayer = Layer.effect(NotificationsService, makeMockNotificationsService);

// Provide a No-Op FileSystem to satisfy any transitive dependencies
export const MockFileSystemLayer = FileSystem.layerNoop({});

// Combine Layers
export const AppLayer = Layer.mergeAll(
    MockPRServiceLayer, 
    MockNotificationsServiceLayer,
    MockFileSystemLayer,
    ConfigServiceLive
);

// Export runtimeAtom
export const runtimeAtom = Atom.runtime(AppLayer);
