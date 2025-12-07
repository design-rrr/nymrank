are the ni# NymRank - Name Reputation System

## Project Overview
**NymRank** is a decentralized name reputation system for Nostr that prevents name squatting by high-reputation users and provides paid reputation boosts for available names. The system uses Nostr events as the source of truth and maintains computed aggregations for performance.

## Goal
Build a **name reputation system** that warns users when trying to register names already used by high-reputation users, and provides reputation grants for available names. Uses **kind:10040 (Delegation Events)** and **kind:30382 (Ranking Events)** from Nostr relays as the source of truth, with computed aggregations cached for performance.

## Architecture Overview
- **Core API**: Backend service that processes Nostr events and provides name reputation APIs
- **NymRank Boost**: Frontend developer tool for Nostr apps to integrate name reputation and referrals
- **Committee-Based Ranking**: Multiple trusted sources (initial members + approved referrers) provide rankings
- **Sybil Fee System**: Paid endorsements for names occupied by non-elite users or available names
- **Referrer Program**: Apps can become committee members and earn revenue from sybil fees

## Current Implementation Status
- ✅ Event capture for both kind 10040 and kind 30382 events
- ✅ PostgreSQL database with full schema
- ✅ Health endpoint at `/healthz`
- ✅ Fastify framework with auto-loading routes
- ✅ Complete database schema design
- ✅ User profile metadata ingestion (kind 0 events) with 1-day refresh
- ✅ Activity tracking (any event kind) with 7-day refresh
- ✅ Web UI with search, browse, pagination, and perspective switching
- ✅ FAQ page explaining profile optimization
- ✅ Materialized view for fast queries
- ✅ Real-time activity check endpoint (`/check-activity`)
- ✅ Open Graph meta tags for social sharing
- ❌ Sybil fee payment processing
- ❌ Referrer onboarding system

## Use Case
**Name Reputation System**: When users try to register names in social apps, warn them if high-reputation users already use those names, and provide reputation grants for available names.

**Core Workflow**:
1. User attempts to register name "alice"
2. System checks name status in order:
   - **Reserved**: Name in reserved_names table - requires manual verification
   - **Discourage Strongly**: Name occupied by elite user (rank ≥95) - no options
   - **Discourage**: Name occupied by established user (rank 75-94) - no options
   - **Caution**: Name occupied by legitimate user (rank 35-74) - resolution unlikely until following built or paid
   - **Encourage**: Name available, suggest paid reputation boost
3. For reputation upgrades: Committee manually reviews and follows to provide ranking boost

**Rank Distribution & Service Outcomes**:
- **95+**: Elite users (very strong protection) → **Discourage Strongly** (no options)
- **75-94**: Established users (strong protection) → **Discourage** (no options)
- **35-74**: Legitimate users (basic protection) → **Caution** (resolution unlikely until following is built or sybil fee paid)
- **<35**: Filtered out (likely bots/inactive) → **Encourage** (suggest paid reputation)

