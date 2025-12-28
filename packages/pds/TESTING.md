# Testing the PDS

## Testing the Firehose Locally

The firehose test script creates posts and subscribes to the event stream to verify everything works.

### Prerequisites

Make sure you have your `.dev.vars` file set up with:

```bash
DID=did:web:pds.mk.gg
HANDLE=your-handle.bsky.social
PDS_HOSTNAME=pds.mk.gg
AUTH_TOKEN=your-secret-token
SIGNING_KEY=your-signing-key
SIGNING_KEY_PUBLIC=your-public-key
```

### Run the Test

```bash
# Run the automated test
node scripts/test-firehose.js
```

This will:

1. Create 3 initial test posts
2. Subscribe to the firehose from cursor 0 (should backfill those posts)
3. Create 2 more posts while subscribed (should see in real-time)
4. Delete one post (should see delete event)
5. Show all 6 events received

### Manual Testing with wscat

```bash
# Install wscat
npm install -g wscat

# Connect to firehose
wscat -c "wss://pds.mk.gg/xrpc/com.atproto.sync.subscribeRepos"

# Or with cursor to backfill from beginning
wscat -c "wss://pds.mk.gg/xrpc/com.atproto.sync.subscribeRepos?cursor=0"
```

In another terminal, create a post:

```bash
curl -X POST https://pds.mk.gg/xrpc/com.atproto.repo.createRecord \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:web:pds.mk.gg",
    "collection": "app.bsky.feed.post",
    "record": {
      "text": "Testing the firehose!",
      "createdAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }
  }'
```

You should see the event appear on the WebSocket connection!

## Testing XRPC Endpoints

### Create a Post

```bash
curl -X POST https://pds.mk.gg/xrpc/com.atproto.repo.createRecord \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:web:pds.mk.gg",
    "collection": "app.bsky.feed.post",
    "record": {
      "text": "Hello, World!",
      "createdAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }
  }'
```

### List Posts

```bash
curl "https://pds.mk.gg/xrpc/com.atproto.repo.listRecords?repo=did:web:pds.mk.gg&collection=app.bsky.feed.post"
```

### Get a Specific Post

```bash
# Use the rkey from creating the post
curl "https://pds.mk.gg/xrpc/com.atproto.repo.getRecord?repo=did:web:pds.mk.gg&collection=app.bsky.feed.post&rkey=YOUR_RKEY"
```

### Delete a Post

```bash
curl -X POST https://pds.mk.gg/xrpc/com.atproto.repo.deleteRecord \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:web:pds.mk.gg",
    "collection": "app.bsky.feed.post",
    "rkey": "YOUR_RKEY"
  }'
```

### Export Repository as CAR

```bash
curl "https://pds.mk.gg/xrpc/com.atproto.sync.getRepo?did=did:web:pds.mk.gg" > repo.car
```

### Check Repository Status

```bash
curl "https://pds.mk.gg/xrpc/com.atproto.sync.getRepoStatus?did=did:web:pds.mk.gg"
```

## Running Unit Tests

```bash
# Run all tests
pnpm test

# Run in watch mode
pnpm test --watch

# Run specific test file
pnpm test storage.test.ts
```

## Testing with AT Protocol Tools

```bash
# Install AT Protocol dev tools
npm install -g @atproto/dev-env

# Subscribe to your firehose
atproto subscribe wss://pds.mk.gg/xrpc/com.atproto.sync.subscribeRepos
```

## Expected Firehose Frame Format

Each WebSocket frame contains two concatenated CBOR objects:

**Header:**

```javascript
{ op: 1, t: "#commit" }  // Normal commit
{ op: -1 }               // Error
```

**Body (commit event):**

```javascript
{
  seq: 123,              // Sequence number
  repo: "did:web:...",   // Repository DID
  commit: CID,           // Commit CID
  rev: "...",            // Revision
  since: "...",          // Previous revision
  blocks: Uint8Array,    // CAR file with blocks
  ops: [                 // Operations
    {
      action: "create",  // or "update", "delete"
      path: "app.bsky.feed.post/abc123",
      cid: CID           // null for deletes
    }
  ],
  blobs: [],            // Referenced blobs
  time: "2024-01-01T00:00:00Z"
}
```
