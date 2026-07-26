import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Servora-Med U1 Sentetik Kanıt</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/scripts/phase-u-u1-evidence-fixture.tsx"></script>
  </body>
</html>`;

const vite = await createViteServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
});
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const acceptsHtml = request.headers.accept?.includes('text/html');
  if (acceptsHtml && !pathname.startsWith('/src/') && !pathname.startsWith('/scripts/')
    && !pathname.startsWith('/branding/') && !pathname.startsWith('/@')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
    return;
  }
  vite.middlewares(request, response, () => {
    response.writeHead(404);
    response.end();
  });
});

server.listen(4178, '127.0.0.1', () => {
  console.log('U1 evidence fixture: http://127.0.0.1:4178/overview?role=staff');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await vite.close();
    server.close(() => process.exit(0));
  });
}
