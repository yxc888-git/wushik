/**
 * 本地启动器（Node 原生，零依赖、不联网、不用装任何东西）
 *
 * 为什么必须有它：游戏用的是 ES Module，浏览器不允许 file:// 直接加载模块，
 * 所以需要一个本地 http 服务。双击「启动游戏.bat」就是跑这个。
 *
 *   node serve.js          默认 http://localhost:8080
 *   node serve.js 3000     换端口
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); res.end('bad request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到：' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const line = '─'.repeat(52);
  console.log('\n' + line);
  console.log('  五十K · 河南郑州版  已经跑起来了');
  console.log(line);
  console.log(`  本机打开：  http://localhost:${PORT}`);
  console.log(`  同一 WiFi 下别人打开（把 IP 换成你的）：`);
  console.log(`              http://${getLanIp()}:${PORT}`);
  console.log(line);
  console.log('  关掉这个黑窗口 = 关掉服务');
  console.log(line + '\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 被占用了，换一个：node serve.js 8081\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

function getLanIp() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch (_) {}
  return '192.168.1.x';
}
