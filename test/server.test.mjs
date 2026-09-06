/**
 * 自建服务器测试：4 个客户端连上 → 分座位 → 开局 → 动作转发
 * 跑法：node test/server.test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8899;
const URL_WS = `ws://localhost:${PORT}`;

let pass = 0, fail = 0;
function ok(v, msg) { if (v) { pass++; console.log(' ✓ ' + msg); } else { fail++; console.log(' ✗ ' + msg); } }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 极简 WebSocket 客户端封装（Node 22 自带 WebSocket） */
class Client {
  constructor(name) {
    this.name = name;
    this.id = 'c_' + name;
    this.msgs = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_WS);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(this.name + ' 连接失败'));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const w = this.waiters[i];
          if (w.pred(m)) { this.waiters.splice(i, 1); w.resolve(m); }
        }
      };
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(pred, timeout = 4000, label = '') {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待超时: ' + label)), timeout);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), String(PORT)], { stdio: 'pipe' });
await sleep(1200);

try {
  const a = new Client('甲'), b = new Client('乙'), c = new Client('丙'), d = new Client('丁');

  await a.connect(); await b.connect(); await c.connect(); await d.connect();
  console.log('\n════════ 自建服务器测试 ════════');
  ok(true, '四个客户端都连上了');

  a.send({ t: 'join', room: 'R1', name: '甲', id: a.id });
  b.send({ t: 'join', room: 'R1', name: '乙', id: b.id });
  c.send({ t: 'join', room: 'R1', name: '丙', id: c.id });
  d.send({ t: 'join', room: 'R1', name: '丁', id: d.id });

  const wa = await a.waitFor((m) => m.t === 'welcome', 4000, '甲welcome');
  const wb = await b.waitFor((m) => m.t === 'welcome', 4000, '乙welcome');
  const wc = await c.waitFor((m) => m.t === 'welcome', 4000, '丙welcome');
  const wd = await d.waitFor((m) => m.t === 'welcome', 4000, '丁welcome');

  const seats = [wa.mySeat, wb.mySeat, wc.mySeat, wd.mySeat];
  ok(JSON.stringify(seats.slice().sort()) === '[0,1,2,3]', `座位分配 0/1/2/3（实际 ${seats.join(',')})`);

  const peersA = await a.waitFor((m) => m.t === 'peers' && m.list.length === 4, 4000, 'peers')
    .catch((e) => {
      console.log('   [debug] 甲收到的消息序列：', a.msgs.map((m) => m.t + (m.list ? `(${m.list.length})` : '')).join(' → '));
      throw e;
    });
  ok(peersA.list.length === 4, '甲看到 4 人到齐');

  // 开局：甲（座位0=host）发 start
  a.send({ t: 'start', seed: 12345, rules: null });
  const sa = await a.waitFor((m) => m.t === 'start' && m.mySeat !== undefined, 4000, '甲start');
  const sb = await b.waitFor((m) => m.t === 'start', 4000, '乙start');
  ok(sa.mySeat === 0 && sb.mySeat === 1, 'start 消息各带各的座位');

  // 出牌动作：乙发 act，甲/丙/丁应该收到，乙自己不该收到
  b.send({ t: 'act', action: { type: 'play', seat: 1, uids: ['x'] } });
  await sleep(400);
  ok(a.msgs.some((m) => m.t === 'act'), '甲收到了 act');
  ok(c.msgs.some((m) => m.t === 'act'), '丙收到了 act');
  ok(d.msgs.some((m) => m.t === 'act'), '丁收到了 act');
  ok(!b.msgs.some((m) => m.t === 'act'), '乙自己没收到（防重复执行）');

  // 房间隔离：开第二个房间，不应串台
  const e2 = new Client('戊');
  await e2.connect();
  e2.send({ t: 'join', room: 'R2', name: '戊', id: e2.id });
  await e2.waitFor((m) => m.t === 'welcome', 4000, '戊welcome');
  e2.send({ t: 'act', action: { type: 'pass', seat: 0 } });
  await sleep(300);
  const actCountR1 = [a, c, d].filter((cl) => cl.msgs.filter((m) => m.t === 'act' && m.action.type === 'pass').length > 0).length;
  ok(actCountR1 === 0, '不同房间消息不串台');

  // 网页也能从这台服务器拿
  const res = await fetch(`http://localhost:${PORT}/`);
  ok(res.status === 200, '服务器同时托管网页（GET / → 200）');

  console.log('════════════════════════════════\n');
} catch (e) {
  console.log(' ✗ ' + e.message);
  fail++;
} finally {
  server.kill();
}

console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