## Data Sources
- **Ranking Relay**: `ws://localhost:7777` (local strfry, synced from `wss://nip85.brainstorm.world`)
- **Profile/Activity Relays**: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`
- **Event kinds**: 
  - `0` (profiles) - fetched daily for name/nip05/lud16 fields
  - `10040` (delegations) - who delegates to which service keys
  - `30382` (ranking attestations) - user rankings with metrics in tags
  - Any kind (activity) - checked every 7 days for "last seen" display

## Actual Data Structure Observed

### Kind 10040 (Delegation Events)
```json
{
  "content": "",
  "created_at": 1757007439,
  "id": "12275f8efc8564f1d338d778fce8a5f5bd332075fa23365f8f742e4f895cbbe3",
  "kind": 10040,
  "pubkey": "3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088",
  "sig": "...",
  "tags": [
    ["30382:rank", "48ec018359cac3c933f0f7a14550e36a4f683dcf55520c916dd8c61e7724f5de", "wss://nip85.brainstorm.world"],
    ["30382:personalizedGrapeRank_influence", "48ec018359cac3c933f0f7a14550e36a4f683dcf55520c916dd8c61e7724f5de", "wss://nip85.brainstorm.world"]
  ]
}
```

### Kind 30382 (Ranking Events)
```json
{
  "content": "",
  "created_at": 1757007439,
  "id": "...",
  "kind": 30382,
  "pubkey": "c7b05c6335d12e61940f48af8f6d45ec293db540806eecf3e51207aa82386617",
  "sig": "...",
  "tags": [
    ["d", "e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f"],
    ["rank", "100"],
    ["hops", "0"],
    ["personalizedGrapeRank_influence", "1"],
    ["personalizedGrapeRank_average", "1"],
    ["personalizedGrapeRank_confidence", "1"],
    ["personalizedGrapeRank_input", "9999"],
    ["personalizedPageRank", "1"],
    ["verifiedFollowerCount", "1654"],
    ["verifiedMuterCount", "1"],
    ["verifiedReporterCount", "0"]
  ]
}
```

### Kind 0 (Profile Metadata)
```json
{
  "content": "{\"name\":\"alice\",\"nip05\":\"alice@domain.com\",\"lud16\":\"alice@lightning.com\"}",
  "created_at": 1757007439,
  "id": "...",
  "kind": 0,
  "pubkey": "e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f",
  "sig": "...",
  "tags": []
}
```

## Architecture Principles
- **Relay as Source of Truth**: Nostr relay is the authoritative event store
- **Computed Aggregations**: Only store processed data, not raw events
- **Real-time Processing**: Continuous subscription, no batching
- **Resilient**: Serve cached data when relay is down
- **Name Affinity**: 1-4 points based on name fields (name=2, nip05=1, lud16=1)

## Name Affinity System
**Purpose**: Prevent gaming while properly weighting different types of name claims

**Scoring**:
- `name` field: 2 points (primary identifier)
- `nip05` username prefix: 1 point (extract "user" from "user@domain.com", **must verify with a lookup**)
- `lud16` username prefix: 1 point (extract "user" from "user@domain.com")
- **Total**: 0-4 points

**Name Occupation Rules**:
- Only occupy names with affinity ≥ 2
- Prevents random lud16/nip05 from triggering occupation
- Allows users to occupy multiple names if they have sufficient affinity for each
- Breaks ties when users have identical ranks

**Name Validation**:
- `name` field must be a valid slug (alphanumeric, hyphens, underscores only)
- Invalid names like "First Last" (with spaces) are disregarded
- Only valid slug-formatted names contribute to affinity scoring

**Examples**:
- User with `name="jack"` only: affinity = 2 ✅ (occupies name "jack")
- User with `name="jack"` + `nip05="jack@domain.com"`: affinity = 3 ✅ (occupies name "jack")
- User with `name="jack"` + `nip05="jack@domain.com"` + `lud16="jack@lightning.com"`: affinity = 4 ✅ (occupies name "jack")
- User with only `lud16="jack@random.com"`: affinity = 1 ❌ (doesn't occupy name)
- User with `name="First Last"` (invalid slug): affinity = 0 ❌ (name field disregarded)

**Username Extraction**:
- `nip05="alice@domain.com"` → extract "alice" for name occupation
- `lud16="bob@lightning.com"` → extract "bob" for name occupation
- Only the username prefix is used for name protection, not the full identifier

**Edge Case - Multiple Name Occupation**:
- User with `name="jake"` + `nip05="jack@domain.com"` + `lud16="jack@lightning.com"`: 
  - Affinity for "jake" = 2 ✅ (occupies "jake" via name field)
  - Affinity for "jack" = 2 ✅ (occupies "jack" via nip05/lud16 username prefixes)
  - **Result**: User occupies both "jake" and "jack" names

## Committee-Based Ranking System

**Purpose**: Use a committee of trusted members to provide averaged rankings for more reliable name protection.

**Committee Members**:
- **Initial**: justin, straycat, vinny (foundation members to bootstrap service)
- **Referrers**: Onboarded developers/companies using NymRank Boost
- **Equal Weight**: All members contribute equally to rankings.

**Process**:
1. Committee members delegate to service keys via `kind:10040` events
2. Service keys publish rankings via `kind:30382` events on behalf of committee members
3. System tracks individual rankings by committee member in `user_rankings` table
4. Computes averaged rankings for each user in `averaged_user_rankings` table
5. Uses averaged rankings for name protection decisions

**Example Event Processing**:
```javascript
// When processing a kind:30382 event
async function processRankingEvent(event) {
  // Extract the committee member who delegated this service key
  const servicePubkey = event.pubkey;
  const committeeMember = await getCommitteeMemberByServiceKey(servicePubkey);
  
  // Extract the ranked user and rank value
  const rankedUser = event.tags.find(tag => tag[0] === 'd')[1];
  const rankValue = parseInt(event.tags.find(tag => tag[0] === 'rank')[1]);
  
  // Update individual committee member's ranking
  await updateUserRanking(rankedUser, servicePubkey, committeeMember.pubkey, rankValue);
  
  // Recompute averaged ranking for this user
  await recomputeAveragedRanking(rankedUser);
  
  // Update name reputations if this affects name protection
  await updateNameReputations(rankedUser);
}
```

**Benefits**:
- Reduces single-point-of-failure bias
- More stable rankings over time
- Consensus-based reputation system
- Transparent committee governance
- **Network Effect**: More referrers = more diverse, robust rankings
- **Incentive Alignment**: Quality apps get voting power for joining

## Sybil Fee System

**Purpose**: Allow users to pay for committee endorsement when names are weakly occupied.

**Process**:
1. User requests name that's occupied by rank 35-94 users (non-elite)
2. System offers tiered sybil fee endorsement based on current occupant's rank:
   - **Premium** (85-94): Higher fee to endorse over established influencers
   - **Standard** (75-84): Medium fee to endorse over professionals  
   - **Basic** (35-74): Lower fee to endorse over legitimate users
3. User pays appropriate sybil fee tier (pricing determined externally)
4. Committee manually reviews payment and follows user
5. Committee follows skew the averaged rankings in user's favor
6. Future: Automatic sybil receipt integration for seamless processing

**Benefits**:
- **Reputation Protection**: Higher fees prevent endorsing nobodies over established users
- **System Integrity**: Maintains NymRank's credibility through incentive alignment
- **Committee Control**: Manual review ensures quality and prevents reputation damage
- **Ranking Influence**: Committee follows provide ranking boost for endorsed users

**Future Enhancements**:
- Automatic sybil receipt verification
- Dynamic pricing integration (external pricing service)
- Amount-based ranking influence (higher fees = more committee follows)
- Committee member specialization (some only deal with sybil fee users)

## Database Schema (Computed Aggregations Only)

### User Rankings (from kind 30382 events)
Stores individual committee member perspectives. Each row represents one committee member's view of one ranked user.

**Key Insight**: The `influence_score` (from `personalizedGrapeRank_influence` tag) is the primary reputation score. This is what we use for name protection decisions. Averaging happens at query time, not storage time.

```sql
CREATE TABLE user_rankings (
    ranked_user_pubkey VARCHAR(64) NOT NULL,           -- The user being ranked
    service_pubkey VARCHAR(64) NOT NULL,               -- Service key that published the ranking
    committee_member_pubkey VARCHAR(64) NOT NULL,      -- Committee member who delegated to service key
    rank_value INTEGER NOT NULL,                       -- Raw rank (0-100) from 'rank' tag
    hops INTEGER DEFAULT 0,                            -- Network distance from 'hops' tag
    influence_score DOUBLE PRECISION,                  -- PRIMARY SCORE from 'personalizedGrapeRank_influence' tag
    average_score DOUBLE PRECISION,                    -- From 'personalizedGrapeRank_average' tag
    confidence_score DOUBLE PRECISION,                 -- From 'personalizedGrapeRank_confidence' tag
    input_value DOUBLE PRECISION,                      -- From 'personalizedGrapeRank_input' tag
    pagerank_score DOUBLE PRECISION,                   -- From 'personalizedPageRank' tag
    follower_count INTEGER DEFAULT 0,                  -- From 'verifiedFollowerCount' tag
    muter_count INTEGER DEFAULT 0,                     -- From 'verifiedMuterCount' tag
    reporter_count INTEGER DEFAULT 0,                  -- From 'verifiedReporterCount' tag
    event_timestamp TIMESTAMP NOT NULL,                -- Timestamp of the kind 30382 event
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ranked_user_pubkey, service_pubkey, committee_member_pubkey),
    INDEX idx_ranked_user (ranked_user_pubkey),
    INDEX idx_rank_value (rank_value),
    INDEX idx_ranking_service (service_pubkey),
    INDEX idx_committee_member (committee_member_pubkey),
    FOREIGN KEY (committee_member_pubkey) REFERENCES committee_members(pubkey)
);
```

### Committee Members (Initial + Referrers)
```sql
CREATE TABLE committee_members (
    pubkey VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255),
    type ENUM('initial', 'referrer') NOT NULL,
    app_name VARCHAR(255),
    app_url VARCHAR(255),
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    INDEX idx_type (type),
    INDEX idx_is_active (is_active)
);

