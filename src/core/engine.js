/**
 * 游戏引擎（纯逻辑，无 UI / 无网络依赖）
 *
 * 关键设计：完全确定性。
 * 给定 seed + 一串 action，各端算出的结果完全一致 —— 这是 P2P 联机
 * 不需要服务器做权威仲裁的前提（各端只同步 seed 和 action 列表）。
 */
import { buildShoe, shuffle, sortCards, makeRng, randomSeed, cardScore, handScore, removeCards } from './cards.js';
import { detect, canBeat, comboPower, isBombFamily, freeCombo } from './combo.js';
import { CT, RANK, cloneRules } from './rules.js';

export const PHASE = { READY: 'ready', PLAYING: 'playing', FINISHED: 'finished' };

/** 座位默认称呼：随人数变化（0 永远是"我"） */
export function defaultNames(n) {
  const base = ['我', '下家', '二家', '上家', '旁家', '六家', '七家', '八家'];
  const arr = [];
  for (let s = 0; s < n; s++) arr.push(base[s] || `家${s}`);
  return arr;
}

export class Game {
  /**
   * @param {object} opts { rules, seed, names }
   */
  constructor(opts = {}) {
    this.rules = opts.rules || cloneRules('henan');
    this.seed = opts.seed !== undefined ? opts.seed : randomSeed();
    const n = this.rules.seatCount || 4;
    this.names = opts.names || defaultNames(n); // 座位 0 为"我"
    // 首发座位：联机/连局时由外部指定（上局头游先出）；null = 按 rules.firstDealBy 决定
    this.firstLeader = opts.firstLeader !== undefined ? opts.firstLeader : null;
    this.reset();
  }

  reset() {
    const n = this.rules.seatCount || 4;
    this.rng = makeRng(this.seed);
    this.phase = PHASE.READY;
    this.hands = Array.from({ length: n }, () => []);
    this.turn = 0;
    this.lastPlay = null;       // { seat, combo }
    this.trickCards = [];       // 本圈所有打出的牌（用于收分）
    this.passes = new Set();
    this.trickLeader = 0;
    this.finishOrder = [];      // 出完牌的先后顺序
    this.finished = Array.from({ length: n }, () => false);
    this.pot = new Array(n).fill(0);    // 各座位抓到的分
    this.actions = [];          // 动作日志（联机同步 / 回放用）
    this.result = null;
    this.roundNo = 1;
    this.listeners = [];
  }

  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
  emit(evt) { for (const fn of this.listeners) fn(evt, this); }

  /* ---------------- 发牌 ---------------- */

  deal() {
    this.reset();
    const n = this.rules.seatCount;
    const shoe = shuffle(buildShoe(this.rules.deckCount, this.rules.useJokers), this.rng);
    const per = Math.floor(shoe.length / n);
    let idx = 0;
    for (let s = 0; s < n; s++) {
      this.hands[s] = sortCards(shoe.slice(idx, idx + per));
      idx += per;
    }
    // 余牌（108 不能被人数整除时，如 5 人剩 3 张）轮流发给前几座，保证全部分完、确定性可复现
    while (idx < shoe.length) {
      this.hands[idx % n].push(shoe[idx]);
      idx++;
    }
    for (let s = 0; s < n; s++) this.hands[s] = sortCards(this.hands[s]);
    this.turn = this.firstSeat();
    this.trickLeader = this.turn;
    this.phase = PHASE.PLAYING;
    this.emit({ type: 'deal', turn: this.turn });
    return this;
  }

  /** 首局谁先出：外部指定 firstLeader 优先（连局时=上局头游），否则按规则配置 */
  firstSeat() {
    const n = this.rules.seatCount;
    if (this.firstLeader !== null && this.firstLeader !== undefined
        && this.firstLeader >= 0 && this.firstLeader < n) return this.firstLeader;
    const by = this.rules.firstDealBy;
    if (by === 'random') return Math.floor(this.rng() * n);
    const want = { heart3: { s: 2, r: 3 }, spade3: { s: 3, r: 3 }, heartA: { s: 2, r: 14 } }[by] || { s: 2, r: 3 };
    for (let s = 0; s < n; s++) {
      if (this.hands[s].some((c) => c.r === want.r && c.s === want.s)) return s;
    }
    return 0;
  }

  /* ---------------- 查询 ---------------- */

  get currentCombo() { return this.lastPlay ? this.lastPlay.combo : null; }

