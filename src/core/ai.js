/**
 * AI 出牌策略
 *
 * 目标不是"算无遗策"，而是像个会打牌的人：
 *   · 领出时先走小牌、留炮，分牌不轻易送人
 *   · 跟牌时算桌面上值多少分，够本才压
 *   · 个人制：谁领出都拦，重点拦快要跑光的人
 *   · 出完牌优先，能一手走绝不废话
 */
import { detect, findBeats, canBeat, isBombFamily, comboPower, enumerateBombs } from './combo.js';
import { CT, RANK } from './rules.js';
import { cardScore, handScore, groupByRank, sortCardsAsc } from './cards.js';

const isScoreCard = (c) => c.r === 5 || c.r === 10 || c.r === 13;

/** 手牌里还剩多少分 */
function leftoverScore(hand, rules) {
  return handScore(hand, rules);
}

/** 手牌的"出手数"估算：越少越好（衡量牌顺不顺） */
function handMessiness(hand) {
  const groups = groupByRank(hand);
  let n = 0;
  for (const [, list] of groups) {
    if (list.length === 1) n += 1;
    else if (list.length === 2) n += 0.6;
    else if (list.length === 3) n += 0.4;
    else n += 0.1;
  }
  return n;
}

/** 找能一手打完的出法 */
function findFinishers(hand, rules) {
  const d = detect(hand, rules);
  return d ? [d] : [];
}

/**
 * 领出（自由出牌）
 */
function leadMove(game, seat, rng) {
  const rules = game.rules;
  const hand = game.hands[seat];

  // 1. 能一手走完 → 直接走
  const fin = findFinishers(hand, rules);
  if (fin.length) return toAction(fin[0]);

  // 2. 只剩两张以下，急着跑
  const groups = groupByRank(hand);
  const ranks = [...groups.keys()].sort((a, b) => a - b);

  // 3. 有顺子/连对/三顺 → 先甩出去（长牌型最占手，仅在该规则打开时）
  const longOnes = [];
  if (rules.allowStraight || rules.allowDoubleStraight) {
    for (let len = 5; len <= Math.min(12, hand.length); len++) {
      const c = tryStraight(hand, len, rules);
      if (c) longOnes.push(c);
    }
    for (let p = 3; p * 2 <= hand.length; p++) {
      const c = tryDoubleStraight(hand, p, rules);
      if (c) longOnes.push(c);
    }
  }
  if (longOnes.length) {
    // 优先出不含分牌、点数小的
    longOnes.sort((a, b) => {
      const sa = a.cards.filter(isScoreCard).length;
      const sb = b.cards.filter(isScoreCard).length;
      return (sa - sb) || (a.mainRank - b.mainRank) || (b.len - a.len);
    });
    const pick = longOnes[0];
    // 分牌太多就别硬拆（除非这条顺子很短）
    if (pick.cards.filter(isScoreCard).length <= 2) return toAction(pick);
  }

  // 4. 三带
  if (rules.allowTrioKick) {
    const trio = ranks.filter((r) => groups.get(r).length >= 3 && r < RANK.JOKER_S).sort((a, b) => a - b)[0];
    if (trio !== undefined) {
      const body = groups.get(trio).slice(0, 3);
      const pool = hand.filter((c) => c.r !== trio);
      const kick = pickWorst(pool, 1, groups);
      if (kick) {
        const c = detect([...body, ...kick], rules);
        if (c && c.type === CT.TRIO_ONE) return toAction(c);
      }
    }
  }

  // 5. 三张（不带）
  const trioPlain = ranks.filter((r) => groups.get(r).length === 3).sort((a, b) => a - b)[0];
  if (trioPlain !== undefined) {
    return toAction(detect(groups.get(trioPlain).slice(0, 3), rules));
  }

  // 6. 对子：出最小的非分牌对
  const pairs = ranks.filter((r) => groups.get(r).length >= 2 && r < RANK.JOKER_S).sort((a, b) => a - b);
  const nonScorePair = pairs.find((r) => !isScoreCard({ r }));
  if (nonScorePair !== undefined) {
    return toAction(detect(groups.get(nonScorePair).slice(0, 2), rules));
  }

  // 7. 单张：出最小的非分牌、非大牌
  const singles = sortCardsAsc(hand);
  const safe = singles.find((c) => !isScoreCard(c) && c.r < RANK.A && c.r < RANK.JOKER_S);
  const pick = safe || singles.find((c) => c.r < RANK.JOKER_S) || singles[0];
  return toAction(detect([pick], rules));
}