-- Insert initial committee members
INSERT INTO committee_members (pubkey, name, type) VALUES 
('3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088', 'justin', 'initial'),
('e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f', 'straycat', 'initial'),
('2efaa715bbb46dd5be6b7da8d7700266d11674b913b8178addb5c2e63d987331', 'vinny', 'initial');
```

### Delegations (from kind 10040 events)
```sql
CREATE TABLE delegations (
    delegator_pubkey VARCHAR(64) NOT NULL,
    service_pubkey VARCHAR(64) NOT NULL,
    perspective_hex VARCHAR(64) NOT NULL,
    source_relay TEXT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (delegator_pubkey, service_pubkey, perspective_hex),
    INDEX idx_delegator (delegator_pubkey),
    INDEX idx_service (service_pubkey),
    INDEX idx_perspective (perspective_hex),
    FOREIGN KEY (delegator_pubkey) REFERENCES committee_members(pubkey)
);
```

### User Names (from kind 0 events)
```sql
CREATE TABLE user_names (
    pubkey VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255),
    nip05 VARCHAR(255),
    lud16 VARCHAR(255),
    name_affinity INTEGER DEFAULT 0,     -- 0-4 based on fields present
    primary_name VARCHAR(255),           -- Best name to use
    profile_timestamp BIGINT,            -- Timestamp of the kind 0 event
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_name (name),
    INDEX idx_nip05 (nip05),
    INDEX idx_lud16 (lud16),
    INDEX idx_primary_name (primary_name),
    INDEX idx_name_affinity (name_affinity)
);

