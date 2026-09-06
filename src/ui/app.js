/**
 * 主流程：单机 / 联机 / 规则设置
 *
 * 一条重要设计：不管单机还是联机，游戏进程都走同一个 loop() ——
 * 区别只在于"非本机座位的动作"是本地 AI 给的，还是网络传过来的。
 * 这样联机功能加上去的时候，单机逻辑一行都不用改。
 */
import { Game, PHASE } from '../core/engine.js';
import { decide } from '../core/ai.js';
import { detect, findBeats, isBombFamily, canBeat, freeCombo } from '../core/combo.js';
import { cloneRules, PRESETS, CT, CT_NAME, RANK } from '../core/rules.js';
import { sortCards, handScore, makeRng, randomSeed, cardLabel } from '../core/cards.js';
import { cardEl, renderCards, renderPass, clear, comboText } from './render.js';
import { play, unlock, isEnabled, toggle as toggleSound } from './sound.js';
import { LocalTransport } from '../net/local.js';
import { MqttTransport, MQTT_BROKERS } from '../net/mqtt.js';
import { WsTransport } from '../net/ws.js';

/* ==================== 全局状态 ==================== */

const UI = {
  screen: 'home',
  mode: 'solo',            // solo | online
  game: null,
  mySeat: 0,
  rules: cloneRules('henan'),
  selected: new Set(),
  hintSeq: [],
  hintIdx: 0,
  total: [0, 0, 0, 0],     // 跨局累计：各家各自总分（个人制）
  roundNo: 1,
  busy: false,
  transport: null,
  myName: '玩家',
  trickPlays: {},          // 本圈各家出的牌 {seat: combo|'pass'}
  rng: makeRng(Date.now() & 0xffffffff),
  revealAll: false,
  speed: 1,                // AI 出牌速度倍数（测试或赶时间时调大）
  pendingSeatCount: 4,     // 首页选的人数（3/4/5）
  lastWinner: null,        // 上一局头游（第一名）：下一局由他先出；null=第一局掷骰子定
  lastResult: null,        // 上一局结算结果（连局时取头游）
};

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 座位称呼：随当前对局人数变化（座位 0 永远是"我"） */
function seatLabel(s) {
  const names = UI.game && UI.game.names;
  if (names && names[s] !== undefined) return names[s];
  const fallback = ['我', '下家', '二家', '上家', '旁家', '六家', '七家', '八家'];
  return fallback[s] || ('家' + s);
}

/* ==================== 屏幕切换 ==================== */

function showScreen(name) {
  UI.screen = name;
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  $(name).classList.add('active');
}

function toast(msg, ms = 1100) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ==================== 开一局 ==================== */

function newGame(seed) {
  UI.game = new Game({
    rules: UI.rules,
    seed: seed !== undefined ? seed : randomSeed(),
    names: UI.rules.seatCount === 4
      ? ['我', '下家', '二家', '上家']
      : undefined, // 其余人数交给引擎 defaultNames 自动生成
    firstLeader: UI.lastWinner, // 连局：上一局头游先出；null=首局按规则随机
  });
  UI.selected.clear();
  UI.hintSeq = [];
  UI.trickPlays = {};
  UI.busy = false;
  UI.game.roundNo = UI.roundNo;
  // 音效：发牌声由事件驱动（含联机回放），一圈打完收分给个"叮咚"
  UI.game.on((evt) => {
    if (evt.type === 'deal') play('deal');
    else if (evt.type === 'trick' && evt.score > 0) play('coin');
  });
  UI.game.deal();
  buildSeats();
  renderAll();

  // 首局（单机）：掷骰子定首发；连局：上局头游先出，直接开打
  if (UI.mode === 'solo' && UI.lastWinner === null) {
    showDice();
  } else {
    if (UI.lastWinner !== null && UI.lastWinner !== UI.mySeat) {
      toast(`${seatLabel(UI.lastWinner)} 上局头游，先出牌`, 1000);
    }
    loop();
  }
}

/** 第一局掷骰子定首发：随机动画，最终落在引擎已定的首发座位（seed 决定，确定性） */
function showDice() {
  const modal = $('modalDice');
  const seatEl = $('diceSeat');
  const tipEl = $('diceTip');
  $('btnRollDice').style.display = '';
  tipEl.textContent = '点骰子，指到谁谁先出牌';
  seatEl.textContent = '🎲';
  modal.classList.add('show');
}

function rollDice() {
  const btn = $('btnRollDice');
  btn.style.display = 'none';
  play('dice');
  const seatEl = $('diceSeat');
  const tipEl = $('diceTip');
  const n = UI.game.rules.seatCount;
  const final = UI.game.turn; // 引擎已按 seed 定好首发，动画只是演出来
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    seatEl.textContent = seatLabel(Math.floor(Math.random() * n));
    if (ticks > 14) {
      clearInterval(timer);
      seatEl.textContent = seatLabel(final);
      tipEl.textContent = `${seatLabel(final)} 先出牌！`;
      setTimeout(() => {
        $('modalDice').classList.remove('show');
        loop();
      }, 900);
    }
  }, 80);
}

