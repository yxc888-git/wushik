/**
 * 联机信道实测：三个免费公共 MQTT broker 到底能不能用、快不快
 *
 * 测两项：
 *   1. 连接耗时（连 3 次，看成功率）
 *   2. 端到端往返延迟：A 订阅 → B 发一条 → A 收到（这就是打牌时"我出牌到你屏幕上"的真实延迟）
 *
 * 跑法：node test/broker-probe.mjs
 */
import { TinyMqtt, MQTT_BROKERS } from '../src/net/mqtt.js';

const factory = (url, proto) => new WebSocket(url, proto);
const rnd = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectOnce(b, timeout = 8000) {
  const t0 = Date.now();
  const m = new TinyMqtt(b.url, { socketFactory: factory, clientId: 'probe_' + rnd() });
  await m.connect(timeout);
  const ms = Date.now() - t0;
  return { m, ms };
}

async function testBroker(b) {
  const connTimes = [];
  let error = '';
  for (let i = 0; i < 3; i++) {
    try {
      const { m, ms } = await connectOnce(b);
      connTimes.push(ms);
      m.close();
    } catch (e) {
      connTimes.push(null);
      error = e.message;
    }
  }

  // 端到端往返：同一台机器开两个客户端 A/B，B 订阅，A 发，测 B 收到要多久
  let rtt = null;
  try {
    const A = await connectOnce(b);
    const B = await connectOnce(b);
    const topic = 'wushik-probe-' + rnd();
    const got = new Promise((resolve) => {
      B.m.on('message', (t, payload) => {
        if (t === topic) resolve(Date.now() - t0send);
      });
    });
    B.m.subscribe(topic);
    await sleep(400); // 等订阅生效
    const t0send = Date.now();
    for (let i = 0; i < 5; i++) A.m.publish(topic, 'ping' + i);
    rtt = await Promise.race([got, sleep(6000).then(() => null)]);
    A.m.close(); B.m.close();
  } catch (e) {
    error = error || e.message;
  }

  const okCount = connTimes.filter((x) => x !== null).length;
  return {
    name: b.name,
    url: b.url,
    ok: okCount,
    conn: connTimes,
    rtt,
    error: okCount === 0 ? error : '',
  };
}

console.log('\n════ 联机信道实测（郑州 · 家宽）════\n');
const rows = [];
for (const b of MQTT_BROKERS) {
  process.stdout.write(`测 ${b.name} … `);
  const r = await testBroker(b);
  rows.push(r);
  console.log(r.ok ? `连上 ${r.ok}/3，往返 ${r.rtt === null ? '超时' : r.rtt + 'ms'}` : `连不上（${r.error}）`);
}

console.log('\n' + '─'.repeat(76));
console.log('信道'.padEnd(24) + '成功率'.padEnd(10) + '连接耗时'.padEnd(20) + '出牌→对方屏幕延迟');
console.log('─'.repeat(76));
for (const r of rows) {
  const conn = r.conn.map((x) => (x === null ? '×' : x + 'ms')).join(' / ');
  console.log(
    r.name.padEnd(22) +
    `${r.ok}/3`.padEnd(10) +
    conn.padEnd(20) +
    (r.rtt === null ? '超时（不可用）' : r.rtt + ' ms')
  );
}
console.log('─'.repeat(76));
const best = rows.filter((r) => r.ok > 0).sort((a, b) => (a.rtt ?? 9999) - (b.rtt ?? 9999))[0];
console.log(best
  ? `结论：推荐用「${best.name}」，往返约 ${best.rtt}ms${best.rtt > 400 ? '（偏慢，出牌会有明显延迟感）' : '（够用，打牌基本感觉不到）'}`
  : '结论：三个公共信道全部连不上 —— 需要改用自建服务器方案');
console.log('');
