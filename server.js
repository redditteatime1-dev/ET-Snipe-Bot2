const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

const MAX_ADMIN_GENERATE = 500;

function normalizeKeyType(input) {
  const raw = String(input || '').trim().toLowerCase();
  const map = {
    lft: 'lft',
    trial: 'lft',
    hourtrial: 'lft',
    second: 'second',
    seconds: 'second',
    sec: 'second',
    minute: 'minute',
    minutes: 'minute',
    min: 'minute',
    hour: 'hour',
    hours: 'hour',
    hr: 'hour',
    day: 'day',
    days: 'day',
    week: 'week',
    weeks: 'week',
    month: 'month',
    months: 'month',
    lifetime: 'lifetime',
    life: 'lifetime',
    forever: 'lifetime',
    custom: 'custom',
  };
  return map[raw] || raw;
}

function unitToMs(unit) {
  const map = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  return map[unit] || null;
}

function durationLabel(type, length, durationMs, lifetime) {
  if (lifetime) return 'lifetime';
  const safeLength = Math.max(1, Number(length || 1));
  const names = { lft: 'hour', second: 'second', minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month' };
  if (names[type]) return `${safeLength} ${names[type]}${safeLength === 1 ? '' : 's'}`;
  if (durationMs) {
    const ms = Number(durationMs);
    if (ms % (30 * 24 * 60 * 60 * 1000) === 0) return `${ms / (30 * 24 * 60 * 60 * 1000)} month${ms === 30 * 24 * 60 * 60 * 1000 ? '' : 's'}`;
    if (ms % (7 * 24 * 60 * 60 * 1000) === 0) return `${ms / (7 * 24 * 60 * 60 * 1000)} week${ms === 7 * 24 * 60 * 60 * 1000 ? '' : 's'}`;
    if (ms % (24 * 60 * 60 * 1000) === 0) return `${ms / (24 * 60 * 60 * 1000)} day${ms === 24 * 60 * 60 * 1000 ? '' : 's'}`;
    if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)} hour${ms === 60 * 60 * 1000 ? '' : 's'}`;
    if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)} minute${ms === 60 * 1000 ? '' : 's'}`;
    if (ms % 1000 === 0) return `${ms / 1000} second${ms === 1000 ? '' : 's'}`;
  }
  return 'custom';
}

function resolveDuration(body = {}) {
  const requestedType = normalizeKeyType(body.type || body.duration_unit || body.duration || 'day');
  const unit = normalizeKeyType(body.duration_unit || requestedType);
  const length = Math.max(1, Number(body.duration_length || body.length || 1));
  const lifetime = body.lifetime === true || requestedType === 'lifetime' || unit === 'lifetime';

  if (lifetime) {
    return {
      ok: true,
      type: 'lifetime',
      durationMs: 0,
      lifetime: true,
      label: 'lifetime',
    };
  }

  if (requestedType === 'lft') {
    return {
      ok: true,
      type: 'lft',
      durationMs: 60 * 60 * 1000,
      lifetime: false,
      label: '1 hour',
    };
  }

  let durationMs = Number(body.duration_ms || 0);
  if (!durationMs && body.duration_seconds) durationMs = Number(body.duration_seconds) * 1000;

  if (!durationMs) {
    const base = unitToMs(unit);
    if (!base) {
      return { ok: false, error: 'Invalid duration. Use: second, minute, hour, day, week, month, lifetime, lft, or custom duration_ms' };
    }
    durationMs = base * length;
  }

  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return { ok: false, error: 'duration_ms must be at least 1000 for non-lifetime keys' };
  }

  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const maxMs = 1000 * oneYearMs;
  if (durationMs > maxMs) {
    return { ok: false, error: 'duration_ms is too large. Use lifetime for permanent keys.' };
  }

  const standardMs = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };

  let type = requestedType;
  if (requestedType === 'custom') {
    type = 'custom';
  } else if (requestedType === 'hour' && length === 1) {
    type = 'hour';
  } else if (['second', 'minute', 'hour', 'day', 'week', 'month'].includes(unit)) {
    type = length === 1 ? unit : 'custom';
  }

  if (type !== 'custom' && standardMs[type] && durationMs !== standardMs[type] * length) type = 'custom';

  return {
    ok: true,
    type,
    durationMs: Math.floor(durationMs),
    lifetime: false,
    label: String(body.label || durationLabel(type, length, durationMs, false)),
  };
}

