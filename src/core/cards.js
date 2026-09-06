/**
 * 牌与牌堆：两副牌 108 张，可洗牌、发牌、排序、分组。
 * 牌对象： { uid, r, s, copy }
 *   r: 点数 3..17（见 RANK）
 *   s: 花色 3=♠ 2=♥ 1=♣ 0=♦，王为 -1
 *   copy: 第几副（0 或 1），仅用于 uid 唯一性
 */
import { RANK, SUIT_CHAR, RANK_CHAR, SCORE_MAP } from './rules.js';

/** 可复现的随机数发生器（mulberry32），用于联机时"种子同步" */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** 生成一副牌（54 张） */
export function buildDeck(copyIndex, useJokers = true) {
  const deck = [];
  for (let s = 0; s <= 3; s++) {
    for (let r = 3; r <= 15; r++) {
      deck.push({ uid: `${copyIndex}_${r}_${s}`, r, s, copy: copyIndex });
    }
  }
  if (useJokers) {
    deck.push({ uid: `${copyIndex}_16_J`, r: RANK.JOKER_S, s: -1, copy: copyIndex });
    deck.push({ uid: `${copyIndex}_17_J`, r: RANK.JOKER_B, s: -1, copy: copyIndex });
  }
  return deck;
}

/** 生成整副牌堆（默认两副 = 108 张） */
export function buildShoe(deckCount = 2, useJokers = true) {
  let shoe = [];
  for (let i = 0; i < deckCount; i++) shoe = shoe.concat(buildDeck(i, useJokers));
  return shoe;
}

/** Fisher-Yates 洗牌（外部传入 rng，保证可复现） */
export function shuffle(cards, rng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 每张牌的分值 */
export function cardScore(card, rules) {
  if (card.r === RANK.JOKER_S || card.r === RANK.JOKER_B) return rules.jokerScore || 0;
  return (rules.scoreMap || SCORE_MAP)[card.r] || 0;
}

/** 是否分牌（5/10/K；按 rules.scoreMap，王不算分） */
export function isScoreCard(card, rules) {
  const map = (rules && rules.scoreMap) || SCORE_MAP;
  return !!map[card.r];
}

/** 一组牌的总分 */
export function handScore(cards, rules) {
  return cards.reduce((sum, c) => sum + cardScore(c, rules), 0);
}

/** 手牌排序：大的在前（从左到右 大 → 小），方便渲染 */
export function sortCards(cards) {
  return cards.slice().sort((a, b) => (b.r - a.r) || (b.s - a.s) || (a.uid < b.uid ? -1 : 1));
}

/** 手牌排序（小的在前） */
export function sortCardsAsc(cards) {
  return cards.slice().sort((a, b) => (a.r - b.r) || (a.s - b.s) || (a.uid < b.uid ? -1 : 1));
}

/** 按点数分组： { 3: [card...], 15: [...] } */
export function groupByRank(cards) {
  const g = new Map();
  for (const c of cards) {
    if (!g.has(c.r)) g.set(c.r, []);
    g.get(c.r).push(c);
  }
  return g;
}

/** 计数表： rank -> 张数 */
export function countByRank(cards) {
  const g = groupByRank(cards);
  const m = new Map();
  for (const [r, list] of g) m.set(r, list.length);
  return m;
}

export function cardLabel(card) {
  if (card.r === RANK.JOKER_S) return '小王';
  if (card.r === RANK.JOKER_B) return '大王';
  return (SUIT_CHAR[card.s] || '') + RANK_CHAR[card.r];
}

export function cardsLabel(cards) {
  return cards.map(cardLabel).join(' ');
}

/** 从手牌中按 uid 移除（返回新数组） */
export function removeCards(hand, cards) {
  const ids = new Set(cards.map((c) => c.uid));
  return hand.filter((c) => !ids.has(c.uid));
}

/** 按 uid 找牌 */
export function findByUid(cards, uid) {
  return cards.find((c) => c.uid === uid) || null;
}

/** 手牌序列化（联机传输用，只传 uid 数组即可，牌本身由种子重建） */
export function serializeHand(cards) {
  return cards.map((c) => c.uid);
}
