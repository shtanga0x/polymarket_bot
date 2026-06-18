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
// Roster-change circuit breaker. Each market's exposure/traderCount in the feed
// is the SUM over the included traders, so adding/removing even a couple of
// active traders (e.g. a tier reshuffle on the dashboard) re-weights every
// market they touch — shifting many top-30 ranks and bumping trader counts in a
// single regenerated feed. That trips (rank-cross + activity) on dozens of
// positions at once, which is a data artifact, not dozens of real moves. When a
// single tick would fire more than this many events on one source, skip the
// send and just re-baseline the snapshot (already saved) so the next tick
// compares against the post-shift roster and only genuine changes notify.
// Same spirit as the isFirstRun guard, extended to wholesale churn.
const MAX_EVENTS_PER_TICK = 12;
// A position's rank moves for two reasons: a real trade (logged in the trade-flow
// feed → windowChanges) OR bookkeeping — price drift, another position rising/
// falling, or the holdings aggregate lagging the trade log and only now counting
// an hours-old trade. Only the first deserves a notification. So we gate on
// RECENT trade flow (last-hour net USD), NOT on a shares/traderCount delta or a
// drop-out: those are driven by the lagging holdings aggregate and fire for pure
// displacement and stale-refresh artifacts — every false alert observed had
// 1h == $0. Redemptions (resolved markets) are legitimately flow-less, so the
// exit path exempts them separately.
const MIN_RECENT_FLOW_USD = 1; // |last-hour net flow| below this ≈ no real trade
function hasRecentFlow(deltas) {
  return Math.abs(deltas?.h1?.usd ?? 0) >= MIN_RECENT_FLOW_USD;
}

// Merge/split coupling. A MERGE redeems equal YES+NO share pairs back into
// collateral and a SPLIT mints them — both outcomes of one market move by the
// SAME share amount in the SAME direction in a single tick. Neither is a
// directional bet, yet each side produces real flow and can cross thresholds,
// firing two coupled notifications. When both outcomes move together we keep only
// the side with the larger |share change| (the net directional move) and drop the
// other; when the changes are equal (a pure merge/split) we drop both. Two sides
// moving in OPPOSITE directions are two real trades — left alone.
const MERGE_EQ_TOLERANCE = 0.02; // |ΔYES−ΔNO| within 2% of the larger ⇒ "equal"

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
  // A position built from near-zero shows a huge but truthful % — drop the
  // decimal past 1000% so it reads cleanly (e.g. +5118%, not +5118.4%).
  const digits = Math.abs(n) >= 1000 ? 0 : 1;
  return `${sign}${n.toFixed(digits)}%`;
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

