const { getGroqConfig } = require('./config');

const CANDIDATE_BATCH_SIZE = 40;
const THEMATIC_SUFFIXES = ['btc', 'sats', 'str', 'coin', 'isbased', 'real', 'uber', 'callme'];
const ABSOLUTE_MAX_LENGTH = 32;
const LENGTH_EXTENSION = 8;

function getMaxSuggestionLength(baseName) {
  const baseLength = (baseName || '').length;
  return Math.min(ABSOLUTE_MAX_LENGTH, Math.max(12, baseLength + LENGTH_EXTENSION));
}

function normalizeCandidates(values, maxLength) {
  const seen = new Set();
  const cleaned = [];
  const safeMaxLength = Math.max(4, maxLength || 16);

  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().toLowerCase().replace(/\s+/g, '');
    const candidatePattern = new RegExp(`^[a-z0-9_-]{2,${safeMaxLength}}$`);
    if (!candidatePattern.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(normalized);
  }

  return cleaned;
}

function extractJsonArray(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      return [];
    }

    try {
      const sliced = content.slice(start, end + 1);
      const parsed = JSON.parse(sliced);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
}

function isLowQualityVariant(name, baseName) {
  if (/\d{1,3}$/.test(name)) return true;
  if (/[013457]/.test(name)) return true;
  if (name === baseName) return true;
  if (name.length < 4) return true;
  if (name.startsWith(baseName) && name.length - baseName.length <= 1) return true;
  if (baseName.startsWith(name) && baseName.length - name.length <= 1) return true;
  return false;
}

function qualityFilter(candidates, baseName) {
  return candidates.filter((name) => {
    if (isLowQualityVariant(name, baseName)) return false;
    // Avoid low-value vowel-swap tails: alicea, alicee, alicey, etc.
    if (name.startsWith(baseName) && /^[aeiouy]+$/.test(name.slice(baseName.length))) return false;
    return true;
  });
}

function buildPrompt(baseName, maxLength) {
  return [
    `Generate exactly ${CANDIDATE_BATCH_SIZE} concise, brandable username suggestions for "${baseName}".`,
    'Output ONLY a JSON array of strings with no markdown.',
    'Rules:',
    '- lowercase only',
    `- 4-${maxLength} chars`,
    '- letters, numbers, _ and - only',
    '- avoid leetspeak and random digit suffixes',
    '- avoid trivial mutations like base+1, base+2, single-char swaps',
    '- favor pronounceable, memorable names suitable for a new user handle',
    '- include diverse styles: underscore, thematic suffix, phrase-like, and bold brandable',
    `- prefer patterns similar to: ${baseName}_sats, ${baseName}_btc, callme${baseName}, real${baseName}, uber${baseName}`,
    `- include at least 12 candidates using thematic terms from: ${THEMATIC_SUFFIXES.join(', ')}`
  ].join('\n');
}

async function generateGroqSuggestions(baseName) {
  const groq = getGroqConfig();
  if (!groq.apiKey) {
    const error = new Error('GROQ_API_KEY is not configured');
    error.code = 'missing_groq_key';
    throw error;
  }

  const maxLength = getMaxSuggestionLength(baseName);
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${groq.apiKey}`
    },
    body: JSON.stringify({
      model: groq.model,
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: 'You are a naming assistant. Return strict JSON arrays only.'
        },
        {
          role: 'user',
          content: buildPrompt(baseName, maxLength)
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Groq request failed with status ${response.status}: ${body}`);
    error.code = 'groq_failed';
    throw error;
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  const normalized = normalizeCandidates(extractJsonArray(content), maxLength);
  return qualityFilter(normalized, baseName);
}

module.exports = {
  generateGroqSuggestions
};
