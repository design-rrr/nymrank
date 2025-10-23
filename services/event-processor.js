class EventProcessor {
  constructor(database, log) {
    this.database = database;
    this.log = log || console;
  }

  async processEvents(events, kind) {
    for (const event of events) {
      try {
        if (kind === 10040) {
          await this.handleDelegationEvent(event);
        } else if (kind === 30382) {
          await this.handleRankingEvent(event);
        } else if (kind === 0) {
          await this.handleProfileEvent(event);
        }
      } catch (error) {
        this.log.error({err: error}, `[Processing] Error processing event ${event.id} of kind ${kind}`);
      }
    }
  }

  async handleRankingEvent(event) {
    this.log.debug(`[HandleRanking] Received ranking event to handle: ${event.id}`);
    const servicePubkey = event.pubkey;
    const delegatorPubkey = await this.database.getDelegatorForService(servicePubkey);

    if (!delegatorPubkey) {
      this.log.warn(`[HandleRanking] No delegator found for service pubkey ${servicePubkey}. Proceeding without committee member assignment for event ${event.id}.`);
    }

    this.log.debug(`[HandleRanking] Found delegator ${delegatorPubkey} for service ${servicePubkey}.`);

    const data = this.parseRankingEvent(event);
    if (!data) {
      this.log.error(`[HandleRanking] Failed to parse ranking event ${event.id}.`);
      return;
    }

    // Assign the looked-up committee member pubkey if available
    if (delegatorPubkey) {
      data.committee_member_pubkey = delegatorPubkey;
    }
    
    this.log.debug({data: data}, `[HandleRanking] Parsed data for event ${event.id}`);

    await this.database.insertRanking(data);
    // Also store the raw attestation event id for cardinality/diagnostics
    try {
      await this.database.insertAttestationEvent(event.id, data);
    } catch (e) {
      this.log.warn({err: e}, `[HandleRanking] Failed to insert attestation_events for ${event.id}`);
    }
    this.log.debug(`[HandleRanking] Ranking event ${event.id} processed and stored.`);
  }

  async handleDelegationEvent(event) {
    try {
      // Parse delegation event (kind 10040) and store in database
      const delegationData = this.parseDelegationEvent(event);
      
      // Verify the delegator is a committee member
      const committeeResult = await this.database.query(
        'SELECT pubkey FROM committee_members WHERE pubkey = $1 AND is_active = true',
        [delegationData.delegator_pubkey]
      );
      
      if (committeeResult.rows.length > 0) {
        await this.database.insertDelegation(delegationData);
        this.log.debug(`Delegation event ${event.id} processed and stored`);
        
      } else {
        this.log.info(`Delegation event ${event.id} skipped - delegator ${delegationData.delegator_pubkey} is not an active committee member`);
      }
    } catch (error) {
      this.log.error({err: error}, `Failed to process delegation event ${event.id}`);
    }
  }

  async handleProfileEvent(event) {
    try {
      if (!event.content || event.content.trim() === '') {
        this.log.debug(`Skipping profile event ${event.id} due to empty content.`);
        return;
      }

      let profile;
      try {
        profile = JSON.parse(event.content);
      } catch (parseError) {
        this.log.debug(`Skipping profile event ${event.id} - invalid JSON`);
        return;
      }

      if (!profile || typeof profile !== 'object') {
        this.log.debug(`Skipping profile event ${event.id} - content is not an object`);
        return;
      }

      // Sanitize strings: remove null bytes and control characters
      const sanitize = (str) => {
        if (!str || typeof str !== 'string') return null;
        return str.replace(/\x00/g, '').replace(/[\x01-\x08\x0B-\x1F\x7F]/g, '').substring(0, 255) || null;
      };

      const name = profile.name ? sanitize(String(profile.name)) : null;
      let nip05 = null;
      let lud16 = null;
      
      if (profile.nip05 && typeof profile.nip05 === 'string' && profile.nip05.includes('@')) {
        nip05 = sanitize(profile.nip05.split('@')[0]);
      }
      
      if (profile.lud16 && typeof profile.lud16 === 'string' && profile.lud16.includes('@')) {
        lud16 = sanitize(profile.lud16.split('@')[0]);
      }

      const data = {
        pubkey: event.pubkey,
        name: name,
        nip05: nip05,
        lud16: lud16,
        profile_timestamp: event.created_at,
      };

      await this.database.insertUserName(data);
      this.log.debug(`Profile event for ${event.pubkey} processed and stored.`);
    } catch (error) {
      this.log.error({err: error}, `Failed to process profile event ${event.id}`);
    }
  }

  parseRankingEvent(event) {
    // Extract ranking data from kind 30382 event tags
    const tags = event.tags;
    const data = {
      ranked_user_pubkey: '', // Will be extracted from 'd' tag
      service_pubkey: event.pubkey, // The author is the service
      committee_member_pubkey: '', // Will be determined from delegation
      rank_value: 0,
      hops: 0,
      influence_score: null,
      average_score: null,
      confidence_score: null,
      input_value: null,
      pagerank_score: null,
      follower_count: 0,
      muter_count: 0,
      reporter_count: 0,
      event_timestamp: new Date(event.created_at * 1000) // Convert Unix timestamp to Date
    };

    // Extract the user being ranked from the 'd' tag
    for (const tag of tags) {
      if (tag.length >= 2 && tag[0] === 'd') {
        data.ranked_user_pubkey = tag[1];
        break;
      }
    }

    // Parse tags to extract ranking metrics
    for (const tag of tags) {
      if (tag.length >= 2) {
        const [key, value] = tag;
        switch (key) {
          case 'rank':
            data.rank_value = parseInt(value) || 0;
            break;
          case 'hops':
            data.hops = parseInt(value) || 0;
            break;
          case 'personalizedGrapeRank_influence':
            data.influence_score = parseFloat(value) || null;
            break;
          case 'personalizedGrapeRank_average':
            data.average_score = parseFloat(value) || null;
            break;
          case 'personalizedGrapeRank_confidence':
            data.confidence_score = parseFloat(value) || null;
            break;
          case 'personalizedGrapeRank_input':
            data.input_value = parseFloat(value) || null;
            break;
          case 'personalizedPageRank':
            data.pagerank_score = parseFloat(value) || null;
            break;
          case 'verifiedFollowerCount':
            data.follower_count = parseInt(value) || 0;
            break;
          case 'verifiedMuterCount':
            data.muter_count = parseInt(value) || 0;
            break;
          case 'verifiedReporterCount':
            data.reporter_count = parseInt(value) || 0;
            break;
        }
      }
    }

    return data;
  }

  parseDelegationEvent(event) {
    // Extract delegation data from kind 10040 event
    const tags = event.tags;
    const data = {
      delegator_pubkey: event.pubkey,
      service_pubkey: '',
      source_relay: event.relay || null,
      event_timestamp: new Date(event.created_at * 1000) // Convert Unix timestamp to Date
    };

    // Parse tags to extract delegation info
    // Format: ["30382:rank", "service_pubkey", "source_relay"]
    for (const tag of tags) {
      if (tag.length >= 3) {
        const [key, serviceKey, relay] = tag;
        if (key.startsWith('30382:')) {
          data.service_pubkey = serviceKey;
          data.source_relay = relay || event.relay || null;
          break; // Take the first valid delegation
        }
      }
    }
    return data;
  }
}

module.exports = EventProcessor;