/** 游戏主循环：谁该动，就让它动 */
async function loop() {
  if (!UI.game || UI.game.phase !== PHASE.PLAYING) return;
  const seat = UI.game.turn;

  if (seat === UI.mySeat) {
    // 轮到我：解锁操作区，等玩家点。
    // 统一走 syncActions：三个按钮的可用性 + 「不出」按 canPass（自由出/见张乎）真正置灰
    UI.busy = false;
    syncActions();
    $('hand').classList.remove('locked');
    if (UI.game.isFreeTurn(seat)) { toast('该你出牌', 800); play('turn'); }
    return;
  }

  // 轮到别人：锁操作，等 AI 或网络
  UI.busy = true;
  setActionsEnabled(false);
  $('hand').classList.add('locked');

  const isOnline = UI.mode === 'online' && UI.transport;
  if (isOnline) return; // 联机时等对方的消息推过来

  await delay((520 + Math.random() * 380) / UI.speed);
  if (!UI.game || UI.game.phase !== PHASE.PLAYING) return;
  if (UI.game.turn !== seat) return;

  const mv = decide(UI.game, seat, UI.rng);
  UI.game.applyAction(mv);
  afterAction(mv);
}

/** 每个动作之后的统一处理：播提示、刷新、推进 */
function afterAction(mv) {
  const g = UI.game;
  if (mv.type === 'play' && mv.combo) {
    UI.trickPlays[mv.seat] = mv.combo;
    const c = mv.combo;
    if (c.type === CT.PURE_510K) { toast(`${seatLabel(mv.seat)}：正五十K！`, 1200); play('bell'); }
    else if (c.type === CT.MIXED_510K) { toast(`${seatLabel(mv.seat)}：副五十K`, 900); play('bell'); }
    else if (c.type === CT.BOMB) { toast(`${seatLabel(mv.seat)}：${c.label}！`, 1200); play('bomb'); }
    else if (c.type === CT.JOKER_BOMB) { toast(`${seatLabel(mv.seat)}：王炸！`, 1200); play('joker'); }
    else play('play');
  } else {
    UI.trickPlays[mv.seat] = 'pass';
    play('pass');
  }

  // 一圈打完 → 清桌面
  if (!g.lastPlay) {
    UI.trickPlays = {};
  }

  renderAll();
  setTimeout(() => {
    if (!UI.game) return;
    if (UI.game.phase === PHASE.PLAYING) loop();
    else showResult();
  }, 260 / UI.speed);
}

/* ==================== 渲染 ==================== */

function renderAll() {
  const g = UI.game;
  if (!g) return;
  renderTop();
  renderSeats();
  renderCenter();
  renderHand();
  syncActions();
}

function renderTop() {
  const g = UI.game;
  $('tbRound').textContent = `第 ${UI.roundNo} 局`;
  // 个人制（各打各的）：顶栏逐家显示「累计分 + 本局已抓分」，没有任何我方/敌方概念
  $('scoreLine').textContent = UI.total
    .map((v, s) => `${seatLabel(s)} ${v + (g.pot[s] || 0)}`)
    .join(' · ');
  $('potChip').textContent = `桌面 ${g.tableScore} 分`;
  $('potChip').style.background = g.tableScore >= 20
    ? 'rgba(232,196,106,.35)' : 'rgba(232,196,106,.14)';
}

/** 按当前人数动态生成对手座位（圆桌定位，人数可变） */
function buildSeats() {
  const ring = $('seatRing');
  ring.innerHTML = '';
  const n = UI.game.rules.seatCount;
  const m = n - 1;                 // 对手数
  const R = 40;                    // 半径（占牌桌百分比）
  for (let s = 1; s < n; s++) {
    // 角度：对手沿【上半圆】分布——下家(s=1)在右上、二家(s=2)在正上方、上家(s=3)在左上。
    // 从 +90° 往 -90° 走，保证下家在右手边、上家在左手边；
    // 之前公式从 90° 起算往下，把对手全摆到了下半圆、压到"我"的牌区（已修正）。
    const ang = 90 - (s - 1 + 0.5) * (180 / m);
    const rad = (ang * Math.PI) / 180;
    const x = 50 + R * Math.sin(rad);
    const y = 50 - R * Math.cos(rad);

    const el = document.createElement('div');
    el.className = 'seat opp';
    el.id = `seat${s}`;
    el.style.left = x + '%';
    el.style.top = y + '%';
    el.style.transform = 'translate(-50%, -50%)';
    el.innerHTML = `
      <div class="avatar">${seatLabel(s).slice(0, 1)}</div>
      <div class="seat-info">
        <span class="seat-name">${seatLabel(s)}</span>
        <span class="seat-count"><b id="cnt${s}">0</b> 张</span>
      </div>
      <div class="seat-bubble" id="bubble${s}"></div>
      <div class="seat-played" id="played${s}"></div>`;
    ring.appendChild(el);
  }
}

