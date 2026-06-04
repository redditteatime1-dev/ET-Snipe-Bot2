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
const LOOTLAB_REQUIRE_API = String(process.env.LOOTLAB_REQUIRE_API || 'true').toLowerCase() !== 'false';
const LOOTLAB_REWARD_MS = Math.max(1000, Number(process.env.LOOTLAB_REWARD_HOURS || 12) * 60 * 60 * 1000);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.API_PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '').replace(/\/$/, '');

function getPublicBaseUrl(req) {
  if (PUBLIC_URL) {
    if (PUBLIC_URL.startsWith('http://') || PUBLIC_URL.startsWith('https://')) return PUBLIC_URL;
    return `https://${PUBLIC_URL}`;
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}


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

async function insertGeneratedKey(type, durationMs, generatedBy, generatedByTag) {
  let key = makeKey(type);
  for (let tries = 0; tries < 8; tries++) {
    try {
      await pool.query(
        'INSERT INTO keys (key, type, duration_ms, generated_by, generated_by_tag) VALUES ($1, $2, $3, $4, $5)',
        [key, type, durationMs, generatedBy || null, generatedByTag || null]
      );
      return key;
    } catch (err) {
      if (err.code !== '23505' || tries === 7) throw err;
      key = makeKey(type);
    }
  }
  return key;
}

async function readLootLabsResponse(response) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return data;
}

function lootLabsUrlFromResponse(data) {
  const pick = (item) => {
    if (!item || typeof item !== 'object') return null;
    return item.loot_url || item.short_url || item.short || item.url || item.link || null;
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      const url = pick(item);
      if (url) return url;
    }
  }

  if (Array.isArray(data?.message)) {
    for (const item of data.message) {
      const url = pick(item);
      if (url) return url;
    }
  }

  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      const url = pick(item);
      if (url) return url;
    }
  }

  return (
    pick(data) ||
    pick(data?.message) ||
    pick(data?.data) ||
    pick(data?.result) ||
    null
  );
}