-- Name occupations (handles multiple names per user)
CREATE TABLE name_occupations (
    pubkey VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    affinity INTEGER NOT NULL,
    name_source ENUM('name', 'nip05', 'lud16', 'combined') NOT NULL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pubkey, name),
    INDEX idx_name (name),
    INDEX idx_affinity (affinity),
    INDEX idx_pubkey (pubkey)
);

-- Profile refresh queue (for stale profile and activity management)
CREATE TABLE profile_refresh_queue (
    pubkey VARCHAR(64) PRIMARY KEY,
    profile_timestamp BIGINT NOT NULL,    -- Timestamp of the kind 0 event we're using
    last_activity_timestamp BIGINT,       -- Most recent activity timestamp from any event
    last_profile_fetch TIMESTAMP,         -- When we last fetched kind-0 profile (1-day cooldown)
    last_activity_check TIMESTAMP,        -- When we last checked for activity events (7-day cooldown)
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    priority INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    INDEX idx_queued_at (queued_at),
    INDEX idx_priority (priority),
    INDEX idx_retry_count (retry_count)
);
```

### Averaged User Rankings (computed on-demand)
**Note**: We don't store averaged rankings in a table. Instead, we compute averages at query time:

```sql
-- Query to get averaged influence score for a user (computed on-demand)
SELECT 
    ranked_user_pubkey,
    AVG(influence_score) as avg_influence_score,
    AVG(rank_value) as avg_rank_value,
    COUNT(DISTINCT committee_member_pubkey) as committee_votes,
    MAX(influence_score) as max_influence,
    MIN(influence_score) as min_influence
