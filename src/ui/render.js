/** DOM 渲染：牌、手牌、出牌区 */
import { RANK_CHAR, SUIT_CHAR, RANK, SUIT } from '../core/rules.js';
import { isScoreCard } from '../core/cards.js';

/** 造一张牌的 DOM */
export function cardEl(card, { mini = false, faceDown = false, beaten = false } = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  if (mini) el.classList.add('mini');
  if (beaten) el.classList.add('beaten'); // 已被别人压下去的牌：淡化
  if (faceDown) { el.classList.add('back'); return el; }

  if (card.r >= RANK.JOKER_S) {
    const isBig = card.r === RANK.JOKER_B;
    el.classList.add('joker', isBig ? 'jb' : 'js');
    const tl = document.createElement('div');
    tl.className = 'c-tl';
    tl.textContent = isBig ? '大\n王' : '小\n王';
    tl.style.whiteSpace = 'pre-line';
    el.appendChild(tl);
    const big = document.createElement('div');
    big.className = 'c-big';
    big.textContent = isBig ? '🃏' : '🃏';
    big.style.opacity = '.35';
    el.appendChild(big);
    return el;
  }

  const suit = SUIT_CHAR[card.s];
  const rank = RANK_CHAR[card.r];
  // 颜色以花色常量为准：红桃 ♥ / 方块 ♦ 为红，黑桃 ♠ / 梅花 ♣ 为黑
  el.classList.add(card.s === SUIT.HEART || card.s === SUIT.DIAMOND ? 'red' : 'black');
  // 分牌（5/10/K）加金色角标，一眼认出能抓分的牌
  if (isScoreCard(card)) el.classList.add('score');

  const tl = document.createElement('div');
  tl.className = 'c-tl';
  tl.innerHTML = `${rank}<small>${suit}</small>`;
  el.appendChild(tl);

  const mid = document.createElement('div');
  mid.className = 'c-mid';
  mid.textContent = suit;
  el.appendChild(mid);

  // 右下角分值角标
  if (isScoreCard(card)) {
    const sc = document.createElement('div');
    sc.className = 'c-score';
    sc.textContent = card.r === 5 ? '5分' : '10分';
    el.appendChild(sc);
  }

  return el;
}

/** 渲染一排牌 */
export function renderCards(container, cards, opts = {}) {
  container.innerHTML = '';
  for (const c of cards) {
    container.appendChild(cardEl(c, opts));
  }
}

/** 渲染"不出"标记 */
export function renderPass(container, text = '不出') {
  container.innerHTML = '';
  const el = document.createElement('div');
  el.style.cssText = 'font-size:13px;color:#9fc4b3;background:rgba(0,0,0,.4);padding:5px 12px;border-radius:14px;';
  el.textContent = text;
  container.appendChild(el);
}

/** 清空一个容器 */
export function clear(container) { container.innerHTML = ''; }

/** 牌型的中文说明（用于气泡/提示） */
export function comboText(combo) {
  if (!combo) return '';
  return combo.label || combo.name || '';
}