function renderSeats() {
  const g = UI.game;
  const n = g.rules.seatCount;
  for (let s = 1; s < n; s++) {
    const cnt = $(`cnt${s}`);
    if (cnt) cnt.textContent = g.hands[s].length;
    const el = $(`seat${s}`);
    if (el) {
      el.classList.toggle('turn', g.turn === s && g.phase === PHASE.PLAYING);
      el.classList.toggle('done', g.finished[s]);
    }
    const bub = $(`bubble${s}`);
    if (bub) {
      const play = UI.trickPlays[s];
      if (play && play !== 'pass') {
        bub.textContent = comboText(play);
        bub.classList.add('show');
      } else if (play === 'pass') {
        bub.textContent = '不出';
        bub.classList.add('show');
      } else {
        bub.classList.remove('show');
      }
    }
    // 谁出的牌就摆在谁面前；被别人压过的那手淡化（当前最大的一手在中央大号显示）
    const spot = $(`played${s}`);
    if (spot) {
      const play = UI.trickPlays[s];
      const isTop = !!(g.lastPlay && g.lastPlay.seat === s);
      if (play && play !== 'pass') {
        renderCards(spot, play.cards, { mini: true, beaten: !isTop });
      } else if (play === 'pass') {
        renderPass(spot, '不出');
      } else {
        clear(spot);
      }
    }
  }
  $('cnt0').textContent = g.hands[0].length;
  $('myPot').textContent = `抓到 ${g.pot[0]} 分`;
  $('myTeamName').textContent = '各管各的';
}

function renderCenter() {
  const g = UI.game;
  const main = $('playedMain');
  const owner = $('playedOwner');
  const mineSlot = $('playedMine');

  // 中央永远摆"本圈当前最大的一手牌"（不管是谁出的），用大号牌 → 3~8 张都完整显示不被裁
  if (g.phase === PHASE.PLAYING && g.lastPlay) {
    renderCards(main, g.lastPlay.combo.cards);
    owner.textContent = `${seatLabel(g.lastPlay.seat)} · ${g.lastPlay.combo.label}`;
    owner.classList.add('show');
  } else {
    clear(main);
    owner.classList.remove('show');
    owner.textContent = '';
  }

  // 我出的牌：若我是当前最大，已在中央显示；被别人压过后 → 落到我面前淡化显示
  const mine = UI.trickPlays[UI.mySeat];
  const iAmTop = !!(g.lastPlay && g.lastPlay.seat === UI.mySeat);
  if (mine && mine !== 'pass' && !iAmTop) {
    renderCards(mineSlot, mine.cards, { mini: true, beaten: true });
  } else if (mine === 'pass') {
    renderPass(mineSlot, '不出');
  } else {
    clear(mineSlot);
  }

  // 提示文字
  const tip = $('centerTip');
  if (g.phase === PHASE.PLAYING) {
    if (g.isFreeTurn(g.turn)) {
      tip.textContent = `${seatLabel(g.turn)} 自由出牌`;
    } else {
      const who = seatLabel(g.lastPlay.seat);
      tip.textContent = `${who} 出了 ${g.lastPlay.combo.label}，要压过它`;
    }
  } else {
    tip.textContent = '';
  }
}

function renderHand() {
  const g = UI.game;
  const box = $('hand');
  box.innerHTML = '';
  const hand = sortCards(g.hands[UI.mySeat]);
  const hintSet = new Set(UI.hintSeq[UI.hintIdx] ? UI.hintSeq[UI.hintIdx].cards.map((c) => c.uid) : []);

  for (const c of hand) {
    const el = cardEl(c);
    if (UI.selected.has(c.uid)) el.classList.add('sel');
    if (hintSet.has(c.uid) && !UI.selected.has(c.uid)) el.classList.add('hintable');
    el.dataset.uid = c.uid;
    el.addEventListener('click', () => toggleCard(c.uid));
    box.appendChild(el);
  }
}

function setActionsEnabled(on) {
  $('btnPlay').disabled = !on;
  $('btnPass').disabled = !on;
  $('btnHint').disabled = !on;
}

function syncActions() {
  if (UI.busy) { setActionsEnabled(false); return; }
  const g = UI.game;
  if (!g || g.phase !== PHASE.PLAYING || g.turn !== UI.mySeat) { setActionsEnabled(false); return; }
  setActionsEnabled(true);
  // 自由出牌 或 见张乎能压必须出 → 禁用"不出"
  $('btnPass').disabled = !g.canPass(UI.mySeat);
  // 出牌按钮跟着选牌状态走（没选牌/压不过 → 置灰）
  updatePlayBtn();
}

/* ==================== 交互 ==================== */

function toggleCard(uid) {
  if (UI.busy || UI.game.turn !== UI.mySeat) return;
  if (UI.selected.has(uid)) UI.selected.delete(uid);
  else UI.selected.add(uid);
  UI.hintSeq = [];
  UI.hintIdx = 0;
  play('tick');
  renderHand();
  updatePlayBtn();
}

function updatePlayBtn() {
  const g = UI.game;
  // 轮不到我 / 忙碌中：出牌按钮一律禁用（防 syncActions 解锁后被误开）
  if (UI.busy || !g || g.phase !== PHASE.PLAYING || g.turn !== UI.mySeat) {
    $('btnPlay').disabled = true;
    return;
  }
  const cards = [...UI.selected].map((u) => g.hands[UI.mySeat].find((c) => c.uid === u)).filter(Boolean);
  if (cards.length === 0) { $('btnPlay').disabled = true; return; }
  // 自由出牌：想怎么打怎么打 —— 非空选牌就能出（凑不成牌型就当"自由出"杂牌）
  if (g.isFreeTurn(UI.mySeat)) { $('btnPlay').disabled = false; return; }
  const combo = detect(cards, g.rules);
  if (!combo) { $('btnPlay').disabled = true; return; }
  if (g.lastPlay && !g.isFreeTurn(UI.mySeat)) {
    $('btnPlay').disabled = !canBeat(combo, g.lastPlay.combo, g.rules);
    return;
  }
  $('btnPlay').disabled = false;
}

