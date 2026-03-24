'use strict';

const { SimplePool, useWebSocketImplementation } = require('nostr-tools/pool');
const WebSocket = require('ws');
const EventProcessor = require('./event-processor');

/**
 * Query social relays for latest author events + kind 0, update DB timestamps.
 * @param {{ database: object, relayUrls: string[], hexPubkey: string, log: object }} opts
 */
async function runAdhocActivityCheck({ database, relayUrls, hexPubkey, log }) {
  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool();

  try {
    const activityFilter = { authors: [hexPubkey], limit: 100 };
    const events = await pool.querySync(relayUrls, activityFilter);

    let latestEvent = null;
    if (events.length > 0) {
      latestEvent = events.reduce((latest, event) =>
        event.created_at > latest.created_at ? event : latest
      );
    }

    if (latestEvent) {
      const activityMap = new Map();
      activityMap.set(hexPubkey, latestEvent.created_at);
      await database.recordActivityCheck([hexPubkey], activityMap);
    } else {
      await database.recordActivityCheck([hexPubkey], new Map());
    }

    const profileFilter = { kinds: [0], authors: [hexPubkey] };
    const profileEvents = await pool.querySync(relayUrls, profileFilter);

    if (profileEvents.length > 0) {
      const eventProcessor = new EventProcessor(database, log);
      await eventProcessor.processEvents(profileEvents, 0);

      const profileTimestamps = new Map();
      profileEvents.forEach((event) => {
        const existing = profileTimestamps.get(event.pubkey);
        if (!existing || event.created_at > existing) {
          profileTimestamps.set(event.pubkey, event.created_at);
        }
      });
      await database.recordProfileTimestamp([hexPubkey], profileTimestamps);
    }

    const profileResult = await database.query(
      `
      SELECT
        un.name,
        un.nip05,
        un.lud16,
        prq.last_activity_timestamp,
        prq.profile_timestamp,
        prq.last_activity_check,
        prq.last_profile_fetch
      FROM user_names un
      LEFT JOIN profile_refresh_queue prq ON un.pubkey = prq.pubkey
      WHERE un.pubkey = $1
    `,
      [hexPubkey]
    );

    const profile = profileResult.rows[0] || null;

    return {
      pubkey: hexPubkey,
      latest_event: latestEvent
        ? {
            id: latestEvent.id,
            kind: latestEvent.kind,
            created_at: latestEvent.created_at,
            created_at_iso: new Date(latestEvent.created_at * 1000).toISOString(),
            days_ago: Math.floor((Date.now() / 1000 - latestEvent.created_at) / 86400)
          }
        : null,
      total_events_found: events.length,
      profile: profile
        ? {
            name: profile.name,
            nip05: profile.nip05,
            lud16: profile.lud16,
            last_activity_timestamp: profile.last_activity_timestamp,
            profile_timestamp: profile.profile_timestamp,
            last_activity_check: profile.last_activity_check,
            last_profile_fetch: profile.last_profile_fetch
          }
        : null
    };
  } finally {
    pool.close(relayUrls);
  }
}

module.exports = { runAdhocActivityCheck };