  /** 当前需要出牌的座位能否自由出牌（即是否是本圈首发） */
  isFreeTurn(seat) {
    if (this.lastPlay === null) return true;
    return this.lastPlay.seat === seat; // 上家是自己 → 说明其他人都 pass 了
  }

  /** 当前座位此刻是否【允许】过牌（不出）
   *  - 自由出牌（本圈首发）不能过，必须领出
   *  - 见张乎（mustBeat）：手里只要还有能压过的牌（含炮），就不许过 */
  canPass(seat) {
    if (this.isFreeTurn(seat)) return false;
    if (this.rules.mustBeat && this.legalMoves(seat).length > 0) return false;
    return true;
  }

  /** 本圈桌面上的分（还没人收走） */
  get tableScore() {
    return this.trickCards.reduce((s, c) => s + cardScore(c, this.rules), 0);
  }

  /** 某座位还剩几张 */
  handCount(seat) { return this.hands[seat].length; }

  teamOf(seat) { return seat % 2; }

  /** 活跃（还没出完牌）的座位 */
  activeSeats() {
    const n = this.rules.seatCount;
    const out = [];
    for (let s = 0; s < n; s++) if (!this.finished[s]) out.push(s);
    return out;
  }

  /** 该座位的合法出牌（UI 提示 / AI 用） */
  legalMoves(seat) {
    const hand = this.hands[seat];
    const target = this.isFreeTurn(seat) ? null : this.lastPlay.combo;
    const { findBeats } = this._comboApi;
    return findBeats(hand, target, this.rules, {});
  }

  /* ---------------- 动作 ---------------- */

  /**
   * @param {object} action { seat, type:'play'|'pass', uids?:string[] }
   * @returns {boolean} 是否成功
   */
  applyAction(action) {
    if (this.phase !== PHASE.PLAYING) return false;
    const seat = action.seat;
    if (seat !== this.turn) return false;
    if (this.finished[seat]) return false;

    if (action.type === 'pass') {
      if (this.isFreeTurn(seat)) return false; // 自由出牌不能 pass
      if (this.rules.mustBeat && this.legalMoves(seat).length > 0) return false; // 见张乎：能压必须出
      this.passes.add(seat);
      this.actions.push({ seat, type: 'pass' });
      this.emit({ type: 'pass', seat });
      this._advance();
      return true;
    }

    if (action.type === 'play') {
      const cards = (action.uids || []).map((uid) => this.hands[seat].find((c) => c.uid === uid)).filter(Boolean);
      if (cards.length === 0) return false;
      // 领出（自由出牌）时想怎么打怎么打：凑不成合法牌型就当一手"自由出"杂牌
      // （5张/6张杂牌、混色4张等同理）；跟牌仍必须 detect 出合法牌型。
      const combo = detect(cards, this.rules)
        || (this.isFreeTurn(seat) ? freeCombo(cards) : null);
      if (!combo) return false;
      if (!this.isFreeTurn(seat) && !canBeat(combo, this.lastPlay.combo, this.rules)) return false;

      this.hands[seat] = removeCards(this.hands[seat], cards);
      this.trickCards.push(...cards);
      this.lastPlay = { seat, combo };
      this.passes.clear();
      this.actions.push({ seat, type: 'play', uids: cards.map((c) => c.uid), combo });
      this.emit({ type: 'play', seat, combo });

      if (this.hands[seat].length === 0) {
        this.finished[seat] = true;
        this.finishOrder.push(seat);
        this.passes.delete(seat);
        this.emit({ type: 'finish', seat, rank: this.finishOrder.length });
        if (this._checkGameOver()) return true;
      }
      this._advance();
      return true;
    }
    return false;
  }

  /** 推进到下一位出牌者；一圈结束时收分 */
  _advance() {
    const active = this.activeSeats();
    if (active.length <= 1) { this._finishRound(); return; }

    const others = active.filter((s) => s !== (this.lastPlay ? this.lastPlay.seat : -1));
    const allPassed = this.lastPlay && others.length > 0 && others.every((s) => this.passes.has(s));

    if (allPassed || !this.lastPlay) {
      this._closeTrick();
      if (this.phase !== PHASE.PLAYING) return;
      return;
    }
    this.turn = this._nextSeat(this.turn);
    this.emit({ type: 'turn', seat: this.turn });
  }

