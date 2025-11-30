'use strict'

module.exports = async function (fastify, opts) {
  const database = fastify.database;

  // Home page - rankings browser
  fastify.get('/', async (request, reply) => {
    const page = parseInt(request.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;
    const search = request.query.search || '';
    const perspective = request.query.perspective || '';
    
    // Get committee members for the dropdown
    const committeeResult = await database.query('SELECT name, pubkey FROM committee_members WHERE is_active = true ORDER BY name');
    const committeeMembers = committeeResult.rows;
    
    let query, params;
    let whereClause = '';
    let paramIndex = 1;
    let queryParams = [];
    
    // Base WHERE clause
    if (search) {
      whereClause += `
        WHERE (
          (LOWER(un.name) = LOWER($${paramIndex}) AND un.name IS NOT NULL) OR
          (LOWER(un.nip05) = LOWER($${paramIndex}) AND LOWER(un.lud16) = LOWER($${paramIndex}) AND un.nip05 IS NOT NULL AND un.lud16 IS NOT NULL)
        )
      `;
      queryParams.push(search);
      paramIndex++;
    } else {
       // If no search, we still need a WHERE clause for the next AND if perspective is used
       whereClause += ' WHERE 1=1 ';
    }
    
    // Perspective filter
    if (perspective) {
      whereClause += ` AND ur.committee_member_pubkey = $${paramIndex}`;
      queryParams.push(perspective);
      paramIndex++;
    }
    
    if (search) {
      // We need to use the search parameter again for the CASE statements
      // Since we can't reuse numbered parameters easily in all drivers, let's just inject the $1 index for those specific parts
      // But for safety, let's stick to the params array order.
      // The search param is at index 0 of queryParams (so $1).
      
      query = `
        SELECT 
          ur.ranked_user_pubkey,
          un.name,
          un.nip05,
          un.lud16,
          AVG(ur.rank_value)::INTEGER as rank_value,
          AVG(ur.influence_score) as influence_score,
          AVG(ur.hops)::INTEGER as hops,
          AVG(ur.follower_count)::INTEGER as follower_count,
          un.name_affinity,
          COALESCE(MAX(prq.last_activity_timestamp), MAX(un.profile_timestamp)) as last_seen,
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
            (AVG(ur.influence_score) * LOG(GREATEST(AVG(ur.follower_count), 1) + 1)) * 
            CASE 
              WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) / 86400 < 180 THEN 1.0
              WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) / 86400 < 365 THEN 0.9
              WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) / 86400 < 730 THEN 0.7
              ELSE 0.5
            END
          ) * (
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
          ) as blended_score
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
        ${whereClause}
        AND ur.rank_value >= 35
        GROUP BY ur.ranked_user_pubkey, un.pubkey, un.name, un.nip05, un.lud16, un.name_affinity, prq.last_activity_timestamp, un.profile_timestamp
        ORDER BY 
          blended_score DESC NULLS LAST
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      params = [...queryParams, limit, offset];
    } else {
      query = `
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
        ${whereClause}
        GROUP BY ur.ranked_user_pubkey, un.pubkey, un.name, un.nip05, un.lud16
        ORDER BY effective_score DESC NULLS LAST
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      params = [...queryParams, limit, offset];
    }
    
    const result = await database.query(query, params);
    
    const countQuery = search 
      ? `SELECT COUNT(DISTINCT ur.ranked_user_pubkey) FROM user_rankings ur LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey ${whereClause} AND ur.rank_value >= 35`
      : `SELECT COUNT(DISTINCT ranked_user_pubkey) FROM user_rankings ur ${whereClause}`;
      
    // Re-use queryParams for count query
    const countResult = await database.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>NymRank - Rankings Browser</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; overflow-x: hidden; }
    .container { max-width: 1200px; margin: 0 auto; width: 100%; }
    h1 { margin-bottom: 10px; color: #fff; }
    .subtitle { color: #888; margin-bottom: 30px; }
    .controls { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .search-box { flex-grow: 1; }
    .search-box input { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #333; background: #1a1a1a; color: #fff; border-radius: 8px; }
    .search-box input:focus { outline: none; border-color: #555; }
    .perspective-select { min-width: 200px; }
    .perspective-select select { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #333; background: #1a1a1a; color: #fff; border-radius: 8px; cursor: pointer; }
    .stats { display: flex; gap: 20px; margin-bottom: 30px; flex-wrap: wrap; }
    .stat-card { background: #1a1a1a; padding: 15px 20px; border-radius: 8px; border: 1px solid #333; }
    .stat-card .label { color: #888; font-size: 14px; margin-bottom: 5px; }
    .stat-card .value { color: #fff; font-size: 24px; font-weight: bold; }
    .table-wrapper { width: 100%; overflow-x: visible; overflow-y: visible; }
    table { width: 100%; min-width: 800px; border-collapse: collapse; background: #1a1a1a; border-radius: 8px; overflow: visible; }
    th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid #333; white-space: nowrap; position: relative; }
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
    .small-text { font-size: 11px; color: #888; display: block; margin-top: 2px; }
    .tooltip { position: relative; display: inline-block; cursor: help; margin-left: 5px; }
    .tooltip .tooltip-text {
      visibility: hidden;
      width: 320px;
      background-color: #222;
      color: #eee;
      text-align: left;
      border-radius: 6px;
      padding: 12px;
      position: absolute;
      z-index: 9999;
      bottom: 125%;
      left: 50%;
      margin-left: -160px;
      opacity: 0;
      transition: opacity 0.3s;
      font-size: 12px;
      font-weight: normal;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      border: 1px solid #444;
      white-space: normal;
      line-height: 1.4;
    }
    .tooltip .tooltip-text::after {
      content: "";
      position: absolute;
      top: 100%;
      left: 50%;
      margin-left: -5px;
      border-width: 5px;
      border-style: solid;
      border-color: #333 transparent transparent transparent;
    }
    .tooltip:hover .tooltip-text {
      visibility: visible;
      opacity: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>NymRank</h1>
    <div class="subtitle">Consensus-based namespace, secured by Web-of-Trust</div>
    
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
    
    <form method="get" action="/">
      <div class="controls">
        <div class="search-box">
          <input type="text" name="search" placeholder="Check slug availability (e.g., 'jack')..." value="${search}">
        </div>
        <div class="perspective-select">
          <select name="perspective" onchange="this.form.submit()">
            <option value="">Average</option>
            ${committeeMembers.map(m => {
              let label = m.name;
              if (m.name.toLowerCase() === 'straycat') label += ' (Default)';
              else if (m.name.toLowerCase() === 'justin') label += ' (Permissive)';
              else if (m.name.toLowerCase() === 'vinny') label += ' (Restrictive)';
              return `<option value="${m.pubkey}" ${perspective === m.pubkey ? 'selected' : ''}>${label}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
    </form>
    
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
          <th>
            Rank Score
            <div class="tooltip">ⓘ
              <span class="tooltip-text">
                <strong>NymRank Scoring Algorithm</strong><br><br>
                This score is derived from <strong>GrapeRank</strong> influence scores calculated via the <strong>Web of Trust</strong>.<br><br>
                • <strong>Weighting:</strong> The raw score is multiplied by the log of verified followers to surface notable accounts.<br>
                • <strong>Affinity:</strong> During search, exact matches on Name, NIP-05, or LUD-16 receive a significant ranking bonus.
              </span>
            </div>
          </th>
          <th>Hops</th>
          <th>Followers</th>
          <th>Last Seen</th>
        </tr>
      </thead>
      <tbody>
        ${result.rows.map(row => {
          const influence = row.influence_score ? parseFloat(row.influence_score) : 0;
          
          // Use effective score if available (from non-search query), otherwise use influence (but we should probably always use effective in display if that's what we sort by)
          // Actually, let's calculate effective score here for display consistency if it wasn't in the SELECT (though it is now)
          // Or better: Use the blended/effective score for the main ranking display
          
          const effectiveScore = row.effective_score || (row.blended_score ? row.blended_score : (influence * Math.log(Math.max(parseInt(row.follower_count || 0), 1) + 1)));
          
          const rankClass = influence >= 0.9 ? 'high' : influence >= 0.7 ? 'med' : 'low';
          const scoreDisplay = effectiveScore ? effectiveScore.toFixed(2) : '0.00';
          const influenceDisplay = influence ? influence.toFixed(4) : '0.0000';
          
          let lastSeenDisplay = 'N/A';
          if (row.last_seen) {
            const lastSeenDate = new Date(row.last_seen * 1000);
            const now = new Date();
            const daysAgo = Math.floor((now - lastSeenDate) / (1000 * 60 * 60 * 24));
            lastSeenDisplay = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : daysAgo < 30 ? daysAgo + 'd ago' : Math.floor(daysAgo / 30) + 'mo ago';
          }
          
          return `
            <tr>
              <td>${row.name ? row.name : '<span class="no-profile">No profile</span>'}</td>
              <td>${row.nip05 || '-'}</td>
              <td>${row.lud16 || '-'}</td>
              <td><a href="https://primal.net/p/${row.ranked_user_pubkey}" target="_blank" class="pubkey">${row.ranked_user_pubkey}</a></td>
              <td>
                <span class="rank ${rankClass}">${scoreDisplay}</span>
                <span class="small-text">Base: ${influenceDisplay}</span>
              </td>
              <td>${row.hops || 0}</td>
              <td>${row.follower_count ? row.follower_count.toLocaleString() : 0}</td>
              <td style="font-size: 12px; color: #888;">${lastSeenDisplay}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    </div>
    
    <div class="pagination">
      ${page > 1 ? `<a href="/?page=${page - 1}${search ? '&search=' + encodeURIComponent(search) : ''}${perspective ? '&perspective=' + encodeURIComponent(perspective) : ''}">← Previous</a>` : '<span>← Previous</span>'}
      <span class="current">Page ${page}</span>
      ${page < totalPages ? `<a href="/?page=${page + 1}${search ? '&search=' + encodeURIComponent(search) : ''}${perspective ? '&perspective=' + encodeURIComponent(perspective) : ''}">Next →</a>` : '<span>Next →</span>'}
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

