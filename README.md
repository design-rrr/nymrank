# NymRank

A Nostr-based reputation and name protection system using committee-based ranking.

## Overview

NymRank leverages Web-of-Trust (WoT) reputation scores for users of a given namespace. Instead of relying on a single authority for name issuance, it aggregates rankings from a specific set of committee members to create a multi-perspective view of name occupancy. It includes a search tool to check if a specific name or handle is occupied by a well-reputed user.

## Committee Members

The system tracks delegation events from these initial committee members:

- **justin**: `3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088`
- **straycat**: `e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f`
- **vinny**: `2efaa715bbb46dd5be6b7da8d7700266d11674b913b8178addb5c2e63d987331`

These keys are used to:
- Track delegation events (kind 10040) from committee members
- Track service key delegations for ranking
- Process ranking events (kind 30382) from delegated service keys
- Compute averaged rankings across committee members

## Setup

### Prerequisites

1. PostgreSQL 17 with a database named `nymrank`
2. strfry compiled and available at `~/strfry/strfry`
   - Clone: `git clone https://github.com/hoytech/strfry.git ~/strfry`
   - Build: `cd ~/strfry && make`

### Initial Backfill

Before running the app, you must backfill attestations and delegations from the relay using negentropy:

```bash
node backfill-attestations.js
```

This will:
1. Use strfry sync with negentropy to download all delegations (kind 10040) and attestations (kind 30382) from all committee members
2. Export to JSONL
3. Import into PostgreSQL
4. Clean up temporary files

This is a one-time operation that may take several minutes.

### Database Setup

If this is your first run:

```bash
psql -d nymrank -f schema.sql
```

### Start the App

After backfill:

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The app will:
1. Fetch profiles (kind 0) for all ranked users (daily refresh)
2. Check for activity to update LastSeen display (7-day refresh)
3. Start the web UI on http://localhost:3333

## Features

- **Multi-perspective Ranking**: Averages reputation scores from all committee members
- **Name Availability**: Search tool to check if a name/handle is occupied
- **Activity Tracking**: Displays when users were last active ("Recently" for <7 days, "Xd ago" for 7-29 days, "Xmo ago" for 30+ days)
- **Name Affinity Scoring**: Scores based on name, NIP-05, and LUD-16 fields (partial name matches score lower)
- **FAQ Page**: Explains how to optimize profiles for name occupation

## Architecture

- **Backfill**: Negentropy sync via strfry for efficient historical data transfer
- **Profile Fetching**: Batched relay queries for kind 0 events with 1-day cooldown
- **Activity Checking**: Batched relay queries for various event kind with 7-day cooldown
- **Rankings**: Per-committee-member storage in DB, averaged on search/browse
- **Materialized View**: `precomputed_rankings` for fast default list queries
- **UI**: Fastify web server with search, browse, pagination, and perspective switching

## Database Schema

### Key Tables

- `user_rankings`: Individual rankings from each committee member
- `user_names`: Profile metadata (name, nip05, lud16) from kind 0 events
- `profile_refresh_queue`: Tracks profile and activity fetch timestamps
  - `profile_timestamp`: Timestamp of the kind 0 event
  - `last_activity_timestamp`: Most recent activity event
  - `last_profile_fetch`: When we last fetched kind-0 profile
  - `last_activity_check`: When we last checked for activity events

### Materialized View

`precomputed_rankings` aggregates rankings for the default list view, refreshed automatically on ranking changes.

## API Endpoints

- `GET /` - Main search/browse UI
- `GET /faq` - FAQ page (served from `/public/faq.html`)
- `GET /api-docs` - Interactive API page (form inputs + live JSON responses)
- `GET /api/status` - API health/readiness
- `GET /api/names/:name` - Resolve name occupancy (`pubkey`, `average_rank`, `name_affinity`)
- `GET /api/users/:pubkey/rank` - Averaged user rank and committee breakdown
- `GET /api/users/:pubkey/activity` - Ad-hoc activity + profile refresh (hex or npub; same family as `/api/users/:pubkey/rank`)
- `GET /healthz` - Health check
- `GET /logs` - Recent server logs

