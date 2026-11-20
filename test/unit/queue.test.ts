// queue.test.ts (Node only) — the Node host's stand-in for the input gate: one space's requests
// run one at a time in arrival order; different spaces never wait on each other.
import { expect, it } from 'vitest';
import { SpaceQueues } from '../../src/local/queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const turn = () => new Promise<void>((done) => setImmediate(done));

it("one space's requests run one at a time, in arrival order", async () => {
  const queues = new SpaceQueues();
  const log: string[] = [];
  const gates = [deferred(), deferred(), deferred()];
  const runs = gates.map((gate, i) =>
    queues.run('a', async () => {
      log.push(`start ${i}`);
      await gate.promise;
      log.push(`end ${i}`);
      return i;
    }),
  );
  await turn();
  expect(log).toEqual(['start 0']);
  // Releasing a later request first changes nothing: it has not started.
  gates[2].resolve();
  await turn();
  expect(log).toEqual(['start 0']);
  gates[0].resolve();
  gates[1].resolve();
  expect(await Promise.all(runs)).toEqual([0, 1, 2]);
  expect(log).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
});

it("two spaces' requests interleave; a slow request on one does not delay the other, nor a third", async () => {
  const queues = new SpaceQueues();
  const log: string[] = [];
  const slow = deferred();
  const stuck = queues.run('a', async () => {
    log.push('a1 start');
    await slow.promise;
    log.push('a1 end');
  });
  const behind = queues.run('a', () => void log.push('a2'));
  // While `a` is held, `b` and `c` run to completion, each in its own order.
  await queues.run('b', () => void log.push('b1'));
  await queues.run('c', () => void log.push('c1'));
  await queues.run('b', () => void log.push('b2'));
  expect(log).toEqual(['a1 start', 'b1', 'c1', 'b2']);
  slow.resolve();
  await Promise.all([stuck, behind]);
  expect(log).toEqual(['a1 start', 'b1', 'c1', 'b2', 'a1 end', 'a2']);
});

it('a failed request releases the queue, and an idle space keeps no queue', async () => {
  const queues = new SpaceQueues();
  await expect(queues.run('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  expect(await queues.run('a', () => 'next')).toBe('next');
  await turn();
  expect(queues.size).toBe(0);
});
