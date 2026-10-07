---
"@knpkv/codecommit-web": patch
"@knpkv/codecommit": patch
---

Installing codecommit no longer downloads the web client's build tooling and browser libraries: the client ships prebuilt, so vite, tailwind, react-dom and the rest are devDependencies of codecommit-web, and codecommit drops an unused tslib.
