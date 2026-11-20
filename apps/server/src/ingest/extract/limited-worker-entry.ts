export async function startLimitedWorker(): Promise<void> {
  const { getHeapStatistics, serialize } = await import('node:v8');
  const { getEnvironmentData, parentPort } = await import('node:worker_threads');
  const memoryBytes = getEnvironmentData('extractionWorker.memoryBytes') as number;
  const send = parentPort!.postMessage.bind(parentPort);
  const started = new Promise<void>((resolve) => parentPort!.once('message', () => resolve()));
  send({ kind: 'ready' });
  await started;
  parentPort!.postMessage = (result: unknown) => {
    const before = getHeapStatistics();
    if (before.total_physical_size + before.external_memory > memoryBytes) {
      send({
        kind: 'result',
        result: getEnvironmentData('extractionWorker.memoryFailure'),
        heapBytes: before.total_physical_size,
        externalBytes: before.external_memory,
      });
      return;
    }
    // Serialization reserves the result copy before it can leave the bounded process.
    const copy = serialize(result);
    const statistics = getHeapStatistics();
    const used = statistics.total_physical_size + statistics.external_memory + copy.byteLength;
    send({
      kind: 'result',
      result: used > memoryBytes ? getEnvironmentData('extractionWorker.memoryFailure') : result,
      heapBytes: statistics.total_physical_size,
      externalBytes: statistics.external_memory + copy.byteLength,
    });
  };
  await import(getEnvironmentData('extractionWorker.entry') as string);
}
