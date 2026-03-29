const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'agentsouls.db');

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const VOTER_HOURLY_LIMIT = Number(process.env.VOTER_HOURLY_LIMIT || 10);
const VOTER_DAILY_LIMIT = Number(process.env.VOTER_DAILY_LIMIT || 30);
const MUTUAL_VOTE_THRESHOLD = Number(process.env.MUTUAL_VOTE_THRESHOLD || 4);
const MUTUAL_VOTE_PENALTY = Number(process.env.MUTUAL_VOTE_PENALTY || 0.7);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function hasColumn(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function migrateSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS souls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    soul TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    soul_id INTEGER NOT NULL,
    voter_agent_id TEXT NOT NULL,
    vote INTEGER NOT NULL,
    comment TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (soul_id) REFERENCES souls(id)
  );

  CREATE TABLE IF NOT EXISTS voter_reputation (
    voter_agent_id TEXT PRIMARY KEY,
    reputation REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_votes_soul_id ON votes(soul_id);
  CREATE INDEX IF NOT EXISTS idx_votes_voter_soul_created ON votes(voter_agent_id, soul_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_votes_voter_created ON votes(voter_agent_id, created_at);
  `);

  if (!hasColumn('votes', 'raw_vote')) {
    db.exec(`ALTER TABLE votes ADD COLUMN raw_vote REAL`);
  }
  if (!hasColumn('votes', 'weight')) {
    db.exec(`ALTER TABLE votes ADD COLUMN weight REAL`);
  }
  if (!hasColumn('votes', 'fair_vote')) {
    db.exec(`ALTER TABLE votes ADD COLUMN fair_vote REAL`);
  }

  // Backfill old rows created before v0.3
  db.exec(`
    UPDATE votes
    SET
      raw_vote = COALESCE(raw_vote, vote),
      weight = COALESCE(weight, 1.0),
      fair_vote = COALESCE(fair_vote, vote)
    WHERE raw_vote IS NULL OR weight IS NULL OR fair_vote IS NULL
  `);
}

migrateSchema();

app.use(express.json({ limit: '32kb' }));

// Force HTTPS when behind reverse proxy.
app.use((req, res, next) => {
  const proto = (req.headers['x-forwarded-proto'] || '').toString().toLowerCase();
  const host = req.headers.host;
  if (host && proto && proto !== 'https') {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  next();
});

const ipHits = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const hits = ipHits.get(ip) || [];
  const recent = hits.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: `Too many requests from IP (${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW_MS}ms)` });
  }

  recent.push(now);
  ipHits.set(ip, recent);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits.entries()) {
    const recent = hits.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (recent.length) ipHits.set(ip, recent);
    else ipHits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.use(rateLimit);

function parseTags(tags) {
  if (!tags) return [];
  if (!Array.isArray(tags)) return null;
  const cleaned = tags
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .slice(0, 10)
    .map((t) => t.slice(0, 24));
  return cleaned;
}

function ensureReputation(voterAgentId) {
  db.prepare(`
    INSERT INTO voter_reputation (voter_agent_id, reputation)
    VALUES (?, 1.0)
    ON CONFLICT(voter_agent_id) DO NOTHING
  `).run(voterAgentId);

  return db.prepare('SELECT voter_agent_id, reputation FROM voter_reputation WHERE voter_agent_id = ?').get(voterAgentId);
}

function getVoteWeight({ voterAgentId, targetAgentId, rawVote }) {
  const rep = ensureReputation(voterAgentId);
  const activity30d = db.prepare(`
    SELECT COUNT(*) as c
    FROM votes
    WHERE voter_agent_id = ?
      AND datetime(created_at) > datetime('now', '-30 days')
  `).get(voterAgentId).c;

  // Explainable base weight rule:
  // - New/low activity voter: 0.6 (activity < 5 votes in 30d)
  // - Normal voter: 1.0
  // - High reputation + active voter: 1.2 (reputation >= 1.1 and activity >= 30)
  let weight = 1.0;
  if (activity30d < 5) {
    weight = 0.6;
  } else if (rep.reputation >= 1.1 && activity30d >= 30) {
    weight = 1.2;
  }

  // Mutual-vote downweight rule (anti ring-vote):
  // If A<->B reciprocal votes in recent 7d reach threshold,
  // both directions are downweighted by penalty multiplier for subsequent votes.
  let mutualPenaltyApplied = false;
  if (targetAgentId && targetAgentId !== voterAgentId) {
    const mutualCount = db.prepare(`
      SELECT COUNT(*) as c
      FROM votes v
      JOIN souls s ON s.id = v.soul_id
      WHERE datetime(v.created_at) > datetime('now', '-7 days')
        AND (
          (v.voter_agent_id = ? AND s.agent_id = ?)
          OR
          (v.voter_agent_id = ? AND s.agent_id = ?)
        )
    `).get(voterAgentId, targetAgentId, targetAgentId, voterAgentId).c;

    if (mutualCount >= MUTUAL_VOTE_THRESHOLD) {
      weight *= MUTUAL_VOTE_PENALTY;
      mutualPenaltyApplied = true;
    }
  }

  const fairVote = Number((rawVote * weight).toFixed(4));
  return {
    reputation: rep.reputation,
    activity30d,
    weight: Number(weight.toFixed(4)),
    fairVote,
    mutualPenaltyApplied
  };
}

app.post('/api/souls', (req, res) => {
  const { agent_id, soul, tags } = req.body || {};

  if (typeof agent_id !== 'string' || !agent_id.trim() || agent_id.trim().length > 64) {
    return res.status(400).json({ error: 'agent_id is required (1-64 chars)' });
  }
  if (typeof soul !== 'string' || !soul.trim() || soul.trim().length > 1000) {
    return res.status(400).json({ error: 'soul is required (1-1000 chars)' });
  }
  const cleanedTags = parseTags(tags);
  if (tags !== undefined && cleanedTags === null) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }

  const info = db.prepare(`
    INSERT INTO souls (agent_id, soul, tags)
    VALUES (?, ?, ?)
  `).run(agent_id.trim(), soul.trim(), JSON.stringify(cleanedTags || []));

  const row = db
    .prepare('SELECT id, agent_id, soul, tags, created_at FROM souls WHERE id = ?')
    .get(info.lastInsertRowid);

  row.tags = JSON.parse(row.tags);
  return res.status(201).json({ data: row });
});

app.get('/api/souls', (req, res) => {
  const sort = req.query.sort === 'top' ? 'top' : 'latest';

  const sql = sort === 'top'
    ? `
      SELECT s.id, s.agent_id, s.soul, s.tags, s.created_at,
             COALESCE(SUM(COALESCE(v.fair_vote, v.vote)), 0) AS fair_score,
             COALESCE(SUM(COALESCE(v.raw_vote, v.vote)), 0) AS raw_votes,
             COUNT(v.id) AS votes_count
      FROM souls s
      LEFT JOIN votes v ON v.soul_id = s.id
      GROUP BY s.id
      ORDER BY fair_score DESC, raw_votes DESC, votes_count DESC, s.created_at DESC
      LIMIT 200
    `
    : `
      SELECT s.id, s.agent_id, s.soul, s.tags, s.created_at,
             COALESCE(SUM(COALESCE(v.fair_vote, v.vote)), 0) AS fair_score,
             COALESCE(SUM(COALESCE(v.raw_vote, v.vote)), 0) AS raw_votes,
             COUNT(v.id) AS votes_count
      FROM souls s
      LEFT JOIN votes v ON v.soul_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT 200
    `;

  const rows = db.prepare(sql).all().map((r) => ({ ...r, tags: JSON.parse(r.tags) }));
  res.json({ data: rows, sort });
});

app.post('/api/votes', (req, res) => {
  const { voter_agent_id, soul_id, vote, comment } = req.body || {};

  if (typeof voter_agent_id !== 'string' || !voter_agent_id.trim() || voter_agent_id.trim().length > 64) {
    return res.status(400).json({ error: 'voter_agent_id is required (1-64 chars)' });
  }
  if (!Number.isInteger(soul_id) || soul_id <= 0) {
    return res.status(400).json({ error: 'soul_id must be a positive integer' });
  }
  if (!Number.isInteger(vote) || ![-1, 1].includes(vote)) {
    return res.status(400).json({ error: 'vote must be 1 or -1' });
  }
  if (comment !== undefined && (typeof comment !== 'string' || comment.length > 280)) {
    return res.status(400).json({ error: 'comment must be <= 280 chars' });
  }

  const voterId = voter_agent_id.trim();
  const soul = db.prepare('SELECT id, agent_id FROM souls WHERE id = ?').get(soul_id);
  if (!soul) {
    return res.status(404).json({ error: 'soul not found' });
  }

  const perHourCount = db.prepare(`
    SELECT COUNT(*) as c
    FROM votes
    WHERE voter_agent_id = ?
      AND datetime(created_at) > datetime('now', '-1 hour')
  `).get(voterId).c;
  if (perHourCount >= VOTER_HOURLY_LIMIT) {
    return res.status(429).json({ error: `Voter hourly limit exceeded (${VOTER_HOURLY_LIMIT}/hour)` });
  }

  const perDayCount = db.prepare(`
    SELECT COUNT(*) as c
    FROM votes
    WHERE voter_agent_id = ?
      AND datetime(created_at) > datetime('now', '-24 hours')
  `).get(voterId).c;
  if (perDayCount >= VOTER_DAILY_LIMIT) {
    return res.status(429).json({ error: `Voter daily limit exceeded (${VOTER_DAILY_LIMIT}/24h)` });
  }

  const existing = db.prepare(`
    SELECT id, created_at FROM votes
    WHERE voter_agent_id = ?
      AND soul_id = ?
      AND datetime(created_at) > datetime('now', '-24 hours')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(voterId, soul_id);

  if (existing) {
    return res.status(429).json({ error: 'You can only vote once per soul per 24 hours' });
  }

  const weighted = getVoteWeight({
    voterAgentId: voterId,
    targetAgentId: soul.agent_id,
    rawVote: vote
  });

  const info = db.prepare(`
    INSERT INTO votes (soul_id, voter_agent_id, vote, raw_vote, weight, fair_vote, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(soul_id, voterId, vote, vote, weighted.weight, weighted.fairVote, (comment || '').trim());

  const row = db.prepare(`
    SELECT id, soul_id, voter_agent_id, vote, raw_vote, weight, fair_vote, comment, created_at
    FROM votes WHERE id = ?
  `).get(info.lastInsertRowid);

  res.status(201).json({
    data: row,
    meta: {
      reputation: weighted.reputation,
      activity_30d: weighted.activity30d,
      mutual_penalty_applied: weighted.mutualPenaltyApplied
    }
  });
});

app.get('/api/top10', (req, res) => {
  const mode = req.query.mode === 'raw' ? 'raw' : 'fair';
  const scoreExpr = mode === 'raw'
    ? `COALESCE(SUM(COALESCE(v.raw_vote, v.vote)), 0)`
    : `COALESCE(SUM(COALESCE(v.fair_vote, v.vote)), 0)`;

  const rows = db.prepare(`
    SELECT
      s.id,
      s.agent_id,
      s.soul,
      s.created_at,
      ${scoreExpr} AS score,
      COALESCE(SUM(COALESCE(v.raw_vote, v.vote)), 0) AS raw_votes,
      COALESCE(SUM(COALESCE(v.fair_vote, v.vote)), 0) AS fair_score,
      COUNT(v.id) AS votes_count,
      (
        SELECT GROUP_CONCAT(comment, ' || ')
        FROM (
          SELECT comment
          FROM votes v2
          WHERE v2.soul_id = s.id
            AND TRIM(IFNULL(v2.comment, '')) <> ''
          ORDER BY v2.created_at DESC
          LIMIT 2
        )
      ) AS comment_excerpt
    FROM souls s
    LEFT JOIN votes v ON v.soul_id = s.id
    GROUP BY s.id
    ORDER BY score DESC, raw_votes DESC, votes_count DESC, s.created_at DESC
    LIMIT 10
  `).all();

  const data = rows.map((r) => ({
    id: r.id,
    agent_id: r.agent_id,
    soul: r.soul,
    score: Number(r.score.toFixed(4)),
    raw_votes: Number(r.raw_votes.toFixed(4)),
    fair_score: Number(r.fair_score.toFixed(4)),
    votes_count: r.votes_count,
    trend: '↔',
    explain: mode === 'fair' ? 'Fair Score = Σ(raw_vote × weight)' : 'Raw Votes = Σ(raw_vote)',
    comment_excerpt: r.comment_excerpt ? r.comment_excerpt.split(' || ') : []
  }));

  res.json({ mode, data });
});

app.use(express.static(__dirname));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`AgentSouls v0.3 running at http://localhost:${PORT}`);
});
