---
"@knpkv/herdr-hub": minor
"@knpkv/herdr-connect": minor
---

Add the Connect home descriptor and migrate hub destinations only when their source pages are retired and their replacement pages are installed. Connect stage, approval, Work and Usage selectors survive redirects, while the shell preserves foreign history state.

Primary module links open their declared default page without resuming a previous object selection or filter. Module sections remain mounted while inactive; page-local state survives a page switch only when the pages render a shared owner component, as Fleet does.

Add an optional discriminated Home presentation to ConnectSurface, with a host-owned summary above the directory. Fleet remains the default; directory reads, stage selection, pins and terminal callbacks keep one owner.

Install Connect home as the canonical landing page, with flat installed-only sidebar and phone destinations, settings in More, and Fleet Approvals/Work through fleetHubModule. The standalone Fleet surface retains all four pages. Add typed primaryModules and optional FleetShell pages for canonical composition.

Add Usage By tool from the existing reported host/tool/model data; unknown hosts never count as zero. Move the authenticated summary API to /v1/modules/connect/needs-you; the retired Today API returns 404. needsYouRouteOwner identifies the reserved collector route.

Export one explicit Fleet/Home/push agent-group policy. Home includes Ready/Idle and truthful relationship labels, while Fleet's unknown-state fallback remains unchanged. Clearing filters in a hidden Connect owner no longer steals focus.

Add optional agentStatePresentation policy and Creature statePolicy, defaulting to Fleet. Home's unknown agent has caution wording without a needs-you pose. Fleet host filtering matches host names case-insensitively, consistently with Home and selectors.

Require SuperappShell session access and connection state from its composition. The footer distinguishes local/Tailscale access, retained readings while reconnecting, and an unreachable hub without claiming connected.

Add ConnectSurface active (default true) for inactive embedded modules: release the stage portal and watched-agent presence while keeping saved selection, polls, pins and terminal/session ownership alive.

Add the shell terminalOwnsKeys input so Connect Home retains Ask Relay summon keys until an active connected terminal reserves them; legacy Fleet Connect ownership is unchanged.

Only the displayed Fleet limits footer owns its poll. Home performs no limits read; Fleet starts that read after the directory loads and the footer is shown, including its terminal presentation policy.

Add optional ModuleViews.navigationBadge for owner-supplied bounded readings. Fleet uses its existing pending approvals, marks partial counts with a plus and stale counts as a previous reading, and shares expiry-aware counting with the app icon badge. Unknown readings have an accessible label without a visible zero badge. No unread notification count is claimed.

The active Connect terminal keeps its existing full-screen layout, hides shell chrome from focus and accessibility, and restores the Home document scroll on return.

Home's Done label uses the design's neutral shared check glyph through an additive AgentStateLabel statePolicy; Fleet retains its positive tone. Failed terminal focus transitions are announced with actionable words instead of internal reason codes.

Add an optional Home empty-state slot and shell-owned openHostAccess mount callback. Empty Home links only to existing Fleet Work and Host access. Silent-host Home rows say Unknown with cached work and reported last-activity time; Fleet retains its last-known labels.

Add an optional AgentStage presentation for Home navigation chrome. Phone Back and desktop Close use the existing selection close and focus-return path; Fleet's header and both stage bodies stay unchanged.

Add optional module-page `showInPhoneTitle` metadata for designed phone mast labels.

Connect Home retains Active/Archived navigation, including read-only closed stages and retained older-page recovery. The optional paired directoryLocation owns URL and navigation together; absent keeps standalone history unchanged. Embedded hub owners require that pair, build links from their saved Connect location and preserve shell/foreign history through the shell navigator. Inactive archive portals and expired-selection repair are suppressed while closure selection and loaded pages remain retained. Paging and retry transitions keep keyboard focus in the archive and move it to the new result or recovery control.

The canonical Connect module forwards the dashboard notification state to its stage footer, avoiding a competing device-state read.

Inactive Connect releases its document and viewport locks while retaining the terminal socket. Reactivation restores guarded terminal focus once. Leaving Active for Archived releases terminal ownership so shell chrome and summon keys recover. URL-selected stage close removes selectors through replace navigation without remounting the directory; a repeated incoming selection reopens it.

Returning to a module keeps its owner's arrival focus, such as Work goal details. History traversal also preserves focus claimed inside the destination; explicit page-focus requests stay unchanged. URL-owned stages follow history selector changes and return focus to their agent row; local stages and filters remain owned by the retained directory.

Empty Home keeps a compact Approvals unknown link when the independent approval reading is incomplete or failed. By tool retains its reported range during range updates and names failed retained readings with their timestamp and five-minute retry cadence.

Controlled Connect locations also supply selection dismissal. Archived-stage Close consumes the shell-owned pushed entry, or replaces a direct/reloaded selection, so Back does not reopen it. Standalone history stays unchanged. Approval-count copy uses the singular noun for one waiting approval.
