/**
 * 联机传输层集成测试（默认方案：TinyMqtt + 免费公共 broker 协议）
 *
 * 不依赖外网：用一个内存里的「假 broker」实现 MQTT 3.1.1 的最小服务端
 * （CONNECT→CONNACK / SUBSCRIBE→SUBACK / PUBLISH 按 topic 路由 / PING→PONG），
 * 然后拿真·TinyMqtt 当客户端去连它。这样能真实验证自写的帧编解码 + 房间/广播逻辑。
 *
 * 跑法：node test/mqtt.test.mjs
 */
import { MqttTransport } from '../src/net/mqtt.js';
import { cloneRules } from '../src/core/rules.js';

/* ============ 极简 MQTT broker 模拟（仅本测试用） ============ */
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
      if (f.type === 1) { // CONNECT → CONNACK
        sender._raw([0x20, 0x02, 0x00, 0x00]);
      } else if (f.type === 8) { // SUBSCRIBE → SUBACK
        const pid = (f.body[0] << 8) | f.body[1];
        const tlen = (f.body[2] << 8) | f.body[3];
        const topic = dec.decode(f.body.slice(4, 4 + tlen));
        if (!sender.subs.includes(topic)) sender.subs.push(topic);
        sender._raw([0x90, 0x03, (pid >> 8) & 0xff, pid & 0xff, 0x00]);
      } else if (f.type === 3) { // PUBLISH → 路由给其它订阅者
        const tlen = (f.body[0] << 8) | f.body[1];
        const topic = dec.decode(f.body.slice(2, 2 + tlen));
        for (const c of this.clients) {
          if (c === sender) continue; // MQTT 不回显给发布者本人
          if (c.subs.includes(topic)) c._raw(bytes);
        }
      } else if (f.type === 12) { // PINGREQ → PINGRESP
        sender._raw([0xD0, 0x00]);
      } else if (f.type === 14) { // DISCONNECT
        this.remove(sender);
      }
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
    // 必须异步投递：真实网络有延迟，TinyMqtt 的 onopen 里是先发 CONNECT、
    // 发完才挂 _onceConnack。同步回包会让 CONNACK 早于回调挂载到达。
    const ab = Uint8Array.from(bytes).buffer;
    setTimeout(() => { if (this.onmessage) this.onmessage({ data: ab }); }, 0);
  }
  send(arrayBuffer) {
    const u = new Uint8Array(arrayBuffer);
    MockWS._broker.route(this, u);
  }
  close() { this.readyState = 3; MockWS._broker.remove(this); if (this.onclose) this.onclose(); }
}
MockWS._broker = new MockBroker();

/* ============ 测试 ============ */
let pass = 0, fail = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(cond, name) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// 注入假 WebSocket（不碰全局，避免 Node 原生 WebSocket 抢先）
const factory = (url) => new MockWS(url);

(async () => {
  console.log('════════ MqttTransport 联机链路（mock broker）════════');

  const host = new MqttTransport(0, { socketFactory: factory });
  let hostPeers = null, hostMsgs = [];
  host.on('peers', (p) => { hostPeers = p; });
  host.on('message', (m) => { hostMsgs.push(m); });

  const guest = new MqttTransport(0, { socketFactory: factory });
  let guestPeers = null, guestMsgs = [], guestPeersEvents = 0;
  guest.on('peers', (p) => { guestPeers = p; guestPeersEvents++; });
  guest.on('message', (m) => { guestMsgs.push(m); });

  // 1) 房主建房
  await host.connect('ROOM_X', '房主', true);
  ok(host.state === 'connected', '房主连上 broker');
  ok(host.peers.length === 1 && host.peers[0].seat === 0, '房主初始占 0 号座');

  // 2) 客人加入
  await guest.connect('ROOM_X', '客人', false);
  await delay(30); // 等 hello→分座→广播 peers 的异步链路
  ok(guest.seatIndex === 1, '客人被分到 1 号座（host.peers 里）');
  ok(hostPeers && hostPeers.length === 2, '房主看到 2 人（含客人）');
  ok(guestPeers && guestPeers.length === 2 && guestPeers[1].name === '客人', '客人收到 peers 列表且自己是 1 号');

  // 3) 房主开局：广播同一个 seed
  const seed = 246810;
  host.broadcastSeats(seed, cloneRules('henan'));
  await delay(30);
  const startMsg = guestMsgs.find((m) => m.t === 'start');
  ok(!!startMsg, '客人收到了 start 消息');
  ok(startMsg && startMsg.seed === seed, 'start 里的 seed 与房主一致（确定性联机前提）');
  ok(startMsg && startMsg.mySeat === 1, 'start 指定客人座位 = 1');

  // 4) 客人出牌动作 → 房主收到转发
  guest.send({ t: 'act', action: { type: 'pass', seat: 1 } });
  await delay(30);
  const actMsg = hostMsgs.find((m) => m.t === 'act');
  ok(!!actMsg, '房主收到了客人的 act 转发');
  ok(actMsg && actMsg.action.seat === 1, '转发的动作座位正确（1 号）');

  // 5) 房主再广播一次 peers：客人应再次收到（peers 走 'peers' 事件，不走 'message'）
  const before = guestPeersEvents;
  host.send({ t: 'peers', list: hostPeers });
  await delay(30);
  ok(guestPeersEvents > before, '客人能收到房主广播的 peers（再次触发 peers 事件）');
  ok(guestPeers && guestPeers.length === 2, '客人端 peers 列表仍是 2 人');
  // 6) broker 不回显给发布者本人：房主发的 peers 不该回到房主的 message 里
  const hostPeerEcho = hostMsgs.filter((m) => m.t === 'peers');
  ok(hostPeerEcho.length === 0, 'broker 不回显给发布者本人（房主收不到自己的广播）');

  host.close(); guest.close();
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本挂了：', e); process.exit(2); });