/** 人类出牌 */
function humanPlay() {
  const g = UI.game;
  if (UI.busy || g.turn !== UI.mySeat) return;
  const uids = [...UI.selected];
  if (uids.length === 0) { toast('先选牌'); return; }
  const mv = { type: 'play', seat: UI.mySeat, uids };
  const cards = uids.map((u) => g.hands[UI.mySeat].find((c) => c.uid === u)).filter(Boolean);
  // 领出：凑不成牌型也放行（引擎按"自由出"杂牌处理）；跟牌必须成合法牌型
  const combo = detect(cards, g.rules) || (g.isFreeTurn(UI.mySeat) ? freeCombo(cards) : null);
  if (!combo) { toast('这牌不成牌型'); return; }
  mv.combo = combo;

  // 联机：广播动作，等回执（本地也同步执行，靠确定性保证一致）
  if (UI.mode === 'online' && UI.transport) UI.transport.send({ t: 'act', action: { type: 'play', seat: UI.mySeat, uids } });

  const ok = g.applyAction(mv);
  if (!ok) { toast('压不过，换一手'); return; }
  UI.selected.clear();
  UI.hintSeq = [];
  afterAction(mv);
}

function humanPass() {
  const g = UI.game;
  if (UI.busy || g.turn !== UI.mySeat) return;
  if (g.isFreeTurn(UI.mySeat)) { toast('你先出，不能不出'); return; }
  if (g.rules.mustBeat && g.legalMoves(UI.mySeat).length > 0) { toast('见张乎：能压必须出，不能不出'); return; }
  if (UI.mode === 'online' && UI.transport) {
    UI.transport.send({ t: 'act', action: { type: 'pass', seat: UI.mySeat } });
  }
  const ok = g.applyAction({ type: 'pass', seat: UI.mySeat });
  if (ok) afterAction({ type: 'pass', seat: UI.mySeat });
}

/** 提示：轮着给出能压的牌 */
function humanHint() {
  const g = UI.game;
  if (UI.busy || g.turn !== UI.mySeat) return;
  if (UI.hintSeq.length === 0) {
    const target = g.isFreeTurn(UI.mySeat) ? null : g.lastPlay.combo;
    if (!target) {
      // 自由出牌：给个最小单张当起手建议
      const hand = sortCards(g.hands[UI.mySeat]);
      const min = hand[hand.length - 1];
      UI.hintSeq = [detect([min], g.rules)].filter(Boolean);
    } else {
      UI.hintSeq = findBeats(g.hands[UI.mySeat], target, g.rules, {});
    }
    UI.hintIdx = 0;
    if (UI.hintSeq.length === 0) { toast('没有能压的牌'); return; }
  } else {
    UI.hintIdx = (UI.hintIdx + 1) % UI.hintSeq.length;
  }
  const pick = UI.hintSeq[UI.hintIdx];
  UI.selected = new Set(pick.cards.map((c) => c.uid));
  toast(`${pick.label}（再点提示换一种）`, 1000);
  renderHand();
  updatePlayBtn();
}

/* ==================== 结算 ==================== */

function showResult() {
  const g = UI.game;
  const r = g.result;
  if (!r) return;

  if (r.mode === 'team') return showResultTeam(g, r);

  /* ---- 个人制（各管各的 + 交公粮 + 末游留分翻倍）---- */
  // 累计到总分
  for (let s = 0; s < r.finalScore.length; s++) UI.total[s] += r.finalScore[s];
  UI.lastResult = r;

  const iAmWin = r.winner === UI.mySeat;
  play(iAmWin ? 'win' : 'lose');
  $('resTitle').textContent = iAmWin ? '🎉 这局你赢了（头游过线）' : `这局赢家：${seatLabel(r.winner)}`;

  let html = '';
  const myPenalty = r.penalty[UI.mySeat];
  if (myPenalty > 0) html += `你<b>收公粮</b> <b>+${myPenalty}</b> 分`;
  else if (myPenalty < 0) html += `你交公粮 <b>${myPenalty}</b> 分`;
  else html += '本局你不交不收公粮';
  const n = r.finalScore.length;
  html += `<br><span style="font-size:12px;color:#8fb3a3">第1名收末游的 ${r.penaltyLast} 分`
    + (n >= 4 ? `，第2名收倒数第二的 ${r.penalty3rd} 分` : `（${n} 人局只末游交公粮）`)
    + `；末游手里剩的分 ${r.lastLeftover} 分 ×${r.lastLeftoverMult} 计（扣末游、给头游）</span>`;
  if (r.winThreshold > 0) {
    html += `<br><span style="font-size:12px;color:#8fb3a3">头游总分 ${r.finalScore[r.order[0]]} 分`
      + `（门槛 ${r.winThreshold} 分${r.headPassed ? '，已过线 ✓' : ''}）→ 头游即赢方，其余按总分依次排</span>`;
  }
  $('resCatch').innerHTML = html;

  // 按【交完公粮后的总分】排名（同分按跑牌顺序靠前）
  const rows = [];
  rows.push('<tr><th>名次</th><th>跑牌</th><th>谁</th><th>抓分</th><th>公粮</th><th>总分</th><th>剩牌</th></tr>');
  r.scoreRank.forEach((s, i) => {
    const who = s === UI.mySeat ? '我' : seatLabel(s);
    const isWinner = s === r.winner;
    const cls = isWinner ? 'win' : 'lose';
    rows.push(`<tr class="${cls}">
      <td>${isWinner ? '🏆 ' : ''}${i + 1}</td>
      <td class="num">${r.pos[s]}</td>
      <td>${who}</td>
      <td class="num">${r.perSeatPot[s]}</td>
      <td class="num">${r.penalty[s] >= 0 ? '+' : ''}${r.penalty[s]}</td>
      <td class="num"><b>${r.finalScore[s]}</b></td>
      <td class="num">${r.handsLeft[s]}</td></tr>`);
  });
  const runStr = r.order.map((s) => seatLabel(s)).join('→');
  const totalStr = UI.total.map((v, i) => `${seatLabel(i)}:${v}`).join('  ');
  rows.push(`<tr><td colspan="7" style="text-align:right;border:0;color:#8fb3a3;font-size:11px">
    跑牌顺序 ${runStr}（下局头游先出）｜累计总分 <b style="color:#e8c46a">${totalStr}</b></td></tr>`);
  $('resTable').innerHTML = rows.join('');
  $('modalResult').classList.add('show');
}

