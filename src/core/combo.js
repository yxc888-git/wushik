/**
 * 牌型识别 / 大小比较 / 可压牌搜索
 *
 * 五十五K 的精髓就在两个地方：
 *   1. 五十K（正/副）本身是"炮"，能压单张对子顺子
 *   2. 炸弹体系跨牌型压制，N 张炸越大越猛
 * 所以比较逻辑分两套：同型比点数，跨型走 tier 权重。
 */
import { CT, CT_NAME, RANK, BOMB_TIER, SUIT_NAME, SUIT } from './rules.js';
import { sortCards, sortCardsAsc, groupByRank, cardLabel } from './cards.js';

const BOMB_FAMILY = new Set([CT.BOMB, CT.JOKER_BOMB, CT.PURE_510K, CT.MIXED_510K]);

export function isBombFamily(type, rules) {
  if (BOMB_FAMILY.has(type)) return true;
  if (rules && rules.trioIsBomb && type === CT.TRIO) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 识别                                                                 */
/* ------------------------------------------------------------------ */

/** 是否连续（用于顺子/连对/三顺）。2(15) 与王不参与。 */
function isConsecutive(ranks) {
  if (ranks.length < 2) return true;
  const s = ranks.slice().sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== s[i - 1] + 1) return false;
  }
  return true;
}

function maxRankAllowed(rules) {
  // A=14 可连（放在 K 后）；2=15 视配置
  return rules.straightCanInclude2 ? 15 : 14;
}

/**
 * 识别一组牌的牌型。
 * @returns {null | {type,cards,mainRank,len,tier,sub,label}}
 */
