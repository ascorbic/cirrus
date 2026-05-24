---
"@getcirrus/pds": minor
---

The firehose now emits the sync 1.1 message shape, matching what the bsky.network relay and other AT Protocol consumers expect. Existing subscribers will start seeing new fields and new event types; nothing has to change on the consumer side, but the warnings some relays were logging against Cirrus hosts (notably `missing prevData field`) will stop.

What changed on the wire:

- `#commit` messages now include `prevData` (the prior commit's MST root CID), so relays can verify each commit inductively without re-fetching the repo. The CAR slice now also carries the MST covering-proof blocks needed for that verification.
- Each `ops[]` entry on update and delete now includes `prev`, the previous CID of the touched record. Creates omit it as before.
- `tooBig` is always `false`. It was previously set based on payload size, which never matched the field's meaning under sync 1.1.
- New `#account` events are emitted on activation and deactivation, so relays learn about account status changes without polling. Deactivation reports `status: "deactivated"`; activation reports `active: true` with no status.
- New `#sync` events are emitted on activation (after migration or initial setup), giving relays the current commit block without a diff.
- `#identity` events now allow the `handle` field to be omitted, per spec.
- A `#info` frame with `name: "OutdatedCursor"` is sent when a client connects with a cursor older than the retained event window. The stream continues from the oldest available event instead of disconnecting.
- `applyWrites` rejects calls with more than 200 operations, matching the spec cap.