  /** 一圈结束：算分、定下一圈首发（含接风） */
  _closeTrick() {
    const winner = this.lastPlay ? this.lastPlay.seat : this.trickLeader;
    const gained = this.trickCards.reduce((s, c) => s + cardScore(c, this.rules), 0);
    this.pot[winner] += gained;
    this.emit({ type: 'trick', seat: winner, score: gained });

    this.trickCards = [];
    this.lastPlay = null;
    this.passes.clear();

    // 郑州规矩（用户原话）：我的大 → 我继续出；只有我把牌全部打完（走光），
    // 且最后出的这手没人压时，才轮到下手（下家）接风。_nextSeat 自动跳过已走光的座位。
    let leader = winner;
    if (this.finished[leader]) leader = this._nextSeat(leader);
    this.trickLeader = leader;
    this.turn = leader;
    this.emit({ type: 'turn', seat: this.turn, free: true });
  }

  _nextSeat(seat) {
    const n = this.rules.seatCount;
    let s = (seat + 1) % n;
    for (let i = 0; i < n; i++) {
      if (!this.finished[s]) return s;
      s = (s + 1) % n;
    }
    return seat;
  }

  /** 结束条件：团队制=一方两人走完；个人制=除末游外全部走完（剩 1 人即末游） */
  _checkGameOver() {
    const n = this.rules.seatCount;
    if (this.rules.mode === 'team' && n === 4) {
      for (const t of [0, 1]) {
        const seats = [t, t + 2];
        if (this.finished[seats[0]] && this.finished[seats[1]]) { this._finishRound(); return true; }
      }
    }
    // 全部走完 或 个人制下只剩 1 人（其余都出完，剩下那位就是末游）
    if (this.finishOrder.length >= n) { this._finishRound(); return true; }
    if (this.rules.mode !== 'team' && this.finishOrder.length >= n - 1) { this._finishRound(); return true; }
    return false;
  }

  _finishRound() {
    // 收最后一圈的分
    if (this.trickCards.length && this.lastPlay) {
      const gained = this.trickCards.reduce((s, c) => s + cardScore(c, this.rules), 0);
      this.pot[this.lastPlay.seat] += gained;
      this.trickCards = [];
    }
    this.phase = PHASE.FINISHED;
    this.result = this._settle();
    this.emit({ type: 'roundEnd', result: this.result });
  }

  /* ---------------- 结算 ---------------- */

  _settle() {
    const R = this.rules;
    const n = this.rules.seatCount;
    const order = this.finishOrder.slice();
    // 没出完的人按剩余手牌分排序补在后面（个人制下最后剩的那位即末游）
    const rest = [];
    for (let s = 0; s < n; s++) if (!this.finished[s]) rest.push(s);
    rest.sort((a, b) => this.hands[a].length - this.hands[b].length);
    const fullOrder = order.concat(rest);

    const pos = {};
    fullOrder.forEach((s, i) => { pos[s] = i + 1; });

    if (R.mode === 'team' && n === 4) return this._settleTeam(fullOrder, pos, R);

    /* ---- 个人制（郑州：各管各的，不打对家）---- */
    // 名次：fullOrder[0]=头游 … fullOrder[n-1]=末游
    // 公粮：末游交 penaltyLast → 头游；倒数第二交 penalty3rd → 二游
    //   （仅当人数 >= 4 时才有独立的"倒数第二"和"二游"；3 人局只有末游交公粮给头游）
    const penalty = new Array(n).fill(0);
    const p3 = R.penalty3rd || 0;
    const pL = R.penaltyLast || 0;
    penalty[fullOrder[0]] += pL;        // 末游 → 头游
    penalty[fullOrder[n - 1]] -= pL;    // 末游交
    if (n >= 4) {
      penalty[fullOrder[1]] += p3;        // 倒数第二 → 二游
      penalty[fullOrder[n - 2]] -= p3;    // 倒数第二交
    }

    // 末游手里剩的分牌（5/10/K）按倍数结算：双倍扣末游、给头游（lastLeftoverMult=0 关）
    const lastSeat = fullOrder[n - 1];
    const lastLeftover = handScore(this.hands[lastSeat], R);
    const loMult = R.lastLeftoverMult !== undefined ? R.lastLeftoverMult : 2;
    const loBonus = lastLeftover * (loMult || 0);
    if (loBonus > 0) {
      penalty[lastSeat] -= loBonus;
      penalty[fullOrder[0]] += loBonus;
    }

    const finalScore = new Array(n).fill(0);
    for (let s = 0; s < n; s++) finalScore[s] = this.pot[s] + penalty[s];

    // 最终名次：交完公粮后【按总分】从高到低（同分按跑牌顺序靠前）
    const scoreRank = fullOrder.slice().sort((a, b) =>
      (finalScore[b] - finalScore[a]) || (pos[a] - pos[b]));

    // 赢家：头游总分达到门槛（winThreshold，0=不限）即算赢方，与别人分多高无关
    const head = fullOrder[0];
    const thr = R.winThreshold || 0;
    const headPassed = thr === 0 || finalScore[head] >= thr;

    return {
      mode: 'individual',
      order: fullOrder,          // 跑牌顺序（头游→…→末游）
      pos,
      scoreRank,                 // 最终名次（按总分）
      winner: headPassed ? head : scoreRank[0],
      winThreshold: thr,
      headPassed,
      lastLeftover,              // 末游手里剩的分牌分值
      lastLeftoverMult: loMult,
      penalty: penalty.slice(),
      penalty3rd: p3,
      penaltyLast: pL,
      perSeatPot: this.pot.slice(),
      finalScore: finalScore.slice(),
      handsLeft: (() => { const a = []; for (let s = 0; s < n; s++) a.push(this.hands[s].length); return a; })(),
    };
  }

