// ET Sniper Key System - Backend API
// Deploy to Railway. Uses PostgreSQL (Railway provides DATABASE_URL automatically).
// All secrets come from Railway environment variables - never hardcoded.

const express = require('express');
const { Pool } = require('pg');
const crypto  = require('crypto');
const cors    = require('cors');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── DB INIT ────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keys (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      type        TEXT NOT NULL,          -- 'lft' | 'day' | 'week' | 'month'
      duration_ms BIGINT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      redeemed_by TEXT,                   -- discord user id
      redeemed_at TIMESTAMPTZ,
      expires_at  TIMESTAMPTZ,
      revoked     BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS users (
      discord_id   TEXT PRIMARY KEY,
      username     TEXT,
      tag          TEXT,
      avatar       TEXT,
      active_key   TEXT REFERENCES keys(key),
      expires_at   TIMESTAMPTZ,
      last_seen    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] Tables ready');
}

// ── ADMIN AUTH MIDDLEWARE ──────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── GENERATE KEY ──────────────────────────────────────────────────────────
// POST /admin/keys/generate  { type: 'day' | 'week' | 'month' | 'lft', amount: 1-50 }
app.post('/admin/keys/generate', adminAuth, async (req, res) => {
  const { type, amount = 1 } = req.body;

  const durations = {
    lft:   1 * 60 * 60 * 1000,            // 1 hour  (lifetime free trial)
    day:   24 * 60 * 60 * 1000,           // 1 day
    week:  7  * 24 * 60 * 60 * 1000,      // 1 week
    month: 30 * 24 * 60 * 60 * 1000,      // 30 days
  };

  if (!durations[type]) return res.status(400).json({ error: 'Invalid type. Use: lft, day, week, month' });
  if (amount < 1 || amount > 50) return res.status(400).json({ error: 'Amount must be 1–50' });

  const generated = [];
  for (let i = 0; i < amount; i++) {
    const key = `ET-${type.toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await pool.query(
      'INSERT INTO keys (key, type, duration_ms) VALUES ($1, $2, $3)',
      [key, type, durations[type]]
    );
    generated.push(key);
  }

  res.json({ success: true, keys: generated, type, amount });
});

// ── LIST KEYS ──────────────────────────────────────────────────────────────
// GET /admin/keys
app.get('/admin/keys', adminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM keys ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

// ── DELETE / REVOKE KEY ────────────────────────────────────────────────────
// DELETE /admin/keys/:key
app.delete('/admin/keys/:key', adminAuth, async (req, res) => {
  const { key } = req.params;
  const result = await pool.query('UPDATE keys SET revoked = TRUE WHERE key = $1', [key]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ success: true, message: `Key ${key} revoked` });
});

// ── LIST USERS ──────────────────────────────────────────────────────────────
// GET /admin/users
app.get('/admin/users', adminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY last_seen DESC LIMIT 200');
  res.json(rows);
});

// ── REVOKE USER ─────────────────────────────────────────────────────────────
// DELETE /admin/users/:discord_id
app.delete('/admin/users/:discord_id', adminAuth, async (req, res) => {
  const { discord_id } = req.params;
  await pool.query('UPDATE users SET expires_at = NOW(), active_key = NULL WHERE discord_id = $1', [discord_id]);
  res.json({ success: true, message: `User ${discord_id} access revoked` });
});

// ── REDEEM KEY (called by Discord bot) ──────────────────────────────────────
// POST /redeem  { key, discord_id, username, avatar }
app.post('/redeem', async (req, res) => {
  const { key, discord_id, username, avatar } = req.body;
  if (!key || !discord_id) return res.status(400).json({ error: 'Missing key or discord_id' });

  // Look up key
  const keyRow = await pool.query('SELECT * FROM keys WHERE key = $1', [key]);
  if (keyRow.rows.length === 0) return res.status(404).json({ error: 'invalid_key' });

  const k = keyRow.rows[0];
  if (k.revoked)      return res.status(403).json({ error: 'revoked' });
  if (k.redeemed_by)  return res.status(409).json({ error: 'already_redeemed', redeemed_by: k.redeemed_by });

  // Check if user already has an active non-expired subscription
  const userRow = await pool.query('SELECT * FROM users WHERE discord_id = $1', [discord_id]);
  if (userRow.rows.length > 0) {
    const user = userRow.rows[0];
    if (user.expires_at && new Date(user.expires_at) > new Date()) {
      return res.status(409).json({
        error: 'already_active',
        expires_at: user.expires_at,
        message: `You already have an active subscription until ${new Date(user.expires_at).toUTCString()}`
      });
    }
  }

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + Number(k.duration_ms));

  // Mark key as redeemed
  await pool.query(
    'UPDATE keys SET redeemed_by = $1, redeemed_at = $2, expires_at = $3 WHERE key = $4',
    [discord_id, now, expiresAt, key]
  );

  // Upsert user
  await pool.query(`
    INSERT INTO users (discord_id, username, avatar, active_key, expires_at, last_seen)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (discord_id) DO UPDATE SET
      username = $2, avatar = $3, active_key = $4, expires_at = $5, last_seen = NOW()
  `, [discord_id, username || 'Unknown', avatar || null, key, expiresAt]);

  res.json({
    success: true,
    type: k.type,
    expires_at: expiresAt,
    message: `Key redeemed! Access granted until ${expiresAt.toUTCString()}`
  });
});

// ── VERIFY (called by desktop app on startup) ───────────────────────────────
// POST /verify  { discord_id, access_token }
app.post('/verify', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ error: 'Missing discord_id' });

  const userRow = await pool.query('SELECT * FROM users WHERE discord_id = $1', [discord_id]);
  if (userRow.rows.length === 0) return res.json({ valid: false, reason: 'no_subscription' });

  const user = userRow.rows[0];

  if (!user.expires_at || new Date(user.expires_at) <= new Date()) {
    return res.json({ valid: false, reason: 'expired', expired_at: user.expires_at });
  }

  // Update last seen
  await pool.query('UPDATE users SET last_seen = NOW() WHERE discord_id = $1', [discord_id]);

  res.json({
    valid: true,
    discord_id: user.discord_id,
    username: user.username,
    avatar: user.avatar,
    expires_at: user.expires_at,
    type: user.active_key ? user.active_key.split('-')[1]?.toLowerCase() : null,
  });
});

// ── VERSION CHECK (called by desktop app on startup) ────────────────────────
// GET /version-check
// Railway env vars:
//   REQUIRED_VERSION   → e.g. "8.3.0" — any build older than this sees the update wall
//   UPDATE_URL         → direct download link or Discord invite
//   UPDATE_MESSAGE     → headline shown on the update screen
//   UPDATE_CHANGE_NOTE → optional detail line (e.g. "Fixed exploit in inject engine")
//
// To force all 8.2.0 users to update right now:
//   Set REQUIRED_VERSION = 8.3.0 in Railway Variables and save.
//   Every user gets the update wall on next app launch. No bypass.
app.get('/version-check', (req, res) => {
  res.json({
    required_version: process.env.REQUIRED_VERSION   || '1.0.0',
    update_url:       process.env.UPDATE_URL         || 'https://discord.gg/WcZwrqytTy',
    message:          process.env.UPDATE_MESSAGE     || 'A new required update is available. Please download the latest version to continue.',
    change_note:      process.env.UPDATE_CHANGE_NOTE || null,
  });
});

// ── STATUS (public health check) ────────────────────────────────────────────
app.get('/status', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date() });
});

// ── DASHBOARD STATS (admin) ─────────────────────────────────────────────────
app.get('/admin/stats', adminAuth, async (req, res) => {
  const [totalKeys, usedKeys, activeUsers, revokedKeys] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM keys'),
    pool.query('SELECT COUNT(*) FROM keys WHERE redeemed_by IS NOT NULL'),
    pool.query("SELECT COUNT(*) FROM users WHERE expires_at > NOW()"),
    pool.query('SELECT COUNT(*) FROM keys WHERE revoked = TRUE'),
  ]);
  res.json({
    total_keys:   parseInt(totalKeys.rows[0].count),
    used_keys:    parseInt(usedKeys.rows[0].count),
    active_users: parseInt(activeUsers.rows[0].count),
    revoked_keys: parseInt(revokedKeys.rows[0].count),
  });
});

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
}).catch(err => {
  console.error('[Server] DB init failed:', err);
  process.exit(1);
});
