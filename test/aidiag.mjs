/**
 * AI 行为诊断：统计出牌/跟牌/赢圈分布，用来调参
 * 跑法：node test/aidiag.mjs [局数]
 *
 * 健康指标：
 *   · 四个座位的赢圈次数应该大致均衡（各 25% 左右）
 *   · 每局圈数 20~45 之间比较像真人局
 *   · 不应该出现"某家一张牌都出不去"
 */
import { Game, PHASE } from '../src/core/engine.js';
import { decide } from '../src/core/ai.js';
import { cloneRules } from '../src/core/rules.js';
import { makeRng } from '../src/core/cards.js';

const N = Number(process.argv[2] || 100);
const rules = cloneRules('henan');

const stat = {
  tricks: 0, rounds: 0,
  playCount: [0, 0, 0, 0],
  passCount: [0, 0, 0, 0],
  winTrick: [0, 0, 0, 0],
  zeroPlaySeats: 0,
  bombs: 0, pure510k: 0, mixed510k: 0,
  finalScores: [],
  // 个人制：每个座位分别当过头游(第1) / 末游(第4) 多少次
  rankCount: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
  penaltySum: [0, 0, 0, 0],
};

for (let i = 0; i < N; i++) {
  const g = new Game({ rules, seed: i * 104729 + 11 });
  g.deal();
  const rng = makeRng(i + 77);
  let guard = 0;
  let lastWinner = -1;

  g.on((evt) => {
    if (evt.type === 'trick') { stat.tricks++; stat.winTrick[evt.seat]++; }
    if (evt.type === 'play') {
      stat.playCount[evt.seat]++;
      const t = evt.combo.type;
      if (t === 'BOMB' || t === 'JOKER_BOMB') stat.bombs++;
      if (t === 'PURE_510K') stat.pure510k++;
      if (t === 'MIXED_510K') stat.mixed510k++;
    }
  });

  while (g.phase === PHASE.PLAYING && ++guard < 3000) {
    const seat = g.turn;
    const mv = decide(g, seat, rng);
    if (mv.type === 'pass') stat.passCount[seat]++;
    g.applyAction(mv);
  }
  stat.rounds++;
  for (let s = 0; s < 4; s++) if (stat.playCount[s] === 0) stat.zeroPlaySeats++;
  stat.finalScores.push(g.result.finalScore.slice());
  for (let s = 0; s < 4; s++) stat.rankCount[s][g.result.pos[s] - 1]++;
  for (let s = 0; s < 4; s++) stat.penaltySum[s] += g.result.penalty[s];
}

const avgTricks = (stat.tricks / stat.rounds).toFixed(1);
const totalPlay = stat.playCount.reduce((a, b) => a + b, 0);
const totalPass = stat.passCount.reduce((a, b) => a + b, 0);
const totalWin = stat.winTrick.reduce((a, b) => a + b, 0);
const pct = (x, t) => ((x / t) * 100).toFixed(1) + '%';

console.log('\n════════ AI 行为诊断（' + N + ' 局）════════');
console.log(`每局平均圈数      ${avgTricks}`);
console.log(`平均出牌 / 不出   ${(totalPlay / N).toFixed(1)} / ${(totalPass / N).toFixed(1)}  （跟牌率 ${pct(totalPlay, totalPlay + totalPass)}）`);
console.log(`出牌次数分布      ${stat.playCount.map((c) => pct(c, totalPlay)).join('  ')}`);
console.log(`赢圈次数分布      ${stat.winTrick.map((c) => pct(c, totalWin)).join('  ')}`);
console.log(`一局中炮的用量    炸弹 ${(stat.bombs / N).toFixed(2)}  正五十K ${(stat.pure510k / N).toFixed(2)}  副五十K ${(stat.mixed510k / N).toFixed(2)}`);
console.log(`头游(第1)次数     ${stat.rankCount.map((r) => r[0]).join('  ')}`);
console.log(`末游(第4)次数     ${stat.rankCount.map((r) => r[3]).join('  ')}`);
console.log(`人均公粮(收+/-)   ${stat.penaltySum.map((p) => (p / N).toFixed(1)).join('  ')}`);
const avgDiff = stat.finalScores.reduce((a, s) => a + Math.abs(s[0] - s[1]) + Math.abs(s[2] - s[3]), 0) / N / 2;
console.log(`平均净胜分差      ${avgDiff.toFixed(1)}`);
console.log('══════════════════════════════════════════\n');
