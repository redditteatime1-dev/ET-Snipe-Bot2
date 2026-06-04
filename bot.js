require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const API_URL = (process.env.API_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const REDEEM_CHANNEL_ID = process.env.REDEEM_CHANNEL_ID || '';
const GENKEY_ROLE_ID = process.env.GENKEY_ROLE_ID || process.env.ADMIN_ROLE_ID || '';
const REDEEM_ROLE_ID = process.env.REDEEM_ROLE_ID || '';
const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID || '';
const LOOTLAB_ROLE_ID = process.env.LOOTLAB_ROLE_ID || '';
const LOOTLAB_POLL_SECONDS = Math.max(10, Number(process.env.LOOTLAB_POLL_SECONDS || 15));

if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID || !API_URL || !ADMIN_TOKEN) {
  console.error('[Bot] Missing required environment variables.');
  process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
const keyLogPath = path.join(dataDir, 'key-log.json');

function loadKeyLog() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(keyLogPath)) fs.writeFileSync(keyLogPath, JSON.stringify({ keys: {}, users: {} }, null, 2));
    const parsed = JSON.parse(fs.readFileSync(keyLogPath, 'utf8'));
    if (!parsed.keys) parsed.keys = {};
    if (!parsed.users) parsed.users = {};
    return parsed;
  } catch {
    return { keys: {}, users: {} };
  }
}

function saveKeyLog(log) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyLogPath, JSON.stringify(log, null, 2));
  } catch {}
}

function logGeneratedKeys(keys, meta) {
  const log = loadKeyLog();
  for (const key of keys) {
    log.keys[key] = {
      key,
      type: meta.type,
      duration_ms: meta.durationMs,
      duration_label: meta.durationLabel,
      generated_by: meta.generatedBy,
      generated_by_tag: meta.generatedByTag,
      generated_at: new Date().toISOString(),
      redeemed_by: null,
      redeemed_by_tag: null,
      redeemed_at: null,
      revoked: false,
    };
  }
  saveKeyLog(log);
}

function logRedeemedKey(key, user) {
  const log = loadKeyLog();
  if (!log.keys[key]) log.keys[key] = { key };
  log.keys[key].redeemed_by = user.id;
  log.keys[key].redeemed_by_tag = user.tag || user.username;
  log.keys[key].redeemed_at = new Date().toISOString();
  if (!log.users[user.id]) log.users[user.id] = [];
  if (!log.users[user.id].includes(key)) log.users[user.id].push(key);
  saveKeyLog(log);
}

function logRevokedKey(key) {
  const log = loadKeyLog();
  if (!log.keys[key]) log.keys[key] = { key };
  log.keys[key].revoked = true;
  log.keys[key].revoked_at = new Date().toISOString();
  saveKeyLog(log);
}

const durationChoices = [
  { name: 'Seconds', value: 'second' },
  { name: 'Minutes', value: 'minute' },
  { name: 'Hours', value: 'hour' },
  { name: 'Days', value: 'day' },
  { name: 'Weeks', value: 'week' },
  { name: 'Months', value: 'month' },
  { name: 'Lifetime', value: 'lifetime' },
];

