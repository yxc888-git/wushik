/**
 * 五十K（五十凯 / 见张乎）—— 河南郑州及周辺玩法规则配置
 *
 * 设计原则：所有"各地不一样"的地方全部收敛到这里，引擎只读配置。
 * 想改成自己村里的规矩，只改这个文件的 PRESETS 即可，UI 上也能实时切换。
 */

export const RANK = {
  R3: 3, R4: 4, R5: 5, R6: 6, R7: 7, R8: 8, R9: 9, R10: 10,
  J: 11, Q: 12, K: 13, A: 14, R2: 15,
  JOKER_S: 16, // 小王
  JOKER_B: 17, // 大王
};

/**
 * 花色：数值越大越大。
 * 郑州分色顺序是「黑 > 红 > 片 > 梅」：黑桃(黑) > 红桃(红) > 方块(片) > 梅花(梅)。
 * 正五十K 之间就按这个顺序分大小。
 */
export const SUIT = { SPADE: 3, HEART: 2, DIAMOND: 1, CLUB: 0 };
export const SUIT_CHAR = { 3: '♠', 2: '♥', 1: '♦', 0: '♣' };
export const SUIT_NAME = { 3: '黑桃', 2: '红桃', 1: '方块', 0: '梅花' };

export const RANK_CHAR = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};

/** 分牌：5=5分，10=10分，K=10分（王是否算分见配置） */
export const SCORE_MAP = { 5: 5, 10: 10, 13: 10 };

/** 牌型类别 */
export const CT = {
  SINGLE: 'SINGLE',                 // 单张
  PAIR: 'PAIR',                     // 对子
  TRIO: 'TRIO',                     // 三同张（裸三张）
  TRIO_ONE: 'TRIO_ONE',             // 三带一
  TRIO_TWO: 'TRIO_TWO',             // 三带二
  STRAIGHT: 'STRAIGHT',             // 顺子（单龙）—— 郑州默认禁用
  DOUBLE_STRAIGHT: 'DOUBLE_STRAIGHT', // 连对（双龙）—— 郑州默认禁用
  TRIO_STRAIGHT: 'TRIO_STRAIGHT',   // 三顺/连三（飞机不带）—— 郑州默认禁用
  PLANE_ONE: 'PLANE_ONE',           // 飞机带单 —— 郑州默认禁用
  PLANE_TWO: 'PLANE_TWO',           // 飞机带对 —— 郑州默认禁用
  PURE_510K: 'PURE_510K',           // 正五十K（同花色）
  MIXED_510K: 'MIXED_510K',         // 副五十K（混花色）
  BOMB: 'BOMB',                     // N 张同点炸弹（N>=4）
  JOKER_BOMB: 'JOKER_BOMB',         // 四王组合（最大炮）
  FREE: 'FREE',                     // 自由出（领出时任意张数杂牌，不构成牌型就当自由出）
};

export const CT_NAME = {
  SINGLE: '单张', PAIR: '对子', TRIO: '三张', TRIO_ONE: '三带一', TRIO_TWO: '三带二',
  STRAIGHT: '顺子', DOUBLE_STRAIGHT: '连对', TRIO_STRAIGHT: '三顺',
  PLANE_ONE: '飞机带单', PLANE_TWO: '飞机带对',
  PURE_510K: '正五十K', MIXED_510K: '副五十K', BOMB: '炸弹', JOKER_BOMB: '王炸',
  FREE: '自由出',
};

/**
 * 炸弹体系大类权重（越大越大）。
 * 这是"跨牌型"比较的唯一依据，普通牌型之间只能同型同张数比。
 *
 * 郑州顺序（用户确认）：
 *   四王(4 个王)  >  4张炸（黑炸 > 红炸；同色比点数：2 > A > K …）  >  正五十K  >  副五十K
 *
 * 注意：炸弹【只有 4 张】这一种 —— 5张/6张/7张/8张同点都不算炸（bombMaxCount=4）。
 *
 * 注意：郑州【没有】"双大王大"这一说 —— 两张王只是普通对子，压不过正五十K；
 *   三张王也凑不成合法牌型。只有 4 张王（四王）才是最大的炮。
 */
export const BOMB_TIER = {
  JOKER4: 900,     // 四王：全场最大
  BOMB8: 800, BOMB7: 780, BOMB6: 770, BOMB5: 750, BOMB4: 740,
  PURE_510K: 710,
  MIXED_510K: 690,
  TRIO: 600,       // 三张炮（仅当 trioIsBomb=true 时生效）
};

