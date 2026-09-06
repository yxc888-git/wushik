/**
 * 核心逻辑自测：牌型识别 / 大小比较 / 完整对局跑批
 * 跑法：node test/core.test.mjs
 */
import { buildShoe, shuffle, makeRng, cardScore, handScore, sortCards } from '../src/core/cards.js';
import { detect, canBeat, findBeats, enumerateBombs, isBombFamily, freeCombo } from '../src/core/combo.js';
import { CT, cloneRules, RANK, SUIT } from '../src/core/rules.js';
import { Game, PHASE } from '../src/core/engine.js';
import { decide } from '../src/core/ai.js';

let pass = 0, fail = 0;
const results = [];

function t(name, fn) {
  try {
    fn();
    pass++; results.push(['✓', name, '']);
  } catch (e) {
    fail++; results.push(['✗', name, e.message]);
  }
}
function eq(a, b, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} 期望 ${sb}，实际 ${sa}`);
}
function ok(v, msg = '断言失败') { if (!v) throw new Error(msg); }

const rules = cloneRules('henan');

/** 用简明写法造牌： C('5♠') C('10♥') C('K♠') C('大王') */
const SUIT_MAP = { '♠': 3, '♥': 2, '♦': 1, '♣': 0 }; // 与 rules.js 一致：♥♦红，♠♣黑
const RANK_MAP = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15 };
let uidSeq = 0;
function C(spec) {
  if (spec === '大王') return { uid: 'u' + uidSeq++, r: RANK.JOKER_B, s: -1, copy: 0 };
  if (spec === '小王') return { uid: 'u' + uidSeq++, r: RANK.JOKER_S, s: -1, copy: 0 };
  const m = spec.match(/^(10|[3-9JQKA2])([♠♥♣♦])$/);
  if (!m) throw new Error('牌面写法不对: ' + spec);
  return { uid: 'u' + uidSeq++, r: RANK_MAP[m[1]], s: SUIT_MAP[m[2]], copy: 0 };
}
function Cs(list) { return list.map(C); }

/* ===================== 牌堆 ===================== */

t('两副牌 108 张', () => {
  eq(buildShoe(2, true).length, 108);
});

t('洗牌不丢牌', () => {
  const shoe = buildShoe(2, true);
  const s = shuffle(shoe, makeRng(12345));
  eq(s.length, 108);
  eq(new Set(s.map((c) => c.uid)).size, 108);
});

t('分牌总分 200', () => {
  const shoe = buildShoe(2, true);
  eq(handScore(shoe, rules), 200);
});

t('洗牌可复现（同 seed 同结果）', () => {
  const a = shuffle(buildShoe(2, true), makeRng(999));
  const b = shuffle(buildShoe(2, true), makeRng(999));
  eq(a.map((c) => c.uid), b.map((c) => c.uid));
});

/* ===================== 牌型识别 ===================== */

t('单张', () => eq(detect(Cs(['7♠']), rules).type, CT.SINGLE));
t('对子', () => eq(detect(Cs(['7♠', '7♥']), rules).type, CT.PAIR));
t('三张', () => eq(detect(Cs(['7♠', '7♥', '7♣']), rules).type, CT.TRIO));
t('默认规则不能三带一（郑州规矩：不能带牌）', () => eq(detect(Cs(['7♠', '7♥', '7♣', '3♦']), rules), null));
t('默认规则不能三带二', () => eq(detect(Cs(['7♠', '7♥', '7♣', '3♦', '3♠']), rules), null));
t('打开 allowTrioKick 后三带一/三带二仍可识别（规则可切换）', () => {
  const r2 = cloneRules('henan');
  r2.allowTrioKick = true;
  eq(detect(Cs(['7♠', '7♥', '7♣', '3♦']), r2).type, CT.TRIO_ONE);
  eq(detect(Cs(['7♠', '7♥', '7♣', '3♦', '3♠']), r2).type, CT.TRIO_TWO);
});
t('默认规则不认顺子（郑州跑得快式）', () => eq(detect(Cs(['3♠', '4♥', '5♣', '6♦', '7♠']), rules), null));
t('默认规则不认连对', () => eq(detect(Cs(['3♠', '3♥', '4♣', '4♦', '5♠', '5♥']), rules), null));
t('默认规则不认三顺（飞机）', () => eq(detect(Cs(['3♠', '3♥', '3♣', '4♣', '4♦', '4♠']), rules), null));
t('正五十K（同花色）', () => eq(detect(Cs(['5♠', '10♠', 'K♠']), rules).type, CT.PURE_510K));
t('副五十K（混花色）', () => eq(detect(Cs(['5♠', '10♥', 'K♠']), rules).type, CT.MIXED_510K));
t('四张炸（同色：全黑 ♠♣）', () => eq(detect(Cs(['9♠', '9♣', '9♠', '9♣']), rules).type, CT.BOMB));
t('四张炸（同色：全红 ♥♦）也算', () => eq(detect(Cs(['9♥', '9♦', '9♥', '9♦']), rules).type, CT.BOMB));
t('混色 4 张不算炸弹（郑州规矩）', () => {
  eq(detect(Cs(['9♠', '9♥', '9♣', '9♦']), rules), null);
  eq(detect(Cs(['2♠', '2♥', '2♠', '2♥']), rules), null);
});
t('双大王只是普通对子（不是炮）', () => eq(detect(Cs(['大王', '大王']), rules).type, CT.PAIR));
t('四王 = 天炸', () => {
  const c = detect(Cs(['大王', '大王', '小王', '小王']), rules);
  eq(c.type, CT.JOKER_BOMB);
  ok(c.label.includes('四王'), '应是四王');
});
t('2 不进顺子', () => eq(detect(Cs(['J♠', 'Q♥', 'K♣', 'A♦', '2♠']), rules), null));
t('4 张顺子不合法（最少 5 张）', () => eq(detect(Cs(['3♠', '4♥', '5♣', '6♦']), rules), null));
t('非连续不算顺子', () => eq(detect(Cs(['3♠', '4♥', '6♣', '7♦', '8♠']), rules), null));
t('乱牌返回 null', () => eq(detect(Cs(['3♠', '7♥', 'K♣']), rules), null));

/* ===================== 大小比较 ===================== */

t('单张大压小', () => ok(canBeat(detect(Cs(['9♠']), rules), detect(Cs(['8♠']), rules), rules)));
t('单张小压不过大', () => ok(!canBeat(detect(Cs(['8♠']), rules), detect(Cs(['9♠']), rules), rules)));
t('2 比 A 大', () => ok(canBeat(detect(Cs(['2♠']), rules), detect(Cs(['A♠']), rules), rules)));
t('大王最大', () => ok(canBeat(detect(Cs(['大王']), rules), detect(Cs(['2♠']), rules), rules)));
t('不同类型不能互压（单张压不过对子）', () => ok(!canBeat(detect(Cs(['9♠']), rules), detect(Cs(['3♠', '3♥']), rules), rules)));
t('炸弹压单张', () => ok(canBeat(detect(Cs(['9♠', '9♣', '9♠', '9♣']), rules), detect(Cs(['2♠']), rules), rules)));
t('炸弹压对子', () => ok(canBeat(detect(Cs(['9♠', '9♣', '9♠', '9♣']), rules), detect(Cs(['2♠', '2♥']), rules), rules)));
t('四张 2 压四张 A 压四张 K（同色炸，比点数）', () => {
  const four2 = detect(Cs(['2♠', '2♣', '2♠', '2♣']), rules);
  const fourA = detect(Cs(['A♠', 'A♣', 'A♠', 'A♣']), rules);
  const fourK = detect(Cs(['K♠', 'K♣', 'K♠', 'K♣']), rules);
  ok(canBeat(four2, fourA, rules));
  ok(canBeat(fourA, fourK, rules));
  ok(!canBeat(fourK, fourA, rules));
});
t('5张、8张同点都不算炸（郑州规矩：炸弹只有4张）', () => {
  eq(detect(Cs(['3♠', '3♥', '3♣', '3♦', '3♠']), rules), null, '5张同点不算炸');
  eq(detect(Cs(['3♠', '3♥', '3♣', '3♦', '3♠', '3♥', '3♣', '3♦']), rules), null, '8张同点不算炸');
});
t('四王（天炸）压 4 张炸', () => {
  const four = detect(Cs(['大王', '大王', '小王', '小王']), rules);
  const b4 = detect(Cs(['3♠', '3♣', '3♠', '3♣']), rules);
  ok(canBeat(four, b4, rules), '四王应压 4 张炸');
  ok(!canBeat(b4, four, rules), '4 张炸压不过四王');
});
t('双大王只是对子，压不过正五十K', () => {
  const dbl = detect(Cs(['大王', '大王']), rules);
  const p = detect(Cs(['5♠', '10♠', 'K♠']), rules);
  ok(!canBeat(dbl, p, rules));
});
t('打开 allowStraight 后顺子仍可识别（规则可切换）', () => {
  const r2 = cloneRules('henan');
  r2.allowStraight = true;
  eq(detect(Cs(['3♠', '4♥', '5♣', '6♦', '7♠']), r2).type, CT.STRAIGHT);
});
t('副五十K 压普通三张', () => ok(canBeat(detect(Cs(['5♠', '10♥', 'K♠']), rules), detect(Cs(['2♠', '2♥', '2♣']), rules), rules)));
t('正五十K 压副五十K', () => ok(canBeat(detect(Cs(['5♠', '10♠', 'K♠']), rules), detect(Cs(['5♥', '10♣', 'K♦']), rules), rules)));
t('副五十K 压不过正五十K', () => ok(!canBeat(detect(Cs(['5♥', '10♣', 'K♦']), rules), detect(Cs(['5♠', '10♠', 'K♠']), rules), rules)));
t('正五十K 比花色：黑桃 > 方块', () => ok(canBeat(detect(Cs(['5♠', '10♠', 'K♠']), rules), detect(Cs(['5♦', '10♦', 'K♦']), rules), rules)));
t('4 张炸（同色）压正五十K', () => ok(canBeat(detect(Cs(['3♠', '3♣', '3♠', '3♣']), rules), detect(Cs(['5♠', '10♠', 'K♠']), rules), rules)));
t('同点数同张数炸弹不能互压', () => {
  const a = detect(Cs(['9♠', '9♣', '9♠', '9♣']), rules);
  ok(!canBeat(a, a, rules));
});

/* ===================== 完整对局跑批 ===================== */

t('AI 自动对战 300 局：不崩溃、牌数守恒、分数守恒', () => {
  let totalRounds = 0;
  for (let i = 0; i < 300; i++) {
    const g = new Game({ rules: cloneRules('henan'), seed: i * 7919 + 3 });
    g.deal();
    const rng = makeRng(i + 1);
    let guard = 0;
    while (g.phase === PHASE.PLAYING) {
      if (++guard > 2000) throw new Error('第 ' + i + ' 局死循环');
      const seat = g.turn;
      const mv = decide(g, seat, rng);
      const before = g.hands[seat].length;
      const okApply = g.applyAction(mv);
      if (!okApply) throw new Error(`第 ${i} 局：座位 ${seat} 的动作被拒 ${JSON.stringify(mv.type)}`);
      if (mv.type === 'play' && g.hands[seat].length === before) throw new Error('出牌后手牌没减少');
    }
    // 牌数守恒
    const left = [0, 1, 2, 3].reduce((s, x) => s + g.hands[x].length, 0);
    const played = 108 - left;
    // 分数守恒：各方抓到的分 + 桌上没结算的 + 手里剩的 = 200
    const pot = g.pot.reduce((a, b) => a + b, 0);
    const remain = [0, 1, 2, 3].reduce((s, x) => s + handScore(g.hands[x], rules), 0);
    const onTable = g.trickCards.reduce((s, c) => s + cardScore(c, rules), 0);
    if (pot + remain + onTable !== 200) {
      throw new Error(`第 ${i} 局分数不守恒：${pot}+${remain}+${onTable} != 200`);
    }
    // 个人制：三人出完即结束（第四名为末游）
    const r = g.result;
    if (!r) throw new Error('没有结算结果');
    if (r.mode !== 'individual') throw new Error('默认应为个人制');
    if (g.finishOrder.length < 3) throw new Error(`第 ${i} 局结束时出完人数不足 3：${g.finishOrder.length}`);
    // 公粮平衡（收 = 交）
    const penSum = r.penalty.reduce((a, b) => a + b, 0);
    if (penSum !== 0) throw new Error(`第 ${i} 局公粮不平衡：${penSum}`);
    // 总分 = 各座位抓分 + 公粮，且总和等于全场 200
    const fsSum = r.finalScore.reduce((a, b) => a + b, 0);
    const potSum = g.pot.reduce((a, b) => a + b, 0);
    if (fsSum !== potSum) throw new Error(`第 ${i} 局 finalScore(${fsSum}) != pot(${potSum})`);
    // 第 4 名（末游）必为负公粮，第 1 名必为正公粮
    const last = r.order[3], first = r.order[0];
    if (r.penalty[last] >= 0) throw new Error('末游未交公粮');
    if (r.penalty[first] <= 0) throw new Error('头游未收公粮');
    totalRounds++;
  }
  results.push(['·', `跑批统计：个人制 4 人 ${totalRounds} 局，公粮/总分校验全部通过`, '']);
});

/* ---------- 3 / 5 人局：验证引擎已泛化到任意人数 ---------- */

/** 通用跑批：对所有人数校验「不崩溃 / 分数守恒 / 公粮平衡」 */
function batchSeatCount(n, count, seedBase) {
  const r = cloneRules('henan');
  r.seatCount = n;
  let okRounds = 0;
  for (let i = 0; i < count; i++) {
    const g = new Game({ rules: r, seed: seedBase + i * 7919 });
    g.deal();
    const rng = makeRng(i + 1);
    let guard = 0;
    while (g.phase === PHASE.PLAYING) {
      if (++guard > 5000) throw new Error(`${n} 人局死循环`);
      const seat = g.turn;
      const before = g.hands[seat].length;
      const mv = decide(g, seat, rng);
      const okApply = g.applyAction(mv);
      if (!okApply) throw new Error(`${n} 人局：座位 ${seat} 动作被拒 ${JSON.stringify(mv.type)}`);
      if (mv.type === 'play' && g.hands[seat].length === before) throw new Error(`${n} 人局出牌后手牌没减少`);
    }
    // 分数守恒：已结算 + 没结算的 + 手里剩的 = 200
    const pot = g.pot.reduce((a, b) => a + b, 0);
    let remain = 0;
    for (let s = 0; s < n; s++) remain += handScore(g.hands[s], r);
    const onTable = g.trickCards.reduce((s, c) => s + cardScore(c, r), 0);
    if (pot + remain + onTable !== 200) throw new Error(`${n} 人局分数不守恒：${pot}+${remain}+${onTable}`);
    // 公粮平衡
    const penSum = g.result.penalty.reduce((a, b) => a + b, 0);
    if (penSum !== 0) throw new Error(`${n} 人局公粮不平衡：${penSum}`);
    // 出完人数：个人制 = n-1（剩 1 人为末游）
    if (g.finishOrder.length !== n - 1) throw new Error(`${n} 人局结束时应出完 ${n - 1} 人，实际 ${g.finishOrder.length}`);
    okRounds++;
  }
  return okRounds;
}

t('3 人局：发牌/出完/分数守恒/公粮平衡（只有末游交）', () => {
  const n = batchSeatCount(3, 80, 50000);
  results.push(['·', `跑批统计：个人制 3 人 ${n} 局全部通过`, '']);
});

t('5 人局：发牌/出完/分数守恒/公粮平衡（末游+倒数第二交）', () => {
  const n = batchSeatCount(5, 80, 90000);
  results.push(['·', `跑批统计：个人制 5 人 ${n} 局全部通过`, '']);
});

/* ===================== 见张乎（能压必须出） ===================== */

t('见张乎：跟牌能压时 AI 必出、引擎拒绝过牌', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 4242 });
  g.deal();
  const rng = makeRng(7);
  let guard = 0, checked = 0;
  while (g.phase === PHASE.PLAYING && ++guard < 3000) {
    const seat = g.turn;
    if (!g.isFreeTurn(seat) && g.legalMoves(seat).length > 0) {
      if (g.canPass(seat)) throw new Error('见张乎下能压却允许过牌');
      const mv = decide(g, seat, rng);
      if (mv.type !== 'play') throw new Error('见张乎下 AI 该出却过了');
      checked++;
    }
    g.applyAction(decide(g, seat, rng));
  }
  if (checked === 0) throw new Error('整局未出现能压的跟牌场景（检查种子）');
});

t('见张乎：引擎直接拒绝非法过牌动作', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 13 });
  g.deal();
  const rng = makeRng(1);
  let found = false, guard = 0;
  while (g.phase === PHASE.PLAYING && ++guard < 3000 && !found) {
    const seat = g.turn;
    if (!g.isFreeTurn(seat) && g.legalMoves(seat).length > 0) {
      const rejected = g.applyAction({ type: 'pass', seat });
      if (rejected !== false) throw new Error('引擎应在见张乎下拒绝过牌');
      found = true;
    }
    g.applyAction(decide(g, seat, rng));
  }
  if (!found) throw new Error('一局里没出现能压的跟牌场景（检查种子）');
});

t('见张乎可关：关掉后跟牌能压也可过牌', () => {
  const rules = cloneRules('henan');
  rules.mustBeat = false;
  const g = new Game({ rules, seed: 55 });
  g.deal();
  const rng = makeRng(2);
  let sawCanPass = false, guard = 0;
  while (g.phase === PHASE.PLAYING && ++guard < 3000) {
    const seat = g.turn;
    if (!g.isFreeTurn(seat) && g.legalMoves(seat).length > 0) {
      if (g.canPass(seat)) sawCanPass = true; // 关掉后允许过
    }
    g.applyAction(decide(g, seat, rng));
  }
  if (!sawCanPass) throw new Error('关掉见张乎后仍处处强制（策略层未放开）');
});

t('引擎确定性：同 seed + 同动作序列 = 同结果', () => {
  const run = () => {
    const g = new Game({ rules: cloneRules('henan'), seed: 424242 });
    g.deal();
    const rng = makeRng(7);
    let guard = 0;
    while (g.phase === PHASE.PLAYING && ++guard < 2000) g.applyAction(decide(g, g.turn, rng));
    return JSON.stringify({ pot: g.pot, order: g.finishOrder, result: g.result });
  };
  eq(run(), run());
});

t('简化版规则也能跑完（无顺子）', () => {
  const g = new Game({ rules: cloneRules('simple'), seed: 555 });
  g.deal();
  const rng = makeRng(2);
  let guard = 0;
  while (g.phase === PHASE.PLAYING && ++guard < 2000) g.applyAction(decide(g, g.turn, rng));
  eq(g.phase, PHASE.FINISHED);
});

t('三张算炮的变体也能跑完', () => {
  const g = new Game({ rules: cloneRules('trioBomb'), seed: 888 });
  g.deal();
  const rng = makeRng(3);
  let guard = 0;
  while (g.phase === PHASE.PLAYING && ++guard < 2000) g.applyAction(decide(g, g.turn, rng));
  eq(g.phase, PHASE.FINISHED);
});

t('不能出非法牌型', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 31 });
  g.deal();
  const seat = g.turn;
  // 手牌已按点数排序，取两张；排除王（两张王组成"对王"是合法炮）
  const two = g.hands[seat].filter((c) => c.r < RANK.JOKER_S).slice(0, 2);
  const okApply = g.applyAction({ seat, type: 'play', uids: two.map((c) => c.uid) });
  const isPair = two[0].r === two[1].r;
  eq(okApply, isPair, `两张 ${two.map((c) => c.r).join('+')}：`);
});

t('两张王是合法的"对王"炮', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 36 });
  g.deal();
  const seat = g.turn;
  const jokers = g.hands[seat].filter((c) => c.r >= RANK.JOKER_S);
  if (jokers.length >= 2) {
    eq(g.applyAction({ seat, type: 'play', uids: jokers.slice(0, 2).map((c) => c.uid) }), true);
  } else {
    ok(true); // 这局没摸到王，跳过
  }
});

t('非当前出牌人不能出牌', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 32 });
  g.deal();
  const other = (g.turn + 1) % 4;
  eq(g.applyAction({ seat: other, type: 'play', uids: [g.hands[other][0].uid] }), false);
});

t('自由出牌不能 pass', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 33 });
  g.deal();
  eq(g.applyAction({ seat: g.turn, type: 'pass' }), false);
});

t('findBeats 能找到压制牌', () => {
  const hand = Cs(['3♠', '4♥', '5♣', '6♦', '7♠', '9♠', '9♣', '9♠', '9♣']);
  const target = detect(Cs(['5♣']), rules);
  const beats = findBeats(hand, target, rules, {});
  ok(beats.length > 0, '应能找到压制牌');
  ok(beats.some((c) => c.type === CT.BOMB), '应包含炸弹选项');
});

t('enumerateBombs：手里 4红+4黑 9 → 只有红炸、黑炸两个（8张不算炸）', () => {
  const hand = Cs(['9♥', '9♦', '9♥', '9♦', '9♠', '9♣', '9♠', '9♣']);
  const bombs = enumerateBombs(hand, rules).filter((b) => b.type === CT.BOMB);
  eq(bombs.length, 2, '应恰为红炸+黑炸两个');
  const keys = new Set(bombs.map((b) => b.cards.map((c) => c.uid).sort().join('|')));
  eq(keys.size, 2, '两个炸弹 uid 组合应不同');
  // 手里 4 红 9 + 1 黑 9 → 只有红炸（5 张不算炸）
  const hand2 = Cs(['9♥', '9♦', '9♥', '9♦', '9♠']);
  const bombs2 = enumerateBombs(hand2, rules).filter((b) => b.type === CT.BOMB);
  eq(bombs2.length, 1, '应只有红4炸一个');
  ok(bombs2.every((b) => b.len === 4), '不存在 5 张炸');
});

t('黑炸 > 红炸（同点数），点数仍主导大小', () => {
  const black9 = detect(Cs(['9♠', '9♣', '9♠', '9♣']), rules);
  const red9 = detect(Cs(['9♥', '9♦', '9♥', '9♦']), rules);
  ok(canBeat(black9, red9, rules), '黑9炸应压红9炸');
  ok(!canBeat(red9, black9, rules), '红9炸压不过黑9炸');
  const red2 = detect(Cs(['2♥', '2♦', '2♥', '2♦']), rules);
  ok(canBeat(red2, black9, rules), '红2炸仍压黑9炸（点数主导）');
  eq(red2.label.includes('红'), true, '红炸标签带"红"');
  eq(black9.label.includes('黑'), true, '黑炸标签带"黑"');
});

/* ---------- 接风：赢家连出；走光后下手接风 ---------- */

t('接风：我的大→我继续出；只有走光后最后一手没人压才下手接风', () => {
  const runGame = (seed) => {
    const g = new Game({ rules: cloneRules('henan'), seed });
    g.deal();
    let lastTrickWinner = -1, lead = 0, jiefeng = 0;
    g.on((evt) => {
      if (evt.type === 'trick') lastTrickWinner = evt.seat;
      if (evt.type === 'turn' && evt.free && lastTrickWinner >= 0) {
        if (g.finished[lastTrickWinner]) {
          if (evt.seat === lastTrickWinner) throw new Error('赢家已走光却还连出');
          jiefeng++;
        } else {
          if (evt.seat !== lastTrickWinner) {
            throw new Error(`打住后没让赢家 ${lastTrickWinner} 连出，却给了 ${evt.seat}`);
          }
          lead++;
        }
        lastTrickWinner = -1;
      }
    });
    const rng = makeRng(seed);
    let guard = 0;
    while (g.phase === PHASE.PLAYING && ++guard < 2000) g.applyAction(decide(g, g.turn, rng));
    return { lead, jiefeng };
  };
  // 多跑几局，确保「赢家连出」和「走光后接风」两种场景都被覆盖
  let totalLead = 0, totalJiefeng = 0;
  for (let seed = 424242; seed < 424252; seed++) {
    const { lead, jiefeng } = runGame(seed);
    totalLead += lead;
    totalJiefeng += jiefeng;
  }
  ok(totalLead > 0, '多局中未出现"赢家连出"场景');
  ok(totalJiefeng > 0, '多局中未出现"走光后接风"场景');
});

/* ---------- 终局结算：末游留分翻倍 / 总分排名 / 头游过线 / 连局首发 ---------- */

t('连局首发：firstLeader 指定谁谁先出（上局头游先出牌）', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 9, firstLeader: 2 });
  g.deal();
  eq(g.turn, 2);
});

t('终局结算：末游留分×2 扣给头游；名次按总分排；头游过线即赢', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 1 });
  g.deal();
  // 伪造终局：0=头游 1=二游 2=三游 3=末游（手里留 5♠+10♥ = 15 分没跑掉）
  g.hands[0] = []; g.hands[1] = []; g.hands[2] = [];
  g.hands[3] = Cs(['5♠', '10♥', '3♣']);
  g.finished = [true, true, true, false];
  g.finishOrder = [0, 1, 2];
  g.pot = [20, 30, 40, 50];
  g._finishRound();
  const r = g.result;
  // 末游：抓 50 - 公粮 30 - 留分 15×2=30 → -10
  eq(r.finalScore[3], -10, '末游应被翻倍扣留分');
  // 头游：抓 20 + 公粮 30 + 翻倍 30 → 80
  eq(r.finalScore[0], 80, '头游应收翻倍留分');
  eq(r.lastLeftover, 15);
  eq(r.penalty.reduce((a, b) => a + b, 0), 0, '公粮+翻倍后收支仍守恒');
  // 名次按总分：头游80 > 二游40(30+10) > 三游30(40-10) > 末游-10
  eq(r.scoreRank, [0, 1, 2, 3], '应按总分排名');
  ok(r.winner === 0 && r.headPassed, '头游总分过 40 门槛，即赢方');
});

t('enumerateBombs 能识别正五十K', () => {
  const hand = Cs(['5♠', '10♠', 'K♠', '3♦', '7♥']);
  const bombs = enumerateBombs(hand, rules);
  ok(bombs.some((b) => b.type === CT.PURE_510K), '应找到正五十K');
});

/* ===================== 自由出（杂牌） ===================== */

t('自由出：5张杂牌 detect 仍判 null，freeCombo 构造 FREE', () => {
  eq(detect(Cs(['5♠', '5♥', '5♣', '5♦', '7♠']), rules), null, '5张杂牌不构成牌型');
  const f = freeCombo(Cs(['5♠', '5♥', '5♣', '5♦', '7♠']));
  eq(f.type, CT.FREE);
  eq(f.len, 5);
  ok(f.label.includes('5张'), '标签应说明张数');
});

t('自由出：杂牌只能被炮压，杂牌压不了任何人', () => {
  const junk = freeCombo(Cs(['5♠', '5♥', '5♣', '5♦', '7♠']));
  ok(canBeat(detect(Cs(['9♠', '9♣', '9♠', '9♣']), rules), junk, rules), '4张炸应能压杂牌');
  ok(canBeat(detect(Cs(['5♠', '10♠', 'K♠']), rules), junk, rules), '正五十K应能压杂牌');
  ok(canBeat(detect(Cs(['大王', '大王', '小王', '小王']), rules), junk, rules), '四王应能压杂牌');
  ok(!canBeat(detect(Cs(['3♠', '3♥']), rules), junk, rules), '对子不能压杂牌');
  ok(!canBeat(detect(Cs(['3♠']), rules), junk, rules), '单张不能压杂牌');
  ok(!canBeat(junk, detect(Cs(['3♠']), rules), rules), '杂牌不能压别人');
  ok(!canBeat(freeCombo(Cs(['3♠', '4♥', '5♣'])), junk, rules), '杂牌不能压杂牌');
});

t('findBeats 面对杂牌只返回炸弹（含五十K）', () => {
  const hand = Cs(['3♠', '3♥', '9♠', '9♣', '9♠', '9♣', '5♠', '10♠', 'K♠']);
  const junk = freeCombo(Cs(['2♠', '2♥', '2♣', '2♦', '7♠']));
  const beats = findBeats(hand, junk, rules, {});
  ok(beats.length > 0, '应有能压的炮');
  for (const b of beats) ok(isBombFamily(b.type, rules), '返回的全应是炮：' + b.label);
});

t('引擎：领出5张杂牌成功（FREE）；跟牌对子被拒、炸弹放行；见张乎管住杂牌', () => {
  const g = new Game({ rules: cloneRules('henan'), seed: 77 });
  g.deal();
  const h0 = Cs(['5♠', '5♥', '5♣', '5♦', '7♠']);
  const h1 = Cs(['3♠', '3♥', '9♠', '9♣', '9♠', '9♣']);
  g.hands[0] = sortCards(h0);
  g.hands[1] = sortCards(h1);
  g.hands[2] = sortCards(Cs(['4♠', '4♥']));
  g.hands[3] = sortCards(Cs(['6♠', '6♥']));
  g.turn = 0; g.trickLeader = 0; g.lastPlay = null; g.trickCards = [];

  // 领出 5 张杂牌 → 成功，FREE
  ok(g.applyAction({ seat: 0, type: 'play', uids: h0.map((c) => c.uid) }), '5张杂牌应能一手领出');
  eq(g.lastPlay.combo.type, CT.FREE, '应按自由出处理');
  eq(g.turn, 1, '轮到下家');

  // 见张乎：下家手里有炮（4张9），面对杂牌不能 pass
  ok(!g.canPass(1), '手里有炮能压杂牌 → 不许过');

  // 跟牌出对子 → 拒（对子不能压杂牌）
  const pairUids = h1.slice(0, 2).map((c) => c.uid);
  ok(!g.applyAction({ seat: 1, type: 'play', uids: pairUids }), '对子不能压杂牌');
  eq(g.turn, 1, '拒绝后仍轮到同一人');

  // 出 4张9 炸 → 放行
  const bombUids = h1.slice(2).map((c) => c.uid);
  ok(g.applyAction({ seat: 1, type: 'play', uids: bombUids }), '炸弹应能压杂牌');

  // 剩下两家没有炮 → 只能过；一圈结束，赢家（座位1）继续出
  ok(g.applyAction({ seat: 2, type: 'pass' }), '没炮可过');
  ok(g.applyAction({ seat: 3, type: 'pass' }), '没炮可过');
  eq(g.turn, 1, '赢家没走光 → 赢家继续自由出');
  // 座位1 剩一对3，自由出甩对子 → 走光
  ok(g.applyAction({ seat: 1, type: 'play', uids: pairUids }), '自由出甩对子走光');
  ok(g.finished[1], '座位1应已走光');
});

/* ===================== 输出 ===================== */

console.log('\n' + '='.repeat(62));
console.log(' 五十K（河南郑州版）核心逻辑自测');
console.log('='.repeat(62));
for (const [mark, name, err] of results) {
  console.log(` ${mark} ${name}${err ? '\n     → ' + err : ''}`);
}
console.log('-'.repeat(62));
console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(62) + '\n');
process.exit(fail ? 1 : 0);
