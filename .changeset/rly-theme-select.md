---
"@knpkv/rly": minor
---

Add `useStoredTheme`, `useDocumentTheme`, `decodeRlyTheme`, and `ThemeSelect`, so apps share one way to remember, apply, and choose the theme instead of copying storage code. `useStoredTheme` takes an application-chosen key and lazily supplied storage, stays correct through server rendering and hydration, and keeps tabs in sync. `useDocumentTheme` themes `<html>` so the viewport canvas and scrollbars match. `Select` now shows a controlled value's label before its list mounts, including during server rendering.
