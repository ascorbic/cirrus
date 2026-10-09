# Resolve locally owned feeds without public self-fetches

The getFeed proxy resolves the feed creator's DID and fetches its feed record over HTTP,
even when the creator is the local account. On Cloudflare, a same-zone fetch cannot target
an ordinary Worker route. A did:web document served through such a route can therefore
work for external clients but time out when fetched from its own PDS.

Observed on Cirrus 0.19.0: two authenticated requests spent 3015 ms and 3010 ms in DID
resolution, returning no document. Feed-record lookup never ran. Both fell back to AppView
service-auth claims. Current upstream ce1c36e retains this resolution path.

Fix: when the parsed feed repository equals the configured account DID, read the generator
record from the existing account DO. Validate its service DID identically to a remote
record. Keep remote resolution and missing-record fallback unchanged. Do not synthesize
DID documents (especially for did:plc identities) or introduce a stale feed-record cache.

Validation: initial and cursor requests must use the generator service-auth audience/method
with no public DID/getRecord fetch. Missing local records must retain the existing fallback;
remote feeds remain covered by existing proxy tests. Final test results are recorded in the
accompanying PR draft after execution.

References:

- https://developers.cloudflare.com/workers/configuration/routing/routes/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

Results: PDS and dependency builds passed; all 23 proxy tests passed with the patch.
All three new local-feed regressions failed against unchanged upstream. A backport to Cirrus 0.19.0 was deployed for a live trial: local lookup took
156 ms and 75 ms, with successful generator resolution. Full client initial and cursor
requests took 2542 ms and 2776 ms, returned five posts each, and had no cross-page duplicates.
These are separate live samples rather than a controlled benchmark.
