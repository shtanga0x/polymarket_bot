/**
 * Polymarket Bot — Cloudflare Worker
 *
 * fetch handler:     Telegram webhook (user conversations)
 * scheduled handler: Notification cron (every minute)
 */

import { sendMessage, editMessage, answerCallback, checkMembership, setWebhook, setMyCommands, getWebhookInfo } from './tg.js';
import { t, portfolioLabel } from './i18n.js';
import { langKeyboard, subKeyboard, noSubKeyboard, portfolioKeyboard, topKeyboard, settingsKeyboard, openDashboardKeyboard } from './keyboards.js';
import { runNotifications } from './notify.js';
import { recordStart, recordSubCheck, recordActivate, recordStop, recordRemoved } from './db.js';

// D1 writes are tracking-only: never let one break a user's conversation.
const track = p => Promise.resolve(p).catch(err => console.error('D1 track failed:', err?.message));

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
  await track(recordStart(env, chatId, from));
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

/** Dashboard access is handled by @shtanga_gate_bot; just point the user there. */
async function handleDashboards(chatId, env) {
  const { BOT_TOKEN: token } = env;
  const user = await getUser(env, chatId);
  const txt  = t[user.lang ?? 'en'];
  await sendMessage(token, chatId, txt.dashboards, { reply_markup: openDashboardKeyboard(txt) });
}

async function handleStop(chatId, env) {
  const { BOT_TOKEN: token } = env;
  const user = await getUser(env, chatId);
  const lang = user.lang ?? 'en';
  await track(recordStop(env, chatId));
  await saveUser(env, chatId, { ...user, active: false });
  await sendMessage(token, chatId, t[lang].stopped);
}

// ─── Group membership tracking ───────────────────────────────────────────────
// A user is "in" the group while their status is member/admin/creator (or a
// restricted member who is still present). Mirrors checkMembership().
const stillInGroup = m =>
  ['creator', 'administrator', 'member'].includes(m.status) ||
  (m.status === 'restricted' && m.is_member);

/** Revoke a user's access after they leave/are kicked — but only if they ever
 *  used the bot, so unrelated group departures don't trigger DMs. */
async function deactivateForRemoval(env, tgUser, reason) {
  const { BOT_TOKEN: token } = env;
  const chatId = tgUser.id;
  const ids = await getUserIndex(env);
  const wasSubscribed = ids.includes(chatId);
  const user = await getUser(env, chatId);
  const known = wasSubscribed || Object.keys(user).length > 0;
  if (!known) return;

  if (Object.keys(user).length) await saveUser(env, chatId, { ...user, active: false, removed: true });
  if (wasSubscribed) await putR2Json(env.BOT_STATE, 'users/index.json', ids.filter(id => id !== chatId));
  // Recorded as a D1 'removed' event; the control bot's cron relays it to the owner.
  await track(recordRemoved(env, chatId, tgUser, reason, wasSubscribed));
  const txt = t[user.lang ?? 'en'];
  await sendMessage(token, chatId, txt.removed, { reply_markup: noSubKeyboard(txt) }).catch(() => {});
}

/** Telegram pushes this the moment a member's group status changes (admin-only). */
async function handleChatMember(update, env) {
  const cm = update.chat_member;
  if (String(cm.chat?.id) !== String(env.CHANNEL_ID)) return; // only the gated group
  if (stillInGroup(cm.new_chat_member)) return;               // joined or stayed
  await deactivateForRemoval(env, cm.new_chat_member.user, cm.new_chat_member.status);
}

// ─── Message handler ────────────────────────────────────────────────────────

async function handleMessage(update, env) {
  const msg = update.message;
  if (!msg?.text) return;
  // Onboarding/settings is a 1:1 DM flow. Ignore group/supergroup messages —
  // otherwise a user typing /start inside the gated group makes the bot reply
  // INTO the group (spamming the inner circle) and key the flow on the group's
  // own id instead of the user's. Group joins/leaves arrive via chat_member.
  if (msg.chat?.type !== 'private') return;
  const chatId = msg.chat.id;
  const text   = msg.text;

  if (text === '/start')      return handleStart(chatId, msg.from, env);
  if (text === '/settings')   return handleSettings(chatId, env);
  if (text === '/stop')       return handleStop(chatId, env);
  if (text === '/dashboard' ||
      text === '/dashboards') return handleDashboards(chatId, env);
}

// ─── Callback handler ───────────────────────────────────────────────────────

