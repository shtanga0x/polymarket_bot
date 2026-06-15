/**
 * Notification engine — runs on every cron tick.
 *
 * Fires three kinds of messages, all gated by an "activity gate":
 *   • Entry / progression — when a position crosses one or more of
 *     [30, 15, 10, 5, 4, 3, 2, 1] going up (rank decreasing).
 *   • Exit — when a position drops below the user's topLevel.
 *
 * Activity gate: only fire if the position's aggregate `size` (shares) or
 * `traderCount` changed since the last snapshot. Pure rank shuffles caused by
 * other positions moving (or by price drift alone) do not trigger messages.
 */

import { sendMessage } from './tg.js';
import { fingerprint, symbolForIndex } from './fingerprint.js';

const POLYMARKET    = 'https://polymarket.com';
const REFERRAL      = '?via=shtanga';
const SNAPSHOT_SIZE   = 200; // track top-200 so positions falling fast still have prevRank
const THRESHOLDS      = [30, 15, 10, 5, 4, 3, 2, 1]; // descending — used for both entry & exit
const MAX_MILESTONES  = 10; // cap chain length so a long-lived position can't grow snapshot unboundedly
// How long a rank-progression chain stays "live". A position that crossed
// #31 → #9 → #4 and then sits idle for hours shouldn't re-print that whole
// passed path when it later ticks to #3 — after this window the chain resets
// so the next message shows only the fresh movement (e.g. "#4 → #3").
const MILESTONE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SOURCES = [
  {
    key:     'watch',
    label:   { en: 'Watch', ru: 'Watch' },
    emoji:   '👁',
    url:     'https://watch.shtanga.xyz/',
    feedUrl: 'https://data.shtanga.xyz/watch/bot_feed.json',
  },
  {
    key:     'core',
    label:   { en: 'Core', ru: 'Core' },
    emoji:   '📊',
    url:     'https://core.shtanga.xyz/',
    feedUrl: 'https://data.shtanga.xyz/core/bot_feed.json',
  },
];

// ─── Format helpers ────────────────────────────────────────────────────────

