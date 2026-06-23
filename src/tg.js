/**
 * Thin Telegram Bot API wrapper (pure fetch, no deps)
 */

const BASE = 'https://api.telegram.org/bot';

async function call(token, method, body = {}) {
  const res = await fetch(`${BASE}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export const sendMessage = (token, chatId, text, extra = {}) =>
  call(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });

export const editMessage = (token, chatId, messageId, text, extra = {}) =>
  call(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...extra });

export const answerCallback = (token, id, text = '') =>
  call(token, 'answerCallbackQuery', { callback_query_id: id, text });

// chat_member: a user's group status changed (join/leave/kick) — needs the bot
// to be a group admin. my_chat_member: the BOT's own status changed.
export const setWebhook = (token, url) =>
  call(token, 'setWebhook', {
    url,
    allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
  });

export const getWebhookInfo = token => call(token, 'getWebhookInfo');

// Registers the command list so Telegram shows a ☰ menu next to the input —
// members reach /dashboard with a tap instead of typing it.
export const setMyCommands = (token, commands) =>
  call(token, 'setMyCommands', { commands });

// Like checkMembership but distinguishes "definitely not a member" from "could
// not check" (bot not admin / transient error) — reconcile must never drop a
// real member on an API failure.
export async function getMemberStatus(token, channelId, userId) {
  const res = await call(token, 'getChatMember', { chat_id: channelId, user_id: userId });
  if (!res.ok) return { ok: false, error: res.description };
  return { ok: true, status: res.result?.status, is_member: res.result?.is_member };
}

// Fails CLOSED: if the check errors (bot not yet a group admin), deny access —
// the gate fronts a closed group, so nobody slips in while it's misconfigured.
export async function checkMembership(token, channelId, userId) {
  const res = await call(token, 'getChatMember', { chat_id: channelId, user_id: userId });
  if (!res.ok) {
    console.error('getChatMember failed (bot not group admin?):', res.description);
    return false;
  }
  const m = res.result;
  // A 'restricted' member is STILL in the group (is_member: true) — Telegram
  // reports ordinary members as 'restricted' whenever the group's default
  // permissions are restrictive. Treat them as members so they aren't falsely
  // gated (matches the chat_member revocation 'stillInGroup' logic).
  if (m?.status === 'restricted') return m.is_member === true;
  return ['member', 'administrator', 'creator'].includes(m?.status);
}
