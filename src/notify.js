/**
 * Notification engine — runs on every cron tick.
 * Fetches fresh portfolio data, compares with stored snapshot,
 * sends Telegram messages for positions newly entering Top N.
 */

import { sendMessage } from './tg.js';

const POLYMARKET    = 'https://polymarket.com';
const REFERRAL      = '?r=shtanga';
const SNAPSHOT_SIZE = 100; // track top-100 for rank-change context

const SOURCES = [
  {
    key:     'watch',
    label:   { en: 'Watch', ru: 'Watch' },
    emoji:   '👁',
    url:     'https://shtanga0x.github.io/polymarket_watch/',
    dataUrl: 'https://shtanga0x.github.io/polymarket_watch/data/aggregated_portfolio.json',
    metaUrl: 'https://shtanga0x.github.io/polymarket_watch/data/metadata.json',
  },
  {
    key:     'core',
    label:   { en: 'Core', ru: 'Core' },
    emoji:   '📊',
    url:     'https://shtanga0x.github.io/polymarket_core/',
    dataUrl: 'https://shtanga0x.github.io/polymarket_core/data/aggregated_portfolio.json',
    metaUrl: 'https://shtanga0x.github.io/polymarket_core/data/metadata.json',
  },
];

// ─── Format helpers ────────────────────────────────────────────────────────

function fmtUSD(v) {
  const n = parseFloat(v) || 0;
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function fmtCents(v) {
  return (parseFloat(v) * 100).toFixed(1) + '¢';
}

function fmtPct(v) {
  const n = parseFloat(v) || 0;
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function marketUrl(pos) {
  return pos.eventSlug
    ? `${POLYMARKET}/event/${pos.eventSlug}${REFERRAL}`
    : `${POLYMARKET}/market/${pos.slug}${REFERRAL}`;
}

function buildMessage(pos, currentRank, prevRank, source, lang, topLevel, totalPortfolioExposure) {
  const isNew         = prevRank === null;
  const portfolioLink = `<a href="${source.url}">${source.label[lang]} Portfolio</a>`;
  const rankChange    = isNew
    ? `NEW → <b>#${currentRank}</b>`
    : `#${prevRank} → <b>#${currentRank}</b>`;
  const header        = `${source.emoji} <b>${portfolioLink}</b> ${rankChange}`;

  const outcomeIcon = pos.outcome === 'Yes' ? '🟢' : '🔴';
  const priceChange = pos.priceChangePct != null
    ? ` (${fmtPct(pos.priceChangePct)})`
    : '';
  const exposurePct = totalPortfolioExposure > 0
    ? ` (${(pos.totalExposure / totalPortfolioExposure * 100).toFixed(2)}%)`
    : '';

  return [
    header,
    '',
    `📌 <a href="${marketUrl(pos)}">${escHtml(pos.title)}</a>`,
    `${outcomeIcon} <b>${pos.outcome}</b> | Entry: ${fmtCents(pos.avgEntry)} → Now: ${fmtCents(pos.curPrice)}${priceChange}`,
    `💰 Exposure: <b>${fmtUSD(pos.totalExposure)}${exposurePct}</b>  |  👥 ${pos.traderCount} traders`,
  ].join('\n');
}

// ─── KV helpers ────────────────────────────────────────────────────────────
// snapshot + lastProcessed live in one key so each cron tick does at most
// 1 write per source (free-tier KV gives 1000 writes/day).

async function getState(kv, key) {
  const raw = await kv.get(`state:${key}`);
  if (raw) return JSON.parse(raw);
  // Legacy fallback — runs once per source after deploy, then state:* takes over.
  const [snapRaw, lastProcessed] = await Promise.all([
    kv.get(`snapshot:${key}`),
    kv.get(`last_processed:${key}`),
  ]);
  return {
    snapshot: snapRaw ? JSON.parse(snapRaw) : [],
    lastProcessed: lastProcessed || null,
  };
}

async function saveState(kv, key, positions, lastProcessed) {
  const snapshot = positions.slice(0, SNAPSHOT_SIZE).map((p, i) => ({
    conditionId:  p.conditionId,
    outcomeIndex: p.outcomeIndex ?? (p.outcome === 'Yes' ? 1 : 0),
    rank: i + 1,
  }));
  await kv.put(`state:${key}`, JSON.stringify({ snapshot, lastProcessed }));
}

// ─── Portfolio fetch ────────────────────────────────────────────────────────

async function fetchJSON(url) {
  try {
    const res = await fetch(url + '?t=' + Date.now());
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ─── Subscriber fetch ───────────────────────────────────────────────────────

async function getSubscribers(kv) {
  const raw = await kv.get('users_index');
  return raw ? JSON.parse(raw) : [];
}

async function getUser(kv, chatId) {
  const raw = await kv.get(`user:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

// ─── Main notification runner ────────────────────────────────────────────────

export async function runNotifications(env) {
  const { BOT_TOKEN: token, BOT_KV: kv } = env;

  for (const source of SOURCES) {
    // 1. Check if data was updated since last run
    const meta = await fetchJSON(source.metaUrl);
    if (!meta?.last_updated) continue;

    const state = await getState(kv, source.key);
    if (state.lastProcessed === meta.last_updated) continue; // nothing new

    // 2. Fetch current portfolio
    const portfolio = await fetchJSON(source.dataUrl);
    if (!portfolio?.positions?.length) continue;

    const currentPositions = portfolio.positions; // already sorted by exposure desc

    // 3. Load previous snapshot
    const prevRanks = new Map(state.snapshot.map(p => [
      `${p.conditionId}-${p.outcomeIndex}`, p.rank
    ]));

    // 4. Find positions that newly entered top-30
    const newEntries = [];
    for (let i = 0; i < Math.min(30, currentPositions.length); i++) {
      const pos          = currentPositions[i];
      const outcomeIdx   = pos.outcomeIndex ?? (pos.outcome === 'Yes' ? 1 : 0);
      const posKey       = `${pos.conditionId}-${outcomeIdx}`;
      const currentRank  = i + 1;
      const prevRank     = prevRanks.get(posKey) ?? null;

      // Already in top-30 before → no notification
      if (prevRank !== null && prevRank <= 30) continue;

      newEntries.push({ pos, currentRank, prevRank });
    }

    // 5. Save new snapshot and mark as processed (single write)
    await saveState(kv, source.key, currentPositions, meta.last_updated);

    if (newEntries.length === 0) continue;

    // 6. Notify subscribers
    const userIds = await getSubscribers(kv);

    for (const userId of userIds) {
      const user = await getUser(kv, userId);
      if (!user?.active) continue;
      if (user.portfolio !== source.key && user.portfolio !== 'both') continue;

      const topLevel            = user.topLevel ?? 10;
      const lang                = user.lang ?? 'en';
      const totalPortfolioExposure = portfolio.summary?.totalExposure ?? 0;

      const toSend = newEntries.filter(e => e.currentRank <= topLevel);

      for (const { pos, currentRank, prevRank } of toSend) {
        const msg = buildMessage(pos, currentRank, prevRank, source, lang, topLevel, totalPortfolioExposure);
        try {
          await sendMessage(token, userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          console.error(`Failed to notify ${userId}:`, err.message);
        }
        // Respect Telegram's 30 msg/sec limit
        await new Promise(r => setTimeout(r, 50));
      }
    }
  }
}