### Rankings list (`/`)

- Default view and committee **perspective** filter hide accounts whose last-seen (activity or kind-0 profile time) is older than **365 days**, so the leaderboard is not dominated by long-dormant rows. Rows with **unknown** last-seen (no timestamps) still appear.
- Append **`?include_stale=1`** or **`?all=1`** to show everyone. **Search** is not filtered.

### Background activity checks

Uses one definition of **recent**: **10 days** (same window for “activity in DB counts as fresh” and “time before we run another check”).

- **Who gets checked** (`rank_value ≥ 35`): no `last_activity_timestamp`, or it is **older than 10 days**, **and** we never checked activity or `last_activity_check` is **older than 10 days**. Anyone with activity in the DB **within 10 days** is skipped (no relay query that cycle).
- **Tier 1** — first pass, batches of **10** authors per relay filter.
- **Tier 2** — **after** tier 1, only for the **same** users who **still** have no activity in the last **10 days** in the DB; batches of **3** to mimic a tighter, nearer-to-single-key query when large batches under-return events.

## Environment Variables

- `PORT`: Server port (default: 3000)
- `DB_HOST`: PostgreSQL host (default: localhost)
- `DB_PORT`: PostgreSQL port (default: 5432)
- `DB_NAME`: Database name (default: nymrank)
- `DB_USER`: Database user (default: nymrank_user)
- `DB_PASSWORD`: Database password (default: nymrank_password)
- `RANKING_RELAY_URLS`: Comma-separated relay list for ranking/delegation (default: `wss://nip85.brainstorm.world`)
- `SOCIAL_RELAY_URLS`: Comma-separated relay list shared by profile fetching and activity checks

Copy `.env.example` to `.env` and set secrets locally:

```bash
cp .env.example .env
```

## Relay Configuration

### Ranking Relay
- `wss://nip85.brainstorm.world`

### Profile/Activity Relays
- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.primal.net`

## API Response Examples

### `GET /api/names/alice`

```json
{
  "name": "alice",
  "available": false,
  "occupant": {
    "pubkey": "abc123...",
    "average_rank": 86,
    "name_affinity": 3,
    "profile": {
      "name": "alice",
      "nip05": "alice",
      "lud16": "alice"
    }
  }
}
```

### `GET /api/users/<pubkey>/rank`

```json
{
  "pubkey": "abc123...",
  "average_rank": 82,
  "average_influence_score": 0.74,
  "average_hops": 2,
  "average_follower_count": 318,
  "perspective_count": 3,
  "profile": {
    "name": "alice",
    "nip05": "alice",
    "lud16": "alice",
    "name_affinity": 4
  },
  "committee_breakdown": []
}
```

### `GET /api/users/<pubkey>/activity`

Queries `SOCIAL_RELAY_URLS` for the author’s latest event (any kind) and kind 0 profile, then updates `last_activity_check` / `last_activity_timestamp` and profile fields when data is found. Errors use `{ "error": { "code", "message" } }` like other `/api` routes.

```json
{
  "pubkey": "e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f",
  "latest_event": {
    "id": "...",
    "kind": 1,
    "created_at": 1730000000,
    "created_at_iso": "2024-10-27T00:00:00.000Z",
    "days_ago": 12
  },
  "total_events_found": 42,
  "profile": {
    "name": "alice",
    "nip05": null,
    "lud16": null,
    "last_activity_timestamp": "1730000000",
    "profile_timestamp": "1729900000",
    "last_activity_check": "2025-03-24T12:00:00.000Z",
    "last_profile_fetch": "2025-03-24T11:58:00.000Z"
  }
}
```

`latest_event` is `null` when no events are returned from relays; `profile` is `null` if that pubkey has no row in `user_names` after the run.

## Maintenance

### Reset Activity Checks

To re-run activity checks while preserving existing activity data:

```bash
docker exec -i nymrank_postgres psql -U nymrank_user -d nymrank < reset-activity-checks.sql
```

This sets `last_activity_check` to NULL while keeping `last_activity_timestamp` intact.

