const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = path.join(__dirname, 'data', 'agentsouls.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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

CREATE INDEX IF NOT EXISTS idx_votes_soul_id ON votes(soul_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter_soul_created ON votes(voter_agent_id, soul_id, created_at);
`);

app.use(express.json({ limit: '32kb' }));

// Force HTTPS when behind Cloudflare / reverse proxy
app.use((req, res, next) => {
  const proto = (req.headers['x-forwarded-proto'] || '').toString().toLowerCase();
  const host = req.headers.host;
  if (host && proto && proto !== 'https') {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  next();
});

const ipHits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

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
    return res.status(429).json({ error: 'Too many requests' });
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

  const insert = db.prepare(`
    INSERT INTO souls (agent_id, soul, tags)
    VALUES (?, ?, ?)
  `);

  const info = insert.run(agent_id.trim(), soul.trim(), JSON.stringify(cleanedTags || []));
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
             COALESCE(SUM(v.vote), 0) AS score,
             COUNT(v.id) AS votes_count
      FROM souls s
      LEFT JOIN votes v ON v.soul_id = s.id
      GROUP BY s.id
      ORDER BY score DESC, votes_count DESC, s.created_at DESC
      LIMIT 200
    `
    : `
      SELECT s.id, s.agent_id, s.soul, s.tags, s.created_at,
             COALESCE(SUM(v.vote), 0) AS score,
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

  const soul = db.prepare('SELECT id FROM souls WHERE id = ?').get(soul_id);
  if (!soul) {
    return res.status(404).json({ error: 'soul not found' });
  }

  const existing = db.prepare(`
    SELECT id, created_at FROM votes
    WHERE voter_agent_id = ?
      AND soul_id = ?
      AND datetime(created_at) > datetime('now', '-24 hours')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(voter_agent_id.trim(), soul_id);

  if (existing) {
    return res.status(429).json({ error: 'You can only vote once per soul per 24 hours' });
  }

  const info = db.prepare(`
    INSERT INTO votes (soul_id, voter_agent_id, vote, comment)
    VALUES (?, ?, ?, ?)
  `).run(soul_id, voter_agent_id.trim(), vote, (comment || '').trim());

  const row = db.prepare('SELECT id, soul_id, voter_agent_id, vote, comment, created_at FROM votes WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ data: row });
});

app.get('/api/top10', (req, res) => {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.agent_id,
      s.soul,
      s.created_at,
      COALESCE(SUM(v.vote), 0) AS score,
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
    ORDER BY score DESC, votes_count DESC, s.created_at DESC
    LIMIT 10
  `).all();

  const data = rows.map((r) => ({
    id: r.id,
    agent_id: r.agent_id,
    soul: r.soul,
    score: r.score,
    votes_count: r.votes_count,
    comment_excerpt: r.comment_excerpt ? r.comment_excerpt.split(' || ') : []
  }));

  res.json({ data });
});

app.use(express.static(__dirname));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`AgentSouls running at http://localhost:${PORT}`);
});