// Trade USD flow (BUY positive, SELL negative) per DISJOINT window for a specific
// conditionId+outcomeIndex: h1 = now→1h, d1 = 1h→24h, w1 = 24h→1w (each slice
// stands alone — they do NOT include each other). The relative % for a slice is
// its flow over the position's value at the START (older end) of that slice,
// reconstructed by walking exposure backwards from now — i.e. the true % change
// the position underwent during that interval. Mirrors dashboard semantics.
function computeWindowDeltas(changes, conditionId, outcomeIndex, totalExposure, pos = null) {
  const out = { h1: { usd: 0, pct: null }, d1: { usd: 0, pct: null }, w1: { usd: 0, pct: null } };

  // Per-interval (disjoint) USD flow.
  let per;
  if (pos?.windowChanges) {
    // Fast path: the pipeline precomputes chained non-overlapping window sums.
    const wc = pos.windowChanges;
    per = { h1: wc.h1 || 0, d1: wc.d1 || 0, w1: wc.w1 || 0 };
  } else {
    // Fallback (positions that dropped out): bucket raw change events into the
    // disjoint windows by timestamp.
    per = { h1: 0, d1: 0, w1: 0 };
    const now = Math.floor(Date.now() / 1000);
    const b1h = now - 3600, b24h = now - 24 * 3600, b1w = now - 7 * 24 * 3600;
    for (const c of changes) {
      if (c.conditionId !== conditionId) continue;
      if (c.outcomeIndex !== undefined && c.outcomeIndex !== outcomeIndex) continue;
      const ts = c.timestamp || 0;
      const d  = c.delta || 0;
      if (ts >= b1h)       per.h1 += d;
      else if (ts >= b24h) per.d1 += d;
      else if (ts >= b1w)  per.w1 += d;
    }
  }

  // Reconstruct the position's exposure at each interval's older boundary.
  const e1h  = totalExposure - per.h1; // value 1h ago
  const e24h = e1h - per.d1;           // value 24h ago
  const e1w  = e24h - per.w1;          // value 1w ago
  const base = { h1: e1h, d1: e24h, w1: e1w };
  for (const w of ['h1', 'd1', 'w1']) {
    out[w].usd = per[w];
    // % change over the slice vs its starting value. A full sell within a slice
    // gives base = flow magnitude → −100%, as expected.
    if (base[w] > 0) out[w].pct = (per[w] / base[w]) * 100;
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

// Trade-flow lines — shown on every position-change message. Each line is a
// DISJOINT interval (not cumulative): last hour, the 1h→24h slice, the 24h→1w
// slice. % is the change over that slice vs its starting value.
function renderDeltaLines(deltas) {
  return [
    `📊 1h:     ${fmtUSDSigned(deltas.h1.usd)} (${fmtPct(deltas.h1.pct)})`,
    `📊 1h–24h: ${fmtUSDSigned(deltas.d1.usd)} (${fmtPct(deltas.d1.pct)})`,
    `📊 24h–1w: ${fmtUSDSigned(deltas.w1.usd)} (${fmtPct(deltas.w1.pct)})`,
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
    let entryEvents = []; // { pos, key, prev, current, milestones, upCrossed }
    let exitEvents  = []; // { pos, key, prev, current, milestones, downCrossed, deltas, redeemed }

    // Pass A: current top-200
    for (const [key, current] of currentByKey) {
      const prev = prevByKey.get(key);
      const prevRank        = prev?.rank ?? null;       // null = wasn't in prev top-200
      const prevMilestones  = prev?.milestones ?? [];
      const prevMilestonesTs = prev?.milestonesTs ?? null;
      // Stale once the chain hasn't advanced within the TTL (or predates this
      // field, e.g. snapshots written before TTL tracking existed).
      const chainStale = prevMilestonesTs == null
        || (nowMs - prevMilestonesTs) > MILESTONE_TTL_MS;

      // Threshold transitions
      const upCrossed = THRESHOLDS.filter(T =>
        (prevRank == null || prevRank > T) && current.rank <= T
      );
      const downCrossed = THRESHOLDS.filter(T =>
        prevRank != null && prevRank <= T && current.rank > T
      );

      // Recent trade flow for this position — the activity gate (see
      // hasRecentFlow) and the message body share it. Computed once, only when a
      // threshold actually crossed.
      const deltas = (upCrossed.length || downCrossed.length)
        ? computeWindowDeltas(changes, current.pos.conditionId, current.outcomeIndex, current.pos.totalExposure, current.pos)
        : null;

      // Entry / progression: gated on a real recent trade — not a price-drift /
      // displacement / stale-refresh rank shift.
      if (upCrossed.length && hasRecentFlow(deltas)) {
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
        entryEvents.push({
          key, current, prev, milestones, upCrossed, deltas,
          conditionId: current.pos.conditionId,
          outcomeIndex: current.outcomeIndex,
          shareDelta: current.size - (prev?.size ?? 0),
        });
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

      // Exit (partial drop within top-200): a real recent sell-down, OR a
      // redemption (resolved market — legitimately flow-less). A drop driven only
      // by other positions rising (displacement) has no flow → not an exit.
      if (downCrossed.length) {
        const redeemed = isRedeemedExit(current.pos, true);
        if (hasRecentFlow(deltas) || redeemed) {
          // Exit chain shows downward threshold crossings, symmetric to entry.
          const exitMilestones = buildExitChain(prevRank, downCrossed);
          exitEvents.push({
            key, current, prev,
            milestones: exitMilestones,
            downCrossed, deltas, redeemed,
            conditionId: current.pos.conditionId,
            outcomeIndex: current.outcomeIndex,
            shareDelta: current.size - (prev?.size ?? 0),
          });
          // After exit, reset milestones for re-entry
          current.nextMilestones = [];
          current.nextMilestonesTs = null;
        }
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

      let displayPos;
      let redeemed;
      if (fullPos) {
        displayPos = fullPos;
        redeemed = isRedeemedExit(fullPos, true);
      } else {
        // Disappeared → infer redemption if we know endDate, else a full sell.
        displayPos = prev.lastPos || null;
        redeemed = isRedeemedExit(displayPos || prev, false);
      }
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

      // Gate: a real drop-out is backed by recent sell flow OR is a redemption.
      // A position that merely fell out of the tracked window because others rose
      // (no flow, not resolved) is displacement, not a "sold down" — skip it.
      if (!redeemed && !hasRecentFlow(deltas)) continue;

      const exitMilestones = buildExitChain(prevRank, downCrossed);

      exitEvents.push({
        key,
        current: { pos: displayPos, rank: null, traderCount: displayPos.traderCount ?? 0 },
        prev,
        milestones: exitMilestones,
        downCrossed,
        deltas,
        redeemed,
        conditionId: displayPos.conditionId,
        outcomeIndex: displayPos.outcomeIndex ?? (displayPos.outcome === 'Yes' ? 1 : 0),
        shareDelta: (fullPos ? aggregateSize(fullPos) : 0) - (prev.size ?? 0),
      });
    }

    // 6b. Merge/split dedup. Build per-outcome share deltas for the whole feed so
    // we can see a market's *other* outcome even when it didn't itself fire, then
    // drop coupled merge/split events (keep only the larger directional side).
    const shareDeltaByKey = new Map();
    for (const p of allPositions) {
      const idx = p.outcomeIndex ?? (p.outcome === 'Yes' ? 1 : 0);
      const k = `${p.conditionId}-${idx}`;
      shareDeltaByKey.set(k, aggregateSize(p) - (prevByKey.get(k)?.size ?? 0));
    }
    for (const [k, prev] of prevByKey) {
      if (!shareDeltaByKey.has(k)) shareDeltaByKey.set(k, 0 - (prev.size ?? 0)); // dropped out
    }
    const dropMergeSplit = (ev) => {
      const sib = shareDeltaByKey.get(`${ev.conditionId}-${1 - ev.outcomeIndex}`);
      if (sib == null) return false;                                  // no sibling data
      const self = ev.shareDelta ?? 0;
      if (self === 0 || Math.sign(self) !== Math.sign(sib)) return false; // not same-direction
      const a = Math.abs(self), b = Math.abs(sib), big = Math.max(a, b);
      if (big > 0 && Math.abs(a - b) <= big * MERGE_EQ_TOLERANCE) return true; // ~equal → pure merge/split
      return a < b;                                                   // keep only the larger side
    };
    entryEvents = entryEvents.filter(ev => !dropMergeSplit(ev));
    exitEvents  = exitEvents.filter(ev => !dropMergeSplit(ev));

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

    // 9b. Roster-change circuit breaker. Snapshot is already saved (step 8), so
    // skipping the send here re-baselines silently — the next tick fires only on
    // genuine post-shift movement instead of the whole reshuffle at once.
    const eventCount = entryEvents.length + exitEvents.length;
    if (eventCount > MAX_EVENTS_PER_TICK) {
      console.warn(`[notify] ${source.key}: ${eventCount} events in one tick (> ${MAX_EVENTS_PER_TICK}) — likely a roster/feed change; re-baselining without notifying.`);
      continue;
    }

    // 10. Notify subscribers
    console.log(`[notify] ${source.key}: sending ${entryEvents.length} entr${entryEvents.length === 1 ? 'y' : 'ies'}, ${exitEvents.length} exit${exitEvents.length === 1 ? '' : 's'} — ${[...entryEvents, ...exitEvents].map(e => `${e.current?.pos?.title?.slice(0, 30)}[${e.outcomeIndex}]`).join('; ')}`);
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
