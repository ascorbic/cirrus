---
"@getcirrus/pds": minor
---

Proxy `com.atproto.moderation.createReport` so the Bluesky app's "Report" button works. Reports default to Bluesky's moderation service (`did:plc:ar7c4by46qjdydhdevvrndac#atproto_labeler`) with a service-auth JWT addressed to that labeler. Clients can override the target by setting the `atproto-proxy` header to a different labeler's `did#service_id`, in which case the request is routed to the resolved endpoint and the JWT is addressed there instead. Previously these reports fell through to the generic AppView proxy and were silently rejected.
