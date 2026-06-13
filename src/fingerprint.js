/**
 * Per-user message fingerprinting for the polymarket bot. Two redundant channels
 * so a leaked notification traces back to its recipient:
 *
 *   1. INVISIBLE — chat_id encoded as zero-width chars on the message's blank
 *      line (the empty second line of entry messages). Survives copy/paste &
 *      forwarding; exact. Not screenshots.
 *   2. VISIBLE — one neutral geometric glyph appended as the LAST symbol of the
 *      LAST line. Survives screenshots. ~113-symbol pool, assigned per user.
 *
 * Pool + zero-width scheme are byte-identical to hyper_bot/src/fingerprint.js and
 * the control bot's decoder — do NOT reorder or the symbol↔index map drifts.
 */

export const VISIBLE_SYMBOLS = [...new Set([
  '■','□','▢','▣','▤','▥','▦','▧','▨','▩','▪','▫','▬','▭','▮','▯','▰','▱',
  '◧','◨','◩','◪','◫','◰','◱','◲','◳','◻','◼','⬛','⬜','⊞','⊟','⊠','⊡',
  '▲','△','▶','▷','▼','▽','◀','◁','◢','◣','◤','◥','◬','⊿',
  '●','○','◉','◎','◍','◌','◯','⊙','⊚','⊛','◐','◑','◒','◓','◔','◕','◖','◗','⦾','⦿',
  '◆','◇','◈','◊','❖','⬥','⬦','⬧','⬨','⬩','⬪','⬫',
  '⬠','⬡','⬢','⬣','⬤','⏣','⎔',
  '★','☆','✦','✧','✩','✪','✫','✬','✭','✮','✯','✰','✶','✷','✸','✹','✺','❂',
  '◦','⊕','⊖','⊗','⊘','⊜','⊝','◉','⦿',
])];
export const SYMBOL_POOL_SIZE = VISIBLE_SYMBOLS.length;
export const symbolForIndex = idx => VISIBLE_SYMBOLS[idx % VISIBLE_SYMBOLS.length];

const ZW0 = '​', ZW1 = '‌', ZWS = '⁠';

/** Encode a chat_id into an invisible zero-width string. */
export function zwEncode(chatId) {
  const bits = BigInt(chatId).toString(2);
  let out = ZWS;
  for (const b of bits) out += b === '1' ? ZW1 : ZW0;
  return out + ZWS;
}

/**
 * Stamp a built notification for one recipient.
 *  - invisible chat_id payload goes on the first blank line (the empty 2nd line
 *    of entry messages); if there's none, a zero-width-only line is inserted
 *    above the last line so it never sits at the trailing edge.
 *  - the visible glyph is appended as the last symbol of the last line.
 */
export function fingerprint(msg, chatId, symbol) {
  const lines = msg.split('\n');
  const payload = zwEncode(chatId);

  const blankIdx = lines.findIndex(l => l === '');
  if (blankIdx >= 0 && blankIdx < lines.length - 1) {
    lines[blankIdx] = payload;
  } else {
    lines.splice(Math.max(lines.length - 1, 0), 0, payload);
  }

  const last = lines.length - 1;
  lines[last] = `${lines[last]} ${symbol}`;
  return lines.join('\n');
}