const commands = [
  new SlashCommandBuilder()
    .setName('redeem')
    .setDescription('Redeem a key')
    .addStringOption(opt => opt.setName('key').setDescription('Your license key').setRequired(true)),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check your subscription status'),

  new SlashCommandBuilder()
    .setName('lootlab')
    .setDescription('Get a LootLabs link that rewards you with a 12 hour key'),

  new SlashCommandBuilder()
    .setName('lootlabstatus')
    .setDescription('Check your latest LootLabs reward status'),

  new SlashCommandBuilder()
    .setName('genkey')
    .setDescription('Generate keys with a custom duration')
    .addStringOption(opt => opt.setName('duration').setDescription('Duration unit').setRequired(true).addChoices(...durationChoices))
    .addIntegerOption(opt => opt.setName('length').setDescription('How many units, example: 3 days').setRequired(false).setMinValue(1).setMaxValue(100000))
    .addIntegerOption(opt => opt.setName('amount').setDescription('How many keys to generate').setRequired(false).setMinValue(1).setMaxValue(25)),

  new SlashCommandBuilder()
    .setName('bulkkeys')
    .setDescription('Generate bulk keys and download them as a txt file')
    .addStringOption(opt => opt.setName('duration').setDescription('Duration unit').setRequired(true).addChoices(...durationChoices))
    .addIntegerOption(opt => opt.setName('amount').setDescription('How many keys to generate').setRequired(true).setMinValue(1).setMaxValue(500))
    .addIntegerOption(opt => opt.setName('length').setDescription('How many units, example: 3 days').setRequired(false).setMinValue(1).setMaxValue(100000)),

  new SlashCommandBuilder()
    .setName('quickgen')
    .setDescription('Generate common key types fast')
    .addStringOption(opt => opt.setName('type').setDescription('Key type').setRequired(true).addChoices(
      { name: '1 hour trial', value: 'lft' },
      { name: '1 day', value: 'day' },
      { name: '1 week', value: 'week' },
      { name: '1 month', value: 'month' },
      { name: 'lifetime', value: 'lifetime' },
    ))
    .addIntegerOption(opt => opt.setName('amount').setDescription('How many keys').setRequired(false).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName('keyinfo')
    .setDescription('Look up a key')
    .addStringOption(opt => opt.setName('key').setDescription('The key to search').setRequired(true)),

  new SlashCommandBuilder()
    .setName('keysbyuser')
    .setDescription('Track keys redeemed by a user ID')
    .addStringOption(opt => opt.setName('user_id').setDescription('Discord user ID').setRequired(false))
    .addUserOption(opt => opt.setName('user').setDescription('Discord user').setRequired(false)),

  new SlashCommandBuilder()
    .setName('userstatus')
    .setDescription('Check another user subscription by Discord ID')
    .addStringOption(opt => opt.setName('user_id').setDescription('Discord user ID').setRequired(false))
    .addUserOption(opt => opt.setName('user').setDescription('Discord user').setRequired(false)),

  new SlashCommandBuilder()
    .setName('deletekey')
    .setDescription('Revoke/delete a key')
    .addStringOption(opt => opt.setName('key').setDescription('The key to revoke').setRequired(true)),

  new SlashCommandBuilder()
    .setName('revoke')
    .setDescription('Revoke a user by Discord ID')
    .addStringOption(opt => opt.setName('user_id').setDescription('Discord user ID').setRequired(false))
    .addUserOption(opt => opt.setName('user').setDescription('Discord user').setRequired(false)),

  new SlashCommandBuilder()
    .setName('deleteavailablekeys')
    .setDescription('Delete every unused/unredeemed available key')
    .addBooleanOption(opt => opt.setName('confirm').setDescription('Confirm deleting all available keys').setRequired(true)),

  new SlashCommandBuilder()
    .setName('deleteallkeys')
    .setDescription('Delete every key and revoke/log out every active user')
    .addBooleanOption(opt => opt.setName('confirm').setDescription('Confirm deleting ALL keys and revoking ALL users').setRequired(true)),

  new SlashCommandBuilder()
    .setName('deletegennedkeys')
    .setDescription('Delete keys generated by a specific Discord user ID')
    .addStringOption(opt => opt.setName('user_id').setDescription('Discord user ID that generated the keys').setRequired(true))
    .addBooleanOption(opt => opt.setName('confirm').setDescription('Confirm deleting keys generated by this user').setRequired(true))
    .addBooleanOption(opt => opt.setName('include_redeemed').setDescription('Also delete redeemed keys from database').setRequired(false)),

  new SlashCommandBuilder()
    .setName('users')
    .setDescription('List active subscribers'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show key system stats'),

  new SlashCommandBuilder()
    .setName('exportkeys')
    .setDescription('Download the bot key tracking log as txt'),

  new SlashCommandBuilder()
    .setName('bothelp')
    .setDescription('Show every bot command'),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot/API ping'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
  console.log('[Bot] Commands registered.');
}

async function apiRequest(method, apiPath, body) {
  const options = { method, headers: { 'x-admin-token': ADMIN_TOKEN } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_URL}${apiPath}`, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
}

const apiPost = (p, b) => apiRequest('POST', p, b);
const apiGet = p => apiRequest('GET', p);
const apiDelete = p => apiRequest('DELETE', p);

function roleOk(interaction, roleId) {
  if (!roleId) return true;
  if (!interaction.member || !interaction.member.roles || !interaction.member.roles.cache) return false;
  return interaction.member.roles.cache.has(roleId);
}

function isAdminCommand(name) {
  return ['genkey', 'bulkkeys', 'quickgen', 'keyinfo', 'keysbyuser', 'userstatus', 'deletekey', 'revoke', 'deleteavailablekeys', 'deleteallkeys', 'deletegennedkeys', 'users', 'stats', 'exportkeys'].includes(name);
}

function canUseAdmin(interaction) {
  if (OWNER_ROLE_ID && roleOk(interaction, OWNER_ROLE_ID)) return true;
  return roleOk(interaction, GENKEY_ROLE_ID);
}

function formatExpiry(expiresAt) {
  if (!expiresAt || expiresAt === 'lifetime') return 'Lifetime';
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return 'Unknown';
  const diff = exp - new Date();
  if (diff <= 0) return 'Expired';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(mins, 1)}m`;
}

function durationMs(unit, length) {
  if (unit === 'lifetime') return null;
  const n = Math.max(1, Number(length || 1));
  const map = {
    second: 1000,
    minute: 60000,
    hour: 3600000,
    day: 86400000,
    week: 604800000,
    month: 2592000000,
  };
  return map[unit] * n;
}

function durationLabel(unit, length) {
  if (unit === 'lifetime') return 'lifetime';
  const n = Math.max(1, Number(length || 1));
  const names = { second: 'second', minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month' };
  return `${n} ${names[unit]}${n === 1 ? '' : 's'}`;
}

function durationType(unit, length) {
  const n = Math.max(1, Number(length || 1));
  if (unit === 'lifetime') return 'lifetime';
  if (unit === 'hour' && n === 1) return 'lft';
  if (unit === 'day' && n === 1) return 'day';
  if (unit === 'week' && n === 1) return 'week';
  if (unit === 'month' && n === 1) return 'month';
  return 'custom';
}

function emojiForType(type, unit) {
  if (type === 'lifetime' || unit === 'lifetime') return '♾️';
  if (unit === 'second') return '⏱️';
  if (unit === 'minute') return '⏲️';
  if (unit === 'hour' || type === 'lft') return '⚡';
  if (unit === 'day' || type === 'day') return '📅';
  if (unit === 'week' || type === 'week') return '📆';
  if (unit === 'month' || type === 'month') return '🗓️';
  return '🔑';
}

async function generateKeys({ unit, length, amount, user }) {
  const type = durationType(unit, length);
  const ms = durationMs(unit, length);
  const label = durationLabel(unit, length);
  const body = {
    type,
    amount,
    duration_unit: unit,
    duration_length: unit === 'lifetime' ? null : Math.max(1, Number(length || 1)),
    duration_ms: ms,
    duration_seconds: ms ? Math.floor(ms / 1000) : null,
    lifetime: unit === 'lifetime',
    label,
    generated_by: user.id,
    generated_by_tag: user.tag || user.username,
  };

  const attempts = [
    ['/admin/keys/generate', body],
    ['/admin/keys/generate-custom', body],
    ['/admin/generate-keys', body],
  ];

  let data;
  for (const [route, payload] of attempts) {
    data = await apiPost(route, payload);
    if (Array.isArray(data.keys)) break;
    if (data.key) { data.keys = [data.key]; break; }
  }

  if (!Array.isArray(data.keys) && type !== 'custom') {
    data = await apiPost('/admin/keys/generate', { type, amount });
  }

  if (!Array.isArray(data.keys)) return data;

  logGeneratedKeys(data.keys, {
    type,
    durationMs: ms,
    durationLabel: label,
    generatedBy: user.id,
    generatedByTag: user.tag || user.username,
  });

  return { ...data, type, duration_ms: ms, duration_label: label };
}

function getTargetUserId(interaction) {
  const user = interaction.options.getUser('user');
  const id = interaction.options.getString('user_id');
  return user?.id || id?.trim() || interaction.user.id;
}

function keysTxt(keys, meta) {
  const lines = [];
  lines.push('ET Keys');
  lines.push(`Duration: ${meta.duration_label || meta.type || 'unknown'}`);
  lines.push(`Amount: ${keys.length}`);
  lines.push(`Generated by: ${meta.generatedByTag || 'unknown'}`);
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(...keys);
  return lines.join('\n');
}

function makeKeyEmbed(title, keys, meta) {
  const shown = keys.slice(0, 20).map(k => `\`${k}\``).join('\n');
  const hidden = keys.length > 20 ? `\n\n+ ${keys.length - 20} more in the txt file.` : '';
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle(title)
    .setDescription((shown || 'No keys returned.') + hidden)
    .addFields(
      { name: 'Duration', value: meta.duration_label || meta.type || 'Unknown', inline: true },
      { name: 'Amount', value: String(keys.length), inline: true },
    )
    .setFooter({ text: 'Each key is single-use.' })
    .setTimestamp();
}

async function tryGetKeyInfo(key) {
  const routes = [
    `/admin/keys/${encodeURIComponent(key)}`,
    `/admin/key/${encodeURIComponent(key)}`,
    `/admin/keys?key=${encodeURIComponent(key)}`,
  ];
  for (const route of routes) {
    const data = await apiGet(route);
    if (!data.error && (data.key || data.keys || data.id || data.type)) return data;
  }
  return null;
}

async function tryGetUserKeys(userId) {
  const routes = [
    `/admin/users/${encodeURIComponent(userId)}/keys`,
    `/admin/keys/user/${encodeURIComponent(userId)}`,
    `/admin/keys?discord_id=${encodeURIComponent(userId)}`,
  ];
  for (const route of routes) {
    const data = await apiGet(route);
    if (!data.error && (Array.isArray(data) || Array.isArray(data.keys))) return Array.isArray(data) ? data : data.keys;
  }
  return null;
}


async function deliverLootLabRewards() {
  const data = await apiGet('/admin/lootlab/completed?limit=25');
  const rewards = Array.isArray(data.rewards) ? data.rewards : [];
  for (const reward of rewards) {
    try {
      const user = await client.users.fetch(reward.discord_id);
      const embed = new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle('✅ LootLabs Reward Complete')
        .setDescription('Here is your **12 hour ET Sniper key**. The timer does not start until you redeem it.')
        .addFields(
          { name: 'Key', value: `\`${reward.key}\``, inline: false },
          { name: 'How to activate', value: 'Run `/redeem` in the server and paste this key.', inline: false },
        )
        .setTimestamp();
      await user.send({ embeds: [embed] });
      await apiPost(`/admin/lootlab/${reward.id}/delivered`, { delivered: true });
      console.log(`[Bot] Delivered LootLabs reward key to ${reward.discord_id}`);
    } catch (err) {
      console.error(`[Bot] Could not DM LootLabs reward ${reward.id}:`, err.message);
      await apiPost(`/admin/lootlab/${reward.id}/delivered`, { delivered: false, error: err.message });
    }
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  client.user.setActivity('ET Keys | /bothelp', { type: 3 });
  deliverLootLabRewards().catch(err => console.error('[Bot] LootLabs delivery error:', err));
  setInterval(() => deliverLootLabRewards().catch(err => console.error('[Bot] LootLabs delivery error:', err)), LOOTLAB_POLL_SECONDS * 1000);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  if (name === 'lootlab' && !roleOk(interaction, LOOTLAB_ROLE_ID)) {
    return interaction.reply({ content: '❌ You do not have the required LootLabs reward role.', ephemeral: true });
  }

  if (name === 'redeem') {
    if (REDEEM_CHANNEL_ID && interaction.channelId !== REDEEM_CHANNEL_ID) {
      return interaction.reply({ content: `❌ Redeem keys in <#${REDEEM_CHANNEL_ID}>.`, ephemeral: true });
    }
    if (!roleOk(interaction, REDEEM_ROLE_ID)) {
      return interaction.reply({ content: '❌ You do not have the required redeem role.', ephemeral: true });
    }
  }

  if (isAdminCommand(name) && !canUseAdmin(interaction)) {
    return interaction.reply({ content: '❌ You do not have the required key/admin role.', ephemeral: true });
  }

  if (name === 'lootlab') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const data = await apiPost('/admin/lootlab/start', {
        discord_id: interaction.user.id,
        username: interaction.user.username,
        tag: interaction.user.tag || interaction.user.username,
      });
      if (data.error) return interaction.editReply({ content: `❌ ${data.error}` });
      const link = data.loot_url || data.destination_url;
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('🎁 LootLabs 12 Hour Key')
        .setDescription('Finish this LootLabs link and I will DM you a **12 hour key** automatically.')
        .addFields(
          { name: 'Reward link', value: `[Click here to start](${link})`, inline: false },
          { name: 'Reward', value: '12 hour key — timer starts only after `/redeem`', inline: false },
        )
        .setFooter({ text: data.using_lootlabs_api ? 'LootLabs API link created.' : 'Using direct destination URL because LootLabs API token is not set.' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Bot] /lootlab error:', err);
      return interaction.editReply({ content: '❌ Server error while creating your LootLabs link.' });
    }
  }

  if (name === 'lootlabstatus') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const data = await apiGet(`/admin/lootlab/status/${encodeURIComponent(interaction.user.id)}`);
      const rewards = Array.isArray(data.rewards) ? data.rewards : [];
      if (!rewards.length) return interaction.editReply({ content: 'No LootLabs reward attempts found yet. Run `/lootlab` first.' });
      const lines = rewards.slice(0, 5).map(r => {
        const delivered = r.delivered_at ? 'DM sent' : r.key ? 'completed, waiting for DM' : 'pending';
        return `#${r.id} — **${r.status}** — ${delivered}${r.key ? ` — \`${r.key}\`` : ''}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('🎁 LootLabs Reward Status')
        .setDescription(lines.join('\n'))
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Bot] /lootlabstatus error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'redeem') {
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.options.getString('key').trim().toUpperCase();
    try {
      const data = await apiPost('/redeem', {
        key,
        discord_id: interaction.user.id,
        username: interaction.user.username,
        avatar: interaction.user.displayAvatarURL(),
      });
      if (data.error) {
        const messages = {
          invalid_key: '❌ That key does not exist.',
          revoked: '❌ That key has been revoked.',
          already_redeemed: '❌ That key has already been redeemed.',
          already_active: `❌ You already have an active subscription. Time left: **${formatExpiry(data.expires_at)}**`,
        };
        return interaction.editReply({ content: messages[data.error] || `❌ ${data.error}` });
      }
      logRedeemedKey(key, interaction.user);
      const embed = new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle('✅ Key Redeemed')
        .setDescription(`Your **${String(data.type || 'key').toUpperCase()}** access is now active.`)
        .addFields(
          { name: 'Expires', value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:F>` : 'Lifetime', inline: true },
          { name: 'Time Left', value: formatExpiry(data.expires_at), inline: true },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Bot] /redeem error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'status') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const data = await apiPost('/verify', { discord_id: interaction.user.id });
      if (!data.valid) return interaction.editReply({ content: data.reason === 'expired' ? '❌ Your subscription expired.' : '❌ You do not have an active subscription.' });
      const embed = new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle('✅ Active Subscription')
        .addFields(
          { name: 'Expires', value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:F>` : 'Lifetime', inline: true },
          { name: 'Time Left', value: formatExpiry(data.expires_at), inline: true },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Bot] /status error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'genkey' || name === 'bulkkeys') {
    await interaction.deferReply({ ephemeral: true });
    const unit = interaction.options.getString('duration');
    const length = unit === 'lifetime' ? 1 : (interaction.options.getInteger('length') || 1);
    const amount = name === 'bulkkeys' ? interaction.options.getInteger('amount') : (interaction.options.getInteger('amount') || 1);
    try {
      const data = await generateKeys({ unit, length, amount, user: interaction.user });
      if (data.error || !Array.isArray(data.keys)) return interaction.editReply({ content: `❌ ${data.error || 'No keys returned. Your backend may need custom duration support.'}` });
      const txt = keysTxt(data.keys, { ...data, generatedByTag: interaction.user.tag || interaction.user.username });
      const attachment = new AttachmentBuilder(Buffer.from(txt, 'utf8'), { name: `keys-${Date.now()}.txt` });
      const embed = makeKeyEmbed(`${emojiForType(data.type, unit)} ${data.keys.length} Key${data.keys.length === 1 ? '' : 's'} Generated`, data.keys, data);
      return interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      console.error(`[Bot] /${name} error:`, err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'quickgen') {
    await interaction.deferReply({ ephemeral: true });
    const type = interaction.options.getString('type');
    const amount = interaction.options.getInteger('amount') || 1;
    const map = {
      lft: ['hour', 1],
      day: ['day', 1],
      week: ['week', 1],
      month: ['month', 1],
      lifetime: ['lifetime', 1],
    };
    try {
      const [unit, length] = map[type];
      const data = await generateKeys({ unit, length, amount, user: interaction.user });
      if (data.error || !Array.isArray(data.keys)) return interaction.editReply({ content: `❌ ${data.error || 'No keys returned.'}` });
      const txt = keysTxt(data.keys, { ...data, generatedByTag: interaction.user.tag || interaction.user.username });
      const attachment = new AttachmentBuilder(Buffer.from(txt, 'utf8'), { name: `keys-${type}-${Date.now()}.txt` });
      const embed = makeKeyEmbed(`${emojiForType(type, unit)} ${amount} ${type.toUpperCase()} Key${amount === 1 ? '' : 's'} Generated`, data.keys, data);
      return interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      console.error('[Bot] /quickgen error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'keyinfo') {
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.options.getString('key').trim().toUpperCase();
    const local = loadKeyLog().keys[key];
    let remote = null;
    try { remote = await tryGetKeyInfo(key); } catch {}
    if (!local && !remote) return interaction.editReply({ content: '❌ I could not find that key in the bot log or backend.' });
    const info = remote?.key && typeof remote.key === 'object' ? remote.key : remote || local;
    const embed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setTitle('🔎 Key Info')
      .addFields(
        { name: 'Key', value: `\`${key}\``, inline: false },
        { name: 'Type', value: String(info.type || local?.type || 'Unknown'), inline: true },
        { name: 'Duration', value: String(info.duration_label || local?.duration_label || 'Unknown'), inline: true },
        { name: 'Redeemed By', value: String(info.discord_id || info.redeemed_by || local?.redeemed_by || 'Not redeemed'), inline: true },
        { name: 'Revoked', value: String(info.revoked ?? local?.revoked ?? false), inline: true },
      )
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (name === 'keysbyuser') {
    await interaction.deferReply({ ephemeral: true });
    const userId = getTargetUserId(interaction);
    const localLog = loadKeyLog();
    const localKeys = Object.values(localLog.keys).filter(k => String(k.redeemed_by) === String(userId));
    let remoteKeys = null;
    try { remoteKeys = await tryGetUserKeys(userId); } catch {}
    const keys = remoteKeys || localKeys;
    if (!keys || !keys.length) return interaction.editReply({ content: `No keys found for user ID \`${userId}\`.` });
    const lines = keys.slice(0, 25).map(k => {
      const key = typeof k === 'string' ? k : (k.key || k.license_key || k.id || 'unknown');
      const type = typeof k === 'object' ? (k.type || k.duration_label || '') : '';
      return `\`${key}\`${type ? ` — ${type}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x06b6d4)
      .setTitle(`🔑 Keys for ${userId}`)
      .setDescription(lines.join('\n') + (keys.length > 25 ? `\n+ ${keys.length - 25} more` : ''))
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (name === 'userstatus') {
    await interaction.deferReply({ ephemeral: true });
    const userId = getTargetUserId(interaction);
    try {
      const data = await apiPost('/verify', { discord_id: userId });
      if (!data.valid) return interaction.editReply({ content: `❌ User \`${userId}\` has no active subscription.` });
      const embed = new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle('👤 User Subscription')
        .addFields(
          { name: 'User ID', value: `\`${userId}\``, inline: false },
          { name: 'Expires', value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:F>` : 'Lifetime', inline: true },
          { name: 'Time Left', value: formatExpiry(data.expires_at), inline: true },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Bot] /userstatus error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'deletekey') {
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.options.getString('key').trim().toUpperCase();
    try {
      const data = await apiDelete(`/admin/keys/${encodeURIComponent(key)}`);
      if (data.error) return interaction.editReply({ content: `❌ ${data.error}` });
      logRevokedKey(key);
      return interaction.editReply({ content: `✅ Key \`${key}\` has been revoked.` });
    } catch (err) {
      console.error('[Bot] /deletekey error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'revoke') {
    await interaction.deferReply({ ephemeral: true });
    const userId = getTargetUserId(interaction);
    try {
      const data = await apiDelete(`/admin/users/${encodeURIComponent(userId)}`);
      if (data.error) return interaction.editReply({ content: `❌ ${data.error}` });
      return interaction.editReply({ content: `✅ Access revoked for user ID \`${userId}\`.` });
    } catch (err) {
      console.error('[Bot] /revoke error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'deleteavailablekeys') {
    await interaction.deferReply({ ephemeral: true });
    const confirm = interaction.options.getBoolean('confirm');
    if (!confirm) return interaction.editReply({ content: '❌ Cancelled. Set `confirm:true` to delete all available keys.' });
    try {
      const data = await apiDelete('/admin/keys/available/all');
      if (data.error) return interaction.editReply({ content: `❌ ${data.error}` });
      const log = loadKeyLog();
      let localDeleted = 0;
      for (const [key, value] of Object.entries(log.keys)) {
        if (!value.redeemed_by && !value.revoked) {
          delete log.keys[key];
          localDeleted++;
        }
      }
      saveKeyLog(log);
      return interaction.editReply({ content: `✅ Deleted **${data.deleted ?? 0}** available backend key(s). Removed **${localDeleted}** available key(s) from the bot log.` });
    } catch (err) {
      console.error('[Bot] /deleteavailablekeys error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'deleteallkeys') {
    await interaction.deferReply({ ephemeral: true });
    const confirm = interaction.options.getBoolean('confirm');
    if (!confirm) return interaction.editReply({ content: '❌ Cancelled. Set `confirm:true` to delete ALL keys and revoke ALL active users.' });
    try {
      const data = await apiDelete('/admin/keys/all');
      if (data.error) return interaction.editReply({ content: `❌ ${data.error}` });
      const log = loadKeyLog();
      const localDeleted = Object.keys(log.keys).length;
      log.keys = {};
      log.users = {};
      saveKeyLog(log);
      return interaction.editReply({ content: `✅ Deleted **${data.deleted ?? 0}** backend key(s), revoked/logged out **${data.users_revoked ?? 0}** active user(s), and cleared **${localDeleted}** local bot log key(s).` });
    } catch (err) {
      console.error('[Bot] /deleteallkeys error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'deletegennedkeys') {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.options.getString('user_id').trim();
    const confirm = interaction.options.getBoolean('confirm');
    const includeRedeemed = interaction.options.getBoolean('include_redeemed') || false;
    if (!confirm) return interaction.editReply({ content: '❌ Cancelled. Set `confirm:true` to delete keys generated by that user.' });
    try {
      const route = `/admin/keys/generated-by/${encodeURIComponent(userId)}?include_redeemed=${includeRedeemed ? 'true' : 'false'}`;
      const data = await apiDelete(route);
      if (data.error) return interaction.editReply({ content: `❌ ${data.error}` });
      const log = loadKeyLog();
      let localDeleted = 0;
      for (const [key, value] of Object.entries(log.keys)) {
        if (String(value.generated_by) === String(userId) && (includeRedeemed || !value.redeemed_by)) {
          delete log.keys[key];
          localDeleted++;
        }
      }
      saveKeyLog(log);
      return interaction.editReply({ content: `✅ Deleted **${data.deleted ?? 0}** backend key(s) generated by \`${userId}\`. Revoked/logged out **${data.users_revoked ?? 0}** active user(s). Removed **${localDeleted}** matching key(s) from the bot log.${includeRedeemed ? ' Redeemed keys were included.' : ' Redeemed keys were kept.'}` });
    } catch (err) {
      console.error('[Bot] /deletegennedkeys error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'users') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const users = await apiGet('/admin/users');
      if (users.error || !Array.isArray(users)) return interaction.editReply({ content: `❌ ${users.error || 'No users returned.'}` });
      const active = users.filter(u => u.expires_at === 'lifetime' || (u.expires_at && new Date(u.expires_at) > new Date()));
      if (!active.length) return interaction.editReply({ content: 'No active subscribers.' });
      const lines = active.slice(0, 25).map(u => `**${u.username || 'Unknown'}** (\`${u.discord_id}\`) — ${formatExpiry(u.expires_at)}`);
      const embed = new EmbedBuilder().setColor(0x6366f1).setTitle(`👥 Active Subscribers (${active.length})`).setDescription(lines.join('\n')).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Bot] /users error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'stats') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const data = await apiGet('/admin/stats');
      if (data.error) return interaction.editReply({ content: `❌ ${data.error}` });
      const embed = new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle('📊 Key System Stats')
        .addFields(
          { name: 'Total Keys', value: String(data.total_keys ?? '0'), inline: true },
          { name: 'Used Keys', value: String(data.used_keys ?? '0'), inline: true },
          { name: 'Available Keys', value: String(data.available_keys ?? '0'), inline: true },
          { name: 'Revoked Keys', value: String(data.revoked_keys ?? '0'), inline: true },
          { name: 'Active Users', value: String(data.active_users ?? '0'), inline: true },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Bot] /stats error:', err);
      return interaction.editReply({ content: '❌ Server error.' });
    }
  }

  if (name === 'exportkeys') {
    await interaction.deferReply({ ephemeral: true });
    const log = loadKeyLog();
    const rows = Object.values(log.keys).map(k => [
      k.key,
      k.duration_label || k.type || '',
      k.generated_by_tag || '',
      k.generated_at || '',
      k.redeemed_by || '',
      k.redeemed_by_tag || '',
      k.redeemed_at || '',
      k.revoked ? 'revoked' : 'active',
    ].join(' | '));
    const txt = ['key | duration | generated_by | generated_at | redeemed_by | redeemed_by_tag | redeemed_at | status', ...rows].join('\n');
    const attachment = new AttachmentBuilder(Buffer.from(txt, 'utf8'), { name: `key-log-${Date.now()}.txt` });
    return interaction.editReply({ content: `✅ Exported ${rows.length} tracked keys.`, files: [attachment] });
  }

  if (name === 'bothelp') {
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('🤖 Bot Commands')
      .setDescription([
        '`/redeem key:` redeem a key',
        '`/status` check your own access',
        '`/lootlab` get a LootLabs reward link for a 12 hour key',
        '`/lootlabstatus` check your LootLabs reward status',
        '`/genkey duration length amount` generate custom duration keys',
        '`/bulkkeys duration length amount` generate many keys with a txt download',
        '`/quickgen type amount` generate common keys fast',
        '`/keyinfo key` look up a key',
        '`/keysbyuser user/user_id` track redeemed keys by user ID',
        '`/userstatus user/user_id` check a user subscription',
        '`/deletekey key` revoke a key',
        '`/revoke user/user_id` revoke user access',
        '`/deleteavailablekeys confirm` delete every unused available key',
        '`/deleteallkeys confirm` delete every key and revoke every active user',
        '`/deletegennedkeys user_id confirm include_redeemed` delete keys generated by a user',
        '`/users` list active subscribers',
        '`/stats` key system stats',
        '`/exportkeys` download the local tracking log',
        '`/ping` check bot/API response',
      ].join('\n'))
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (name === 'ping') {
    const started = Date.now();
    let apiMs = 'failed';
    try {
      await apiGet('/admin/stats');
      apiMs = `${Date.now() - started}ms`;
    } catch {}
    return interaction.reply({ content: `🏓 Bot: ${client.ws.ping}ms | API: ${apiMs}`, ephemeral: true });
  }
});

registerCommands()
  .then(() => client.login(BOT_TOKEN))
  .catch(err => {
    console.error('[Bot] Startup error:', err);
    process.exit(1);
  });
