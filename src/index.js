/**
 * Polymarket Bot — Cloudflare Worker
 *
 * fetch handler:     Telegram webhook (user conversations)
 * scheduled handler: Notification cron (every minute)
 */

import { sendMessage, editMessage, answerCallback, checkMembership } from './tg.js';
import { t, portfolioLabel } from './i18n.js';
import { langKeyboard, subKeyboard, portfolioKeyboard, topKeyboard, settingsKeyboard, dashboardsKeyboard } from './keyboards.js';
import { runNotifications } from './notify.js';

// ─── State helpers ─────────────────────────────────────────────────────────

async function getR2Json(bucket, key) {
  const obj = await bucket.get(key);
  return obj ? obj.json() : null;
}

async function putR2Json(bucket, key, data) {
  await bucket.put(
    key,
    JSON.stringify(data),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

async function getUser(env, chatId) {
  const key = `users/user:${chatId}.json`;
  const user = await getR2Json(env.BOT_STATE, key);
  if (user) return user;

  const raw = await env.BOT_KV.get(`user:${chatId}`);
  if (!raw) return {};

  const legacyUser = JSON.parse(raw);
  await putR2Json(env.BOT_STATE, key, legacyUser);
  return legacyUser;
}

async function saveUser(env, chatId, data) {
  await putR2Json(env.BOT_STATE, `users/user:${chatId}.json`, data);
}

async function getUserIndex(env) {
  const ids = await getR2Json(env.BOT_STATE, 'users/index.json');
  if (Array.isArray(ids)) return ids;

  const raw = await env.BOT_KV.get('users_index');
  if (!raw) return [];

  const legacyIds = JSON.parse(raw);
  await putR2Json(env.BOT_STATE, 'users/index.json', legacyIds);
  return legacyIds;
}

async function addToIndex(env, chatId) {
  const ids = await getUserIndex(env);
  if (!ids.includes(chatId)) {
    ids.push(chatId);
    await putR2Json(env.BOT_STATE, 'users/index.json', ids);
  }
}

// ─── /start ────────────────────────────────────────────────────────────────

async function handleStart(chatId, from, env) {
  const { BOT_TOKEN: token } = env;
  const user = await getUser(env, chatId);
  await saveUser(env, chatId, {
    ...user,
    state: 'choosing_language',
    username:   from.username   ?? null,
    firstName:  from.first_name ?? null,
  });
  await sendMessage(token, chatId, t.en.welcome, { reply_markup: langKeyboard(t.en) });
}

// ─── /settings ─────────────────────────────────────────────────────────────

async function handleSettings(chatId, env) {
  const { BOT_TOKEN: token } = env;
  const user = await getUser(env, chatId);
  const lang = user.lang ?? 'en';
  const txt  = t[lang];
  const msg  = txt.settings(
    lang === 'en' ? '🇬🇧 English' : '🇷🇺 Русский',
    portfolioLabel(user.portfolio ?? '—', lang),
    user.topLevel ?? '—',
    user.active ?? false,
  );
  await sendMessage(token, chatId, msg, { reply_markup: settingsKeyboard(txt, user.active) });
}

// ─── /stop ─────────────────────────────────────────────────────────────────

async function handleDashboards(chatId, env) {
  const { BOT_TOKEN: token } = env;
  const user = await getUser(env, chatId);
  const lang = user.lang ?? 'en';
  const txt  = t[lang];
  await sendMessage(token, chatId, txt.dashboards, { reply_markup: dashboardsKeyboard(txt) });
}

async function handleStop(chatId, env) {
  const { BOT_TOKEN: token } = env;
  const user = await getUser(env, chatId);
  const lang = user.lang ?? 'en';
  await saveUser(env, chatId, { ...user, active: false });
  await sendMessage(token, chatId, t[lang].stopped);
}

// ─── Message handler ────────────────────────────────────────────────────────

async function handleMessage(update, env) {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text;

  if (text === '/start')      return handleStart(chatId, msg.from, env);
  if (text === '/settings')   return handleSettings(chatId, env);
  if (text === '/stop')       return handleStop(chatId, env);
  if (text === '/dashboards') return handleDashboards(chatId, env);
}

// ─── Callback handler ───────────────────────────────────────────────────────

async function handleCallback(update, env) {
  const { BOT_TOKEN: token, CHANNEL_ID } = env;
  const cb     = update.callback_query;
  const chatId = cb.message.chat.id;
  const msgId  = cb.message.message_id;
  const data   = cb.data;

  await answerCallback(token, cb.id);

  const user = await getUser(env, chatId);

  // ── Language choice ──────────────────────────────────────────────────────
  if (data === 'lang_en' || data === 'lang_ru') {
    const lang = data === 'lang_en' ? 'en' : 'ru';
    const txt  = t[lang];
    await saveUser(env, chatId, {
      ...user,
      lang,
      state: 'checking_subscription',
      username:  cb.from.username   ?? user.username  ?? null,
      firstName: cb.from.first_name ?? user.firstName ?? null,
    });
    return editMessage(token, chatId, msgId, txt.checkSub, { reply_markup: subKeyboard(txt) });
  }

  const lang = user.lang ?? 'en';
  const txt  = t[lang];

  // ── Subscription check ───────────────────────────────────────────────────
  if (data === 'check_sub') {
    const ok = await checkMembership(token, CHANNEL_ID, chatId);
    if (!ok) {
      return sendMessage(token, chatId, txt.noSub, { reply_markup: subKeyboard(txt) });
    }
    await saveUser(env, chatId, { ...user, state: 'choosing_portfolio' });
    await editMessage(token, chatId, msgId, txt.subOk);
    return sendMessage(token, chatId, txt.choosePortfolio, { reply_markup: portfolioKeyboard(txt) });
  }

  // ── Portfolio choice ─────────────────────────────────────────────────────
  if (data.startsWith('port_')) {
    const portfolio = data.slice(5); // 'core' | 'watch' | 'both'
    await saveUser(env, chatId, { ...user, portfolio, state: 'choosing_top' });
    return editMessage(token, chatId, msgId, txt.chooseTop, { reply_markup: topKeyboard(txt) });
  }

  // ── Top-level choice ─────────────────────────────────────────────────────
  if (data.startsWith('top_')) {
    const topLevel = parseInt(data.slice(4));
    await saveUser(env, chatId, { ...user, topLevel, active: true, state: 'active' });
    await addToIndex(env, chatId);
    const label = portfolioLabel(user.portfolio ?? 'both', lang);
    return editMessage(token, chatId, msgId, txt.configured(label, topLevel));
  }

  // ── Settings actions ─────────────────────────────────────────────────────
  if (data === 'change_settings') {
    await saveUser(env, chatId, { ...user, state: 'choosing_portfolio' });
    return editMessage(token, chatId, msgId, txt.choosePortfolio, { reply_markup: portfolioKeyboard(txt) });
  }

  if (data === 'toggle_off') {
    await saveUser(env, chatId, { ...user, active: false });
    return editMessage(token, chatId, msgId, txt.stopped);
  }

  if (data === 'toggle_on') {
    await saveUser(env, chatId, { ...user, active: true });
    return editMessage(token, chatId, msgId, txt.resumed);
  }
}

// ─── Worker entry points ────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('OK');
    try {
      const update = await req.json();
      if (update.callback_query) await handleCallback(update, env);
      else if (update.message)   await handleMessage(update, env);
    } catch (err) {
      console.error('Webhook error:', err);
    }
    return new Response('OK');
  },

  async scheduled(event, env) {
    await runNotifications(env, event.scheduledTime);
  },
};
