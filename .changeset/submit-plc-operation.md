---
"@getcirrus/pds": minor
---

Implement `com.atproto.identity.submitPlcOperation`. The endpoint forwards an already-signed PLC operation to `plc.directory` on the user's behalf, so migration clients can complete an outbound move without talking to the PLC directory themselves. Pairs with the existing `com.atproto.identity.signPlcOperation` to match the reference PDS migration flow.