function showResultTeam(g, r) {
  for (let t = 0; t < 2; t++) UI.total[t] += r.finalScore[t];
  const catchName = { double: '双 抓', single: '单 抓', draw: '保 牌' }[r.catchType] || '';
  const winTeam = r.winTeam;
  const iAmWin = winTeam === (UI.mySeat % 2);
  play(iAmWin ? 'win' : 'lose');
  $('resTitle').textContent = iAmWin ? '🎉 这局你赢了' : '这局没打过';
  let html = `${iAmWin ? '你这边' : '对面'} <b>${catchName}</b><br>`;
  html += `<span style="font-size:12px;color:#8fb3a3">抓分 ${r.teamPot[0]} : ${r.teamPot[1]}`;
  if (r.penalty) html += ` ｜ 罚分 ${r.penalty}`;
  if (r.leftover) html += ` ｜ 烂分 ${r.leftover}`;
  html += '</span>';
  $('resCatch').innerHTML = html;
  const rows = [];
  rows.push('<tr><th>名次</th><th>谁</th><th>抓分</th><th>剩牌</th></tr>');
  r.order.forEach((s, i) => {
    const who = s === UI.mySeat ? '我' : seatLabel(s);
    rows.push(`<tr class="${r.pos[s] <= 2 && (s % 2) === winTeam ? 'win' : ''}">
      <td>${r.pos[s]}</td><td>${who}</td>
      <td class="num">${g.pot[s]}</td>
      <td class="num">${r.handsLeft[s]}</td></tr>`);
  });
  rows.push(`<tr><td colspan="4" style="text-align:right;border:0;color:#8fb3a3;font-size:11px">
    本局比分 <b style="color:#e8c46a">${r.finalScore[0]} : ${r.finalScore[1]}</b>
    ｜ 总比分 <b style="color:#e8c46a">${UI.total[0]} : ${UI.total[1]}</b></td></tr>`);
  $('resTable').innerHTML = rows.join('');
  $('modalResult').classList.add('show');
}

/* ==================== 规则设置 ==================== */

const RULE_FIELDS = [
  { k: 'mode', label: '玩法阵营', type: 'mode' },
  { k: 'mustBeat', label: '见张乎（能压必须出）', type: 'bool' },
  { k: 'allowStraight', label: '允许顺子', type: 'bool' },
  { k: 'straightMinLen', label: '顺子最少张数', type: 'num', min: 3, max: 8 },
  { k: 'allowDoubleStraight', label: '允许连对', type: 'bool' },
  { k: 'allowTrioStraight', label: '允许三顺（飞机）', type: 'bool' },
  { k: 'allowTrioKick', label: '允许三带一/二', type: 'bool' },
  { k: 'allowMixed510K', label: '副五十K（混花色）算炮', type: 'bool' },
  { k: 'pure510KSuitOrder', label: '正五十K 分花色（黑>红>梅>方）', type: 'bool' },
  { k: 'bombMinCount', label: '几张同点算炸弹', type: 'num', min: 3, max: 6 },
  { k: 'bombSameColor', label: '4张炸须同色（全红/全黑）', type: 'bool' },
  { k: 'trioIsBomb', label: '三同张也算炮', type: 'bool' },
  { k: 'jokerBombEnabled', label: '多张王算炸弹', type: 'bool' },
  { k: 'penalty3rd', label: '第3名(三游)交公粮', type: 'num', min: 0, max: 200, step: 5 },
  { k: 'penaltyLast', label: '第4名(末游)交公粮', type: 'num', min: 0, max: 200, step: 5 },
  { k: 'lastLeftoverMult', label: '末游留分加倍倍数（0=关）', type: 'num', min: 0, max: 5 },
  { k: 'winThreshold', label: '头游多少分算赢（0=不限）', type: 'num', min: 0, max: 200, step: 10 },
  { k: 'jiefeng', label: '接风（走光后下手接）', type: 'bool' },
];

