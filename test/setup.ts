// setup.ts — every test starts from an empty service, on whichever host the project runs.
import { afterEach } from 'vitest';
import { reset } from '#host';
import { closeFeeds } from './lib/harness';

afterEach(async () => {
  await closeFeeds();
  await reset();
});