FROM user_rankings 
WHERE ranked_user_pubkey = ?
GROUP BY ranked_user_pubkey;
```

**Why no table?**: 
- Averages are fast to compute (single query)
- Keeps schema simple
- No sync issues between individual and averaged rankings
- Currently only 1 committee member, but designed for multiple

### Name Reputations (computed aggregations)
```sql
CREATE TABLE name_reputations (
    name VARCHAR(255) PRIMARY KEY,
    total_guardians INTEGER DEFAULT 0,
    avg_rank DECIMAL(5,2),
    max_rank INTEGER,
    name_affinity INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_avg_rank (avg_rank),
    INDEX idx_max_rank (max_rank),
    INDEX idx_name_affinity (name_affinity)
);
```

### Reputation Grants
```sql
CREATE TABLE reputation_grants (
    grantor_pubkey VARCHAR(64) NOT NULL,
    grantee_pubkey VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    amount INTEGER DEFAULT 1,
    status ENUM('pending', 'active', 'revoked') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (grantor_pubkey, grantee_pubkey, name),
    INDEX idx_grantee (grantee_pubkey),
    INDEX idx_name (name),
    INDEX idx_status (status)
);
```

### Sybil Fee Payments
```sql
CREATE TABLE sybil_fee_payments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_pubkey VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    tier ENUM('premium', 'standard', 'basic') NOT NULL,
    amount_sats INTEGER NOT NULL,
    referrer_pubkey VARCHAR(64) NOT NULL,
    referrer_clink_offer TEXT,
    status ENUM('pending', 'paid', 'confirmed', 'refunded') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP NULL,
    confirmed_at TIMESTAMP NULL,
    INDEX idx_user (user_pubkey),
    INDEX idx_name (name),
    INDEX idx_tier (tier),
    INDEX idx_status (status),
    INDEX idx_referrer (referrer_pubkey)
);
```

### Referrer Onboarding
```sql
CREATE TABLE referrer_onboarding (
    app_pubkey VARCHAR(64) PRIMARY KEY,
    app_name VARCHAR(255) NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_status (status)
);
```

### Reserved Names (Trademarked/Protected)
```sql
CREATE TABLE reserved_names (
    name VARCHAR(255) PRIMARY KEY,
    reason ENUM('trademark', 'copyright', 'legal', 'committee_decision') NOT NULL,
    description TEXT,
    requires_manual_verification BOOLEAN DEFAULT TRUE,
    added_by VARCHAR(64) NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    INDEX idx_reason (reason),
    INDEX idx_requires_verification (requires_manual_verification),
    INDEX idx_is_active (is_active),
    FOREIGN KEY (added_by) REFERENCES committee_members(pubkey)
);

-- Example reserved names
INSERT INTO reserved_names (name, reason, description, added_by) VALUES 
('bitcoin', 'trademark', 'Bitcoin trademark protection', '3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088'),
('ethereum', 'trademark', 'Ethereum Foundation trademark', '3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088'),
('nostr', 'trademark', 'Nostr protocol trademark', '3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088');
```

## Real-time Event Processing Pipeline
1. **Continuous Subscription**: Connect to `wss://nip85.brainstorm.world` with `{ kinds: [10040, 30382] }`
2. **Event Processing**: Process events as they arrive (no batching)
3. **Event Types**:
   - **Kind 10040**: Update `delegations` table with delegation relationships
   - **Kind 30382**: Update `user_rankings` table for specific committee member (filter by rank ≥35 threshold)
4. **Profile Metadata Fetching**: 
   - **Atomic**: Fetch kind 0 events from profile relays when processing new ranked users
   - **Smart Refresh**: Queue-based refresh for stale profiles with cooldown periods
5. **Aggregation Updates**: 
   - Recompute `averaged_user_rankings` when individual committee rankings change
   - Recompute `name_reputations` when averaged rankings change
6. **Resilience**: Serve cached data when relay is down

## Profile and Activity Fetching Strategy

### Two-Stage Approach

