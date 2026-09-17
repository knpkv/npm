# Acceptance evidence

Final visible acceptance: PASS, 2026-09-17. Native foreground Chromium on the
shared port 49222, through its existing MCP bridge. Only the monitor's tab 9 was
used; other tabs were preserved. The on-page final PASS panel was retained when
the browser slot was released to guided-review.

This validates desktop Chromium at tablet and phone viewports. No physical iPad
or Safari acceptance has been performed.

| Flow                                                                 | Result          |
| -------------------------------------------------------------------- | --------------- |
| Locked page exposes no published status                              | PASS            |
| Invalid board identifier is rejected by the form                     | PASS            |
| Keyboard login shows an empty board before publication               | PASS            |
| Lock remains reachable on an empty board                             | PASS            |
| Trusted CLI publication appears in the authenticated view            | PASS            |
| Published HTML-like text remains text, with no image or link         | PASS            |
| Clockify observation and agent elapsed duration have separate labels | PASS            |
| 390 × 844 portrait layout has no horizontal overflow                 | PASS            |
| 820 × 1180 portrait layout has no horizontal overflow                | PASS            |
| 1180 × 820 landscape layout has no horizontal overflow               | PASS            |
| Lighthouse accessibility snapshot                                    | PASS, score 100 |
| Offline state hides status and keeps Lock reachable                  | PASS            |
| Lock removes previous board title, ticket and card text from the DOM | PASS            |
| Lock restores focus to the credential input                          | PASS            |
| No application cookies, local storage or session storage             | PASS            |
| Reconnection restores the explicitly published copy                  | PASS            |
| Receipt-time ageing produces the stale state                         | PASS            |
| Console contains only deliberately induced offline network errors    | PASS            |
| No WebSocket connection                                              | PASS            |

`browser-acceptance.py` repeats these flows with synthetic data and an on-page
current-check indicator. It requires an explicitly granted browser slot, the
existing visible MCP bridge, the selected monitor tab, and the verified native
window address. Start with a fresh synthetic monitor process. Do not run against
real board data or take over another owner's browser slot.

Earlier acceptance runs found an HTTP listener scope ending after readiness and
an invalid unescaped hyphen in the browser's board-ID pattern. Both were corrected
before the final passing run. The packed CLI test now proves that the listener
continues serving after readiness; the visible form check covers the identifier
pattern.

The packed consumer also imports all three public exports and compiles a strict
TypeScript consumer against the extracted declarations. Its installation path
contains spaces. That fixture reproduced startup failure when asset loading used
an encoded URL pathname; the CLI now converts file URLs through Effect's Path
service. This startup-only correction leaves the accepted browser assets
unchanged and is verified by the packed server test.

A later startup probe found that the origin allowlist accepted port `99999`.
The regression test failed with `Success` where `Failure` was expected before
the fix. Startup now parses the origin with `Schema.URLFromString` and rejects
noncanonical representations before opening a listener. Focused tests retain
valid HTTPS, nondefault HTTPS-port and loopback cases; the packed CLI test checks
nonzero failure without exposing the invalid origin. Browser assets are unchanged.

## Independent security review

The read-only Herdr reviewer `monitor-security` reviewed the implementation and
reproduced the original quota and tracing failures. Its final narrow review found
no further findings. All three findings were fixed with focused regression tests:

| Finding                                                                          | Fix and prevention                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public traffic could consume authenticated request capacity                      | Separate public, viewer and publisher counters. Actual HTTP flood regression checks that both authenticated operations remain available.                           |
| Hostile publisher responses could expose echoed credentials through HTTP tracing | Disable transport tracing. A test first proves a normal traced client captures the synthetic echo, then verifies the publisher creates no HTTP span or leaked key. |
| Ignored browser error bodies could outlive the request scope                     | Bind requests with `HttpClient.withScope`. Tests verify cancellation for an unfinished 429 response and a timed-out 200 body, plus successful 200 decoding.        |

Parent review also found CLI failures returning success and Lock leaving prior
status in hidden DOM. Packed CLI tests assert nonzero, secret-free failures for
oversized/malformed input, invalid configuration, rejected credentials and an
unreachable destination, plus successful publication exiting zero. The visible
Lock checks above protect complete DOM clearing and empty/offline recovery.
