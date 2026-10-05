# Share one owner session for loopback web apps

codecommit-web, jcf-web and agent-usage each carried a copy of the same Owner Session — about 330
lines each, with the same token roles, bootstrap cap and origin checks. The copies said why: the
policy lived inside one application, and duplicating policy over shared primitives looked like the
smaller mistake. The copies had already drifted: only two applied Fetch Metadata, one stripped a path
from a configured origin that another rejected, and only agent-usage could mint a second link.

The policy now lives in `@knpkv/browser-pairing/owner-session`, and this reverses the package's
earlier boundary that left all authorization and route policy to product packages. What moved is the
single-operator, in-memory policy: token issuance, the one-time bootstrap code and its guess cap,
request authorization (cookie, Origin, Fetch Metadata, CSRF or read-only), and the bootstrap route.
Each application keeps its HTTP API middleware, its wire error types, its cookie name, and how its
dev server presents Origin — codecommit-web's proxy rewrites Origin to the backend, the others keep
the Vite origin, so each passes the origin a browser request must carry.

The drift resolved toward the stricter rule each time: Fetch Metadata for every app, configured
origins without a path, and re-mintable bootstrap codes, minted only once the server is listening.
For codecommit-web and jcf-web that last one is deliberate, not incidental: a bootstrap request that
arrives before the first mint is refused as an invalid code (401) rather than as "not active yet"
(401), because no code exists to match.

Control Center stays out. It persists sessions and supports more than one browser, a different model
that would only be bent by sharing this one.
