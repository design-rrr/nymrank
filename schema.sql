-- NymRank Database Schema
-- PostgreSQL 17

-- Committee Members (must be created first due to foreign key references)
CREATE TABLE committee_members (
    pubkey VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255),
    type VARCHAR(20) NOT NULL CHECK (type IN ('initial', 'referrer')),
    app_name VARCHAR(255),
    app_url VARCHAR(255),
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_committee_type ON committee_members(type);
CREATE INDEX idx_committee_is_active ON committee_members(is_active);

-- Insert initial committee members
INSERT INTO committee_members (pubkey, name, type) VALUES 
('3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088', 'justin', 'initial'),
('e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f', 'straycat', 'initial'),
('2efaa715bbb46dd5be6b7da8d7700266d11674b913b8178addb5c2e63d987331', 'vinny', 'initial');

-- User Rankings (from kind 30382 events)
CREATE TABLE user_rankings (
    ranked_user_pubkey VARCHAR(64) NOT NULL,
    service_pubkey VARCHAR(64) NOT NULL,
    committee_member_pubkey VARCHAR(64) NOT NULL,
    rank_value INTEGER NOT NULL,
    hops INTEGER DEFAULT 0,
    influence_score DOUBLE PRECISION,
    average_score DOUBLE PRECISION,
    confidence_score DOUBLE PRECISION,
    input_value DOUBLE PRECISION,
    pagerank_score DOUBLE PRECISION,
    follower_count INTEGER DEFAULT 0,
    muter_count INTEGER DEFAULT 0,
    reporter_count INTEGER DEFAULT 0,
    event_timestamp TIMESTAMP NOT NULL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ranked_user_pubkey, service_pubkey, committee_member_pubkey),
    FOREIGN KEY (committee_member_pubkey) REFERENCES committee_members(pubkey)
);

CREATE INDEX idx_ranked_user ON user_rankings(ranked_user_pubkey);
CREATE INDEX idx_rank_value ON user_rankings(rank_value);
CREATE INDEX idx_service ON user_rankings(service_pubkey);
CREATE INDEX idx_committee_member ON user_rankings(committee_member_pubkey);
CREATE INDEX idx_user_rankings_influence_follower ON user_rankings(influence_score DESC, follower_count DESC);

-- Delegations (from kind 10040 events)
CREATE TABLE delegations (
    delegator_pubkey VARCHAR(64) NOT NULL,
    service_pubkey VARCHAR(64) NOT NULL,
    source_relay TEXT,
    event_timestamp TIMESTAMP NOT NULL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (delegator_pubkey, service_pubkey),
    FOREIGN KEY (delegator_pubkey) REFERENCES committee_members(pubkey)
);

CREATE INDEX idx_delegator ON delegations(delegator_pubkey);
CREATE INDEX idx_delegation_service ON delegations(service_pubkey);

-- User Names (from kind 0 events)
CREATE TABLE user_names (
    pubkey VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255),
    nip05 VARCHAR(255),
    lud16 VARCHAR(255),
    name_affinity INTEGER DEFAULT 0,     -- 0-4 based on fields present
    primary_name VARCHAR(255),           -- Best name to use
    profile_timestamp BIGINT,            -- Timestamp of the kind 0 event
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_name ON user_names(name);
CREATE INDEX idx_nip05 ON user_names(nip05);
CREATE INDEX idx_lud16 ON user_names(lud16);
CREATE INDEX idx_primary_name ON user_names(primary_name);
CREATE INDEX idx_user_name_affinity ON user_names(name_affinity);

-- Name occupations (handles multiple names per user)
CREATE TABLE name_occupations (
    pubkey VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    affinity INTEGER NOT NULL,
    name_source VARCHAR(20) NOT NULL CHECK (name_source IN ('name', 'nip05', 'lud16', 'combined')),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pubkey, name)
);

CREATE INDEX idx_name_occ ON name_occupations(name);
CREATE INDEX idx_affinity ON name_occupations(affinity);
CREATE INDEX idx_pubkey ON name_occupations(pubkey);

-- Profile refresh queue (for stale profile management)
CREATE TABLE profile_refresh_queue (
    pubkey VARCHAR(64) PRIMARY KEY,
    profile_timestamp BIGINT NOT NULL,    -- Timestamp of the kind 0 event we're using
    last_activity_timestamp BIGINT,       -- Most recent activity timestamp from any event
    last_profile_fetch TIMESTAMP,         -- When we last fetched kind-0 profile
    last_activity_check TIMESTAMP,        -- When we last checked for activity events
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    priority INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0
);

CREATE INDEX idx_queued_at ON profile_refresh_queue(queued_at);
CREATE INDEX idx_priority ON profile_refresh_queue(priority);
CREATE INDEX idx_retry_count ON profile_refresh_queue(retry_count);
CREATE INDEX idx_last_profile_fetch ON profile_refresh_queue(last_profile_fetch);
CREATE INDEX idx_last_activity_check ON profile_refresh_queue(last_activity_check);

-- Pre-computed rankings for fast queries
CREATE MATERIALIZED VIEW precomputed_rankings AS
SELECT 
  ur.ranked_user_pubkey,
  un.name,
  un.nip05,
  un.lud16,
  AVG(ur.rank_value)::INTEGER as rank_value,
  AVG(ur.influence_score) as influence_score,
  AVG(ur.hops)::INTEGER as hops,
  AVG(ur.follower_count)::INTEGER as follower_count,
  COALESCE(MAX(prq.last_activity_timestamp), MAX(un.profile_timestamp)) as last_seen,
  (AVG(ur.influence_score) * LOG(GREATEST(AVG(ur.follower_count), 1) + 1)) as effective_score
