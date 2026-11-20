// What vitest.config.ts provides the local project: the run's bindings.
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    localConfig: { TOKEN_AUDIENCE: string; TOKEN_PUBLIC_KEY_PEM: string; TEST_SIGNING_JWK: string; TEST_SIGNING_PEM: string };
  }
}