**Stage 1: Profile Fetching (Kind 0)**
- **Trigger**: On startup for all ranked users with `last_profile_fetch` older than 1 day
- **Method**: Batched relay queries (500 pubkeys per batch for replaceable kind-0 events)
- **Relays**: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`
- **Query**: `{ kinds: [0], authors: [batch_pubkeys], limit: 500 }`
- **Updates**: `profile_timestamp`, `last_profile_fetch` in `profile_refresh_queue`

**Stage 2: Activity Checking (Any Kind)**
- **Trigger**: After profile fetch, for users with `last_activity_check` NULL or older than 7 days
- **Method**: Batched relay queries (5 pubkeys per batch to stay within relay limits)
- **Relays**: Same as profile relays
- **Query**: `{ authors: [batch_pubkeys], limit: 500 }` (no kinds filter = any kind)
- **Since Filter**: Uses `last_activity_timestamp` from previous checks to only fetch newer events
- **Updates**: `last_activity_timestamp`, `last_activity_check` in `profile_refresh_queue`

### Key Design Decisions

1. **Separate timestamps for profile vs activity**: 
   - `last_profile_fetch`: When we last fetched kind-0 (1-day cooldown)
   - `last_activity_check`: When we last checked for any activity (7-day cooldown)
   - `last_activity_timestamp`: The actual timestamp of the user's most recent event

2. **Re-batching for users without results**:
   - Users with activity in a batch get `last_activity_check` updated
   - Users without activity in a batch do NOT get `last_activity_check` updated (they get re-batched)
   - Exception: If an entire batch returns 0 events after retry, all users in that batch are marked as checked (legitimately inactive)

3. **Relay error handling**:
   - Uses `subscribeEose` with `onclose` callback to detect relay errors
   - Retries with longer timeout (15s → 30s) if 0 events received
   - Logs relay-specific errors for debugging

4. **Since filter optimization**:
   - Only uses `since` filter if `last_activity_check` is NOT NULL (we've done a proper check before)
   - This prevents using stale `last_activity_timestamp` values from before activity checking was implemented

### Benefits:
- **Efficient**: Only fetch when needed, respects cooldown periods
- **Resilient**: Multiple relay sources, retry logic, error handling
- **Scalable**: Batched processing with delays prevents relay abuse
- **Accurate**: Separate tracking for profile freshness vs activity freshness
- **Incremental**: Uses `since` filter to only fetch new events on subsequent checks

## Name Reputation API Endpoints

### 1. Core Name Reputation APIs
- `GET /api/names/{name}` - Check name status (returns pubkey, average_rank, name_affinity)
- `GET /api/names/{name}/suggestions?display_name={display_name}&about={about}&nip05={nip05}&lud16={lud16}` - Suggest available name suggestions based on profile context

### 2. Reputation Boost APIs
- `POST /api/reputation/boost` - Request paid reputation boost (sybil fee)
- **Note**: Pricing determined by external service, not hardcoded

### 3. Referrer APIs
- `POST /api/referrer/onboard` - Request referrer status (app integration)
- `POST /api/reputation/boost` - Request with referrer's Clink offer
- **Note**: NymRank Boost requires Clink SDK (`@shocknet/clink-sdk`) for payment facilitation

### 5. System APIs
- `GET /healthz` - System health (✅ implemented)

## PostgreSQL Setup Instructions

### Run PostgreSQL with Docker
```bash
# Pull and run PostgreSQL container
docker run -d \
  --name nymrank_postgres \
  -e POSTGRES_DB=nymrank \
  -e POSTGRES_USER=nymrank_user \
  -e POSTGRES_PASSWORD=your_password_here \
  -p 5432:5432 \
  -v postgres_data:/var/lib/postgresql/data \
  postgres:17

# Verify container is running
docker ps
```

### Verify Setup
```bash
# Connect to the running container
docker exec -it nymrank_postgres psql -U nymrank_user -d nymrank

# The database and user are automatically created by the environment variables
# You can verify with:
\dt
\du

# Exit psql
\q
```

### Environment Variables
Create a `.env` file in the project root:
```bash
DB_HOST=localhost
DB_PORT=5432
DB_NAME=nymrank
DB_USER=nymrank_user
DB_PASSWORD=your_password_here
```

### Test Connection
```bash
# Test connection from command line (requires psql client)
psql -h localhost -U nymrank_user -d nymrank

