-- Migration: Create precomputed_rankings materialized view
-- Run this manually: docker exec nymrank_postgres psql -U nymrank_user -d nymrank -f /path/to/this/file
-- Or copy/paste into psql

-- Create the materialized view
CREATE MATERIALIZED VIEW IF NOT EXISTS precomputed_rankings AS
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

-- Create indexes for fast queries
CREATE UNIQUE INDEX IF NOT EXISTS idx_precomputed_pubkey ON precomputed_rankings(ranked_user_pubkey);
CREATE INDEX IF NOT EXISTS idx_precomputed_effective_score ON precomputed_rankings(effective_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_precomputed_name ON precomputed_rankings(name);
CREATE INDEX IF NOT EXISTS idx_precomputed_nip05 ON precomputed_rankings(nip05);
CREATE INDEX IF NOT EXISTS idx_precomputed_lud16 ON precomputed_rankings(lud16);

-- Trigger function to notify app when rankings change
CREATE OR REPLACE FUNCTION trigger_rankings_refresh()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('rankings_changed', '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists, then create
DROP TRIGGER IF EXISTS rankings_changed_trigger ON user_rankings;
CREATE TRIGGER rankings_changed_trigger
AFTER INSERT OR UPDATE ON user_rankings
FOR EACH STATEMENT
EXECUTE FUNCTION trigger_rankings_refresh();





