// clock.ts — the Cloudflare host's Clock: the system's. One of the two places in src/ that
// reads the system time (the other is src/local/clock.ts).
import type { Clock } from '../core/ports';

export const systemClock: Clock = { now: () => Date.now() };
