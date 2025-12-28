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

# Define schemas to fetch (namespace/name format)
schemas=(
  # Core AT Proto schemas
  "com/atproto/repo/strongRef"
  "com/atproto/label/defs"

  # Feed schemas
  "app/bsky/feed/post"
  "app/bsky/feed/like"
  "app/bsky/feed/repost"
  "app/bsky/feed/threadgate"

  # Actor schemas
  "app/bsky/actor/profile"

  # Graph schemas
  "app/bsky/graph/follow"
  "app/bsky/graph/block"
  "app/bsky/graph/list"
  "app/bsky/graph/listitem"

  # Richtext schemas
  "app/bsky/richtext/facet"

  # Embed schemas
  "app/bsky/embed/images"
  "app/bsky/embed/external"
  "app/bsky/embed/record"
  "app/bsky/embed/recordWithMedia"
)

# Fetch each schema
echo "Fetching ${#schemas[@]} schemas..."
for schema in "${schemas[@]}"; do
  # Convert path to NSID (e.g., com/atproto/repo/strongRef -> com.atproto.repo.strongRef)
  nsid="${schema//\//.}"
  file="${nsid}.json"

  echo "  → ${nsid}"
  if ! curl -fsSL "$REPO_BASE/${schema}.json" -o "$file"; then
    echo "    ✗ Failed to fetch ${nsid}" >&2
    exit 1
  fi
done

echo ""
echo "✓ Successfully fetched ${#schemas[@]} lexicon schemas!"
echo ""