/**
 * 跟牌
 */
function followMove(game, seat, rng) {
  const rules = game.rules;
  const hand = game.hands[seat];
  const target = game.lastPlay.combo;

  const candidates = findBeats(hand, target, rules, {});
  if (candidates.length === 0) return { type: 'pass', seat };

  // 能一手走完 → 立刻走
  const finisher = candidates.find((c) => c.len === hand.length);
  if (finisher) return toAction(finisher, seat);

  // 见张乎：能压必须压 —— 没有选择的余地，出"最小能压的"（优先非炸弹，留炮）
  if (rules.mustBeat) {
    const ordered = candidates.slice().sort((a, b) => {
      const ab = isBombFamily(a.type, rules) ? 1 : 0;
      const bb = isBombFamily(b.type, rules) ? 1 : 0;
      if (ab !== bb) return ab - bb;            // 非炸弹优先（留炮）
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.len !== b.len) return a.len - b.len;
      return a.mainRank - b.mainRank;
    });
    return toAction(ordered[0], seat);
  }

  const bombs = candidates.filter((c) => isBombFamily(c.type, rules));
  const normals = candidates.filter((c) => !isBombFamily(c.type, rules));

  const tableScore = game.tableScore;
  // 个人制（各管各的）：所有其他人都是竞争对手，盯住最快要走完的那家
  const enemyCounts = [];
  for (let s = 0; s < game.hands.length; s++) {
    if (s !== seat && !game.finished[s]) enemyCounts.push(game.hands[s].length);
  }
  const enemyMinCount = Math.min(...enemyCounts.concat([99]));
  const iAmLastOne = game.activeSeats().length === 2;

  /* ---- 个人竞争：谁领出都拦，重点拦快要跑光的人 ---- */
  // 有人要跑了（剩牌 <= 3）→ 尽力拦
  const mustBlock = enemyMinCount <= 3 && rules.jiefeng;

  // 1. 普通牌型：够本才压
  if (normals.length) {
    const cheap = normals[0];
    const costRank = cheap.mainRank;
    const scoreOut = cheap.cards.filter(isScoreCard).length;
    const gain = tableScore + (mustBlock ? 25 : 0) + (iAmLastOne ? 15 : 0);

    // 出牌权本身值钱：拿到就能自由出牌去甩长牌型
    let threshold = 12;
    if (hand.length <= 8) threshold = 5;            // 手牌少了，抢出牌权更要紧
    if (costRank >= RANK.A) threshold += 12;        // 大牌舍不得
    if (costRank >= RANK.JOKER_S) threshold += 25;
    if (scoreOut > 0) threshold += 10;              // 别把分牌白送人
    if (handMessiness(hand) > 12) threshold -= 6;   // 手太散，赶紧倒腾出去
    // 小牌顺手跟一张，别太机械（真人也这么打）
    if (costRank <= RANK.R9 && rng() < 0.35) threshold = 0;

    if (gain >= threshold || (mustBlock && costRank < RANK.A) || hand.length <= 2) {
      return toAction(cheap, seat);
    }
  }

  // 2. 炸弹：只在关键时刻用
  if (bombs.length) {
    const bomb = bombs[0]; // 最小的炮
    const worthIt =
      tableScore >= 30 ||                                   // 桌上分够多
      enemyMinCount <= 3 ||                                  // 敌人要跑
      (iAmLastOne && tableScore >= 15) ||                    // 单挑了
      hand.length - bomb.len <= 2;                           // 炸完就走
    if (worthIt) return toAction(bomb, seat);
  }

  return { type: 'pass', seat };
}

/* ---------------- 辅助 ---------------- */

function toAction(combo, seat) {
  if (!combo) return { type: 'pass', seat };
  return { type: 'play', uids: combo.cards.map((c) => c.uid), combo };
}

