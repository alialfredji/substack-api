/**
 * Write the OpenAPI document to ./openapi.json without starting a listener.
 *
 *   npm run spec
 */

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/server/app.js';

const app = await buildApp({ logger: false });
await app.ready();
const spec = app.swagger();
await writeFile('openapi.json', `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

const paths = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {});
console.log(`Wrote openapi.json with ${paths.length} paths:`);
for (const p of paths.sort()) console.log(`  ${p}`);

await app.close();