function buildLootLabsPayload(destinationUrl) {
  const title = String(process.env.LOOTLAB_TITLE || 'ET Sniper 12 Hour Key').trim().slice(0, 60) || 'ET Sniper 12 Hour Key';
  const tierId = Number(process.env.LOOTLAB_TIER_ID || 1);
  const tasks = Number(process.env.LOOTLAB_NUMBER_OF_TASKS || 3);
  const theme = Number(process.env.LOOTLAB_THEME || 1);
  const body = {
    title,
    url: destinationUrl,
    tier_id: Number.isFinite(tierId) ? tierId : 1,
    number_of_tasks: Number.isFinite(tasks) ? Math.min(5, Math.max(1, tasks)) : 3,
    theme: Number.isFinite(theme) ? theme : 1,
  };
  const thumbnail = String(process.env.LOOTLAB_THUMBNAIL || '').trim();
  if (thumbnail && /^https?:\/\//i.test(thumbnail)) body.thumbnail = thumbnail;
  return body;
}

async function createLootLabsLink(destinationUrl) {
  const apiToken = String(process.env.LOOTLAB_API_TOKEN || '').trim();
  if (!apiToken) throw new Error('LOOTLAB_API_TOKEN is missing on the backend service');
  if (!/^https?:\/\//i.test(destinationUrl)) throw new Error('PUBLIC_URL must be a public http/https URL');

  const endpoint = 'https://creators.lootlabs.gg/api/public/content_locker';
  const body = buildLootLabsPayload(destinationUrl);
  const safeLog = { ...body, url: destinationUrl, token_set: true };
  console.log('[LootLabs] Creating locked link:', safeLog);

  const postResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'ET-Sniper-Backend/2.4.7',
    },
    body: JSON.stringify(body),
  });

  const postData = await readLootLabsResponse(postResponse);
  console.log('[LootLabs] POST response:', { status: postResponse.status, type: postData?.type, message: typeof postData?.message === 'string' ? postData.message : postData?.message });

  if (postResponse.ok && postData?.type !== 'error') {
    const lootUrl = lootLabsUrlFromResponse(postData);
    if (lootUrl) return { loot_url: lootUrl, raw: postData, method: 'POST' };
  }

  const params = new URLSearchParams();
  params.set('api_token', apiToken);
  for (const [key, value] of Object.entries(body)) params.set(key, String(value));

  const getResponse = await fetch(`${endpoint}?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ET-Sniper-Backend/2.4.7',
    },
  });

  const getData = await readLootLabsResponse(getResponse);
  console.log('[LootLabs] GET fallback response:', { status: getResponse.status, type: getData?.type, message: typeof getData?.message === 'string' ? getData.message : getData?.message });

  if (getResponse.ok && getData?.type !== 'error') {
    const lootUrl = lootLabsUrlFromResponse(getData);
    if (lootUrl) return { loot_url: lootUrl, raw: getData, method: 'GET' };
  }

  const postMessage = typeof postData?.message === 'string' ? postData.message : JSON.stringify(postData?.message || postData || {});
  const getMessage = typeof getData?.message === 'string' ? getData.message : JSON.stringify(getData?.message || getData || {});
  throw new Error(`LootLabs create failed. POST ${postResponse.status}: ${postMessage}; GET ${getResponse.status}: ${getMessage}`);
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

    CREATE TABLE IF NOT EXISTS lootlab_rewards (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      discord_id TEXT NOT NULL,
      username TEXT,
      tag TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      destination_url TEXT,
      loot_url TEXT,
      key TEXT REFERENCES keys(key),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      delivery_error TEXT
    );
  `);

  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS revoked BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS generated_by TEXT`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS generated_by_tag TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lootlab_rewards (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      discord_id TEXT NOT NULL,
      username TEXT,
      tag TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      destination_url TEXT,
      loot_url TEXT,
      key TEXT REFERENCES keys(key),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      delivery_error TEXT
    )
  `);
  await pool.query(`ALTER TABLE lootlab_rewards ADD COLUMN IF NOT EXISTS destination_url TEXT`);
  await pool.query(`ALTER TABLE lootlab_rewards ADD COLUMN IF NOT EXISTS loot_url TEXT`);
  await pool.query(`ALTER TABLE lootlab_rewards ADD COLUMN IF NOT EXISTS key TEXT REFERENCES keys(key)`);
  await pool.query(`ALTER TABLE lootlab_rewards ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE lootlab_rewards ADD COLUMN IF NOT EXISTS delivery_error TEXT`);
  await pool.query(`ALTER TABLE keys ALTER COLUMN duration_ms SET DEFAULT 0`);
  await pool.query(`UPDATE keys SET duration_ms = 0 WHERE duration_ms IS NULL`);
  await pool.query(`ALTER TABLE keys ALTER COLUMN duration_ms SET NOT NULL`);

  console.log('[DB] Tables ready');
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', name: 'ET Sniper Backend', version: '2.4.7', lootlabs_required: LOOTLAB_REQUIRE_API });
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
    const key = await insertGeneratedKey(duration.type, duration.durationMs, req.body.generated_by || null, req.body.generated_by_tag || null);
    generated.push(key);
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
  res.json({ success: true, deleted: result.rowCount, users_revoked: 0, message: `Deleted ${result.rowCount} available key${result.rowCount === 1 ? '' : 's'}. Redeemed/active users were not touched.` });
});

app.delete('/admin/keys/all', adminAuth, async (_req, res) => {
  const userResult = await pool.query('UPDATE users SET active_key = NULL, expires_at = NOW(), last_seen = NOW() WHERE active_key IS NOT NULL');
  const keyResult = await pool.query('DELETE FROM keys');
  res.json({
    success: true,
    deleted: keyResult.rowCount,
    users_revoked: userResult.rowCount,
    message: `Deleted ${keyResult.rowCount} total key${keyResult.rowCount === 1 ? '' : 's'} and revoked ${userResult.rowCount} active user${userResult.rowCount === 1 ? '' : 's'}.`,
  });
});