function pickWorst(pool, n, groups) {
  const scored = pool.map((c) => {
    const cnt = groups.get(c.r) ? groups.get(c.r).length : 1;
    let cost = cnt * 10 + c.r;
    if (isScoreCard(c)) cost += 20;
    if (c.r >= RANK.A) cost += 30;
    if (c.r >= RANK.JOKER_S) cost += 100;
    return { c, cost };
  });
  scored.sort((a, b) => a.cost - b.cost);
  return scored.slice(0, n).map((x) => x.c);
}

function tryStraight(hand, len, rules) {
  const groups = groupByRank(hand.filter((c) => c.r < RANK.JOKER_S));
  const maxR = rules.straightCanInclude2 ? 15 : 14;
  const ranks = [...groups.keys()].filter((r) => r <= maxR).sort((a, b) => a - b);
  for (let s = 0; s + len <= ranks.length; s++) {
    const seq = ranks.slice(s, s + len);
    if (seq[len - 1] - seq[0] !== len - 1) continue;
    const cards = seq.map((r) => groups.get(r)[0]);
    const c = detect(cards, rules);
    if (c && c.type === CT.STRAIGHT) return c;
  }
  return null;
}

function tryDoubleStraight(hand, pairs, rules) {
  const groups = groupByRank(hand.filter((c) => c.r < RANK.JOKER_S));
  const maxR = rules.straightCanInclude2 ? 15 : 14;
  const ranks = [...groups.keys()].filter((r) => r <= maxR && groups.get(r).length >= 2).sort((a, b) => a - b);
  for (let s = 0; s + pairs <= ranks.length; s++) {
    const seq = ranks.slice(s, s + pairs);
    if (seq[pairs - 1] - seq[0] !== pairs - 1) continue;
    const cards = [];
    for (const r of seq) cards.push(...groups.get(r).slice(0, 2));
    const c = detect(cards, rules);
    if (c && c.type === CT.DOUBLE_STRAIGHT) return c;
  }
  return null;
}

/** AI 决策入口 */
export function decide(game, seat, rng = Math.random) {
  if (game.phase !== 'playing') return { type: 'pass', seat };
  if (game.hands[seat].length === 0) return { type: 'pass', seat };

  let move;
  if (game.isFreeTurn(seat)) move = leadMove(game, seat, rng);
  else move = followMove(game, seat, rng);

  // 兜底：自由出牌必须出牌，实在没思路就甩最小的一张（防止卡死整局）
  if (game.isFreeTurn(seat) && move.type !== 'play') {
    const min = sortCardsAsc(game.hands[seat])[0];
    move = {
      type: 'play',
      uids: [min.uid],
      combo: detect([min], game.rules) || {
        type: CT.SINGLE, cards: [min], mainRank: min.r, len: 1, tier: 0, sub: 0, label: '单张',
      },
    };
  }

  // 合法兜底：确保发出的动作一定能被引擎接受，且见张乎（mustBeat）下绝不误转 pass 导致死锁。
  // 候选都来自 findBeats（与引擎 legalMoves 同源），正常情况下必然合法；
  // 即便个别组合因故不被 detect 接受，也退回 findBeats 取最小合法牌，而非直接 pass。
  if (move.type === 'play') {
    const cards = move.uids.map((u) => game.hands[seat].find((c) => c.uid === u)).filter(Boolean);
    const d = cards.length === move.uids.length ? detect(cards, game.rules) : null;
    const legal = d && (game.isFreeTurn(seat) || canBeat(d, game.lastPlay && game.lastPlay.combo, game.rules));
    if (legal) return { ...move, seat };

    // 退路：用 findBeats 重新取一个最小能压的合法牌（已按强度升序，第 0 个最省）
    const fb = findBeats(
      game.hands[seat],
      game.isFreeTurn(seat) ? null : game.lastPlay.combo,
      game.rules,
      {}
    );
    if (fb.length) {
      const pick = fb[0];
      return { type: 'play', uids: pick.cards.map((c) => c.uid), combo: pick, seat };
    }
    // 真没牌可出：自由出牌甩最小单张（兜底防卡死）；跟牌只能过（引擎据 mustBeat 定夺）
    if (game.isFreeTurn(seat)) {
      const min = sortCardsAsc(game.hands[seat])[0];
      return { type: 'play', uids: [min.uid], combo: detect([min], game.rules), seat };
    }
    return { type: 'pass', seat };
  }
  return { ...move, seat };
}

export { handMessiness, leftoverScore };