  /** 团队制结算（对家配合）：保留旧逻辑 */
  _settleTeam(fullOrder, pos, R) {
    let winTeam = null;
    for (const t of [0, 1]) {
      if (this.finished[t] && this.finished[t + 2]) { winTeam = t; break; }
    }
    if (winTeam === null) winTeam = pos[0] <= pos[2] ? 0 : 1;
    const loseTeam = 1 - winTeam;

    const teamPot = [0, 0];
    for (let s = 0; s < 4; s++) teamPot[this.teamOf(s)] += this.pot[s];

    const winSeats = [winTeam, winTeam + 2];
    const loseSeats = [loseTeam, loseTeam + 2];
    const w1 = Math.min(pos[winSeats[0]], pos[winSeats[1]]);
    const w2 = Math.max(pos[winSeats[0]], pos[winSeats[1]]);
    let catchType = 'none';
    if (w1 === 1 && w2 === 2) catchType = 'double';
    else if (w1 === 1 && w2 === 3) catchType = 'single';
    else catchType = 'draw';

    let penalty = 0;
    if (catchType === 'double') penalty = R.doubleCatchPenalty;
    else if (catchType === 'single') penalty = R.singleCatchPenalty;

    let leftover = 0;
    const leftoverDetail = {};
    for (const s of loseSeats) {
      if (!this.finished[s]) {
        const v = handScore(this.hands[s], R);
        leftoverDetail[s] = v;
        leftover += v;
      }
    }

    const finalScore = teamPot.slice();
    if (penalty) { finalScore[winTeam] += penalty; finalScore[loseTeam] -= penalty; }
    if (R.leftoverToWinner && leftover) { finalScore[winTeam] += leftover; finalScore[loseTeam] -= leftover; }

    return {
      mode: 'team',
      winTeam,
      order: fullOrder,
      pos,
      catchType,
      penalty,
      leftover,
      leftoverDetail,
      teamPot,
      finalScore,
      perSeatPot: this.pot.slice(),
      handsLeft: [0, 1, 2, 3].map((s) => this.hands[s].length),
    };
  }

  /* ---------------- 快照（联机同步用） ---------------- */

  snapshot(forSeat = -1) {
    const n = this.rules.seatCount;
    return {
      seed: this.seed,
      phase: this.phase,
      turn: this.turn,
      roundNo: this.roundNo,
      seatCount: n,
      counts: (() => { const a = []; for (let s = 0; s < n; s++) a.push(this.hands[s].length); return a; })(),
      pot: this.pot.slice(),
      tableScore: this.tableScore,
      lastPlay: this.lastPlay ? {
        seat: this.lastPlay.seat,
        type: this.lastPlay.combo.type,
        cards: this.lastPlay.combo.cards.map((c) => ({ r: c.r, s: c.s })),
        label: this.lastPlay.combo.label,
      } : null,
      finishOrder: this.finishOrder.slice(),
      result: this.result,
      hand: forSeat >= 0 ? sortCards(this.hands[forSeat]) : undefined,
      actions: this.actions.length,
    };
  }
}

/* 注入 combo 模块，避免循环依赖 */
import * as ComboApi from './combo.js';
Game.prototype._comboApi = ComboApi;

export { ComboApi };
