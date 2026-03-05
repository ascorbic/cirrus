# Farcaster Hub / Snapchain API Reference

## Hub Hosts

| Host | Notes |
|------|-------|
| `https://haatz.quilibrium.com/v1` | Quilibrium Snapchain node (preferred) |
| `https://hub.pinata.cloud/v1` | Pinata hub (legacy, may have rate limits) |

## Endpoints

### User Data

```
GET /v1/userDataByFid?fid={fid}
```

Returns all user data messages for a given FID.

**Response:**

```json
{
  "messages": [
    {
      "data": {
        "type": "MESSAGE_TYPE_USER_DATA_ADD",
        "fid": 1898,
        "timestamp": 12345678,
        "userDataBody": {
          "type": "USER_DATA_TYPE_DISPLAY",
          "value": "Alice"
        }
      },
      "hash": "0x...",
      "signer": "0x..."
    }
  ]
}
```

**User Data Types:**

| Type | Description |
|------|-------------|
| `USER_DATA_TYPE_PFP` | Profile picture URL |
| `USER_DATA_TYPE_DISPLAY` | Display name |
| `USER_DATA_TYPE_BIO` | Bio / description |
| `USER_DATA_TYPE_URL` | Website URL |
| `USER_DATA_TYPE_USERNAME` | Username (may be ENS name like `user.eth`) |
| `USER_DATA_TYPE_PRIMARY_ADDRESS_ETHEREUM` | Primary Ethereum address |

### Casts by FID

```
GET /v1/castsByFid?fid={fid}&pageSize=100&reverse=true
```

Returns casts authored by a given FID, paginated.

**Query parameters:**

- `fid` (required) - Farcaster ID
- `pageSize` - Number of results per page (default 100, max 100)
- `reverse` - If `true`, returns newest first
- `pageToken` - Pagination token from previous response

**Response:**

```json
{
  "messages": [
    {
      "data": {
        "type": "MESSAGE_TYPE_CAST_ADD",
        "fid": 1898,
        "timestamp": 12345678,
        "castAddBody": {
          "text": "Hello world!",
          "mentions": [456],
          "mentionsPositions": [6],
          "embeds": [{ "url": "https://example.com" }],
          "parentCastId": null
        }
      },
      "hash": "0x...",
      "signer": "0x..."
    }
  ],
  "nextPageToken": "..."
}
```

### Cast by Hash

```
GET /v1/castById?fid={fid}&hash={hash}
```

Returns a single cast by its FID and hash.

## FNAME Registry

Farcaster names (fnames) are managed separately from the Hub.

```
GET https://fnames.farcaster.xyz/transfers?fid={fid}
```

Returns transfer history for an FID. The last entry's `username` field is the current fname.

**Response:**

```json
{
  "transfers": [
    {
      "id": 123,
      "timestamp": 1234567890,
      "username": "alice",
      "owner": "0x...",
      "from": 0,
      "to": 1898
    }
  ]
}
```