export function detect(cardsInput, rules) {
  const cards = cardsInput.slice();
  const n = cards.length;
  if (n === 0) return null;

  const ranks = cards.map((c) => c.r);
  const jokers = cards.filter((c) => c.r >= RANK.JOKER_S);
  const normals = cards.filter((c) => c.r < RANK.JOKER_S);
  const groups = groupByRank(normals);
  const counts = new Map();
  for (const [r, list] of groups) counts.set(r, list.length);
  const rankList = [...counts.keys()].sort((a, b) => a - b);

  /* ---- 1. 王组合。郑州规矩：
   *    · 4 张王（四王）= 最大的炮
   *    · 2 张王 = 普通对子（双大王 / 双小王），【不是】炮，压不过正五十K
   *    · 一大一小、3 张王 = 凑不成合法牌型
   *    · 单张王 = 单张（n===1，走最后的单张分支）
   */
  if (jokers.length === n && n >= 2) {
    if (n === 4 && rules.jokerBombEnabled) {
      return mk(CT.JOKER_BOMB, cards, RANK.JOKER_B, BOMB_TIER.JOKER4, 0, '四王（最大）');
    }
    if (n === 2 && jokers[0].r === jokers[1].r) {
      // 同为大王或同为小王 → 就是普通对子
      return mk(CT.PAIR, cards, jokers[0].r, 0, 0, jokers[0].r === RANK.JOKER_B ? '双大王' : '双小王');
    }
    return null; // 一大一小 / 3 张王：不合法
  }
  if (jokers.length > 0 && jokers.length !== n) {
    // 王只能单独成"王组合"，不能混进别的牌型（河南主流）
    if (!rules.jokerInStraight) {
      // 允许三带一/飞机带牌时带王做"配牌"
      // 下面带牌分支会处理；此处仅排除王参与主体
    }
  }

  /* ---- 2. 五十K：5 + 10 + K 各一张 ---- */
  if (n === 3 && counts.size === 3 && counts.has(5) && counts.has(10) && counts.has(13)) {
    const suits = cards.map((c) => c.s);
    const same = suits[0] === suits[1] && suits[1] === suits[2];
    if (same) {
      return mk(CT.PURE_510K, cards, 13, BOMB_TIER.PURE_510K, suits[0], `${SUIT_NAME[suits[0]]}正五十K`);
    }
    if (rules.allowMixed510K) {
      return mk(CT.MIXED_510K, cards, 13, BOMB_TIER.MIXED_510K, 0, '副五十K');
    }
    return null;
  }

  /* ---- 3. 炸弹：4 张同点且同色（不含王） ----
   * 郑州规矩：炸弹只有一种 —— 4 张同点且同色（全红 ♥♦ 或全黑 ♠♣）；
   * 5 张及以上同点【不算炸】（bombMaxCount=4），混色 4 张也不算炸（当散牌正常出）。
   * 四王是独立的最大炮；同点数黑炸 > 红炸，点数仍主导（红2炸压黑A炸）。 */
  if (jokers.length === 0 && counts.size === 1 && n >= (rules.bombMinCount || 4)) {
    if (n > (rules.bombMaxCount || 99)) return null; // 5张及以上同点：不算炸，不能一手出
    const r = rankList[0];
    // 同色校验：4 张必须全红或全黑，混色不算炸（这 4 张不能一手出）
    const isRedSuit = (c) => c.s === SUIT.HEART || c.s === SUIT.DIAMOND;
    const isBlackSuit = (c) => c.s === SUIT.SPADE || c.s === SUIT.CLUB;
    if (n === 4 && rules.bombSameColor) {
      const reds = cards.filter(isRedSuit).length;
      if (reds !== 0 && reds !== n) return null;
    }
    const tier = BOMB_TIER['BOMB' + n] !== undefined ? BOMB_TIER['BOMB' + n] : 800 + n;
    // 黑炸（♠♣）> 红炸（♥♦），同点数互比时黑占先。
    // 编码进 sub：rank*2 + 黑色位，保证点数仍主导（4红2 仍压 4黑A）。
    let sub = r;
    let colorTag = '';
    if (n === 4 && rules.bombSameColor) {
      const black = cards.every(isBlackSuit);
      sub = r * 2 + (black ? 1 : 0);
      colorTag = black ? '黑' : '红';
    }
    return mk(CT.BOMB, cards, r, tier, sub, `${n}张${colorTag}炸（${cardLabel(cards[0])}）`);
  }

  /* ---- 4. 三同张（可能是炮，也可能是三带） ---- */
  if (jokers.length === 0 && counts.size === 1 && n === 3) {
    return mk(CT.TRIO, cards, rankList[0], rules.trioIsBomb ? BOMB_TIER.TRIO : 0, rankList[0], '三张');
  }

  /* ---- 5. 三带一 / 三带二 ---- */
  if (rules.allowTrioKick && jokers.length === 0 && counts.size === 2 && n === 4) {
    const trioRank = rankList.find((r) => counts.get(r) === 3);
    if (trioRank !== undefined) {
      return mk(CT.TRIO_ONE, cards, trioRank, 0, 0, '三带一');
    }
  }
  if (rules.allowTrioKick && counts.size === 2 && n === 5) {
    const trioRank = rankList.find((r) => counts.get(r) === 3);
    const pairRank = rankList.find((r) => counts.get(r) === 2);
    if (trioRank !== undefined && pairRank !== undefined && trioRank !== pairRank) {
      return mk(CT.TRIO_TWO, cards, trioRank, 0, 0, '三带二');
    }
  }

  /* ---- 6. 顺子（单龙） ---- */
  if (rules.allowStraight && n >= (rules.straightMinLen || 5) && jokers.length === 0
      && counts.size === n && isConsecutive(rankList) && rankList[rankList.length - 1] <= maxRankAllowed(rules)) {
    return mk(CT.STRAIGHT, cards, rankList[rankList.length - 1], 0, 0, `${n}张顺子`);
  }

  /* ---- 7. 连对（双龙） ---- */
  if (rules.allowDoubleStraight && n >= (rules.doubleStraightMinPairs || 3) * 2 && n % 2 === 0
      && jokers.length === 0 && counts.size === n / 2
      && [...counts.values()].every((c) => c === 2)
      && isConsecutive(rankList) && rankList[rankList.length - 1] <= maxRankAllowed(rules)) {
    return mk(CT.DOUBLE_STRAIGHT, cards, rankList[rankList.length - 1], 0, 0, `${n / 2}连对`);
  }

  /* ---- 8. 三顺（连三 / 飞机不带） ---- */
  if (rules.allowTrioStraight && n >= (rules.trioStraightMinGroups || 2) * 3 && n % 3 === 0
      && jokers.length === 0 && counts.size === n / 3
      && [...counts.values()].every((c) => c === 3)
      && isConsecutive(rankList) && rankList[rankList.length - 1] <= maxRankAllowed(rules)) {
    return mk(CT.TRIO_STRAIGHT, cards, rankList[rankList.length - 1], 0, 0, `${n / 3}连三顺`);
  }

  /* ---- 9. 飞机带单 / 带对 ---- */
  if (rules.allowPlaneKick && n >= 8) {
    // 主体：k 组连续三张；附件：k 张单 或 k 个对
    const trioRanks = rankList.filter((r) => counts.get(r) >= 3);
    for (let start = 0; start < trioRanks.length; start++) {
      for (let end = start; end < trioRanks.length; end++) {
        const seq = trioRanks.slice(start, end + 1);
        if (seq.length < (rules.trioStraightMinGroups || 2)) continue;
        if (!isConsecutive(seq)) continue;
        if (seq[seq.length - 1] > maxRankAllowed(rules)) continue;
        const k = seq.length;
        const bodyCount = k * 3;
        // 附件候选：剩余牌 + 主体里多出来的第 4 张
        const rest = [];
        for (const [r, list] of groups) {
          const keep = seq.includes(r) ? 3 : list.length;
          rest.push(...list.slice(keep));
        }
        const restCounts = new Map();
        for (const c of rest) restCounts.set(c.r, (restCounts.get(c.r) || 0) + 1);
        const kickRanks = [...restCounts.keys()].filter((r) => !seq.includes(r));

        // 带单：附件 k 张，且不能成对/成三（否则会被识别成别的）
        if (n === bodyCount + k) {
          const singles = [];
          let ok = true;
          for (const r of kickRanks) {
            const c = restCounts.get(r);
            if (c === 1) singles.push(rest.find((x) => x.r === r));
            else if (c >= 2) { singles.push(rest.find((x) => x.r === r)); } // 可拆对做单
            else ok = false;
          }
          if (ok && singles.length >= k) {
            const body = [];
            for (const r of seq) body.push(...groups.get(r).slice(0, 3));
            const kick = singles.slice(0, k);
            return mk(CT.PLANE_ONE, [...body, ...kick], seq[seq.length - 1], 0, 0, `${k}连飞机带单`);
          }
        }
        // 带对：附件 k 个对子
        if (n === bodyCount + k * 2) {
          const pairs = [];
          for (const r of kickRanks) {
            if (restCounts.get(r) >= 2) {
              const list = rest.filter((x) => x.r === r);
              pairs.push(list[0], list[1]);
            }
          }
          if (pairs.length >= k * 2) {
            const body = [];
            for (const r of seq) body.push(...groups.get(r).slice(0, 3));
            return mk(CT.PLANE_TWO, [...body, ...pairs.slice(0, k * 2)], seq[seq.length - 1], 0, 0, `${k}连飞机带对`);
          }
        }
      }
    }
  }

  /* ---- 10. 对子 ---- */
  if (n === 2 && jokers.length === 0 && counts.size === 1) {
    return mk(CT.PAIR, cards, rankList[0], 0, 0, '对子');
  }

  /* ---- 11. 单张 ---- */
  if (n === 1) {
    return mk(CT.SINGLE, cards, cards[0].r, 0, 0, '单张');
  }

  return null;
}

