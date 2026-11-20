// mint.ts — the drill's token minter (STORE_PORTABILITY_SPEC §5.5.5, §5.5.7): tokens shaped as the
// platform would mint them, signed with the drill's own key. The key is used here and nowhere
// else: it is never logged, never returned and never part of a report.
import { SignJWT, importPKCS8 } from 'jose';
import type { Clock } from '../core/ports';

/** The audience the staging Worker is configured with (wrangler.toml, `[env.staging.vars]`). */
export const DRILL_AUDIENCE = 'space-service-staging';
export const DRILL_TOKEN_TTL_SECONDS = 600;

export type Mint = (uid: string) => Promise<string>;

/** A minter over the PKCS#8 PEM of an ES256 private key. Tokens are reused for half their life. */
export async function minter(PRIVATE_KEY_PEM: string, clock: Clock, audience: string = DRILL_AUDIENCE): Promise<Mint> {
  const key = await importPKCS8(PRIVATE_KEY_PEM, 'ES256');
  const cache = new Map<string, { token: Promise<string>; until: number }>();
  return (uid) => {
    const now = clock.now();
    const hit = cache.get(uid);
    if (hit && hit.until > now) return hit.token;
    const seconds = Math.floor(now / 1000);
    const token = new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setSubject(uid).setAudience(audience).setIssuedAt(seconds).setExpirationTime(seconds + DRILL_TOKEN_TTL_SECONDS).sign(key);
    cache.set(uid, { token, until: now + (DRILL_TOKEN_TTL_SECONDS * 1000) / 2 });
    return token;
  };
}
