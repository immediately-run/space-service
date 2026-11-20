// auth.ts — identity at the service (STORE_PORTABILITY_SPEC §5.5.5): a platform-minted,
// audience-bound ES256 token, verified against one configured public key. It is never an ID
// token of the identity provider, and the same verifier runs on both hosts.
//
// Every failure — malformed, bad signature, wrong audience, no `exp`, expired — is the same
// null, which every caller turns into the same `forbidden` (P7).
import { importSPKI, jwtVerify } from 'jose';
import type { Config } from './ports';
import { MAX_UID_LENGTH } from './protocol';

/** A verified token: who, and until when (epoch milliseconds). */
export interface Claims {
  uid: string;
  exp: number;
}

type Key = Awaited<ReturnType<typeof importSPKI>>;
const keys = new Map<string, Promise<Key>>();

function publicKey(pem: string): Promise<Key> {
  let key = keys.get(pem);
  if (!key) {
    key = importSPKI(pem, 'ES256');
    keys.set(pem, key);
    // A key that does not parse is not cached, so a corrected setting takes effect.
    key.catch(() => keys.delete(pem));
  }
  return key;
}

/** Verify `token` as of the instant `at` (epoch milliseconds). */
export async function verifyToken(token: unknown, config: Config, at: number): Promise<Claims | null> {
  if (typeof token !== 'string' || !config.TOKEN_PUBLIC_KEY_PEM || !config.TOKEN_AUDIENCE) return null;
  try {
    const { payload } = await jwtVerify(token, await publicKey(config.TOKEN_PUBLIC_KEY_PEM), {
      algorithms: ['ES256'],
      audience: config.TOKEN_AUDIENCE,
      requiredClaims: ['exp', 'sub'],
      currentDate: new Date(at),
      clockTolerance: 0,
    });
    const { sub, exp } = payload;
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_UID_LENGTH || typeof exp !== 'number') return null;
    return { uid: sub, exp: exp * 1000 };
  } catch {
    return null;
  }
}

/** Whether verified claims still hold at `now`: the core's own check, on its own clock. */
export const live = (claims: Claims, now: number): boolean => Number.isFinite(claims.exp) && claims.exp > now;