function buildRulesPanel() {
  const sel = $('selPreset');
  sel.innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  sel.onchange = () => {
    UI.rules = cloneRules(sel.value);
    fillRulesGrid();
  };
  fillRulesGrid();

  $('rulesHelp').innerHTML = `
    <b>郑州玩法：各管各的（不打对家）</b><br>
    1. <b>见张乎</b>：跟牌时手里只要还有<b>能压过去的牌（含炮）</b>，就必须出，不能过牌；<br>
    2. 每张 <b>5 = 5 分</b>、<b>10 = 10 分</b>、<b>K = 10 分</b>，两副牌全场 200 分；一圈牌谁最后压住，桌面上的分就归谁（记在自己名下）；<br>
    3. 除末游外全出完即结束，剩下那位就是<b>末游</b>；<br>
    4. <b>交公粮</b>：第 1、2 名为赢家，末游（最后一名）交 ${UI.rules.penaltyLast || 30} 分 → 给第 1 名；
    ${UI.rules.seatCount >= 4 ? `倒数第二交 ${UI.rules.penalty3rd || 10} 分 → 给第 2 名；` : '（3 人局只有末游交）'}<br>
    5. 最终每家总分 = 自己抓到的分 + 公粮（正为收、负为交）。<br>
    6. <b>牌型只有</b>：单 / 对 / 三张 / 五十K / 炸，<b>没有顺子、连对、三顺、飞机，也不能三带一/三带二（不能带牌）</b>，大小纯靠"大压小"。<br>
    7. <b>炸弹只有 4 张</b>：4 张同点必须<b>全红（♥♦）或全黑（♠♣）</b>才算炸，混色不算、5张及更多也不算，只能当散牌正常出（四王除外）。<b>黑炸 &gt; 红炸</b>（同点数互比时黑占先）。<br>
    8. <b>接风</b>：我的大 → <b>我继续出</b>；只有我把牌全部走光、最后一手没人压时，才轮到<b>下手接风</b>。<br>
    9. <b>自由出牌</b>：领出时<b>想怎么打怎么打</b> —— 5张、6张杂牌也能一手甩出（凑不成牌型就当"自由出"）；
    杂牌<b>只能被炮压</b>（五十K/炸/四王），别人跟不出杂牌；<b>见张乎照样管用</b>：手里有炮能压就必须出。<br>
    10. <b>发牌权</b>：第一局<b>掷骰子</b>随机定首发；之后每局由<b>上一局头游</b>先出牌。<br>
    11. <b>算输赢</b>：交完公粮后<b>按总分排名</b>；头游总分达到门槛（默认 40，可在规矩里改）即算<b>赢方</b>；
    末游手里剩的分牌（5/10/K）<b>按 ${UI.rules.lastLeftoverMult || 2} 倍</b>扣末游、给头游。<br>
    <b>炮的大小（从大到小）：</b><b>四王</b> &gt; <b>4张炸</b>（黑炸&gt;红炸，同色比点数：2&gt;A&gt;K…）
    &gt; <b>正五十K</b>（黑♠&gt;红♥&gt;方♦&gt;梅♣） &gt; 副五十K。
    <b>双大王 / 双小王只是普通对子，压不过五十K。</b>
  `;
}

function fillRulesGrid() {
  const grid = $('rulesGrid');
  grid.innerHTML = '';
  for (const f of RULE_FIELDS) {
    const row = document.createElement('div');
    row.className = 'rule-row';
    const span = document.createElement('span');
    span.textContent = f.label;
    row.appendChild(span);

    let input;
    if (f.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!UI.rules[f.k];
      input.onchange = () => { UI.rules[f.k] = input.checked; };
    } else if (f.type === 'mode') {
      input = document.createElement('select');
      input.innerHTML = '<option value="individual">各管各的（个人·郑州）</option>';
      input.value = UI.rules[f.k] || 'individual';
      input.onchange = () => { UI.rules[f.k] = input.value; };
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.value = UI.rules[f.k];
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.step) input.step = f.step;
      input.onchange = () => { UI.rules[f.k] = Number(input.value); };
    }
    row.appendChild(input);
    grid.appendChild(row);
  }
}

/* ==================== 联机 ==================== */

function buildLobby() {
  const tips = $('lobbyTip');
  tips.innerHTML = `默认走<b>免费公共信道</b>（不用你掏一分钱、也不用你买服务器）。<br>
    4 个人到齐<b>自动开局</b>，不用谁点开始；房主也能在 3 人时手动开。<br>
    连不上就点下面的「备用信道」换一个。`;
  // 深链进房：朋友打开带 ?room= 的邀请链接，自动填好房间号
  const r = new URLSearchParams(location.search).get('room');
  if (r) {
    $('inpRoom').value = r;
    $('joinBlock').style.display = 'block';
    $('lobbyTip').textContent = '已为你填好房间号，输个名字点「进去」就能加入';
  }
}