function mk(type, cards, mainRank, tier, sub, label) {
  return {
    type,
    cards: sortCards(cards),
    mainRank,
    len: cards.length,
    tier: tier || 0,
    sub: sub || 0,
    label: label || CT_NAME[type],
    name: CT_NAME[type],
  };
}

/**
 * 自由出（杂牌）：领出时想怎么打怎么打 —— 任意选几张（5张、6张、混色4张…），
 * 只要凑不成合法牌型，就当一手"自由出"杂牌甩出去。
 * 杂牌压不了任何人，别人也只能用炮（五十K/炸/四王）来压它。
 */
export function freeCombo(cardsInput) {
  const cards = cardsInput.slice();
  const maxR = cards.reduce((m, c) => (c.r > m ? c.r : m), 0);
  return mk(CT.FREE, cards, maxR, 0, 0, `${cards.length}张自由出`);
}

/* ------------------------------------------------------------------ */
/* 比较                                                                 */
/* ------------------------------------------------------------------ */

/** 炸弹家族的"强度"：tier 优先，tier 相同比 sub */
function bombPower(c, rules) {
  return c.tier * 1000 + (c.sub || 0);
}

/** a 能否压过 b（b 为 null 表示自由出牌） */
export function canBeat(a, b, rules) {
  if (!a) return false;
  if (!b) return true;

  // 自由出（杂牌）：压不了任何人；被人压时只有炮能压（bombBeats.FREE=1）
  if (a.type === CT.FREE) return false;
  if (b.type === CT.FREE) {
    if (!isBombFamily(a.type, rules)) return false;
    const need = (rules.bombBeats && rules.bombBeats[CT.FREE]) || 0;
    if (!need) return false;
    const size = a.type === CT.BOMB ? a.len
      : (a.type === CT.JOKER_BOMB ? 8 : 3);
    return size >= need;
  }

  const aBomb = isBombFamily(a.type, rules);
  const bBomb = isBombFamily(b.type, rules);

  // 炮 vs 炮：直接比强度
  if (aBomb && bBomb) {
    if (rules.pure510KSuitOrder === false) {
      // 正五十K 不分花色时，同 tier 视为相等（压不过）
      if (a.tier === b.tier && a.type === CT.PURE_510K && b.type === CT.PURE_510K) return false;
    }
    return bombPower(a, rules) > bombPower(b, rules);
  }

  // 炮 vs 普通牌型：看炸弹张数够不够
  if (aBomb && !bBomb) {
    const need = (rules.bombBeats && rules.bombBeats[b.type]) || 0;
    if (!need) return false;
    // 五十K 视作 3 张级（能压单、对、三、顺子）；四王最大，视作 8 张级压一切
    const size = a.type === CT.BOMB ? a.len
      : (a.type === CT.JOKER_BOMB ? 8 : 3);
    return size >= need;
  }

  // 普通 vs 炮：没戏
  if (!aBomb && bBomb) return false;

  // 普通 vs 普通：同型、同张数、比主点数
  if (a.type !== b.type || a.len !== b.len) return false;
  return a.mainRank > b.mainRank;
}

