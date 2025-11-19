# NymRank

A Nostr-based reputation and name protection system using committee-based ranking.

## Overview

NymRank leverages WoT reputation scores for users of a given namespace. Instead of relying on a single authority for name issuance, it aggregates rankings from a specific set of members to create a multi-perspective affinity. It also includes a search tool to check if a specific name or handle is occupied by a well-reputed user.

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
1. Fetch profiles (kind 0) for all ranked users
2. Track activity (any event authored by ranked users) for staleness calculation
3. Start the web UI on http://localhost:3000

## Features

- **Multi-perspective Ranking**: Averages reputation scores from all committee members
- **Name Availability**: Search tool to check if a name/handle is occupied
- **Activity Tracking**: Displays when users were last active (profile update or any event)
- **Staleness Penalties**: Adjusts reputation scores based on inactivity

## Architecture

- **Backfill**: Negentropy sync via strfry for efficient historical data transfer
- **Profiles**: Batched relay queries for kind 0 events with 24-hour cooldown
- **Rankings**: Per-committee-member storage in DB, averaged on search/browse
- **UI**: Fastify web server with search, browse, and pagination

## Environment

- `PORT`: Server port (default: 3000)
- `DATABASE_URL`: PostgreSQL connection string (uses env var or defaults to nymrank DB)