function fmtUSD(v) {
  const n = parseFloat(v) || 0;
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function fmtUSDSigned(v) {
  const n = parseFloat(v) || 0;
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtCents(v) {
  return (parseFloat(v) * 100).toFixed(1) + '¢';
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return 'n/a';
  const n = parseFloat(v);
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

// ─── Per-position helpers ──────────────────────────────────────────────────

function posKeyOf(pos) {
  const idx = pos.outcomeIndex ?? (pos.outcome === 'Yes' ? 1 : 0);
  return `${pos.conditionId}-${idx}`;
}

function aggregateSize(pos) {
  // bot_feed.json carries the precomputed total; the traders array is the
  // legacy fallback for the full aggregated_portfolio shape.
  if (Number.isFinite(pos?.totalSize)) return pos.totalSize;
  if (!Array.isArray(pos.traders)) return 0;
  return pos.traders.reduce((s, t) => s + (parseFloat(t.size) || 0), 0);
}

function isExpired(endDate) {
  if (!endDate) return false;
  // endDate is "YYYY-MM-DD" — compare as date string.
  return endDate.slice(0, 10) <= new Date().toISOString().slice(0, 10);
}

function parseTitleDeadline(title) {
  if (!title) return null;
  const months = {
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    may: '05',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12',
  };
  const match = String(title).match(/\b(?:by|before|on)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i);
  if (!match) return null;
  const month = months[match[1].toLowerCase()];
  const day = match[2].padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function isRedeemedExit(pos, positionExists) {
  // If the position is still present in the aggregate portfolio, this is a
  // sell-down/rank-drop notification, not a redemption, even if Polymarket's
  // raw endDate is stale or inherited from an event collection.
  if (positionExists) return false;

  const titleDeadline = parseTitleDeadline(pos?.title);
  const today = new Date().toISOString().slice(0, 10);
  if (titleDeadline && titleDeadline > today) return false;

  return isExpired(pos?.endDate);
}

// Sum trade USD flow (BUY positive, SELL negative) per window for a specific
// conditionId+outcomeIndex. Mirrors dashboard semantics.
function computeWindowDeltas(changes, conditionId, outcomeIndex, totalExposure, pos = null) {
  const out = { h1: { usd: 0, pct: null }, d1: { usd: 0, pct: null }, w1: { usd: 0, pct: null } };

  // Fast path: the pipeline precomputes chained per-window sums from the FULL
  // activity history (h1 = last hour, d1 = 1h–24h, w1 = 1d–7d). Cumulative
  // "vs now" deltas are their running sums.
  if (pos?.windowChanges) {
    const wc = pos.windowChanges;
    const cum = { h1: wc.h1 || 0 };
    cum.d1 = cum.h1 + (wc.d1 || 0);
    cum.w1 = cum.d1 + (wc.w1 || 0);
    for (const w of ['h1', 'd1', 'w1']) {
      out[w].usd = cum[w];
      const denom = totalExposure - cum[w];
      if (denom > 0) out[w].pct = (cum[w] / denom) * 100;
    }
    return out;
  }

  // Fallback (positions that dropped out of the portfolio): sum raw change
  // events from the feed.
  const now = Math.floor(Date.now() / 1000);
  const windows = { h1: now - 3600, d1: now - 24 * 3600, w1: now - 7 * 24 * 3600 };

  for (const c of changes) {
    if (c.conditionId !== conditionId) continue;
    if (c.outcomeIndex !== undefined && c.outcomeIndex !== outcomeIndex) continue;
    const ts = c.timestamp || 0;
    for (const w of ['h1', 'd1', 'w1']) {
      if (ts >= windows[w]) out[w].usd += (c.delta || 0);
    }
  }
  for (const w of ['h1', 'd1', 'w1']) {
    // Denominator = pre-window exposure ≈ current − delta.
    // For sells, this bounds |pct| to 100% (-100% = fully closed).
    const denom = totalExposure - out[w].usd;
    if (denom > 0) out[w].pct = (out[w].usd / denom) * 100;
  }
  return out;
}

// Build exit chain: [prevRank, ...thresholds crossed going down (ascending), null].
// Mirrors entry — shows each tracked threshold the position passed through on
// the way out. `null` at the end renders as "OUT".
function buildExitChain(prevRank, downCrossed) {
  if (prevRank == null) return [null];
  const intermediates = [...downCrossed]
    .filter(T => T > prevRank) // skip thresholds == prevRank (e.g. #30 crossing 30)
    .sort((a, b) => a - b);
  return [prevRank, ...intermediates, null];
}

// Render rank chain: [35, 28, 14, 8] → "#35 → #28 → #14 → <b>#8</b>"
// `null` at the start renders as "NEW" (position wasn't tracked before).
// `null` at the end renders as "OUT" (position has exited the snapshot).
function renderRankChain(milestones) {
  if (!milestones || milestones.length === 0) return '';
  const tok = (r, isLast) => r === null ? (isLast ? 'OUT' : 'NEW') : `#${r}`;
  if (milestones.length === 1) return `<b>${tok(milestones[0], true)}</b>`;
  const lastIdx = milestones.length - 1;
  const rest = milestones.slice(0, -1).map(r => tok(r, false)).join(' → ');
  return `${rest} → <b>${tok(milestones[lastIdx], true)}</b>`;
}

function renderTraderCount(prevTC, currentTC) {
  if (prevTC == null || prevTC === currentTC) return `${currentTC} traders`;
  return `${prevTC} → <b>${currentTC}</b> traders`;
}

// ─── Message builders ───────────────────────────────────────────────────────

// Price-change % from entry to current; null when entry price is unknown.
function pricePct(pos) {
  if (pos.priceChangePct != null && !isNaN(pos.priceChangePct)) return parseFloat(pos.priceChangePct);
  const e = parseFloat(pos.avgEntry), c = parseFloat(pos.curPrice);
  if (!(e > 0) || isNaN(c)) return null;
  return ((c - e) / e) * 100;
}

// "🟢 Yes | Entry: 34.0¢ → Now: 83.0¢ (+144.1%)" — the entry→now price line.
// `sold` forces the red marker for a sell-down exit (outcome colour otherwise).
function renderPriceLine(pos, sold = false) {
  const icon = sold ? '🔴' : (pos.outcome === 'Yes' ? '🟢' : '🔴');
  if (parseFloat(pos.avgEntry) > 0) {
    const pc = pricePct(pos);
    const pct = pc != null ? ` (${fmtPct(pc)})` : '';
    return `${icon} <b>${pos.outcome}</b> | Entry: ${fmtCents(pos.avgEntry)} → Now: ${fmtCents(pos.curPrice)}${pct}`;
  }
  return `${icon} <b>${pos.outcome}</b> | Now: ${fmtCents(pos.curPrice)}`;
}

// The 1h / 24h / 1w trade-flow lines — shown on every position-change message.
// Label is "24h" (not "1d") to stay consistent with the rest of the UI.
function renderDeltaLines(deltas) {
  return [
    `📊 1h:  ${fmtUSDSigned(deltas.h1.usd)} (${fmtPct(deltas.h1.pct)})`,
    `📊 24h: ${fmtUSDSigned(deltas.d1.usd)} (${fmtPct(deltas.d1.pct)})`,
    `📊 1w:  ${fmtUSDSigned(deltas.w1.usd)} (${fmtPct(deltas.w1.pct)})`,
  ];
}

function exposureLine(pos, prevTraderCount, totalPortfolioExposure) {
  const exposurePct = totalPortfolioExposure > 0
    ? ` (${(pos.totalExposure / totalPortfolioExposure * 100).toFixed(2)}%)`
    : '';
  return `💰 Exposure: <b>${fmtUSD(pos.totalExposure)}${exposurePct}</b>  |  👥 ${renderTraderCount(prevTraderCount, pos.traderCount)}`;
}

function buildEntryMessage({ pos, source, lang, milestones, prevTraderCount, totalPortfolioExposure, deltas }) {
  const portfolioLink = `<a href="${source.url}">${source.label[lang]} Portfolio</a>`;
  const header = `${source.emoji} <b>${portfolioLink}</b> ${renderRankChain(milestones)}`;

  return [
    header,
    '',
    `📌 <a href="${marketUrl(pos)}">${escHtml(pos.title)}</a>`,
    renderPriceLine(pos, false),
    exposureLine(pos, prevTraderCount, totalPortfolioExposure),
    '',
    ...renderDeltaLines(deltas),
  ].join('\n');
}

function buildExitMessage({ pos, source, lang, milestones, prevTraderCount, deltas, redeemed, totalPortfolioExposure }) {
  const portfolioLink = `<a href="${source.url}">${source.label[lang]} Portfolio</a>`;
  const reason = redeemed
    ? '🏁 <b>Event expired — redeemed</b>'
    : '💸 <b>Position sold down</b>';
  // milestones ends with `null` so renderRankChain produces "→ OUT"
  const header = `${source.emoji} <b>${portfolioLink}</b> ${renderRankChain(milestones)}`;

  // A redemption shows its final settle price; a sell-down mirrors the entry
  // message's entry→now line but with the red marker.
  const priceLine = redeemed
    ? `${pos.outcome === 'Yes' ? '🟢' : '🔴'} <b>${pos.outcome}</b> | Final: ${fmtCents(pos.curPrice)}`
    : renderPriceLine(pos, true);

  return [
    header,
    reason,
    '',
    `📌 <a href="${marketUrl(pos)}">${escHtml(pos.title)}</a>`,
    priceLine,
    exposureLine(pos, prevTraderCount, totalPortfolioExposure),
    '',
    ...renderDeltaLines(deltas),
  ].join('\n');
}

// ─── State helpers ─────────────────────────────────────────────────────────

async function getState(env, key) {
  const obj = await env.BOT_STATE.get(`state/${key}.json`);
  if (obj) return await obj.json();
  // Legacy fallback — runs once per source after deploy, then R2 takes over.
  const kvRaw = await env.BOT_KV.get(`state:${key}`);
  return kvRaw ? JSON.parse(kvRaw) : { snapshot: [], lastProcessed: null };
}

async function saveState(env, key, snapshotEntries, lastProcessed) {
  await env.BOT_STATE.put(
    `state/${key}.json`,
    JSON.stringify({ snapshot: snapshotEntries, lastProcessed }),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  try {
    const res = await fetch(url + '?t=' + Date.now());
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

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

async function getSubscribers(env) {
  const ids = await getR2Json(env.BOT_STATE, 'users/index.json');
  if (Array.isArray(ids)) return ids;

  const raw = await env.BOT_KV.get('users_index');
  if (!raw) return [];

  const legacyIds = JSON.parse(raw);
  await putR2Json(env.BOT_STATE, 'users/index.json', legacyIds);
  return legacyIds;
}

async function getUser(env, chatId) {
  const key = `users/user:${chatId}.json`;
  const user = await getR2Json(env.BOT_STATE, key);
  if (user) return user;

  const raw = await env.BOT_KV.get(`user:${chatId}`);
  if (!raw) return null;

  const legacyUser = JSON.parse(raw);
  await putR2Json(env.BOT_STATE, key, legacyUser);
  return legacyUser;
}

// ─── Main notification runner ──────────────────────────────────────────────

export async function runNotifications(env, scheduledTime) {
  const { BOT_TOKEN: token } = env;

  // CPU budget: parsing both sites' multi-MB JSON in one tick exceeds the
  // Workers CPU limit. Alternate sources by minute parity — each site is
  // still checked every 2 minutes, matching the data refresh cadence.
  const nowMs = scheduledTime ?? Date.now(); // tick time — used to age out rank chains
  const minute = Math.floor(nowMs / 60_000);
  const sources = scheduledTime !== undefined
    ? [SOURCES[minute % SOURCES.length]]
    : SOURCES; // manual/webhook invocations still process everything

  for (const source of sources) {
    // Best-effort per-source lock (R2 is read-after-write consistent). Cloudflare
    // cron can occasionally double-deliver or overlap a tick; without
    // serialization two concurrent runs read the same pre-snapshot and both
    // announce the same rank cross (observed as duplicate messages). A fresh
    // lock makes the second run skip — the next tick processes the latest feed.
    // The ts guards against a crashed run holding it forever; no explicit
    // release needed since the same source is only revisited ~2 min later.
    const lockKey = `locks/notify-${source.key}.json`;
    const lockObj = await env.BOT_STATE.get(lockKey);
    if (lockObj) {
      const { ts = 0 } = await lockObj.json().catch(() => ({}));
      if (nowMs - ts < 90_000) continue;
    }
    await env.BOT_STATE.put(lockKey, JSON.stringify({ ts: nowMs }), { httpMetadata: { contentType: 'application/json' } });

    // 1+2. Single slim feed (~100KB) — the pipeline publishes bot_feed.json
    // with exactly the fields we need. Parsing the full aggregated_portfolio
    // (multi-MB) blew the Workers CPU limit and stalled notifications.
    const feed = await fetchJSON(source.feedUrl);
    if (!feed?.last_updated) continue;

    const state = await getState(env, source.key);
    if (state.lastProcessed === feed.last_updated) continue;
    if (!feed.positions?.length) continue;

    const meta = { last_updated: feed.last_updated };
    const allPositions = feed.positions; // sorted by exposure desc
    const totalPortfolioExposure = feed.summary?.totalExposure ?? 0;
    const changes = feed.changes ?? [];

    // 3. Index prev snapshot by posKey
    const prevByKey = new Map();
    for (const p of state.snapshot) {
      prevByKey.set(`${p.conditionId}-${p.outcomeIndex}`, p);
    }

    // 4. First-run safety: if snapshot is empty OR has the legacy schema
    // (no `size` field), save the new-schema snapshot without firing notifications.
    // Otherwise the schema migration would trigger spurious activity-gate hits.
    const isFirstRun = state.snapshot.length === 0
      || state.snapshot[0]?.size === undefined;

    // 5. Build current top-N entries with derived fields
    const topN = allPositions.slice(0, SNAPSHOT_SIZE);
    const currentByKey = new Map();
    topN.forEach((pos, i) => {
      const idx  = pos.outcomeIndex ?? (pos.outcome === 'Yes' ? 1 : 0);
      const key  = `${pos.conditionId}-${idx}`;
      currentByKey.set(key, {
        pos,
        outcomeIndex: idx,
        rank:         i + 1,
        size:         aggregateSize(pos),
        traderCount:  pos.traderCount ?? (pos.traders?.length ?? 0),
      });
    });

    // 6. Compute notifications. Two sources of events:
    //    (a) positions in current top-200 — possible entry/progression OR partial drop
    //    (b) positions in prev snapshot but not in current top-200 — drop-out events
    const entryEvents = []; // { pos, key, prev, current, milestones, upCrossed }
    const exitEvents  = []; // { pos, key, prev, current, milestones, downCrossed, deltas, redeemed }

    // Pass A: current top-200
    for (const [key, current] of currentByKey) {
      const prev = prevByKey.get(key);
      const prevRank        = prev?.rank ?? null;       // null = wasn't in prev top-200
      const prevSize        = prev?.size ?? null;
      const prevTraderCount = prev?.traderCount ?? null;
      const prevMilestones  = prev?.milestones ?? [];
      const prevMilestonesTs = prev?.milestonesTs ?? null;
      // Stale once the chain hasn't advanced within the TTL (or predates this
      // field, e.g. snapshots written before TTL tracking existed).
      const chainStale = prevMilestonesTs == null
        || (nowMs - prevMilestonesTs) > MILESTONE_TTL_MS;

      // Activity gate: size or traderCount must have changed.
      // For brand-new positions in snapshot, treat as "active" (real entry).
      const sizeChanged = prev != null
        ? (Math.abs(current.size - prevSize) > 0.001 || current.traderCount !== prevTraderCount)
        : true;

      // Threshold transitions
      const upCrossed = THRESHOLDS.filter(T =>
        (prevRank == null || prevRank > T) && current.rank <= T
      );
      const downCrossed = THRESHOLDS.filter(T =>
        prevRank != null && prevRank <= T && current.rank > T
      );

      // Entry / progression: any up-crosses (gated by activity)
      if (upCrossed.length && sizeChanged) {
        // Fresh start when: never tracked, was outside top-30, chain was reset
        // by a recent exit (prevMilestones empty), OR the prior chain has gone
        // stale (>1h) — so we show only the new movement instead of re-printing
        // a path the user already saw.
        const startsFresh = prevRank == null || prevRank > 30
          || prevMilestones.length === 0 || chainStale;
        let milestones = startsFresh
          ? [prevRank /* may be null → renders as "NEW" */, current.rank]
          : [...prevMilestones, current.rank];
        // Cap chain length: keep first entry (origin) + last (MAX_MILESTONES-1) entries
        if (milestones.length > MAX_MILESTONES) {
          milestones = [milestones[0], ...milestones.slice(-(MAX_MILESTONES - 1))];
        }
        // Entry/progression messages now carry the same 1h/24h/1w flow lines.
        const deltas = computeWindowDeltas(changes, current.pos.conditionId, current.outcomeIndex, current.pos.totalExposure, current.pos);
        entryEvents.push({ key, current, prev, milestones, upCrossed, deltas });
        // Stamp milestones (+ advance timestamp) on the current snapshot entry
        current.nextMilestones = milestones;
        current.nextMilestonesTs = nowMs;
      } else {
        // Carry milestones forward — but drop a stale chain so a later cross
        // starts fresh rather than appending to an old passed path.
        const kept = startsFreshIfNeeded(prevMilestones, prevRank, current.rank);
        if (kept.length && !chainStale) {
          current.nextMilestones = kept;
          current.nextMilestonesTs = prevMilestonesTs;
        } else {
          current.nextMilestones = [];
          current.nextMilestonesTs = null;
        }
      }

      // Exit (partial drop within top-200): activity required
      if (downCrossed.length && sizeChanged) {
        const deltas = computeWindowDeltas(changes, current.pos.conditionId, current.outcomeIndex, current.pos.totalExposure, current.pos);
        const redeemed = isRedeemedExit(current.pos, true);
        // Exit chain shows downward threshold crossings, symmetric to entry.
        const exitMilestones = buildExitChain(prevRank, downCrossed);
        exitEvents.push({
          key, current, prev,
          milestones: exitMilestones,
          downCrossed, deltas, redeemed,
        });
        // After exit, reset milestones for re-entry
        current.nextMilestones = [];
        current.nextMilestonesTs = null;
      }
    }

    // Pass B: positions in prev snapshot but not in current top-200 (full drop-out)
    for (const [key, prev] of prevByKey) {
      if (currentByKey.has(key)) continue;

      // Look up the position in full portfolio (may exist beyond top-200 with smaller exposure)
      const fullPos = allPositions.find(p => posKeyOf(p) === key);
      const prevRank = prev.rank;

      // Down-crossed thresholds = all thresholds where prev rank was inside
      const downCrossed = THRESHOLDS.filter(T => prevRank <= T);
      if (downCrossed.length === 0) continue; // wasn't in any threshold; nothing to fire

      // Activity gate. If position vanished from portfolio entirely → assume redemption / full sell (activity).
      // If still present but past top-200 — compare size to prev.size.
      let sizeChanged;
      let displayPos;
      let redeemed;
      if (fullPos) {
        const curSize = aggregateSize(fullPos);
        const curTC   = fullPos.traderCount ?? (fullPos.traders?.length ?? 0);
        sizeChanged = Math.abs(curSize - (prev.size ?? 0)) > 0.001 || curTC !== (prev.traderCount ?? 0);
        displayPos = fullPos;
        redeemed = isRedeemedExit(fullPos, true);
      } else {
        // Disappeared → infer redemption if we know endDate, else treat as fully sold.
        sizeChanged = true; // disappearance is itself activity
        displayPos = prev.lastPos || null;
        redeemed = isRedeemedExit(displayPos || prev, false);
      }
      if (!sizeChanged) continue;
      if (!displayPos) continue; // can't render without position metadata

      // For disappeared positions, current exposure is effectively 0 (no remaining
      // position) — pass 0 so % normalizes to -100% on a full sell/redemption.
      const currentExposureForDelta = fullPos ? (fullPos.totalExposure ?? 0) : 0;
      const deltas = computeWindowDeltas(
        changes,
        displayPos.conditionId,
        displayPos.outcomeIndex ?? (displayPos.outcome === 'Yes' ? 1 : 0),
        currentExposureForDelta,
        fullPos, // null when fully dropped out → falls back to change events
      );

      const exitMilestones = buildExitChain(prevRank, downCrossed);

      exitEvents.push({
        key,
        current: { pos: displayPos, rank: null, traderCount: displayPos.traderCount ?? 0 },
        prev,
        milestones: exitMilestones,
        downCrossed,
        deltas,
        redeemed,
      });
    }

    // 7. Build new snapshot (from current top-200 + carry-forward of milestones)
    const newSnapshot = [];
    for (const [key, current] of currentByKey) {
      newSnapshot.push({
        conditionId:  current.pos.conditionId,
        outcomeIndex: current.outcomeIndex,
        rank:         current.rank,
        size:         current.size,
        traderCount:  current.traderCount,
        exposure:     current.pos.totalExposure,
        milestones:   current.nextMilestones || [],
        milestonesTs: current.nextMilestonesTs ?? null,
        // Cache the position payload so a subsequent disappearance can still render a message.
        lastPos: {
          title:        current.pos.title,
          slug:         current.pos.slug,
          eventSlug:    current.pos.eventSlug,
          outcome:      current.pos.outcome,
          outcomeIndex: current.outcomeIndex,
          avgEntry:     current.pos.avgEntry,
          curPrice:     current.pos.curPrice,
          priceChangePct: current.pos.priceChangePct,
          conditionId:  current.pos.conditionId,
          totalExposure: current.pos.totalExposure,
          endDate:      current.pos.endDate,
          traderCount:  current.traderCount,
        },
        endDate: current.pos.endDate,
      });
    }

    // 8. Save snapshot first (idempotent — even if sending fails, we won't double-fire)
    await saveState(env, source.key, newSnapshot, meta.last_updated);

    // 9. Suppress notifications on first run after fresh deploy
    if (isFirstRun) continue;
    if (entryEvents.length === 0 && exitEvents.length === 0) continue;

    // 10. Notify subscribers
    const userIds = await getSubscribers(env);
    for (const userId of userIds) {
      const user = await getUser(env, userId);
      if (!user?.active) continue;
      if (user.portfolio !== source.key && user.portfolio !== 'both') continue;

      const topLevel = user.topLevel ?? 10;
      const lang     = user.lang ?? 'en';
      // Per-user fingerprint: visible glyph (assigned at activation; falls back to
      // a chat_id-derived one) + invisible chat_id payload, applied at send time.
      const symbol   = user.symbol ?? symbolForIndex(Number(userId));

      // Entry/progression: send if any up-crossed threshold is ≤ topLevel
      for (const ev of entryEvents) {
        if (!ev.upCrossed.some(T => T <= topLevel)) continue;
        const msg = buildEntryMessage({
          pos: ev.current.pos,
          source, lang,
          milestones: ev.milestones,
          prevTraderCount: ev.prev?.traderCount ?? null,
          totalPortfolioExposure,
          deltas: ev.deltas,
        });
        try { await sendMessage(token, userId, fingerprint(msg, userId, symbol), { parse_mode: 'HTML' }); }
        catch (err) { console.error(`Failed to notify ${userId}:`, err.message); }
        await new Promise(r => setTimeout(r, 50));
      }

      // Exit: send if topLevel is among the down-crossed thresholds
      // (i.e., this user's view of the position transitioned from "in" to "out").
      for (const ev of exitEvents) {
        if (!ev.downCrossed.includes(topLevel)) continue;
        const msg = buildExitMessage({
          pos: ev.current.pos,
          source, lang,
          milestones: ev.milestones,
          prevTraderCount: ev.prev?.traderCount ?? null,
          deltas: ev.deltas,
          redeemed: ev.redeemed,
          totalPortfolioExposure,
        });
        try { await sendMessage(token, userId, fingerprint(msg, userId, symbol), { parse_mode: 'HTML' }); }
        catch (err) { console.error(`Failed to notify ${userId}:`, err.message); }
        await new Promise(r => setTimeout(r, 50));
      }
    }
  }
}

// Carry-forward helper: when no notification fires, decide what milestones the
// snapshot should keep. If the position is currently in top-30 and was already
// being tracked, keep its chain. If it's outside top-30 entirely, drop the chain
// (a future re-entry will start fresh).
function startsFreshIfNeeded(prevMilestones, prevRank, currentRank) {
  if (currentRank > 30) return [];
  if (prevRank == null || prevRank > 30) return []; // never had a chain
  return prevMilestones || [];
}
