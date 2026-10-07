---
"@knpkv/codecommit": minor
---

`codecommit web --no-open` prints the sign-in link without opening a browser. It also skips the browser when `BROWSER=none`, when `CI` is set, or when stdout is not a terminal, and says why. Test harnesses and scripts no longer open tabs in the user's browser.
