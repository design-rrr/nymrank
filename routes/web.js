'use strict'

module.exports = async function (fastify, opts) {
  const database = fastify.database;

  // Home page - rankings browser
  fastify.get('/', async (request, reply) => {
    const page = parseInt(request.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;
    const search = request.query.search || '';
    
    let query, params;
    
    if (search) {
      query = `
        SELECT 
          ur.ranked_user_pubkey,
          un.name,
          un.nip05,
          un.lud16,
          ur.rank_value,
          ur.influence_score,
          ur.hops,
          ur.follower_count,
          un.name_affinity,
          (
            CASE 
              WHEN LOWER(un.name) = LOWER($1) THEN 2
              ELSE 0
            END +
            CASE 
              WHEN LOWER(un.nip05) = LOWER($1) THEN 1
              ELSE 0
            END +
            CASE 
              WHEN LOWER(un.lud16) = LOWER($1) THEN 1
              ELSE 0
            END
          ) as match_affinity,
          EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) / 86400 as inactivity_days,
          (
            ur.influence_score * 
            CASE 
              WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) / 86400 < 180 THEN 1.0
              WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) / 86400 < 365 THEN 0.9
              WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) / 86400 < 730 THEN 0.7
              ELSE 0.5
            END
          ) as adjusted_score
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
        WHERE (LOWER(un.name) = LOWER($1) OR LOWER(un.nip05) = LOWER($1) OR LOWER(un.lud16) = LOWER($1))
          AND un.name_affinity >= 2
          AND ur.rank_value >= 35
        ORDER BY 
          CASE WHEN LOWER(un.name) = LOWER($1) THEN 1 ELSE 2 END,
          adjusted_score DESC NULLS LAST,
          match_affinity DESC
        LIMIT $2 OFFSET $3
      `;
      params = [search, limit, offset];
    } else {
      query = `
        SELECT 
          ur.ranked_user_pubkey,
          un.name,
          un.nip05,
          un.lud16,
          ur.rank_value,
          ur.influence_score,
          ur.hops,
          ur.follower_count
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        ORDER BY ur.influence_score DESC NULLS LAST
        LIMIT $1 OFFSET $2
      `;
      params = [limit, offset];
    }
    
    const result = await database.query(query, params);
    
    const countQuery = search 
      ? `SELECT COUNT(*) FROM user_rankings ur LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey WHERE (LOWER(un.name) = LOWER($1) OR LOWER(un.nip05) = LOWER($1) OR LOWER(un.lud16) = LOWER($1)) AND un.name_affinity >= 2 AND ur.rank_value >= 35`
      : `SELECT COUNT(*) FROM user_rankings`;
    const countParams = search ? [search] : [];
    const countResult = await database.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>NymRank - Rankings Browser</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; overflow-x: hidden; }
    .container { max-width: 1200px; margin: 0 auto; width: 100%; }
    h1 { margin-bottom: 10px; color: #fff; }
    .subtitle { color: #888; margin-bottom: 30px; }
    .search-box { margin-bottom: 20px; }
    .search-box input { width: 100%; max-width: 500px; padding: 12px; font-size: 16px; border: 1px solid #333; background: #1a1a1a; color: #fff; border-radius: 8px; }
    .search-box input:focus { outline: none; border-color: #555; }
    .stats { display: flex; gap: 20px; margin-bottom: 30px; flex-wrap: wrap; }
    .stat-card { background: #1a1a1a; padding: 15px 20px; border-radius: 8px; border: 1px solid #333; }
    .stat-card .label { color: #888; font-size: 14px; margin-bottom: 5px; }
    .stat-card .value { color: #fff; font-size: 24px; font-weight: bold; }
    .table-wrapper { width: 100%; overflow-x: auto; }
    table { width: 100%; min-width: 800px; border-collapse: collapse; background: #1a1a1a; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid #333; white-space: nowrap; }
    th { background: #252525; color: #fff; font-weight: 600; }
    tr:hover { background: #252525; }
    td:nth-child(1), td:nth-child(2), td:nth-child(3) { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td:nth-child(4) { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .pubkey { font-family: monospace; font-size: 12px; color: #888; display: block; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .score { font-weight: bold; color: #4CAF50; }
    .rank { display: inline-block; padding: 4px 8px; background: #333; border-radius: 4px; font-size: 12px; white-space: nowrap; }
    .rank.high { background: #4CAF50; color: #000; }
    .rank.med { background: #FF9800; color: #000; }
    .rank.low { background: #666; }
    .pagination { margin-top: 30px; display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap; }
    .pagination a, .pagination span { padding: 8px 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; text-decoration: none; color: #fff; }
    .pagination a:hover { background: #333; }
    .pagination .current { background: #4CAF50; color: #000; border-color: #4CAF50; }
    .no-profile { color: #666; font-style: italic; }
    a { color: #4CAF50; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>NymRank Rankings Browser</h1>
    <div class="subtitle">Reputation scores from committee member attestations</div>
    
    <div class="stats">
      <div class="stat-card">
        <div class="label">Total Users</div>
        <div class="value">${total.toLocaleString()}</div>
      </div>
      <div class="stat-card">
        <div class="label">Current Page</div>
        <div class="value">${page} / ${totalPages}</div>
      </div>
    </div>
    
    <div class="search-box">
      <form method="get" action="/">
        <input type="text" name="search" placeholder="Check slug availability (e.g., 'jack')..." value="${search}">
      </form>
    </div>
    ${search && result.rows.length === 0 ? `
    <div style="padding: 20px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333; margin-bottom: 20px; text-align: center;">
      <div style="color: #4CAF50; font-size: 18px; font-weight: bold; margin-bottom: 10px;">✓ "${search}" is available!</div>
      <div style="color: #888;">No users currently occupy this name.</div>
    </div>
    ` : ''}
    ${search && result.rows.length > 0 ? `
    <div style="padding: 20px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333; margin-bottom: 20px; text-align: center;">
      <div style="color: #FF5252; font-size: 18px; font-weight: bold; margin-bottom: 10px;">⚠ "${search}" is occupied</div>
      <div style="color: #888;">${result.rows.length} user(s) currently have this name. Showing highest reputation:</div>
    </div>
    ` : ''}
    
    <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>NIP-05</th>
          <th>LUD-16</th>
          <th>Pubkey</th>
          <th>Reputation</th>
          <th>Hops</th>
          <th>Followers</th>
        </tr>
      </thead>
      <tbody>
        ${result.rows.map(row => {
          const influence = row.influence_score ? parseFloat(row.influence_score) : 0;
          const rankClass = influence >= 0.9 ? 'high' : influence >= 0.7 ? 'med' : 'low';
          const influenceDisplay = influence ? influence.toFixed(6) : 'N/A';
          return `
            <tr>
              <td>${row.name ? row.name : '<span class="no-profile">No profile</span>'}</td>
              <td>${row.nip05 || '-'}</td>
              <td>${row.lud16 || '-'}</td>
              <td><a href="https://primal.net/p/${row.ranked_user_pubkey}" target="_blank" class="pubkey">${row.ranked_user_pubkey}</a></td>
              <td><span class="rank ${rankClass}">${influenceDisplay}</span></td>
              <td>${row.hops || 0}</td>
              <td>${row.follower_count ? row.follower_count.toLocaleString() : 0}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    </div>
    
    <div class="pagination">
      ${page > 1 ? `<a href="/?page=${page - 1}${search ? '&search=' + encodeURIComponent(search) : ''}">← Previous</a>` : '<span>← Previous</span>'}
      <span class="current">Page ${page}</span>
      ${page < totalPages ? `<a href="/?page=${page + 1}${search ? '&search=' + encodeURIComponent(search) : ''}">Next →</a>` : '<span>Next →</span>'}
    </div>
  </div>
</body>
</html>
    `;
    
    reply.type('text/html').send(html);
  });

  // User detail page
  fastify.get('/user/:pubkey', async (request, reply) => {
    const pubkey = request.params.pubkey;
    
    // Get user profile
    const profileResult = await database.query(
      'SELECT * FROM user_names WHERE pubkey = $1',
      [pubkey]
    );
    const profile = profileResult.rows[0];
    
    // Get ranking data
    const rankingResult = await database.query(
      'SELECT * FROM user_rankings WHERE ranked_user_pubkey = $1',
      [pubkey]
    );
    const ranking = rankingResult.rows[0];
    
    if (!ranking) {
      return reply.code(404).send('User not found');
    }
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>NymRank - ${profile?.name || pubkey.substring(0, 16)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    .back { display: inline-block; margin-bottom: 20px; color: #4CAF50; text-decoration: none; }
    .back:hover { text-decoration: underline; }
    h1 { margin-bottom: 10px; color: #fff; }
    .pubkey-full { font-family: monospace; font-size: 12px; color: #888; margin-bottom: 30px; word-break: break-all; }
    .section { background: #1a1a1a; padding: 20px; border-radius: 8px; border: 1px solid #333; margin-bottom: 20px; }
    .section h2 { color: #fff; margin-bottom: 15px; font-size: 18px; }
    .field { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #333; }
    .field:last-child { border-bottom: none; }
    .field-label { color: #888; }
    .field-value { color: #fff; font-weight: 500; }
    .score-big { font-size: 48px; font-weight: bold; color: #4CAF50; text-align: center; margin: 20px 0; }
    .rank-badge { display: inline-block; padding: 8px 16px; background: #333; border-radius: 4px; font-size: 20px; font-weight: bold; }
    .rank-badge.high { background: #4CAF50; color: #000; }
    .rank-badge.med { background: #FF9800; color: #000; }
    .rank-badge.low { background: #666; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back">← Back to Rankings</a>
    
    <h1>${profile?.name || 'Unknown User'}</h1>
    <div class="pubkey-full">${pubkey}</div>
    
    ${profile ? `
    <div class="section">
      <h2>Profile</h2>
      <div class="field">
        <span class="field-label">Name</span>
        <span class="field-value">${profile.name || '-'}</span>
      </div>
      <div class="field">
        <span class="field-label">NIP-05</span>
        <span class="field-value">${profile.nip05 || '-'}</span>
      </div>
      <div class="field">
        <span class="field-label">LUD-16</span>
        <span class="field-value">${profile.lud16 || '-'}</span>
      </div>
      <div class="field">
        <span class="field-label">Name Affinity</span>
        <span class="field-value">${profile.name_affinity || 0} / 4</span>
      </div>
    </div>
    ` : ''}
    
    <div class="section">
      <h2>Reputation</h2>
      <div style="text-align: center; margin-bottom: 20px;">
        <div class="score-big">${parseFloat(ranking.influence_score).toFixed(6)}</div>
        <div style="color: #888;">Influence Score</div>
      </div>
      <div class="field">
        <span class="field-label">Rank Value</span>
        <span class="field-value">
          <span class="rank-badge ${ranking.rank_value >= 90 ? 'high' : ranking.rank_value >= 70 ? 'med' : 'low'}">
            ${ranking.rank_value}
          </span>
        </span>
      </div>
      <div class="field">
        <span class="field-label">Average Score</span>
        <span class="field-value">${parseFloat(ranking.average_score).toFixed(6)}</span>
      </div>
      <div class="field">
        <span class="field-label">Confidence Score</span>
        <span class="field-value">${parseFloat(ranking.confidence_score).toFixed(6)}</span>
      </div>
      <div class="field">
        <span class="field-label">Input Value</span>
        <span class="field-value">${parseFloat(ranking.input_value).toFixed(2)}</span>
      </div>
      <div class="field">
        <span class="field-label">PageRank Score</span>
        <span class="field-value">${parseFloat(ranking.pagerank_score).toFixed(8)}</span>
      </div>
    </div>
    
    <div class="section">
      <h2>Network Metrics</h2>
      <div class="field">
        <span class="field-label">Hops</span>
        <span class="field-value">${ranking.hops}</span>
      </div>
      <div class="field">
        <span class="field-label">Verified Followers</span>
        <span class="field-value">${ranking.follower_count.toLocaleString()}</span>
      </div>
      <div class="field">
        <span class="field-label">Verified Muters</span>
        <span class="field-value">${ranking.muter_count.toLocaleString()}</span>
      </div>
      <div class="field">
        <span class="field-label">Verified Reporters</span>
        <span class="field-value">${ranking.reporter_count.toLocaleString()}</span>
      </div>
    </div>
  </div>
</body>
</html>
    `;
    
    reply.type('text/html').send(html);
  });
}

