#!/bin/bash
#
# Update lexicon schemas from the official Bluesky atproto repository
#

set -e

LEXICONS_DIR="$(cd "$(dirname "$0")/../src/lexicons" && pwd)"
REPO_BASE="https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons"

echo "Updating lexicon schemas in: $LEXICONS_DIR"
mkdir -p "$LEXICONS_DIR"
cd "$LEXICONS_DIR"

# Core AT Proto schemas (dependencies)
echo "Fetching com.atproto schemas..."
curl -sS "$REPO_BASE/com/atproto/repo/strongRef.json" -o com.atproto.repo.strongRef.json
curl -sS "$REPO_BASE/com/atproto/label/defs.json" -o com.atproto.label.defs.json

# Bluesky feed schemas
echo "Fetching app.bsky.feed schemas..."
curl -sS "$REPO_BASE/app/bsky/feed/post.json" -o app.bsky.feed.post.json
curl -sS "$REPO_BASE/app/bsky/feed/like.json" -o app.bsky.feed.like.json
curl -sS "$REPO_BASE/app/bsky/feed/repost.json" -o app.bsky.feed.repost.json
curl -sS "$REPO_BASE/app/bsky/feed/threadgate.json" -o app.bsky.feed.threadgate.json

# Bluesky actor schemas
echo "Fetching app.bsky.actor schemas..."
curl -sS "$REPO_BASE/app/bsky/actor/profile.json" -o app.bsky.actor.profile.json

# Bluesky graph schemas
echo "Fetching app.bsky.graph schemas..."
curl -sS "$REPO_BASE/app/bsky/graph/follow.json" -o app.bsky.graph.follow.json
curl -sS "$REPO_BASE/app/bsky/graph/block.json" -o app.bsky.graph.block.json
curl -sS "$REPO_BASE/app/bsky/graph/list.json" -o app.bsky.graph.list.json
curl -sS "$REPO_BASE/app/bsky/graph/listitem.json" -o app.bsky.graph.listitem.json

# Bluesky richtext schemas (for facets)
echo "Fetching app.bsky.richtext schemas..."
curl -sS "$REPO_BASE/app/bsky/richtext/facet.json" -o app.bsky.richtext.facet.json

# Bluesky embed schemas
echo "Fetching app.bsky.embed schemas..."
curl -sS "$REPO_BASE/app/bsky/embed/images.json" -o app.bsky.embed.images.json
curl -sS "$REPO_BASE/app/bsky/embed/external.json" -o app.bsky.embed.external.json
curl -sS "$REPO_BASE/app/bsky/embed/record.json" -o app.bsky.embed.record.json
curl -sS "$REPO_BASE/app/bsky/embed/recordWithMedia.json" -o app.bsky.embed.recordWithMedia.json

echo ""
echo "✓ Lexicons updated successfully!"
echo ""
echo "Files fetched:"
ls -1 *.json | wc -l | xargs echo "  Total:"
echo ""
echo "To use in code, import from './lexicons/*.json'"
