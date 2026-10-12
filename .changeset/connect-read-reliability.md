---
"@knpkv/herdr-connect": patch
"@knpkv/herdr-hub": patch
---

Stop archive reads after ten seconds with a typed timeout and Retry, without restarting the deadline on directory polls. Limit the directory's configured-host hint to the first 256 machines in configuration order so host metadata stays within the page schema's bound.
