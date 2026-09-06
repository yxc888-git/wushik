/**
 * 五十K 自建服务器（Node 原生，零依赖，单文件）
 *
 * 这是给"以后有钱了"准备的：不用它也能玩（默认走免费公共信道）。
 * 买台最便宜的云服务器（几十块一年那种）后：
 *
 *   1. 把整个 wushik 文件夹传上去
 *   2. node server/server.js            （跑联机 + 顺便托管网页，端口 8787）
 *      或 node server/server.js 9000    （换端口）
 *   3. 大家打开  http://服务器IP:8787/?server=ws://服务器IP:8787
 *      —— 网页也从这台服务器出，联机也走这台服务器，一条龙
 *
 * 协议（JSON over WebSocket）：
 *   客户端 → 服务器：join / act / start / roundEnd
 *   服务器 → 客户端：welcome / peers / start / act / roundEnd
 * 服务端不懂游戏规则，只做"分座位 + 转发"，引擎在各客户端本地跑。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ==================== WebSocket 帧编解码 ==================== */

function encodeFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** 从缓冲区里解出所有完整帧；返回 { frames, rest } */
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off2 = off + 2;
    if (len === 126) { if (off2 + 2 > buf.length) break; len = buf.readUInt16BE(off2); off2 += 2; }
    else if (len === 127) { if (off2 + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(off2)); off2 += 8; }
    if (len > 10 * 1024 * 1024) { off = buf.length; break; } // 防炸弹
    let mask = null;
    if (masked) { if (off2 + 4 > buf.length) break; mask = buf.slice(off2, off2 + 4); off2 += 4; }
    if (off2 + len > buf.length) break;
    let payload = buf.slice(off2, off2 + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    off = off2 + len;
    frames.push({ fin, opcode, payload });
  }
  return { frames, rest: buf.slice(off) };
}

/* ==================== 房间管理 ==================== */

const rooms = new Map(); // roomId -> { clients: [{ws, id, name, seat, alive}] }

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { clients: [] });
  return rooms.get(id);
}

function peerList(room) {
  return room.clients.map((c) => ({ id: c.id, name: c.name, seat: c.seat }));
}

function send(ws, obj) {
  try { ws.socket.send(encodeFrame(JSON.stringify(obj))); } catch (_) {}
}

function broadcast(room, obj, exceptWs = null) {
  for (const c of room.clients) {
    if (c.socket !== exceptWs) send(c, obj);
  }
}

function refreshPeers(room) {
  broadcast(room, { t: 'peers', list: peerList(room) });
}

/* ==================== HTTP + WebSocket 服务 ==================== */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const client = { socket: null, room: null, id: null, name: '', seat: -1, buf: Buffer.alloc(0) };
  client.socket = {
    send: (buf) => { try { socket.write(buf); } catch (_) {} },
    close: () => { try { socket.destroy(); } catch (_) {} },
  };

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    const { frames, rest } = decodeFrames(client.buf);
    client.buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) { handleLeave(client); try { socket.destroy(); } catch (_) {} return; }
      if (f.opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch (_) {} continue; } // ping→pong
      if (f.opcode === 0x1) {
        let msg;
        try { msg = JSON.parse(f.payload.toString('utf8')); } catch (_) { continue; }
        handleMessage(client, msg);
      }
    }
  });
  socket.on('close', () => handleLeave(client));
  socket.on('error', () => handleLeave(client));

  client.wsRef = socket;
});

function handleMessage(client, msg) {
  switch (msg.t) {
    case 'join': {
      const room = getRoom(String(msg.room || 'default'));
      client.room = room;
      client.id = msg.id || client.id;
      client.name = String(msg.name || '玩家');
      // 空位才让进；满员给个观战位（-1，不出牌）
      const used = new Set(room.clients.map((c) => c.seat));
      let seat = 0; while (used.has(seat) && seat < 4) seat++;
      client.seat = seat <= 3 ? seat : -1;
      room.clients.push(client);
      send(client, { t: 'welcome', seat: client.seat, mySeat: client.seat, peers: peerList(room) });
      refreshPeers(room);
      break;
    }
    case 'start': {
      if (!client.room) return;
      // 每个客户端收到的 start 都带自己的座位
      for (const c of client.room.clients) {
        send(c, { t: 'start', seed: msg.seed, rules: msg.rules, mySeat: c.seat });
      }
      break;
    }
    case 'act': {
      if (!client.room) return;
      broadcast(client.room, msg, client.socket); // 不回发给出牌人本人
      break;
    }
    case 'roundEnd': {
      if (!client.room) return;
      broadcast(client.room, msg, client.socket);
      break;
    }
    default:
      if (client.room) broadcast(client.room, msg, client.socket);
  }
}

function handleLeave(client) {
  if (!client.room) return;
  const room = client.room;
  room.clients = room.clients.filter((c) => c !== client);
  client.room = null;
  refreshPeers(room);
}

server.listen(PORT, () => {
  const line = '─'.repeat(52);
  console.log('\n' + line);
  console.log('  五十K 服务器已启动（联机 + 网页托管）');
  console.log(line);
  console.log(`  本机：   http://localhost:${PORT}/?server=ws://localhost:${PORT}`);
  console.log(`  朋友们： http://你的公网IP:${PORT}/?server=ws://你的公网IP:${PORT}`);
  console.log(line);
  console.log('  这个进程同时干两件事：发网页 + 转发联机消息');
  console.log(line + '\n');
});
