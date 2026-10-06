---
"@knpkv/codecommit-web": patch
---

No one-sided accent stripes in the CodeCommit app:

- The pull request's revision panel is a flat panel without the orange edge and tint.
- Reply threads are shown by indentation.
- Finding and comment lines in the diff have an even border.
- The Relay pane is separated by a hairline.
- A selected finding shows a background and `aria-current`, not an edge bar.
- Your own Relay turns sit on a deeper surface.
- The sandbox eyebrow loses its bar.
- rly components are no longer reset by Tailwind's preflight: page titles, buttons and state panels get their rly styles again.
- Metadata reads as plain text ("ana, 2h ago"; "Pull request 12, created …, port 8080") instead of dot-separated lists.