/** 河南郑州默认规则（推荐） */
export const PRESET_HENAN = {
  id: 'henan',
  name: '河南郑州（默认）',
  deckCount: 2,            // 两副牌
  useJokers: true,         // 含大小王 → 108 张
  handSize: 27,            // 每人 27 张（108/4）
  seatCount: 4,
  // —— 牌型 ——
  // 郑州玩法：跑得快式，只认 单 / 对 / 三张 / 五十K / 炸，
  // 没有顺子、连对、三顺、飞机，也不能三带一/三带二（不能带牌）。
  // 想玩这些长牌型，在「规矩」里把下面开关打开即可（规则全在这里）。
  allowStraight: false,
  straightMinLen: 5,       // 顺子最少 5 张（开关打开时生效）
  allowDoubleStraight: false,
  doubleStraightMinPairs: 3, // 连对最少 3 对（开关打开时生效）
  allowTrioStraight: false,
  trioStraightMinGroups: 2,  // 三顺最少 2 组（开关打开时生效）
  allowTrioKick: false,      // 三带一 / 三带二（郑州规矩：不能带牌！想带牌才打开）
  allowPlaneKick: false,     // 飞机带牌（默认关）
  straightCanInclude2: false,  // 2 不进顺子/连对/三顺
  jokerInStraight: false,      // 王不进顺子
  // —— 五十K ——
  allowMixed510K: true,        // 副五十K（混花色）成立
  pure510KSuitOrder: true,     // 正五十K 之间按花色比大小（黑>红>片>梅）
  // —— 炸弹 ——
  bombMinCount: 4,             // 几张同点算炸弹
  bombMaxCount: 4,             // 郑州规矩：炸弹【只有 4 张】—— 5张/6张/7张/8张同点都不算炸！
  bombSameColor: true,         // 且 4 张必须同色：全红（♥♦）或全黑（♠♣）才算炸；
                               //   混色 4 张不算炸（当散牌正常出）。四王除外。
                               //   同点数黑炸 > 红炸；点数仍主导（红2炸压黑A炸）。
  trioIsBomb: false,           // 三同张是否算炮（郑州默认不算）
  jokerBombEnabled: true,      // 四王算最大的炮（双王不算炮，只是普通对子）
  bombBeats: {
    // 炸弹能压住哪些普通牌型（以及所需最小张数）。
    // 郑州默认无顺子/连对/三顺/飞机，所以只列单/对/三/三带；
    // 若打开对应开关，自行补上 STRAIGHT/DOUBLE_STRAIGHT/... 即可。
    SINGLE: 1, PAIR: 1, TRIO: 1, TRIO_ONE: 1, TRIO_TWO: 1,
    FREE: 1,           // 自由出（任意张数杂牌）：任何炮都能压（郑州规矩：杂牌只能被炮压）
  },
  // —— 计分 ——
  scoreMap: SCORE_MAP,
  jokerScore: 0,               // 王算几分（郑州默认 0，部分地方 10）
  totalScore: 200,             // 两副牌总分
  doubleCatchPenalty: 100,     // 双抓：负方罚 100 分给胜方（仅 team 模式用）
  singleCatchPenalty: 50,      // 单抓：负方罚 50 分（仅 team 模式用）
  leftoverToWinner: true,      // 负方手里没出掉的分归胜方（仅 team 模式用）
  firstDealBy: 'random',       // 首局谁先出：random（掷骰子随机定首发）/ heart3 / spade3 / heartA
  nextDealBy: 'winner',        // 之后谁先出：winner = 上一局头游（第一名）先出牌
  jiefeng: true,               // 接风（郑州规矩）：赢家把牌全部走光且最后一手没人压 →
                               //   出牌权顺延给下手（下家）接风；赢家没走完就赢家继续出
  reportThreshold: 0,          // 剩几张要报牌（0=不报）
  winTargetScore: 0,           // 打到多少分赢整场（0=不限，一局一结算）
  // —— 终局判定（用户规矩）——
  winThreshold: 40,            // 头游总分（抓分+公粮）达到这个数就算赢方（0=不限）
  lastLeftoverMult: 2,         // 末游手里剩的分牌（5/10/K）按几倍结算：双倍扣末游、给头游（0=关）
  // —— 玩法阵营 ——
  mode: 'individual',          // individual = 各管各的（郑州：不打对家）；team = 对家配合
  penalty3rd: 10,              // 个人制：倒数第二（第 3 名）交公粮 10 分
  penaltyLast: 30,             // 个人制：倒数第一（第 4 名 / 末游）交公粮 30 分
  mustBeat: true,              // 见张乎：跟牌时只要手里有能压过的牌（含炮）就必须出，不能过牌
};

/** 备选：开封/洛阳一带常见"三张也算炮"的打法 */
export const PRESET_TRIO_BOMB = {
  ...PRESET_HENAN,
  id: 'trioBomb',
  name: '河南（三张算炮）',
  trioIsBomb: true,
  bombMinCount: 3,
  bombBeats: { ...PRESET_HENAN.bombBeats, DOUBLE_STRAIGHT: 3, TRIO_STRAIGHT: 6, PLANE_ONE: 6, PLANE_TWO: 6 },
};

/** 备选：纯跑得快（连三带都不要，只有 单/对/三/五十K/炸 + 大压小）—— 部分县区打法 */
export const PRESET_SIMPLE = {
  ...PRESET_HENAN,
  id: 'simple',
  name: '简化版（纯大压小·无顺子无三带）',
  allowStraight: false,
  allowDoubleStraight: false,
  allowTrioStraight: false,
  allowTrioKick: false,
  allowPlaneKick: false,
};

export const PRESETS = [PRESET_HENAN, PRESET_TRIO_BOMB, PRESET_SIMPLE];

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESET_HENAN;
}

/** 深拷贝一份可修改的规则 */
export function cloneRules(presetId = 'henan') {
  const base = getPreset(presetId);
  return JSON.parse(JSON.stringify(base));
}
