// Minimal local stand-in for Vercel: serves public/ with clean URLs and routes
// /api/<path> to the named method export of api/<path>.js. Use `vercel dev`
// instead if the project is linked.
//   node --env-file=.env.local scripts/dev-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3000);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = normalize(url.pathname.slice(5)).replace(/^(\.\.[/\\])+/, '');
      const mod = await import(pathToFileURL(join(root, 'api', `${name}.js`)).href);
      const fn = mod[req.method];
      if (!fn) return res.writeHead(405).end();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await fn(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    let path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    if (path === '/') path = '/index.html';
    if (!extname(path)) path += '.html';
    const body = await readFile(join(root, 'public', path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ERR_MODULE_NOT_FOUND') return res.writeHead(404).end('not found');
    console.error(err);
    res.writeHead(500).end('error');
  }
}).listen(port, () => console.log(`portal dev server on http://localhost:${port}`));