app.delete('/admin/keys/generated-by/:discord_id', adminAuth, async (req, res) => {
  const includeRedeemed = String(req.query.include_redeemed || 'false').toLowerCase() === 'true';
  const discordId = String(req.params.discord_id);
  let usersRevoked = 0;

  if (includeRedeemed) {
    const userResult = await pool.query(`
      UPDATE users
      SET active_key = NULL, expires_at = NOW(), last_seen = NOW()
      WHERE active_key IN (SELECT key FROM keys WHERE generated_by = $1)
    `, [discordId]);
    usersRevoked = userResult.rowCount;
  }

  const sql = includeRedeemed
    ? 'DELETE FROM keys WHERE generated_by = $1'
    : 'DELETE FROM keys WHERE generated_by = $1 AND redeemed_by IS NULL';
  const result = await pool.query(sql, [discordId]);
  res.json({
    success: true,
    deleted: result.rowCount,
    users_revoked: usersRevoked,
    generated_by: discordId,
    include_redeemed: includeRedeemed,
    message: includeRedeemed
      ? `Deleted ${result.rowCount} key${result.rowCount === 1 ? '' : 's'} generated by ${discordId} and revoked ${usersRevoked} active user${usersRevoked === 1 ? '' : 's'}.`
      : `Deleted ${result.rowCount} unredeemed key${result.rowCount === 1 ? '' : 's'} generated by ${discordId}. Redeemed keys/users were kept.`,
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
  const normalizedKey = String(key).toUpperCase();
  const result = await pool.query('UPDATE keys SET revoked = TRUE WHERE key = $1', [normalizedKey]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Key not found' });
  const userResult = await pool.query('UPDATE users SET active_key = NULL, expires_at = NOW(), last_seen = NOW() WHERE active_key = $1', [normalizedKey]);
  res.json({ success: true, users_revoked: userResult.rowCount, message: `Key ${normalizedKey} revoked and ${userResult.rowCount} active user${userResult.rowCount === 1 ? '' : 's'} logged out.` });
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
  if (!user.active_key) return res.json({ valid: false, reason: 'revoked' });

  const keyRow = await pool.query('SELECT * FROM keys WHERE key = $1', [user.active_key]);
  if (keyRow.rows.length === 0 || keyRow.rows[0].revoked) {
    await pool.query('UPDATE users SET active_key = NULL, expires_at = NOW(), last_seen = NOW() WHERE discord_id = $1', [discord_id]);
    return res.json({ valid: false, reason: keyRow.rows.length === 0 ? 'key_deleted' : 'key_revoked' });
  }

  const key = keyRow.rows[0];
  if (String(key.redeemed_by || '') !== String(discord_id)) {
    await pool.query('UPDATE users SET active_key = NULL, expires_at = NOW(), last_seen = NOW() WHERE discord_id = $1', [discord_id]);
    return res.json({ valid: false, reason: 'key_owner_mismatch' });
  }

  if (user.expires_at === null) {
    await pool.query('UPDATE users SET last_seen = NOW() WHERE discord_id = $1', [discord_id]);
    return res.json({
      valid: true,
      discord_id: user.discord_id,
      username: user.username,
      avatar: user.avatar,
      expires_at: null,
      lifetime: true,
      type: key.type || 'lifetime',
    });
  }

  if (!user.expires_at || new Date(user.expires_at) <= new Date()) {
    return res.json({ valid: false, reason: 'expired', expired_at: user.expires_at });
  }

  await pool.query('UPDATE users SET last_seen = NOW() WHERE discord_id = $1', [discord_id]);

  res.json({
    valid: true,
    discord_id: user.discord_id,
    username: user.username,
    avatar: user.avatar,
    expires_at: user.expires_at,
    lifetime: false,
    type: key.type || null,
  });
});


app.post('/admin/lootlab/start', adminAuth, async (req, res) => {
  const discordId = String(req.body.discord_id || '').trim();
  if (!discordId) return res.status(400).json({ error: 'Missing discord_id' });

  const token = crypto.randomBytes(24).toString('hex');
  const base = getPublicBaseUrl(req);
  const destinationUrl = `${base}/lootlab/complete?token=${encodeURIComponent(token)}`;

  let created;
  try {
    created = await createLootLabsLink(destinationUrl);
  } catch (err) {
    console.error('[LootLabs] Link create failed:', err.message);
    return res.status(502).json({
      error: err.message,
      lootlabs_configured: Boolean(process.env.LOOTLAB_API_TOKEN),
      public_url: base,
      fix: 'Check LOOTLAB_API_TOKEN, PUBLIC_URL, LOOTLAB_TIER_ID, LOOTLAB_NUMBER_OF_TASKS, and required Creator Details in LootLabs.',
    });
  }

  const lootUrl = created.loot_url;
  if (!lootUrl || !/^https?:\/\//i.test(lootUrl)) {
    return res.status(502).json({ error: 'LootLabs did not return a valid loot_url', method: created.method || null });
  }

  await pool.query(
    `INSERT INTO lootlab_rewards (token, discord_id, username, tag, status, destination_url, loot_url)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
    [token, discordId, req.body.username || null, req.body.tag || null, destinationUrl, lootUrl]
  );

  console.log('[LootLabs] Created locked reward link:', { discord_id: discordId, method: created.method, loot_url: lootUrl });

  res.json({
    success: true,
    token,
    loot_url: lootUrl,
    using_lootlabs_api: true,
    method: created.method || 'unknown',
    reward: `${Number(process.env.LOOTLAB_REWARD_HOURS || 12)} hour key`,
  });
});

app.get('/admin/lootlab/config', adminAuth, (req, res) => {
  res.json({
    version: '2.4.7',
    lootlabs_configured: Boolean(process.env.LOOTLAB_API_TOKEN),
    lootlabs_required: LOOTLAB_REQUIRE_API,
    public_url: getPublicBaseUrl(req),
    title: process.env.LOOTLAB_TITLE || 'ET Sniper 12 Hour Key',
    tier_id: Number(process.env.LOOTLAB_TIER_ID || 1),
    number_of_tasks: Number(process.env.LOOTLAB_NUMBER_OF_TASKS || 3),
    theme: Number(process.env.LOOTLAB_THEME || 1),
    reward_hours: Number(process.env.LOOTLAB_REWARD_HOURS || 12),
  });
});

app.get('/lootlab/complete', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).send('Missing reward token.');

  const rewardRow = await pool.query('SELECT * FROM lootlab_rewards WHERE token = $1', [token]);
  if (!rewardRow.rows.length) return res.status(404).send('Invalid or expired reward link.');

  const reward = rewardRow.rows[0];
  if (reward.status === 'completed' && reward.key) {
    return res.send(`<!doctype html><html><head><title>ET Sniper Reward</title><style>body{font-family:Arial;background:#08111f;color:#e5f2ff;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:520px;padding:28px;border:1px solid #1e3a5f;border-radius:18px;background:#0d1728;text-align:center}h1{color:#34d399}.small{color:#8ba5c4}</style></head><body><div class="card"><h1>Reward already completed</h1><p>Your 12 hour key was already generated. Check your Discord DMs.</p><p class="small">You can close this page.</p></div></body></html>`);
  }

  const key = await insertGeneratedKey('hour', LOOTLAB_REWARD_MS, 'lootlab', `LootLabs reward for ${reward.discord_id}`);
  await pool.query(
    `UPDATE lootlab_rewards
     SET status = 'completed', key = $1, completed_at = NOW(), delivery_error = NULL
     WHERE token = $2`,
    [key, token]
  );

  res.send(`<!doctype html><html><head><title>ET Sniper Reward</title><style>body{font-family:Arial;background:#08111f;color:#e5f2ff;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:520px;padding:28px;border:1px solid #1e3a5f;border-radius:18px;background:#0d1728;text-align:center}h1{color:#34d399}.key{font-family:monospace;background:#111f33;padding:10px 12px;border-radius:10px;color:#93c5fd}.small{color:#8ba5c4}</style></head><body><div class="card"><h1>✅ Reward completed</h1><p>Your 12 hour ET Sniper key was generated.</p><p class="key">${key}</p><p class="small">The Discord bot will DM this key to you. Then run /redeem with it.</p></div></body></html>`);
});

app.get('/admin/lootlab/completed', adminAuth, async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
  const { rows } = await pool.query(
    `SELECT id, discord_id, username, tag, key, completed_at
     FROM lootlab_rewards
     WHERE status = 'completed' AND key IS NOT NULL AND delivered_at IS NULL
     ORDER BY completed_at ASC
     LIMIT $1`,
    [limit]
  );
  res.json({ rewards: rows });
});

app.post('/admin/lootlab/:id/delivered', adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid reward id' });
  const delivered = req.body.delivered !== false;
  const error = req.body.error ? String(req.body.error).slice(0, 500) : null;
  const result = await pool.query(
    delivered
      ? `UPDATE lootlab_rewards SET delivered_at = NOW(), delivery_error = NULL WHERE id = $1`
      : `UPDATE lootlab_rewards SET delivery_error = $2 WHERE id = $1`,
    delivered ? [id] : [id, error]
  );
  res.json({ success: result.rowCount > 0 });
});

app.get('/admin/lootlab/status/:discord_id', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, status, key, created_at, completed_at, delivered_at, delivery_error, loot_url
     FROM lootlab_rewards
     WHERE discord_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [req.params.discord_id]
  );
  res.json({ rewards: rows });
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
  res.json({ status: 'ok', version: '2.4.7', lootlabs_required: LOOTLAB_REQUIRE_API, timestamp: new Date() });
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
  app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    console.log('[LootLabs] Config:', { token_set: Boolean(process.env.LOOTLAB_API_TOKEN), require_api: LOOTLAB_REQUIRE_API, public_url: PUBLIC_URL || '(auto)', tier_id: process.env.LOOTLAB_TIER_ID || '1', tasks: process.env.LOOTLAB_NUMBER_OF_TASKS || '3' });
  });
}).catch(err => {
  console.error('[Server] DB init failed:', err);
  process.exit(1);
});
