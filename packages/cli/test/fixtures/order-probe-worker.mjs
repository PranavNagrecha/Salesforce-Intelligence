/**
 * INFRA-05 test probe — completes jobs in REVERSE index order so the pool's
 * input-order collection is forced to differ from completion order.
 */
import { parentPort, workerData } from 'node:worker_threads';

if (parentPort === null) {
  throw new Error('order-probe-worker must run as a worker_thread');
}

const n = typeof workerData?.n === 'number' ? workerData.n : 0;

parentPort.on('message', (job) => {
  const delayMs = Math.max(0, (n - job.index) * 20);
  setTimeout(() => {
    parentPort.postMessage({
      index: job.index,
      result: {
        calls: [`job-${job.index}`],
        reads: [],
        writes: [],
      },
    });
  }, delayMs);
});
