---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": minor
---

feat: settings page with notifications and config management

- Add settings page (accounts, theme, config, about) to web and TUI
- Add notification profile field to NotificationItem domain model
- Add config backup/reset/validate with atomic backup (tmp+rename)
- Add SSO login/logout endpoints with semaphore and timeout
- Add notifications page with auth-error detection and inline SSO actions
- Persist theme to localStorage, debounce account toggle saves
- Add ARIA roles to web settings tabs
- Fix useMemo side-effect, exit timeout cleanup, CORS credentials
