# strfry Query Performance: Deep Historical Queries

## Observation
Queries with `until` filters become progressively slower when fetching older events. Working with a relay containing 200k+ events of a specific kind/author, query times increase from <1s for recent data to 17s+ for data a few hours older.

## Environment
- Remote relay: strfry (wss://nip85.brainstorm.world)
  - Hardware: DigitalOcean droplet, 8GB RAM, SSD storage
- Client: nostr-tools SimplePool.querySync()
- Query: `{ kinds: [30382], authors: ["48ec018359cac3c933f0f7a14550e36a4f683dcf55520c916dd8c61e7724f5de"], until: <timestamp>, limit: 500 }`
- Known event count: ~200,000 events matching this filter

## Observed Behavior

### Query Duration by Depth
Pagination working backward from present (until = now, decrementing):

| Timestamp Range | Duration | Events/page | Notes |
|----------------|----------|-------------|-------|
| Recent (now) | 0.8-1s | 490-500 | Fast, likely in cache |
| -1hr | 7-8s | 450-500 | Moderate slowdown |
| -2hr | 12-14s | 400-480 | Significant slowdown |
| -3hr | 17s | 400-470 | Approaching timeout limits |
| -4.5hr | 24-25s | 400-476 | Near timeout limit (30s) |
| -5hr+ | 26-27s | 410-490 | Consistently near timeout |
| -6hr+ | 28-29s | 450-485 | 96% of timeout limit |
| Older | Timeout | 0 | Eventually returns empty |

### Actual Results
- **With 4.4s timeout**: Retrieved 28,000 events before timing out
- **With 8.8s timeout**: Retrieved 40,000 events before timing out  
- **With 30s timeout**: Retrieved 100,000+ events (ongoing), but all queries timeout at 30s

Query duration increases exponentially as we go back in time. At ~100k events retrieved (roughly 7 hours of history), every query times out at exactly 30 seconds, returning progressively fewer events per page (500 → 280 events) as timeout cuts off responses earlier. This represents only ~50% of the known 200k total events - making it impossible to retrieve the full historical dataset via standard queries with any reasonable timeout.

Hardware specs (8GB RAM, SSD) should be adequate for query performance, suggesting the bottleneck is LMDB-specific behavior rather than raw storage speed.

## Hypothesis
This could be due to:
1. LMDB page cache behavior (recent data cached, older data requires disk I/O)
2. B+ tree traversal characteristics for deep historical queries
3. Index structure for compound filters (author+kind+timestamp)

## Reproduction Steps
```bash
# Using nostr-tools or similar client
# Start with recent data
filter = {
  kinds: [30382],
  authors: ["48ec018359cac3c933f0f7a14550e36a4f683dcf55520c916dd8c61e7724f5de"],
  until: Math.floor(Date.now() / 1000),
  limit: 500
}

# Get first page
events = await pool.querySync(relays, filter)
# Query completes in ~1s

# Paginate backward: set until to oldest timestamp from previous page
oldest = Math.min(...events.map(e => e.created_at))
filter.until = oldest
events = await pool.querySync(relays, filter)
# Query completes in ~1s

# Continue pagination...
# After fetching ~50k events over a few hours of history:
# Query duration has increased to 15-20s+
```

## Questions
1. Is this behavior expected for deep historical queries with LMDB?
2. Are there strfry configuration options that could help (cache size, etc.)?
3. Is there a better query pattern for backfilling large historical datasets?
4. Would a local strfry sync + negentropy copy improve query performance significantly?

