---
"@knpkv/herdr-hub": minor
"@knpkv/codecommit-web": patch
---

Serve the super-app on every host's loopback listener, not only on the notification hub. The dashboard snapshot's `approvalApp` gains `superapp` (this listener renders the super-app shell) and `fleet` (this host is in a fleet; a standalone host's shell has no Fleet module). Module descriptors list the new `local` listener. The tailnet TLS listener, push and agent reports stay on the notification hub; only the hub's loopback aggregates other hosts. Code and Stacks now say they are not set up "on this computer" rather than "on this hub".