FROM user_rankings ur
LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
GROUP BY ur.ranked_user_pubkey, un.pubkey, un.name, un.nip05, un.lud16;

CREATE UNIQUE INDEX idx_precomputed_pubkey ON precomputed_rankings(ranked_user_pubkey);
CREATE INDEX idx_precomputed_effective_score ON precomputed_rankings(effective_score DESC NULLS LAST);
CREATE INDEX idx_precomputed_name ON precomputed_rankings(name);
CREATE INDEX idx_precomputed_nip05 ON precomputed_rankings(nip05);
CREATE INDEX idx_precomputed_lud16 ON precomputed_rankings(lud16);

-- Function to refresh the materialized view
CREATE OR REPLACE FUNCTION refresh_precomputed_rankings()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY precomputed_rankings;
END;
$$ LANGUAGE plpgsql;

-- Trigger function to mark refresh needed (actual refresh done async)
CREATE OR REPLACE FUNCTION trigger_rankings_refresh()
RETURNS TRIGGER AS $$
BEGIN
  -- Use pg_notify to signal refresh needed (app listens for this)
  PERFORM pg_notify('rankings_changed', '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on user_rankings insert/update
CREATE TRIGGER rankings_changed_trigger
AFTER INSERT OR UPDATE ON user_rankings
FOR EACH STATEMENT
EXECUTE FUNCTION trigger_rankings_refresh();

-- Legacy table kept for compatibility
CREATE TABLE averaged_user_rankings (
    ranked_user_pubkey VARCHAR(64) PRIMARY KEY,
    average_rank DECIMAL(5,2) NOT NULL,
    committee_votes INTEGER NOT NULL,
    max_rank INTEGER NOT NULL,
    min_rank INTEGER NOT NULL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_average_rank ON averaged_user_rankings(average_rank);
CREATE INDEX idx_committee_votes ON averaged_user_rankings(committee_votes);

-- Name Reputations (computed aggregations)
CREATE TABLE name_reputations (
    name VARCHAR(255) PRIMARY KEY,
    total_guardians INTEGER DEFAULT 0,
    avg_rank DECIMAL(5,2),
    max_rank INTEGER,
    name_affinity INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_avg_rank ON name_reputations(avg_rank);
CREATE INDEX idx_max_rank ON name_reputations(max_rank);
CREATE INDEX idx_name_affinity ON name_reputations(name_affinity);

-- Reputation Grants
CREATE TABLE reputation_grants (
    grantor_pubkey VARCHAR(64) NOT NULL,
    grantee_pubkey VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    amount INTEGER DEFAULT 1,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (grantor_pubkey, grantee_pubkey, name)
);

CREATE INDEX idx_grantee ON reputation_grants(grantee_pubkey);
CREATE INDEX idx_grant_name ON reputation_grants(name);
CREATE INDEX idx_grant_status ON reputation_grants(status);

-- Sybil Fee Payments
CREATE TABLE sybil_fee_payments (
    id BIGSERIAL PRIMARY KEY,
    user_pubkey VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    tier VARCHAR(20) NOT NULL CHECK (tier IN ('premium', 'standard', 'basic')),
    amount_sats INTEGER NOT NULL,
    referrer_pubkey VARCHAR(64) NOT NULL,
    referrer_clink_offer TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'confirmed', 'refunded')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP NULL,
    confirmed_at TIMESTAMP NULL
);

CREATE INDEX idx_user ON sybil_fee_payments(user_pubkey);
CREATE INDEX idx_payment_name ON sybil_fee_payments(name);
CREATE INDEX idx_tier ON sybil_fee_payments(tier);
CREATE INDEX idx_payment_status ON sybil_fee_payments(status);
CREATE INDEX idx_referrer ON sybil_fee_payments(referrer_pubkey);

-- Referrer Onboarding
CREATE TABLE referrer_onboarding (
    app_pubkey VARCHAR(64) PRIMARY KEY,
    app_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_onboard_status ON referrer_onboarding(status);

-- Reserved Names (Trademarked/Protected)
CREATE TABLE reserved_names (
    name VARCHAR(255) PRIMARY KEY,
    reason VARCHAR(30) NOT NULL CHECK (reason IN ('trademark', 'copyright', 'legal', 'committee_decision')),
    description TEXT,
    requires_manual_verification BOOLEAN DEFAULT TRUE,
    added_by VARCHAR(64) NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (added_by) REFERENCES committee_members(pubkey)
);

CREATE INDEX idx_reason ON reserved_names(reason);
CREATE INDEX idx_requires_verification ON reserved_names(requires_manual_verification);
CREATE INDEX idx_is_active ON reserved_names(is_active);

-- Example reserved names
INSERT INTO reserved_names (name, reason, description, added_by) VALUES 
('bitcoin', 'trademark', 'Bitcoin trademark protection', '3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088'),
('ethereum', 'trademark', 'Ethereum Foundation trademark', '3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088'),
('nostr', 'trademark', 'Nostr protocol trademark', '3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088');
