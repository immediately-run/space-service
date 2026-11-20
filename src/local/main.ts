// main.ts — start the space service as a Node process (STORE_PORTABILITY_SPEC §10.1, Model A):
//
//   npm start -- --data-dir ./data --public-key-file ./platform.pub.pem --audience <aud> [--port 8787] [--host 127.0.0.1]
//
// It trusts exactly one key: the public key in --public-key-file.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LocalHost } from './host';
import { serve } from './server';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    'public-key-file': { type: 'string' },
    audience: { type: 'string' },
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

const missing = (['data-dir', 'public-key-file', 'audience'] as const).filter((k) => !values[k]);
if (missing.length) {
  console.error(`space-service: missing ${missing.map((k) => `--${k}`).join(', ')}`);
  process.exit(2);
}

const host = new LocalHost({
  dataDir: values['data-dir']!,
  config: { TOKEN_PUBLIC_KEY_PEM: readFileSync(values['public-key-file']!, 'utf8'), TOKEN_AUDIENCE: values.audience! },
});
const server = serve(host);
server.listen(Number(values.port), values.host, () => {
  console.log(`space-service: listening on http://${values.host}:${values.port} (data in ${values['data-dir']})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    host.stop();
    process.exit(0);
  });
}
