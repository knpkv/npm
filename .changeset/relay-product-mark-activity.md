---
"@knpkv/relay-product": minor
"@knpkv/codecommit-web": minor
"@knpkv/rly": patch
---

Relay's mark shows when Relay is working in the products. relay-product marks the launcher, panel and dock as working while a continuation sent from Relay waits on its answer, or while the product reports its own run through the registration's new `working` field; codecommit-web reports a running PR review. RelayMark's entrance now moves each stroke instead of the whole svg, and a mark that opens already working starts its loop as the entrance ends.
