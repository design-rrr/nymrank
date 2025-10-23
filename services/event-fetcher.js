const { SimplePool, useWebSocketImplementation } = require('nostr-tools/pool');
const WebSocket = require('ws');

// Required for Node.js environment
useWebSocketImplementation(WebSocket);

class EventFetcher {
  constructor(relayUrls, database, log) {
    this.relayUrls = Array.isArray(relayUrls) ? relayUrls : [relayUrls];
    this.database = database;
    this.pool = new SimplePool();
    this.log = log || console;
  }

  // Fetch latest events only (for delegations and profiles)
  async fetchLatestEvents(kind, authors, relayList = this.relayUrls) {
    // For profiles, just fetch the latest (no since filter needed - database layer handles staleness)
    const filter = {
      kinds: [kind],
      authors: authors
    };
    
    const events = await this.pool.querySync(relayList, filter);
    
    return events;
  }

  // Fetch all historical events with backfill (for rankings/attestations)
  async fetchAllHistoricalEvents(kind, authors, relayList = this.relayUrls) {
    const filter = {
      kinds: [kind],
      authors: authors
    };
    
    this.log.info({filter}, `Starting historical backfill for ${kind} events...`);
    
    let allEvents = [];
    let seenEventIds = new Set(); // Global deduplication across all pages
    let until = Math.floor(Date.now() / 1000);
    const startTime = until;
    const minBackfillTimeEnv = process.env.BACKFILL_SINCE ? Number(process.env.BACKFILL_SINCE) : 0;
    const minBackfillTime = Number.isFinite(minBackfillTimeEnv) && minBackfillTimeEnv >= 0 ? minBackfillTimeEnv : 0;
    
    const direction = (process.env.BACKFILL_DIRECTION || 'backward').toLowerCase();
    if (direction === 'forward') {
      let since = minBackfillTime;
      const nowTs = Math.floor(Date.now() / 1000);
      const progressDenominator = Math.max(1, nowTs - minBackfillTime);
      while (since <= nowTs) {
        const pageFilter = { ...filter, since, limit: 500 };
        this.log.info({ filter: pageFilter }, 'Fetching page of historical events (forward)...');
        const pageEvents = await this.pool.querySync(relayList, pageFilter);
        if (pageEvents.length === 0) {
          this.log.info(`No more historical events found at since=${since}. Forward backfill complete.`);
          break;
        }
        
        // Deduplicate
        const newEvents = pageEvents.filter(e => {
          if (seenEventIds.has(e.id)) return false;
          seenEventIds.add(e.id);
          return true;
        });
        allEvents.push(...newEvents);
        
        const newestTimestamp = Math.max(...pageEvents.map(event => event.created_at));
        this.log.info({
          pageLength: pageEvents.length,
          newLength: newEvents.length,
          newestTimestamp,
          since,
          progress: `${Math.round(((newestTimestamp - minBackfillTime) / progressDenominator) * 100)}%`
        }, 'Page received (forward).');
        if (pageEvents.length === 500) {
          since = newestTimestamp; // inclusive boundary to capture same-second spillover
        } else {
          since = newestTimestamp + 1;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return allEvents;
    }
    
    // Backward pagination
    let consecutiveRetriesWithNoNew = 0;
    const MAX_RETRIES_AT_BOUNDARY = 5; // Allow multiple retries when we're at a timestamp boundary
    
    while (until >= minBackfillTime) {
      const pageFilter = { ...filter, until, limit: 500 };
      this.log.info({ filter: pageFilter, consecutiveRetries: consecutiveRetriesWithNoNew }, 'Fetching page of historical events...');
      
      const startFetch = Date.now();
      const pageEvents = await this.pool.querySync(relayList, pageFilter, { maxWait: 30000 });
      const fetchDuration = Date.now() - startFetch;
      
      this.log.info({ 
        eventCount: pageEvents.length, 
        fetchDurationMs: fetchDuration,
        until 
      }, 'Relay response received');
      
      if (pageEvents.length === 0) {
        // Empty result with 'until' means no events exist at or before this timestamp
        this.log.info({ 
          filter: pageFilter, 
          relayList,
          fetchDurationMs: fetchDuration,
          totalEventsFetched: allEvents.length
        }, `No events at or before timestamp ${until}. Backfill complete.`);
        break;
      }
      
      // Deduplicate events
      const newEvents = pageEvents.filter(e => {
        if (seenEventIds.has(e.id)) return false;
        seenEventIds.add(e.id);
        return true;
      });
      allEvents.push(...newEvents);
      
      const oldestTimestamp = Math.min(...pageEvents.map(event => event.created_at));
      const newestTimestamp = Math.max(...pageEvents.map(event => event.created_at));
      const progressDenominator = Math.max(1, startTime - minBackfillTime);
      
      this.log.info({
        pageLength: pageEvents.length,
        newLength: newEvents.length,
        oldestInPage: oldestTimestamp,
        newestInPage: newestTimestamp,
        timestampRange: newestTimestamp - oldestTimestamp,
        queryUntil: until,
        totalUnique: allEvents.length,
        progress: `${Math.round(((startTime - until) / progressDenominator) * 100)}%`
      }, 'Page received.');
      
      // Check if we got new events
      if (newEvents.length === 0) {
        consecutiveRetriesWithNoNew++;
        this.log.warn({
          consecutiveRetriesWithNoNew,
          until,
          oldestTimestamp
        }, 'No new events in this page - all duplicates.');
        
        // If we've retried at this timestamp level too many times with no new events, move on
        if (consecutiveRetriesWithNoNew >= MAX_RETRIES_AT_BOUNDARY) {
          this.log.warn({
            until,
            oldestTimestamp
          }, `Max retries reached at timestamp ${until}. Moving to ${oldestTimestamp - 1}.`);
          until = oldestTimestamp - 1;
          consecutiveRetriesWithNoNew = 0;
        }
        // Otherwise keep same timestamp for retry
      } else {
        // We got new events - reset retry counter
        consecutiveRetriesWithNoNew = 0;
        
        // Always move until to the oldest timestamp in the response
        // Since max is ~100 events per timestamp, a 500 event page spans multiple timestamps
        // Setting until=oldestTimestamp will get us older events we haven't seen yet
        if (pageEvents.length === 500) {
          until = oldestTimestamp;
          this.log.info({
            until,
            oldestTimestamp,
            newCount: newEvents.length
          }, 'Full page with new events - continuing from oldest timestamp in page.');
        } else {
          // Less than 500 events means we've exhausted this timestamp range, move to older
          until = oldestTimestamp - 1;
        }
      }
      
      if (until < minBackfillTime) {
        this.log.info({ minBackfillTime }, 'Reached configured backfill lower bound. Stopping.');
        break;
      }
      
      this.log.info(`Fetched ${newEvents.length} new events. Total unique so far: ${allEvents.length}. Continuing backfill from timestamp ${until}...`);
      // No delay needed - the query itself provides throttling via the timeout
    }
    
    return allEvents;
  }


  close() {
    this.pool.close(this.relayUrls);
  }
}

module.exports = EventFetcher;
