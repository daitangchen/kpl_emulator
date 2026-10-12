/**
 * 零依赖本地静态服务器：node tools/serve.mjs [port]
 * 打开 http://127.0.0.1:8123 即可游玩
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const target = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const s = await stat(target).catch(() => null);
    if (!s || s.isDirectory()) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KPL 经营模拟器已启动：http://127.0.0.1:${PORT}`);
  console.log('（Ctrl+C 停止）');
});
