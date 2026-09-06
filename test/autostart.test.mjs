/**
 * 联机"人齐自动开局"测试（去中心化：房主收到第 4 人后本地自动发牌）
 *
 * 用内存「假 broker」跑真·TinyMqtt，验证：
 *   1) 房主 + 3 位客人到齐 → 房主触发 'full' 事件（自动开局信号）
 *   2) 仅 3 人时不会触发 'full'（minPlayers=4 生效）
 *   3) 'full' 后房主 broadcastSeats → 3 位客人都收到合法 'start'（seed / 座位一致）
 *
 * 这就是"4 个人都进去以后就自动开牌，不用谁点开始"的核心机制。
 * 跑法：node test/autostart.test.mjs
 */
import { MqttTransport } from '../src/net/mqtt.js';
import { cloneRules, CT } from '../src/core/rules.js';

/* ============ 极简 MQTT broker 模拟（仅本测试用，同 mqtt.test.mjs） ============ */
const dec = new TextDecoder();

function decodeRemaining(buf, start) {
  let multiplier = 1, len = 0, i = start, digit;
  do { digit = buf[i++]; len += (digit & 127) * multiplier; multiplier *= 128; } while ((digit & 128) !== 0 && i < buf.length);
  return { len, headerEnd: i };
}
function parseFrames(buf) {
  const frames = []; let i = 0;
  while (i < buf.length) {
    if (i + 1 > buf.length) break;
    const b0 = buf[i]; const type = b0 >> 4; const flags = b0 & 0x0f;
    const { len, headerEnd } = decodeRemaining(buf, i + 1);
    const total = headerEnd + len;
    if (buf.length < total) break;
    frames.push({ type, flags, body: buf.slice(headerEnd, total) });
    i = total;
  }
  return frames;
}
class MockBroker {
  constructor() { this.clients = []; }
  add(ws) { ws.subs = []; this.clients.push(ws); }
  remove(ws) { this.clients = this.clients.filter((c) => c !== ws); }
  route(sender, bytes) {
    const frames = parseFrames(bytes);
    for (const f of frames) {
      if (f.type === 1) { sender._raw([0x20, 0x02, 0x00, 0x00]); }
      else if (f.type === 8) {
        const pid = (f.body[0] << 8) | f.body[1];
        const tlen = (f.body[2] << 8) | f.body[3];
        const topic = dec.decode(f.body.slice(4, 4 + tlen));
        if (!sender.subs.includes(topic)) sender.subs.push(topic);
        sender._raw([0x90, 0x03, (pid >> 8) & 0xff, pid & 0xff, 0x00]);
      } else if (f.type === 3) {
        const tlen = (f.body[0] << 8) | f.body[1];
        const topic = dec.decode(f.body.slice(2, 2 + tlen));
        for (const c of this.clients) {
          if (c === sender) continue;
          if (c.subs.includes(topic)) c._raw(bytes);
        }
      } else if (f.type === 12) { sender._raw([0xD0, 0x00]); }
      else if (f.type === 14) { this.remove(sender); }
    }
  }
}
class MockWS {
  constructor(url) {
    this.url = url; this.binaryType = 'arraybuffer'; this.readyState = 0;
    MockWS._broker.add(this);
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0);
  }
  _raw(bytes) {
    const ab = Uint8Array.from(bytes).buffer;
    setTimeout(() => { if (this.onmessage) this.onmessage({ data: ab }); }, 0);
  }
  send(arrayBuffer) { const u = new Uint8Array(arrayBuffer); MockWS._broker.route(this, u); }
  close() { this.readyState = 3; MockWS._broker.remove(this); if (this.onclose) this.onclose(); }
}
MockWS._broker = new MockBroker();
const factory = (url) => new MockWS(url);

/* ============ 测试 ============ */
let pass = 0, fail = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(cond, name) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

(async () => {
  console.log('════════ 联机"人齐自动开局"（mock broker，4 人）════════');

  const host = new MqttTransport(0, { socketFactory: factory, minPlayers: 4 });
  let fullFired = false, fullPeers = null;
  host.on('full', (p) => { fullFired = true; fullPeers = p; });

  const guests = [];
  const guestMsgs = [];
  for (let i = 0; i < 3; i++) {
    const g = new MqttTransport(0, { socketFactory: factory });
    g.on('message', (m) => { if (m.t === 'start') guestMsgs.push({ g: i, m }); });
    guests.push(g);
  }

  // 房主建房
  await host.connect('ROOM_A', '房主', true);
  ok(host.state === 'connected', '房主连上 broker');
  ok(host.peers.length === 1, '房主初始 1 人，未触发 full');
  ok(!fullFired, '1 人时未触发 full');

  // 逐位客人加入
  for (let i = 0; i < 3; i++) {
    await guests[i].connect('ROOM_A', '客' + (i + 1), false);
    await delay(40);
    if (i < 2) ok(!fullFired, `第 ${i + 1} 位客人加入后仍未满 4 人，不触发 full`);
  }

  // 3 位客人到齐 = 房主 + 3 = 4 人
  await delay(40);
  ok(fullFired, '4 人齐（房主+3客）→ 触发 full 事件（自动开局信号）');
  ok(fullPeers && fullPeers.length === 4, 'full 携带 4 人 peers 列表');
  ok(fullPeers && fullPeers.every((p) => p.seat >= 0 && p.seat <= 3), 'full 里 4 个座位 0..3 分配正确');

  // 模拟 app.js 的自动开局：收到 full 后房主自动 broadcastSeats
  const seed = 987654;
  host.broadcastSeats(seed, cloneRules('henan'));
  await delay(40);

  ok(guestMsgs.length === 3, '3 位客人都收到了 start');
  ok(guestMsgs.every((x) => x.m.seed === seed), 'start 的 seed 与房主一致（确定性联机前提）');
  ok(guestMsgs.every((x) => x.m.mySeat !== undefined && x.m.mySeat !== 0), '客人的 mySeat 都不是房主的 0 号座');
  const seats = guestMsgs.map((x) => x.m.mySeat).sort();
  ok(JSON.stringify(seats) === JSON.stringify([1, 2, 3]), '3 位客人分别分到 1/2/3 号座');
  ok(guestMsgs.every((x) => x.m.rules && CT), 'start 携带规则对象（联机用同一套规则）');

  host.close(); guests.forEach((g) => g.close());
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本挂了：', e); process.exit(2); });
