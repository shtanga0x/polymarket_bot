/**
 * Shared-D1 user/event recording for the polymarket (portfolio) bot.
 *
 * `env.DB` is the cross-project `shtanga-users` database; rows are tagged
 * bot='polymarket'. All writes are best-effort — a D1 hiccup must never break a
 * user's conversation, so callers wrap these and swallow errors.
 */

import { SYMBOL_POOL_SIZE, symbolForIndex } from './fingerprint.js';

const BOT = 'polymarket';
const now = () => new Date().toISOString();

const detailOf = (from, extra = {}) => JSON.stringify({
  id: from?.id, username: from?.username, first_name: from?.first_name,
  last_name: from?.last_name, language_code: from?.language_code,
  is_premium: from?.is_premium ?? false, ...extra,
});

async function logEvent(env, chatId, from, type, extra) {
  await env.DB.prepare(
    `INSERT INTO events (bot, chat_id, type, username, first_name, detail, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(BOT, chatId, type, from?.username ?? null, from?.first_name ?? null,
         detailOf(from, extra), now()).run();
}

export async function recordStart(env, chatId, from) {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO users (bot, chat_id, username, first_name, last_name, lang_code,
                        is_premium, starts, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(bot, chat_id) DO UPDATE SET
       username = excluded.username, first_name = excluded.first_name,
       last_name = excluded.last_name, lang_code = excluded.lang_code,
       is_premium = excluded.is_premium,
       starts = users.starts + 1, last_seen = excluded.last_seen`
  ).bind(BOT, chatId, from?.username ?? null, from?.first_name ?? null,
         from?.last_name ?? null, from?.language_code ?? null,
         from?.is_premium ? 1 : 0, ts, ts).run();
  await logEvent(env, chatId, from, 'start');
}

export async function recordSubCheck(env, chatId, from, ok) {
  await env.DB.prepare(
    `UPDATE users SET sub_ok = ?, sub_checks = sub_checks + 1, last_seen = ?
     WHERE bot = ? AND chat_id = ?`
  ).bind(ok ? 1 : 0, now(), BOT, chatId).run();
  await logEvent(env, chatId, from, ok ? 'sub_pass' : 'sub_fail');
}

/** Mark active and ensure a visible fingerprint symbol is assigned (once).
 *  `portfolio` ('core' | 'watch' | 'both') is mirrored into the shared DB so the
 *  control panel can segment subscribers — it only ever lived in the R2 profile
 *  before. Returns the symbol so the caller can mirror it into the R2 profile. */
export async function recordActivate(env, chatId, lang, portfolio) {
  const row = await env.DB.prepare(
    `SELECT symbol, symbol_idx FROM users WHERE bot = ? AND chat_id = ?`
  ).bind(BOT, chatId).first();

  let symbol = row?.symbol, idx = row?.symbol_idx;
  if (symbol == null) {
    const max = await env.DB.prepare(
      `SELECT MAX(symbol_idx) AS m FROM users WHERE bot = ?`).bind(BOT).first();
    idx = (max?.m ?? -1) + 1;
    symbol = symbolForIndex(idx);
    if (idx >= SYMBOL_POOL_SIZE) {
      console.warn(`Visible-symbol pool exhausted at idx ${idx}; symbols now repeat (zero-width id still unique).`);
    }
  }
  await env.DB.prepare(
    `UPDATE users SET active = 1, lang = ?, symbol = ?, symbol_idx = ?, portfolio = ?, last_seen = ?
     WHERE bot = ? AND chat_id = ?`
  ).bind(lang ?? null, symbol, idx, portfolio ?? null, now(), BOT, chatId).run();
  await logEvent(env, chatId, null, 'activate', portfolio ? { portfolio } : {});
  return { symbol, idx };
}

export async function recordStop(env, chatId) {
  await env.DB.prepare(
    `UPDATE users SET active = 0, last_seen = ? WHERE bot = ? AND chat_id = ?`
  ).bind(now(), BOT, chatId).run();
  await env.DB.prepare(
    `INSERT INTO events (bot, chat_id, type, ts) VALUES (?, ?, 'stop', ?)`
  ).bind(BOT, chatId, now()).run();
}

/** User left / was kicked from the gated group — drop access, keep history. */
export async function recordRemoved(env, chatId, from, reason, wasSubscribed) {
  await env.DB.prepare(
    `UPDATE users SET active = 0, sub_ok = 0, last_seen = ? WHERE bot = ? AND chat_id = ?`
  ).bind(now(), BOT, chatId).run();
  await env.DB.prepare(
    `INSERT INTO events (bot, chat_id, type, username, first_name, detail, ts)
     VALUES (?, ?, 'removed', ?, ?, ?, ?)`
  ).bind(BOT, chatId, from?.username ?? null, from?.first_name ?? null,
         detailOf(from, { reason, was_subscribed: !!wasSubscribed }), now()).run();
}