async function createRoom() {
  const name = ($('inpName').value || '玩家').trim();
  UI.myName = name;
  const room = String(Math.floor(100000 + Math.random() * 900000));
  await setupTransport(room, name, true);
}

async function joinRoom() {
  const name = ($('inpName').value || '玩家').trim();
  const room = ($('inpRoom').value || '').trim();
  if (!room) { toast('填房间号'); return; }
  UI.myName = name;
  await setupTransport(room, name, false);
}

async function setupTransport(room, name, isHost) {
  let t;
  const useWs = new URLSearchParams(location.search).get('server');
  if (useWs) {
    t = new WsTransport(useWs);
  } else {
    t = new MqttTransport(0, { minPlayers: 4 });
  }
  UI.transport = t;
  UI.mode = 'online';
  UI._autoStarted = false;   // 新房间重置"已自动开局"标记

  t.on('status', (s, info) => {
    $('lobbyTip').textContent = s + (info ? ' — ' + info : '');
  });
  t.on('peers', (peers) => {
    renderSeatList(peers, room);
    // 3 人即可手动开（防第4人迟迟不来）；4 人齐会自动开
    $('btnStartOnline').disabled = !(t.isHost && peers.length >= 3);
  });
  // 人齐自动开局：房主收到"4 人齐"信号后自动发牌，朋友不用等谁点开始
  t.on('full', () => {
    if (!t.isHost || UI._autoStarted) return;
    UI._autoStarted = true;
    $('lobbyTip').textContent = '4 人已到齐，自动开局！';
    setTimeout(() => {
      if (UI.mode === 'online' && UI.screen !== 'table') autoStartOnlineGame();
    }, 500); // 稍等，确保最后一位也收到座位广播
  });
  t.on('message', onNetMessage);
  t.on('error', (e) => {
    $('lobbyTip').textContent = '连接出问题了：' + e + '（可以换个信道重试）';
  });

  try {
    await t.connect(room, name, isHost);
  } catch (e) {
    $('lobbyTip').textContent = '连不上：' + e.message;
    return;
  }
  $('roomBox').style.display = 'block';
  $('roomNo').textContent = room;
  // 一键邀请：复制带房间号的链接，朋友打开即自动填好房间
  $('btnCopyInvite').onclick = () => {
    const url = location.origin + location.pathname + '?room=' + room;
    navigator.clipboard?.writeText(url);
    toast('邀请链接已复制，发给朋友即可加入');
  };
}

