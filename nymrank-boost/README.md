# NymRank Applications

## Overview
NymRank provides a core API for name reputation data. Separate applications consume this API to provide user-facing services.

## Core API
**NymRank API** - Provides raw name reputation data:
- `GET /api/names/{name}` - Returns pubkey, average_rank, name_affinity
- `GET /api/users/{pubkey}/rank` - Returns user ranking data

## Frontend Applications

### NymRank Boost
**Purpose**: Developer tool for Nostr apps to integrate name reputation + referrals

**Features**:
- **Name lookup API** - Check name status for users
- **Referral system** - Apps can take sybil fees themselves
- **Clink integration** - Apps provide Clink offers for payment facilitation

**Developer Integration**:
1. App integrates NymRank Boost API + Clink SDK (`@shocknet/clink-sdk`)
2. User tries to register name in app
3. App checks name status via API
4. If occupied: App asks the user to pick another name (or your own naming flow)
5. If available: App offers reputation boost with their Clink offer
6. Payment goes to referrer, callback handled by referrer's system

**Network Effect - Referrer Rankings**:
- Onboarded developers/companies become committee members
- Their user rankings get equal weight in averaged rankings
- More referrers = more diverse, robust reputation system
- Strong incentive for quality apps to join (they get voting power)
- Creates self-reinforcing network of trusted Nostr applications

## API Examples

### POST /api/reputation/boost
```json
{
  "user_pubkey": "abc123...",
  "name": "charlie",
  "referrer_pubkey": "def456..."
}
```

**Response:**
```json
{
  "bolt11": "lnbc5000n1p..."
}
```

**Error Response (calls exhausted):**
```json
{
  "error": "calls_exhausted",
  "message": "Referrer has exhausted their API calls. Please renew.",
  "calls_remaining": 0,
  "renewal_required": true
}
```

### POST /api/referrer/onboard
```json
{
  "app_pubkey": "def456...",
  "app_name": "MyNostrApp"
}
```

**Response:**
```json
{
  "clink_offer": "lnbc100n1p...",
  "amount_sats": 50000,
  "expires_at": "2024-01-15T11:00:00Z"
}
```

**Note**: Payment completion handled via Clink callback, which activates referrer status

### POST /api/referrer/renew
```json
{
  "app_pubkey": "def456..."
}
```

**Response:**
```json
{
  "clink_offer": "lnbc100n1p...",
  "amount_sats": 10000,
  "expires_at": "2024-01-15T11:00:00Z"
}
```

**Note**: Payment completion handled via Clink callback, which updates calls_remaining

**Note**: Both `/onboard` and `/renew` are protected routes that serve as Clink payment callbacks


## API Integration

### Data Flow
```
NymRank API (Core Data)
    ↓
NymRank Boost (Paid Reputation)
```

### Frontend Responsibilities
- **Pricing** - Integrates with external pricing services
- **Payment** - Provides Clink offers for payment facilitation
- **Callback** - Handles payment completion on their end
- **UI/UX** - Simple name lookup and payment flow

### Core API Responsibilities
- **Data integrity** - Accurate rankings and name occupations
- **Performance** - Fast responses for name lookups
- **Simplicity** - Clean, minimal API responses