# Or test via Docker container
docker exec -it nymrank_postgres psql -U nymrank_user -d nymrank
```

## Implementation Priority

### Phase 1: Core Infrastructure (Current Priority)
1. **Create database schema** - Execute DDL to create tables
2. **Implement event ingestion** - Parse JSONL files and insert into database
3. **Create basic API routes** - Start with event retrieval endpoints

### Phase 2: Data Processing
1. **Add data processing** - Parse content JSON and normalize data
2. **Implement aggregation** - Add entity-centric and analytics endpoints
3. **Add caching** - Implement caching for performance

### Phase 3: Advanced Features
1. **Real-time updates** - Add WebSocket support for live data
2. **Advanced analytics** - Add more sophisticated metrics and insights
3. **API documentation** - Add OpenAPI/Swagger documentation

## Example API Responses

### GET /api/names/bitcoin
```json
{
  "name": "bitcoin",
  "pubkey": "reserved",
  "average_rank": 100.0,
  "name_affinity": 4
}
```

### GET /api/names/alice
```json
{
  "name": "alice",
  "pubkey": "e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f",
  "average_rank": 95.5,
  "name_affinity": 4
}
```

### GET /api/names/bob
```json
{
  "name": "bob",
  "pubkey": "def456...",
  "average_rank": 82.3,
  "name_affinity": 3
}
```

### GET /api/names/charlie
```json
{
  "name": "charlie",
  "pubkey": null,
  "average_rank": null,
  "name_affinity": null
}
```

### GET /api/names/alice/suggestions?display_name=Alice%20Smith&about=Bitcoin%20developer&nip05=alice@domain.com&lud16=alice@lightning.com
```json
{
  "name": "alice",
  "suggestions": [
    "alicebtc",
    "alice_dev"
  ]
}
```

### GET /api/status
```json
{
  "relay_connected": true,
  "last_update": "2024-01-15T10:30:00Z",
  "total_users": 1250,
  "total_names": 3420,
  "avg_rank": 95.5,
  "uptime": "2d 14h 30m"
}
```

## Implementation Notes
- **Architecture**: Relay as source of truth, computed aggregations only
- **Processing**: Real-time event processing, no batching
- **Resilience**: Serve cached data when relay is down
- **Name Affinity**: 1-4 points based on name fields (name=2, nip05=1, lud16=1)
- **Rank Threshold**: Filter events by minimum rank (≥35, not bots)
- **Reputation Grants**: Follow mechanism for now, explicit flagging later
- **Staleness**: Currently uses profile timestamp age for staleness penalty. Future enhancement: track last_event_timestamp for true activity detection by periodically querying for users' most recent events

## Project Structure
```
nymrank/
├── gpt.md                    # This document - complete system design
├── event_analysis.md         # Data analysis and event structure insights
├── app.js                    # Main application entry point
├── package.json              # Node.js dependencies
├── README.md                 # Basic project overview
├── nymrank-boost/            # Developer tool for Nostr apps
│   ├── README.md             # Boost documentation and integration guide
│   ├── package.json          # Boost dependencies (includes @shocknet/clink-sdk)
│   └── .gitignore            # Standard Node.js gitignore
├── delegation_events.jsonl   # Captured delegation events (kind 10040)
└── raw_events.jsonl          # Captured ranking events (kind 30382)
```

## Key Dependencies
- **Node.js**: Runtime environment
- **Fastify**: Web framework with auto-loading routes
- **PostgreSQL**: Database for computed aggregations
- **Nostr**: Event sourcing via WebSocket connections to relays
- **@shocknet/clink-sdk**: Payment processing for sybil fees (NymRank Boost)

## Committee Members (Initial)
- **justin**: `3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088`
- **straycat**: `e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f`
- **vinny**: `2efaa715bbb46dd5be6b7da8d7700266d11674b913b8178addb5c2e63d987331`

## Next Steps for Implementation
1. **Database Setup**: Create all tables from the schema
2. **Event Processing**: Implement real-time subscription and processing pipeline
3. **Profile Ingestion**: Add kind 0 event processing with NIP-05 verification
4. **API Implementation**: Build all endpoint handlers
5. **Committee Management**: Implement member onboarding and delegation tracking
6. **Payment Integration**: Add Clink SDK integration for sybil fees
7. **Referrer System**: Build onboarding and renewal workflows
8. **Testing**: Comprehensive testing of all components
9. **Deployment**: Production deployment with monitoring
