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

export const setWebhook = (token, url) =>
  call(token, 'setWebhook', { url, allowed_updates: ['message', 'callback_query'] });

export async function checkMembership(token, channelId, userId) {
  const res = await call(token, 'getChatMember', { chat_id: channelId, user_id: userId });
  if (!res.ok) return false;
  return ['member', 'administrator', 'creator'].includes(res.result?.status);
}