/** 用于排序/AI 估价的强度值（越大越强，跨型可比） */
export function comboPower(c, rules) {
  if (isBombFamily(c.type, rules)) return 100000 + bombPower(c, rules);
  return c.mainRank * 100 + c.len;
}

/* ------------------------------------------------------------------ */
/* 搜索：给定手牌，找出所有能压过 target 的出法                          */
/* ------------------------------------------------------------------ */

/**
 * 列出手牌中所有"能压过 target"的牌组。
 * @param {Array} hand 手牌
 * @param {object|null} target 需要压过的牌型；null = 自由出牌时列出所有可能（体积大，一般只给 AI 用）
 * @param {object} rules
 * @param {object} opts { limit, includeBomb }
 * @returns {Array<combo>} 按强度从弱到强排序
 */
export function findBeats(hand, target, rules, opts = {}) {
  const limit = opts.limit || 0;
  let out = [];

  if (!target) {
    out = enumerateAll(hand, rules, opts);
  } else if (isBombFamily(target.type, rules)) {
    // 只能用更强的炮压
    const p = bombPower(target, rules);
    out = enumerateBombs(hand, rules).filter((c) => bombPower(c, rules) > p);
    // 同型同张数的普通牌型（例如上家出的是三张炮时，普通三张能压）
    if (!isBombFamily(target.type, { ...rules, trioIsBomb: false })) {
      out = out.concat(enumerateByType(hand, target.type, target.len, rules)
        .filter((c) => c.mainRank > target.mainRank));
    }
  } else {
    // 普通牌型：同型同长度 + 够格的炸弹
    out = enumerateByType(hand, target.type, target.len, rules)
      .filter((c) => c.mainRank > target.mainRank);
    if (opts.includeBomb !== false) {
      const need = (rules.bombBeats && rules.bombBeats[target.type]) || 0;
      if (need) {
        out = out.concat(enumerateBombs(hand, rules).filter((c) => {
          const size = c.type === CT.BOMB ? c.len : (c.type === CT.JOKER_BOMB ? c.len + 1 : 3);
          return size >= need;
        }));
      }
    }
  }

  out.sort((a, b) => comboPower(a, rules) - comboPower(b, rules));
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

/** 按类型+张数枚举所有组合 */
function enumerateByType(hand, type, len, rules) {
  const res = [];
  const groups = groupByRank(hand.filter((c) => c.r < RANK.JOKER_S));
  const jokers = hand.filter((c) => c.r >= RANK.JOKER_S);
  const maxR = maxRankAllowed(rules);

  switch (type) {
    case CT.SINGLE:
      for (const c of hand) res.push(mk(CT.SINGLE, [c], c.r, 0, 0, '单张'));
      break;

    case CT.PAIR: {
      for (const [r, list] of groups) {
        if (list.length >= 2) res.push(mk(CT.PAIR, list.slice(0, 2), r, 0, 0, '对子'));
      }
      break;
    }

    case CT.TRIO: {
      for (const [r, list] of groups) {
        if (list.length >= 3) res.push(mk(CT.TRIO, list.slice(0, 3), r, rules.trioIsBomb ? BOMB_TIER.TRIO : 0, r, '三张'));
      }
      break;
    }

    case CT.TRIO_ONE: {
      for (const [r, list] of groups) {
        if (list.length < 3) continue;
        const body = list.slice(0, 3);
        // 附件：优先挑最小的、非本点数的单张（不拆炸弹）
        const pool = hand.filter((c) => c.r !== r);
        const cand = pickKickers(pool, 1, groups, rules);
        if (cand) res.push(mk(CT.TRIO_ONE, [...body, ...cand], r, 0, 0, '三带一'));
      }
      break;
    }

    case CT.TRIO_TWO: {
      for (const [r, list] of groups) {
        if (list.length < 3) continue;
        const body = list.slice(0, 3);
        for (const [r2, l2] of groups) {
          if (r2 === r || l2.length < 2) continue;
          res.push(mk(CT.TRIO_TWO, [...body, ...l2.slice(0, 2)], r, 0, 0, '三带二'));
        }
      }
      break;
    }

    case CT.STRAIGHT: {
      const ranks = [...groups.keys()].filter((r) => r <= maxR).sort((a, b) => a - b);
      for (let s = 0; s < ranks.length; s++) {
        for (let e = s + len - 1; e < ranks.length; e++) {
          if (e - s + 1 !== len) continue;
          if (ranks[e] - ranks[s] !== len - 1) continue;
          const cards = [];
          for (let i = s; i <= e; i++) cards.push(groups.get(ranks[i])[0]);
          const c = detect(cards, rules);
          if (c && c.type === CT.STRAIGHT) res.push(c);
        }
      }
      break;
    }

    case CT.DOUBLE_STRAIGHT: {
      const pairs = len / 2;
      const ranks = [...groups.keys()].filter((r) => r <= maxR && groups.get(r).length >= 2).sort((a, b) => a - b);
      for (let s = 0; s + pairs <= ranks.length; s++) {
        const seq = ranks.slice(s, s + pairs);
        if (seq[pairs - 1] - seq[0] !== pairs - 1) continue;
        const cards = [];
        for (const r of seq) cards.push(...groups.get(r).slice(0, 2));
        res.push(mk(CT.DOUBLE_STRAIGHT, cards, seq[pairs - 1], 0, 0, `${pairs}连对`));
      }
      break;
    }

    case CT.TRIO_STRAIGHT: {
      const g = len / 3;
      const ranks = [...groups.keys()].filter((r) => r <= maxR && groups.get(r).length >= 3).sort((a, b) => a - b);
      for (let s = 0; s + g <= ranks.length; s++) {
        const seq = ranks.slice(s, s + g);
        if (seq[g - 1] - seq[0] !== g - 1) continue;
        const cards = [];
        for (const r of seq) cards.push(...groups.get(r).slice(0, 3));
        res.push(mk(CT.TRIO_STRAIGHT, cards, seq[g - 1], 0, 0, `${g}连三顺`));
      }
      break;
    }

    case CT.PLANE_ONE:
    case CT.PLANE_TWO: {
      // 飞机带牌组合较多，交给 detect 兜底：枚举连续三张组 + 挑附件
      const withKick = type === CT.PLANE_ONE;
      const k = withKick ? len / 4 : len / 5;
      const ranks = [...groups.keys()].filter((r) => r <= maxR && groups.get(r).length >= 3).sort((a, b) => a - b);
      for (let s = 0; s + k <= ranks.length; s++) {
        const seq = ranks.slice(s, s + k);
        if (seq[k - 1] - seq[0] !== k - 1) continue;
        const body = [];
        for (const r of seq) body.push(...groups.get(r).slice(0, 3));
        const pool = hand.filter((c) => !seq.includes(c.r));
        if (withKick) {
          const kick = pickKickers(pool, k, groups, rules);
          if (kick) res.push(mk(CT.PLANE_ONE, [...body, ...kick], seq[k - 1], 0, 0, `${k}连飞机带单`));
        } else {
          const pairs = [];
          const pg = groupByRank(pool);
          for (const [r, l] of pg) {
            if (l.length >= 2 && pairs.length / 2 < k) pairs.push(l[0], l[1]);
          }
          if (pairs.length / 2 === k) {
            res.push(mk(CT.PLANE_TWO, [...body, ...pairs], seq[k - 1], 0, 0, `${k}连飞机带对`));
          }
        }
      }
      break;
    }

    default:
      break;
  }
  // 王可以当单张使用
  if (type === CT.SINGLE) {
    for (const j of jokers) res.push(mk(CT.SINGLE, [j], j.r, 0, 0, '单张'));
  }
  // 王可以成对（双大王 / 双小王），是普通对子，不是炮
  if (type === CT.PAIR) {
    const jg = groupByRank(jokers);
    for (const [r, list] of jg) {
      if (list.length >= 2) {
        res.push(mk(CT.PAIR, list.slice(0, 2), r, 0, 0, r === RANK.JOKER_B ? '双大王' : '双小王'));
      }
    }
  }
  return res;
}

/** 挑 n 张"最没用"的附件牌：优先散牌，尽量不拆对子/三张/炸弹。
 *  关键约束：河南玩法里王（大小王）只能单独成"王组合"，不能混进三带/飞机做配牌，
 *  否则 detect() 会判非法（TRIO_ONE/三带二/飞机分支都要求 jokers.length === 0）。
 *  所以配牌候选一律排除王——这样 findBeats 产出的牌组与 detect/引擎判定完全一致，
 *  不会出现"findBeats 说能压、detoce 却判 null"的死锁。 */
function pickKickers(pool, n, groups, rules) {
  const scored = pool.filter((c) => c.r < RANK.JOKER_S).map((c) => {
    const cnt = groups.get(c.r) ? groups.get(c.r).length : 1;
    let cost = cnt * 10 + c.r; // 张数越多越舍不得拆，点数越大越舍不得
    if (c.r === 5 || c.r === 10 || c.r === 13) cost += 3; // 分牌别乱丢
    if (c.r >= RANK.JOKER_S) cost += 100;
    return { c, cost };
  });
  scored.sort((a, b) => a.cost - b.cost);
  if (scored.length < n) return null;
  return scored.slice(0, n).map((x) => x.c);
}

/** 枚举手牌里所有炸弹（含五十K、王组合） */
export function enumerateBombs(hand, rules) {
  const res = [];
  const groups = groupByRank(hand.filter((c) => c.r < RANK.JOKER_S));
  const jokers = hand.filter((c) => c.r >= RANK.JOKER_S);

  // 五十K：跨点数找，所以要遍历花色 × 全手牌
  const fiveTensK = hand.filter((c) => c.r === 5 || c.r === 10 || c.r === 13);
  if (fiveTensK.length >= 3) {
    const seenSuit = new Set();
    for (const base of fiveTensK) {
      const s = base.s;
      if (seenSuit.has(s)) continue;
      seenSuit.add(s);
      const c5 = fiveTensK.find((x) => x.r === 5 && x.s === s);
      const c10 = fiveTensK.find((x) => x.r === 10 && x.s === s);
      const cK = fiveTensK.find((x) => x.r === 13 && x.s === s);
      if (c5 && c10 && cK) {
        const d = detect([c5, c10, cK], rules);
        if (d && (d.type === CT.PURE_510K || d.type === CT.MIXED_510K)) res.push(d);
      }
    }
    // 混花色五十K 也枚举一种（挑最小代价的组合）
    const c5 = fiveTensK.find((x) => x.r === 5);
    const c10 = fiveTensK.find((x) => x.r === 10);
    const cK = fiveTensK.find((x) => x.r === 13);
    if (c5 && c10 && cK) {
      const d = detect([c5, c10, cK], rules);
      if (d && d.type === CT.MIXED_510K) res.push(d);
    }
  }

  const bombSeen = new Set();
  const pushBomb = (d) => {
    if (!d || d.type !== CT.BOMB) return;
    const key = d.cards.map((c) => c.uid).sort().join('|');
    if (bombSeen.has(key)) return;
    bombSeen.add(key);
    res.push(d);
  };
  for (const [r, list] of groups) {
    if (list.length < (rules.bombMinCount || 4)) continue;
    // 同色 4 张炸：红组（♥♦）/ 黑组（♠♣）各枚举一次（与 detect 的同色校验保持一致）
    if (rules.bombSameColor && list.length >= 4) {
      const isRed = (c) => c.s === SUIT.HEART || c.s === SUIT.DIAMOND;
      const reds = list.filter(isRed);
      const blacks = list.filter((c) => !isRed(c));
      if (reds.length >= (rules.bombMinCount || 4)) pushBomb(detect(reds.slice(0, 4), rules));
      if (blacks.length >= (rules.bombMinCount || 4)) pushBomb(detect(blacks.slice(0, 4), rules));
    }
    pushBomb(detect(list.slice(0, list.length), rules));
  }

  // 王：只有 4 张（四王）算炮，双王只是对子，不算炮
  if (rules.jokerBombEnabled && jokers.length >= 4) {
    const d = detect(jokers.slice(0, 4), rules);
    if (d && d.type === CT.JOKER_BOMB) res.push(d);
  }
  return res;
}

/** 枚举所有合法出牌（自由出牌时用；27 张手牌可能较多，AI 另有拆牌策略） */
export function enumerateAll(hand, rules, opts = {}) {
  const res = [];
  const groups = groupByRank(hand.filter((c) => c.r < RANK.JOKER_S));
  const ranks = [...groups.keys()].sort((a, b) => a - b);

  // 单张 / 对子 / 三张 / 三带
  res.push(...enumerateByType(hand, CT.SINGLE, 1, rules));
  res.push(...enumerateByType(hand, CT.PAIR, 2, rules));
  res.push(...enumerateByType(hand, CT.TRIO, 3, rules)); // 光三张永远是合法牌型（与 detect 一致）
  if (rules.allowTrioKick) {
    res.push(...enumerateByType(hand, CT.TRIO_ONE, 4, rules));
    res.push(...enumerateByType(hand, CT.TRIO_TWO, 5, rules));
  }
  // 顺子（各种长度）
  if (rules.allowStraight) {
    for (let len = rules.straightMinLen || 5; len <= Math.min(12, hand.length); len++) {
      res.push(...enumerateByType(hand, CT.STRAIGHT, len, rules));
    }
  }
  if (rules.allowDoubleStraight) {
    for (let p = rules.doubleStraightMinPairs || 3; p * 2 <= hand.length; p++) {
      res.push(...enumerateByType(hand, CT.DOUBLE_STRAIGHT, p * 2, rules));
    }
  }
  if (rules.allowTrioStraight) {
    for (let g = rules.trioStraightMinGroups || 2; g * 3 <= hand.length; g++) {
      res.push(...enumerateByType(hand, CT.TRIO_STRAIGHT, g * 3, rules));
    }
  }
  res.push(...enumerateBombs(hand, rules));

  // 去重（同样 uid 组合只留一次）
  const seen = new Set();
  const uniq = [];
  for (const c of res) {
    const key = c.cards.map((x) => x.uid).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  uniq.sort((a, b) => comboPower(a, rules) - comboPower(b, rules));
  return uniq;
}
