# Store facts; derive Booking and cost at read time

A Usage Event stores token counts and Attribution Inputs, not its Booking or its API-Equivalent Cost. Both are derived by pure functions when read. Pruned transcripts cannot be re-ingested, so anything computed at ingest would freeze: a sharper ticket rule or a newly priced model would never reach old events. The consequence is deliberate: a price change reprices all history, and the UI says it shows current list price.
