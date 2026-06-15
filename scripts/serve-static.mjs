#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] || 'site');
const port = Number(process.argv[3] || 4179);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    let path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    if (path === '/' || path === '.') path = '/index.html';
    const full = join(root, path);
    if (!full.startsWith(root) || !existsSync(full)) {
      const notFound = join(root, '404.html');
      if (existsSync(notFound)) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await readFile(notFound));
        return;
      }
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(await readFile(full));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(err?.message || err));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`docs preview → http://127.0.0.1:${port}`);
  console.log(`  root: ${root}`);
});
