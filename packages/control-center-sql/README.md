# @knpkv/control-center-sql

Typed, dialect-specific SQL plans used by Control Center persistence.

The public boundary returns only rendered SQL and parameters. `effect-qb` plans,
tables, and types stay private so persistence repositories remain independent of
query-builder implementation details.

The first plan reads current readiness for a bounded set of releases in one
workspace-scoped query. It replaces portfolio N+1 reads while retaining Control
Center's Schema decoding, materialization verification, and quarantine boundary.

Timeline plans render four independently bounded source reads rather than one
monolithic union. The persistence adapter executes them concurrently, validates
every returned row, and performs a stable merge in application memory. This keeps
query count constant while allowing new durable activity sources to be added
without expanding one deeply coupled SQL statement.

The governed-action recovery plan selects one bounded, stable startup batch for
an explicit workspace after the recovery safety interval. It excludes actions
with a live recovery claim unless that claim has an immutable explicit expiry,
and returns identities only; claim acquisition and reconciliation remain inside
the transactional Control Center execution store.

This package does not own database initialization or migrations. During the MVP,
Control Center uses one exact unstable schema snapshot; versioned migrations begin
only after that persistence model is stable and released databases need upgrades.
