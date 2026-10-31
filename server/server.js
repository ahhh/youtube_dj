// Tube DJ server entry point: serves the static app and the local YouTube -> mp3 API.
// Binds to loopback by default; this is a personal tool, not a public service.
// To reach it from another machine set HOST and list the names you use in TUBEDJ_HOSTS.
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createConverter } from './convert.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '127.0.0.1';
const extraHosts = (process.env.TUBEDJ_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) extraHosts.push(HOST);

const app = createApp({ converter: createConverter(), root, extraHosts });
createServer(app).listen(PORT, HOST, () => console.log(`Tube DJ on http://${HOST}:${PORT}`));