function renderSeatList(peers, room) {
  const box = $('seatList');
  const seats = ['南家（我）', '东家', '北家', '西家'];
  box.innerHTML = seats.map((s, i) => {
    const p = peers[i];
    const on = !!p;
    return `<div class="seat-chip ${on ? 'on' : ''} ${i === 0 ? 'me' : ''}">${s}：${on ? escapeHtml(p.name) : '空位'}</div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 收到网络消息 */
function onNetMessage(msg, fromId) {
  const t = UI.transport;
  switch (msg.t) {
    case 'start': {
      // 房主开局：按约定的 seed 和规则发牌
      UI.rules = msg.rules || UI.rules;
      UI.mySeat = msg.mySeat !== undefined ? msg.mySeat : t.seatIndex;
      UI.roundNo = 1;
      showScreen('table');
      newGame(msg.seed);
      break;
    }
    case 'act': {
      // 其他人的动作：本地重放一遍（引擎是确定性的，结果一定一致）
      if (!UI.game) break;
      const a = msg.action;
      if (a.seat === UI.mySeat) break; // 自己的动作已经执行过
      const cards = (a.uids || []).map((u) => UI.game.hands[a.seat].find((c) => c.uid === u)).filter(Boolean);
      const combo = a.type !== 'play' ? null
        : (detect(cards, UI.game.rules)
          || (UI.game.isFreeTurn(a.seat) ? freeCombo(cards) : null));
      const mv = { ...a, combo };
      UI.game.applyAction(mv);
      afterAction(mv);
      break;
    }
    case 'roundEnd': {
      UI.roundNo = (msg.roundNo || UI.roundNo) + 1;
      newGame(msg.seed);
      break;
    }
    default: break;
  }
}

function autoStartOnlineGame() {
  const t = UI.transport;
  if (!t || !t.isHost) return;
  const seed = randomSeed();
  UI.rules.seatCount = 4; // 联机固定 4 人
  UI.total = [0, 0, 0, 0];
  t.broadcastSeats(seed, UI.rules);
  UI.mySeat = 0;
  UI.roundNo = 1;
  showScreen('table');
  newGame(seed);
}

function startOnlineGame() { autoStartOnlineGame(); }

/* ==================== 绑定 ==================== */

function bind() {
  $('btnSolo').onclick = () => {
    UI.mode = 'solo';
    UI.mySeat = 0;
    UI.rules.seatCount = UI.pendingSeatCount || 4;
    UI.total = new Array(UI.rules.seatCount).fill(0);
    UI.roundNo = 1;
    UI.lastWinner = null;   // 新一场：首局掷骰子定首发
    UI.lastResult = null;
    showScreen('table');
    newGame();
  };

  $('btnRollDice').onclick = rollDice;

  // 音效开关（顶栏按钮 + 菜单项，两处同步，状态记在 localStorage）
  const syncSoundBtns = () => {
    const on = isEnabled();
    $('btnSound').textContent = on ? '🔊 音效' : '🔇 静音';
    $('mSound').textContent = on ? '🔊 音效：开' : '🔇 音效：关';
  };
  const flipSound = () => {
    const on = toggleSound();
    syncSoundBtns();
    if (on) play('tick');
    toast(on ? '音效已开' : '音效已关', 700);
  };
  $('btnSound').onclick = flipSound;
  $('mSound').onclick = () => { $('modalMenu').classList.remove('show'); flipSound(); };
  syncSoundBtns();

  // 浏览器要求：音频必须在用户手势后才能启动 —— 任意点击都试着解锁一下
  document.addEventListener('click', unlock, true);

  // 首页人数选择（3/4/5 人）
  document.querySelectorAll('.sc-btn').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.sc-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      UI.pendingSeatCount = Number(b.dataset.n) || 4;
    };
  });

  $('btnOnline').onclick = () => { showScreen('lobby'); buildLobby(); };
  $('btnBackHome').onclick = () => {
    if (UI.transport) { UI.transport.close(); UI.transport = null; }
    showScreen('home');
  };
  $('btnJoin').onclick = () => { $('joinBlock').style.display = 'block'; };
  $('btnJoinGo').onclick = joinRoom;
  $('btnCreate').onclick = createRoom;
  $('btnStartOnline').onclick = startOnlineGame;
  $('btnCopyRoom').onclick = () => {
    const txt = $('roomNo').textContent;
    navigator.clipboard?.writeText(txt);
    toast('房间号已复制：' + txt);
  };

  $('btnPlay').onclick = humanPlay;
  $('btnPass').onclick = humanPass;
  $('btnHint').onclick = humanHint;

  $('btnNextRound').onclick = () => {
    $('modalResult').classList.remove('show');
    UI.roundNo++;
    // 规矩：下一局由上一局头游（第一名）先出牌
    UI.lastWinner = UI.lastResult ? UI.lastResult.order[0] : null;
    if (UI.mode === 'online' && UI.transport && UI.transport.isHost) {
      const seed = randomSeed();
      UI.transport.send({ t: 'roundEnd', seed, roundNo: UI.roundNo });
      newGame(seed);
    } else {
      newGame();
    }
  };
  $('btnBackMenu').onclick = () => {
    $('modalResult').classList.remove('show');
    if (UI.transport) { UI.transport.close(); UI.transport = null; }
    showScreen('home');
  };

  $('btnRules').onclick = (e) => { e.preventDefault(); $('modalRules').classList.add('show'); };
  $('btnRules2').onclick = () => $('modalRules').classList.add('show');
  $('btnRulesClose').onclick = () => $('modalRules').classList.remove('show');
  $('btnRulesSave').onclick = () => {
    $('modalRules').classList.remove('show');
    if (UI.game) { UI.roundNo = 1; UI.total = new Array(UI.rules.seatCount).fill(0); newGame(); toast('规矩已改，重开一局'); }
  };

  $('btnMenu').onclick = () => $('modalMenu').classList.add('show');
  $('mRules').onclick = () => { $('modalMenu').classList.remove('show'); $('modalRules').classList.add('show'); };
  $('mRestart').onclick = () => { $('modalMenu').classList.remove('show'); newGame(); };
  $('mHome').onclick = () => {
    $('modalMenu').classList.remove('show');
    if (UI.transport) { UI.transport.close(); UI.transport = null; }
    showScreen('home');
  };
  $('mShowCards').onclick = () => {
    $('modalMenu').classList.remove('show');
    const g = UI.game;
    if (!g) return;
    const n = g.rules.seatCount;
    const all = [];
    for (let s = 0; s < n; s++) all.push(`${seatLabel(s)}：${g.hands[s].map(cardLabel).join(' ')}`);
    console.log(all.join('\n'));
    toast('已把各家牌打到控制台（F12）', 1800);
  };

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    if (UI.screen !== 'table') return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); humanPlay(); }
    else if (e.key === 'Escape') { UI.selected.clear(); renderHand(); }
    else if (e.key.toLowerCase() === 'p') humanPass();
    else if (e.key.toLowerCase() === 'h') humanHint();
  });

  // 点空白处关弹窗
  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
  }
}

/* ==================== 启动 ==================== */

buildRulesPanel();
bind();
showScreen('home');

// 便于调试 / 自动化测试：?fast=20 让 AI 快 20 倍，?server=ws://x 走自建服务器
const qs = new URLSearchParams(location.search);
if (qs.get('fast')) UI.speed = Math.max(1, Number(qs.get('fast')) || 10);
window.__wushik = UI;
// 调试 / 自动化测试钩子：可在控制台或脚本里 __wushik.renderAll() 强制重绘
UI.renderAll = renderAll;
UI.sound = { play, isEnabled, toggle: toggleSound };

// PWA：注册 Service Worker（仅 https / localhost / 127.0.0.1 有效）
// 作用：①手机"添加到主屏幕"后是全屏 App；②离线也能开（缓存静态资源）；③PWABuilder 打 APK 的前提
if ('serviceWorker' in navigator) {
  const h = location.hostname;
  if (location.protocol === 'https:' || h === 'localhost' || h === '127.0.0.1') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}
