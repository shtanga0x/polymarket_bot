/**
 * Polymarket Bot — Cloudflare Worker
 *
 * fetch handler:     Telegram webhook (user conversations)
 * scheduled handler: Notification cron (every 5 min)
 */

import { sendMessage, editMessage, answerCallback, checkMembership } from './tg.js';
import { t, portfolioLabel } from './i18n.js';
import { langKeyboard, subKeyboard, portfolioKeyboard, topKeyboard, settingsKeyboard, dashboardsKeyboard } from './keyboards.js';
import { runNotifications } from './notify.js';

// ─── KV helpers ────────────────────────────────────────────────────────────

async function getUser(kv, chatId) {
  const raw = await kv.get(`user:${chatId}`);
  return raw ? JSON.parse(raw) : {};
}

async function saveUser(kv, chatId, data) {
  await kv.put(`user:${chatId}`, JSON.stringify(data));
}

async function addToIndex(kv, chatId) {
  const raw = await kv.get('users_index');
  const ids = raw ? JSON.parse(raw) : [];
  if (!ids.includes(chatId)) {
    ids.push(chatId);
    await kv.put('users_index', JSON.stringify(ids));
  }
}

// ─── /start ────────────────────────────────────────────────────────────────

async function handleStart(chatId, from, env) {
  const { BOT_TOKEN: token, BOT_KV: kv } = env;
  const user = await getUser(kv, chatId);
  await saveUser(kv, chatId, {
    ...user,
    state: 'choosing_language',
    username:   from.username   ?? null,
    firstName:  from.first_name ?? null,
  });
  await sendMessage(token, chatId, t.en.welcome, { reply_markup: langKeyboard(t.en) });
}

// ─── /settings ─────────────────────────────────────────────────────────────

async function handleSettings(chatId, env) {
  const { BOT_TOKEN: token, BOT_KV: kv } = env;
  const user = await getUser(kv, chatId);
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
  const { BOT_TOKEN: token, BOT_KV: kv } = env;
  const user = await getUser(kv, chatId);
  const lang = user.lang ?? 'en';
  const txt  = t[lang];
  await sendMessage(token, chatId, txt.dashboards, { reply_markup: dashboardsKeyboard(txt) });
}

async function handleStop(chatId, env) {
  const { BOT_TOKEN: token, BOT_KV: kv } = env;
  const user = await getUser(kv, chatId);
  const lang = user.lang ?? 'en';
  await saveUser(kv, chatId, { ...user, active: false });
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
  const { BOT_TOKEN: token, BOT_KV: kv, CHANNEL_ID } = env;
  const cb     = update.callback_query;
  const chatId = cb.message.chat.id;
  const msgId  = cb.message.message_id;
  const data   = cb.data;

  await answerCallback(token, cb.id);

  const user = await getUser(kv, chatId);

  // ── Language choice ──────────────────────────────────────────────────────
  if (data === 'lang_en' || data === 'lang_ru') {
    const lang = data === 'lang_en' ? 'en' : 'ru';
    const txt  = t[lang];
    await saveUser(kv, chatId, {
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
    await saveUser(kv, chatId, { ...user, state: 'choosing_portfolio' });
    await editMessage(token, chatId, msgId, txt.subOk);
    return sendMessage(token, chatId, txt.choosePortfolio, { reply_markup: portfolioKeyboard(txt) });
  }

  // ── Portfolio choice ─────────────────────────────────────────────────────
  if (data.startsWith('port_')) {
    const portfolio = data.slice(5); // 'core' | 'watch' | 'both'
    await saveUser(kv, chatId, { ...user, portfolio, state: 'choosing_top' });
    return editMessage(token, chatId, msgId, txt.chooseTop, { reply_markup: topKeyboard(txt) });
  }

  // ── Top-level choice ─────────────────────────────────────────────────────
  if (data.startsWith('top_')) {
    const topLevel = parseInt(data.slice(4));
    await saveUser(kv, chatId, { ...user, topLevel, active: true, state: 'active' });
    await addToIndex(kv, chatId);
    const label = portfolioLabel(user.portfolio ?? 'both', lang);
    return editMessage(token, chatId, msgId, txt.configured(label, topLevel));
  }

  // ── Settings actions ─────────────────────────────────────────────────────
  if (data === 'change_settings') {
    await saveUser(kv, chatId, { ...user, state: 'choosing_portfolio' });
    return editMessage(token, chatId, msgId, txt.choosePortfolio, { reply_markup: portfolioKeyboard(txt) });
  }

  if (data === 'toggle_off') {
    await saveUser(kv, chatId, { ...user, active: false });
    return editMessage(token, chatId, msgId, txt.stopped);
  }

  if (data === 'toggle_on') {
    await saveUser(kv, chatId, { ...user, active: true });
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

  async scheduled(_event, env) {
    await runNotifications(env);
  },
};
