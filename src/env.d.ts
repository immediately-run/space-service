// The Worker's bindings (wrangler.toml): the core's Config and the Durable Object namespace.
import type { Config } from './core/ports';

declare global {
  interface Env extends Config {
    SPACE: DurableObjectNamespace;
  }
  // `env` from cloudflare:test is typed as Cloudflare.Env. The test bindings exist only in
  // vitest.config.ts; nothing under src/ reads them.
  namespace Cloudflare {
    interface Env extends globalThis.Env {
      TEST_SIGNING_JWK: string;
    }
  }
}
