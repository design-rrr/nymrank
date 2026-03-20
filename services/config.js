const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const DEFAULT_RANKING_RELAYS = ['wss://nip85.brainstorm.world'];
const DEFAULT_SOCIAL_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostrue.com',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.land'
];

function parseRelayList(value, fallback) {
  if (!value || typeof value !== 'string') {
    return [...fallback];
  }

  const parsed = value
    .split(',')
    .map((relay) => relay.trim())
    .filter((relay) => relay.length > 0);

  return parsed.length > 0 ? parsed : [...fallback];
}

function getRelayConfig() {
  const socialRelayUrls = parseRelayList(
    process.env.SOCIAL_RELAY_URLS,
    DEFAULT_SOCIAL_RELAYS
  );

  return {
    rankingRelayUrls: parseRelayList(process.env.RANKING_RELAY_URLS, DEFAULT_RANKING_RELAYS),
    socialRelayUrls,
    // Backward-compatible alias in code paths that still reference profile relays.
    profileRelayUrls: socialRelayUrls
  };
}

function getGroqConfig() {
  return {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama-3.1-70b-versatile'
  };
}

module.exports = {
  getRelayConfig,
  getGroqConfig
};