async function handleCallback(update, env) {
  const { BOT_TOKEN: token, CHANNEL_ID } = env;
  const cb     = update.callback_query;
  // Drive the DM flow only in private chats. A button pressed on a bot message
  // that landed in the group would otherwise key every action (membership check,
  // sub-check logging, replies) on the group id — producing false "failed group
  // check" alerts and posting the onboarding flow into the inner-circle group.
  if (cb.message?.chat?.type !== 'private') return answerCallback(token, cb.id);
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
    await track(recordSubCheck(env, chatId, cb.from, ok));
    if (!ok) {
      return sendMessage(token, chatId, txt.noSub, { reply_markup: noSubKeyboard(txt) });
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
    // Activation assigns the user's visible fingerprint symbol (in D1); mirror it
    // into the R2 profile so the notification hot path needs no D1 read.
    const { symbol } = await recordActivate(env, chatId, lang, user.portfolio).catch(() => ({}));
    await saveUser(env, chatId, { ...user, topLevel, active: true, state: 'active', ...(symbol ? { symbol } : {}) });
    await addToIndex(env, chatId);
    const label = portfolioLabel(user.portfolio ?? 'both', lang);
    return editMessage(token, chatId, msgId, txt.configured(label, topLevel),
      { reply_markup: openDashboardKeyboard(txt) });
  }

  // ── Settings actions ─────────────────────────────────────────────────────
  if (data === 'change_settings') {
    await saveUser(env, chatId, { ...user, state: 'choosing_portfolio' });
    return editMessage(token, chatId, msgId, txt.choosePortfolio, { reply_markup: portfolioKeyboard(txt) });
  }

  if (data === 'toggle_off') {
    await track(recordStop(env, chatId));
    await saveUser(env, chatId, { ...user, active: false });
    return editMessage(token, chatId, msgId, txt.stopped);
  }

  if (data === 'toggle_on') {
    const { symbol } = await recordActivate(env, chatId, lang).catch(() => ({}));
    await saveUser(env, chatId, { ...user, active: true, ...(symbol ? { symbol } : {}) });
    return editMessage(token, chatId, msgId, txt.resumed);
  }
}

// ─── Worker entry points ────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Re-register the webhook (and its allowed_updates) using the bot's own
    // token, so the secret is never handled outside the worker.
    if (req.method === 'GET' && url.pathname === '/setup') {
      await setWebhook(env.BOT_TOKEN, url.origin);
      await setMyCommands(env.BOT_TOKEN, [
        { command: 'dashboard', description: '📊 Open the dashboards' },
        { command: 'settings',  description: '⚙️ Change your settings' },
        { command: 'stop',      description: '🔕 Turn off notifications' },
        { command: 'start',     description: '🔄 Restart / re-check access' },
      ]);
      const info = await getWebhookInfo(env.BOT_TOKEN);
      return new Response(JSON.stringify(info), { headers: { 'content-type': 'application/json' } });
    }
    // One-time backfill: copy each existing subscriber's portfolio choice
    // (core|watch|both — historically only in the R2 profile) into the shared DB
    // so the control panel can segment them. Guarded by GATE_SECRET; idempotent.
    if (req.method === 'GET' && url.pathname === '/backfill-portfolio') {
      if (url.searchParams.get('secret') !== env.GATE_SECRET) return new Response('nope', { status: 403 });
      const ids = await getUserIndex(env);
      let updated = 0;
      const seen = {};
      for (const id of ids) {
        const u = await getUser(env, id);
        if (!u?.portfolio) continue;
        const r = await env.DB.prepare(
          `UPDATE users SET portfolio = ? WHERE bot = 'polymarket' AND chat_id = ?`
        ).bind(u.portfolio, id).run();
        if (r.meta.changes > 0) updated++;
        seen[u.portfolio] = (seen[u.portfolio] ?? 0) + 1;
      }
      return new Response(JSON.stringify({ scanned: ids.length, updated, byPortfolio: seen }),
        { headers: { 'content-type': 'application/json' } });
    }
    if (req.method !== 'POST') return new Response('OK');
    try {
      const update = await req.json();
      if (update.callback_query)      await handleCallback(update, env);
      else if (update.message)        await handleMessage(update, env);
      else if (update.chat_member)    await handleChatMember(update, env);
      else if (update.my_chat_member) {
        const m = update.my_chat_member;
        if (String(m.chat?.id) === String(env.CHANNEL_ID) && !stillInGroup(m.new_chat_member))
          console.warn('polymarket-bot lost membership/admin in the gated group — sub checks will fail closed.');
      }
    } catch (err) {
      console.error('Webhook error:', err);
    }
    return new Response('OK');
  },

  async scheduled(event, env) {
    await runNotifications(env, event.scheduledTime);
  },
};
