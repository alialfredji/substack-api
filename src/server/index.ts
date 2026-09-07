/**
 * Server entry point.
 *
 *   npm run dev     # watch mode
 *   npm run serve   # one-shot
 *   npm start       # from the compiled build
 *
 * Then open http://127.0.0.1:3000/docs
 */

import 'dotenv/config';
import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';
const publicUrl = process.env['PUBLIC_URL'] ?? `http://${host}:${port}`;

const app = await buildApp({ publicUrl });

try {
  await app.listen({ port, host });
  app.log.info(`Swagger UI  ->  http://${host}:${port}/docs`);
  app.log.info(`OpenAPI     ->  http://${host}:${port}/openapi.json`);
  app.log.info(`MCP         ->  ${publicUrl}/mcp`);
  app.log.info(
    app.substack.authenticated
      ? 'Cookie detected: viewer-relative fields (is_subscribed, is_following) will resolve.'
      : 'No cookie configured: viewer-relative fields will read false. This is fine for most routes.',
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