function makeKey(type) {
  const prefix = type === 'lifetime' ? 'LIFE' : type === 'custom' ? 'CUS' : type.toUpperCase();
  return `ET-${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keys (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      duration_ms BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      redeemed_by TEXT,
      redeemed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revoked BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT,
      tag TEXT,
      avatar TEXT,
      active_key TEXT REFERENCES keys(key),
      expires_at TIMESTAMPTZ,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS revoked BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS generated_by TEXT`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS generated_by_tag TEXT`);
  await pool.query(`ALTER TABLE keys ALTER COLUMN duration_ms SET DEFAULT 0`);
  await pool.query(`UPDATE keys SET duration_ms = 0 WHERE duration_ms IS NULL`);
  await pool.query(`ALTER TABLE keys ALTER COLUMN duration_ms SET NOT NULL`);

  console.log('[DB] Tables ready');
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', name: 'ET Sniper Backend', version: '2.1.0' });
});

app.post(['/admin/keys/generate', '/admin/keys/generate-custom', '/admin/generate-keys'], adminAuth, async (req, res) => {
  const amount = Number(req.body.amount || 1);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_ADMIN_GENERATE) {
    return res.status(400).json({ error: `Amount must be 1-${MAX_ADMIN_GENERATE}` });
  }

  const duration = resolveDuration(req.body);
  if (!duration.ok) return res.status(400).json({ error: duration.error });

  const generated = [];
  for (let i = 0; i < amount; i++) {
    let key = makeKey(duration.type);
    for (let tries = 0; tries < 5; tries++) {
      try {
        await pool.query(
          'INSERT INTO keys (key, type, duration_ms, generated_by, generated_by_tag) VALUES ($1, $2, $3, $4, $5)',
          [key, duration.type, duration.durationMs, req.body.generated_by || null, req.body.generated_by_tag || null]
        );
        generated.push(key);
        break;
      } catch (err) {
        if (err.code !== '23505' || tries === 4) throw err;
        key = makeKey(duration.type);
      }
    }
  }

  res.json({
    success: true,
    keys: generated,
    type: duration.type,
    amount: generated.length,
    duration_ms: duration.lifetime ? null : duration.durationMs,
    duration_label: duration.label,
    lifetime: duration.lifetime,
  });
});

app.get('/admin/keys', adminAuth, async (req, res) => {
  const { key, discord_id, limit = 200 } = req.query;
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));

  if (key) {
    const { rows } = await pool.query('SELECT * FROM keys WHERE key = $1', [String(key).toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Key not found' });
    return res.json(rows[0]);
  }

  if (discord_id) {
    const { rows } = await pool.query('SELECT * FROM keys WHERE redeemed_by = $1 ORDER BY redeemed_at DESC NULLS LAST, created_at DESC LIMIT $2', [String(discord_id), safeLimit]);
    return res.json(rows);
  }

  if (req.query.generated_by) {
    const { rows } = await pool.query('SELECT * FROM keys WHERE generated_by = $1 ORDER BY created_at DESC LIMIT $2', [String(req.query.generated_by), safeLimit]);
    return res.json(rows);
  }

  if (req.query.available === 'true') {
    const { rows } = await pool.query('SELECT * FROM keys WHERE redeemed_by IS NULL AND revoked = FALSE ORDER BY created_at DESC LIMIT $1', [safeLimit]);
    return res.json(rows);
  }

  const { rows } = await pool.query('SELECT * FROM keys ORDER BY created_at DESC LIMIT $1', [safeLimit]);
  res.json(rows);
});


app.delete('/admin/keys/available/all', adminAuth, async (_req, res) => {
  const result = await pool.query('DELETE FROM keys WHERE redeemed_by IS NULL AND revoked = FALSE');
  res.json({ success: true, deleted: result.rowCount, message: `Deleted ${result.rowCount} available key${result.rowCount === 1 ? '' : 's'}.` });
});

app.delete('/admin/keys/generated-by/:discord_id', adminAuth, async (req, res) => {
  const includeRedeemed = String(req.query.include_redeemed || 'false').toLowerCase() === 'true';
  const discordId = String(req.params.discord_id);
  const sql = includeRedeemed
    ? 'DELETE FROM keys WHERE generated_by = $1'
    : 'DELETE FROM keys WHERE generated_by = $1 AND redeemed_by IS NULL';
  const result = await pool.query(sql, [discordId]);
  res.json({
    success: true,
    deleted: result.rowCount,
    generated_by: discordId,
    include_redeemed: includeRedeemed,
    message: includeRedeemed
      ? `Deleted ${result.rowCount} key${result.rowCount === 1 ? '' : 's'} generated by ${discordId}.`
      : `Deleted ${result.rowCount} unredeemed key${result.rowCount === 1 ? '' : 's'} generated by ${discordId}.`,
  });
});

app.get(['/admin/keys/:key', '/admin/key/:key'], adminAuth, async (req, res) => {
  const { key } = req.params;
  const { rows } = await pool.query('SELECT * FROM keys WHERE key = $1', [String(key).toUpperCase()]);
  if (!rows.length) return res.status(404).json({ error: 'Key not found' });
  res.json(rows[0]);
});

app.delete('/admin/keys/:key', adminAuth, async (req, res) => {
  const { key } = req.params;
  const result = await pool.query('UPDATE keys SET revoked = TRUE WHERE key = $1', [String(key).toUpperCase()]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ success: true, message: `Key ${key} revoked` });
});

app.get('/admin/users', adminAuth, async (req, res) => {
  const { limit = 200 } = req.query;
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
  const { rows } = await pool.query('SELECT * FROM users ORDER BY last_seen DESC LIMIT $1', [safeLimit]);
  res.json(rows);
});

app.get('/admin/users/:discord_id', adminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE discord_id = $1', [req.params.discord_id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

app.get(['/admin/users/:discord_id/keys', '/admin/keys/user/:discord_id'], adminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM keys WHERE redeemed_by = $1 ORDER BY redeemed_at DESC NULLS LAST, created_at DESC LIMIT 200', [req.params.discord_id]);
  res.json({ keys: rows });
});

app.delete('/admin/users/:discord_id', adminAuth, async (req, res) => {
  await pool.query('UPDATE users SET expires_at = NOW(), active_key = NULL, last_seen = NOW() WHERE discord_id = $1', [req.params.discord_id]);
  res.json({ success: true, message: `User ${req.params.discord_id} access revoked` });
});

app.post('/redeem', async (req, res) => {
  const { key, discord_id, username, avatar, tag } = req.body;
  if (!key || !discord_id) return res.status(400).json({ error: 'Missing key or discord_id' });

  const normalizedKey = String(key).trim().toUpperCase();
  const keyRow = await pool.query('SELECT * FROM keys WHERE key = $1', [normalizedKey]);
  if (keyRow.rows.length === 0) return res.status(404).json({ error: 'invalid_key' });

  const k = keyRow.rows[0];
  if (k.revoked) return res.status(403).json({ error: 'revoked' });
  if (k.redeemed_by) return res.status(409).json({ error: 'already_redeemed', redeemed_by: k.redeemed_by });

  const userRow = await pool.query('SELECT * FROM users WHERE discord_id = $1', [discord_id]);
  if (userRow.rows.length > 0) {
    const user = userRow.rows[0];
    if (user.expires_at === null && user.active_key) {
      return res.status(409).json({ error: 'already_active', expires_at: null, message: 'You already have lifetime access.' });
    }
    if (user.expires_at && new Date(user.expires_at) > new Date()) {
      return res.status(409).json({
        error: 'already_active',
        expires_at: user.expires_at,
        message: `You already have an active subscription until ${new Date(user.expires_at).toUTCString()}`,
      });
    }
  }

  const now = new Date();
  const isLifetime = k.type === 'lifetime' || Number(k.duration_ms) === 0;
  const expiresAt = isLifetime ? null : new Date(now.getTime() + Number(k.duration_ms));

  await pool.query(
    'UPDATE keys SET redeemed_by = $1, redeemed_at = $2, expires_at = $3 WHERE key = $4',
    [discord_id, now, expiresAt, normalizedKey]
  );

  await pool.query(`
    INSERT INTO users (discord_id, username, tag, avatar, active_key, expires_at, last_seen)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (discord_id) DO UPDATE SET
      username = $2,
      tag = $3,
      avatar = $4,
      active_key = $5,
      expires_at = $6,
      last_seen = NOW()
  `, [discord_id, username || 'Unknown', tag || null, avatar || null, normalizedKey, expiresAt]);

  res.json({
    success: true,
    type: k.type,
    duration_ms: isLifetime ? null : Number(k.duration_ms),
    expires_at: expiresAt,
    lifetime: isLifetime,
    message: isLifetime ? 'Key redeemed! Lifetime access granted.' : `Key redeemed! Access granted until ${expiresAt.toUTCString()}`,
  });
});

app.post('/verify', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ error: 'Missing discord_id' });

  const userRow = await pool.query('SELECT * FROM users WHERE discord_id = $1', [discord_id]);
  if (userRow.rows.length === 0) return res.json({ valid: false, reason: 'no_subscription' });

  const user = userRow.rows[0];
  if (user.active_key && user.expires_at === null) {
    await pool.query('UPDATE users SET last_seen = NOW() WHERE discord_id = $1', [discord_id]);
    return res.json({
      valid: true,
      discord_id: user.discord_id,
      username: user.username,
      avatar: user.avatar,
      expires_at: null,
      lifetime: true,
      type: 'lifetime',
    });
  }

  if (!user.expires_at || new Date(user.expires_at) <= new Date()) {
    return res.json({ valid: false, reason: 'expired', expired_at: user.expires_at });
  }

  await pool.query('UPDATE users SET last_seen = NOW() WHERE discord_id = $1', [discord_id]);

  let type = null;
  if (user.active_key) {
    const keyRow = await pool.query('SELECT type FROM keys WHERE key = $1', [user.active_key]);
    type = keyRow.rows[0]?.type || user.active_key.split('-')[1]?.toLowerCase() || null;
  }

  res.json({
    valid: true,
    discord_id: user.discord_id,
    username: user.username,
    avatar: user.avatar,
    expires_at: user.expires_at,
    lifetime: false,
    type,
  });
});

app.get('/version-check', (_req, res) => {
  res.json({
    required_version: process.env.REQUIRED_VERSION || '1.0.0',
    update_url: process.env.UPDATE_URL || 'https://discord.gg/WcZwrqytTy',
    message: process.env.UPDATE_MESSAGE || 'A new required update is available. Please download the latest version to continue.',
    change_note: process.env.UPDATE_CHANGE_NOTE || null,
  });
});

app.get('/status', (_req, res) => {
  res.json({ status: 'ok', version: '2.1.0', timestamp: new Date() });
});

app.get('/admin/stats', adminAuth, async (_req, res) => {
  const [totalKeys, usedKeys, availableKeys, activeUsers, lifetimeUsers, revokedKeys] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM keys'),
    pool.query('SELECT COUNT(*) FROM keys WHERE redeemed_by IS NOT NULL'),
    pool.query('SELECT COUNT(*) FROM keys WHERE redeemed_by IS NULL AND revoked = FALSE'),
    pool.query('SELECT COUNT(*) FROM users WHERE active_key IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW())'),
    pool.query('SELECT COUNT(*) FROM users WHERE active_key IS NOT NULL AND expires_at IS NULL'),
    pool.query('SELECT COUNT(*) FROM keys WHERE revoked = TRUE'),
  ]);
  res.json({
    total_keys: parseInt(totalKeys.rows[0].count),
    used_keys: parseInt(usedKeys.rows[0].count),
    available_keys: parseInt(availableKeys.rows[0].count),
    active_users: parseInt(activeUsers.rows[0].count),
    lifetime_users: parseInt(lifetimeUsers.rows[0].count),
    revoked_keys: parseInt(revokedKeys.rows[0].count),
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
}).catch(err => {
  console.error('[Server] DB init failed:', err);
  process.exit(1);
});
