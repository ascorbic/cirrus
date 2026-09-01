# Probe lexicons

The suite's probe spaces use the space type `earth.cirrus.check.space` and
write records in `earth.cirrus.check.note` / `earth.cirrus.check.withblob`.
These NSIDs are **published, resolvable lexicons** — this directory holds
the canonical documents.

## Why published probes matter

An earlier iteration used `app.bsky.group` (the proposal's example type)
and deliberately-unresolvable `test.conformance.*` collections. That works
against implementations that are lenient about unresolvable lexicons
(Cirrus, the reference alpha) but fails against any implementation that
resolves lexicons dynamically and validates strictly — reported by a
third-party implementer running the web checker. A conformance suite must
not depend on the target's leniency, so the probe NSIDs live under an
authority the suite's maintainers control and resolve for everyone. The
probe collections are still invisible to Bluesky: nothing under
`earth.cirrus.check.*` is an `app.bsky.*` lexicon, so AppViews ignore it.

## How they are published

Lexicon resolution is two steps: DNS names the authority, the authority's
repo holds the schema records.

1. DNS, on the `check.cirrus.earth` zone (covers every
   `earth.cirrus.check.*` NSID):

   ```
   _lexicon.check.cirrus.earth.  TXT  "did=did:plc:uwbl4k3tza7eyjv3morkrld2"
   ```

2. One `com.atproto.lexicon.schema` record per NSID in that DID's repo,
   rkey = the NSID, value = the JSON document in this directory.

To (re)publish after editing a document here, with the maintainer's PDS
token in `$AUTH_TOKEN`, from this directory:

```sh
for f in earth.cirrus.check.space earth.cirrus.check.note earth.cirrus.check.withblob; do
  curl -s -X POST https://mk.pds.mk.gg/xrpc/com.atproto.repo.putRecord \
    -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json;print(json.dumps({
      'repo':'did:plc:uwbl4k3tza7eyjv3morkrld2',
      'collection':'com.atproto.lexicon.schema',
      'rkey':'$f',
      'record':json.load(open('$f.json'))}))")"
  echo " $f"
done
```

Verify resolution end-to-end:

```sh
dig +short TXT _lexicon.check.cirrus.earth
curl -s "https://mk.pds.mk.gg/xrpc/com.atproto.repo.getRecord?repo=did:plc:uwbl4k3tza7eyjv3morkrld2&collection=com.atproto.lexicon.schema&rkey=earth.cirrus.check.space"
```
