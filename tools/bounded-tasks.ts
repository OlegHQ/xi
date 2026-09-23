export interface BoundedTaskOutcome<T> {
  readonly code: number;
  readonly value: T;
}

export interface BoundedTaskRun<T> {
  readonly codes: readonly (number | undefined)[];
  readonly failed: boolean;
  readonly interrupted: boolean;
}

export function boundedRunExitCode(run: BoundedTaskRun<unknown>): number {
  if (run.interrupted) return 130;
  return run.codes.find((code) => code !== undefined && code !== 0) ?? 0;
}

/** Runs indexed tasks with a fixed worker count and stops assigning work after a failure or cancellation. */
export async function runBoundedTasks<T>(
  count: number,
  concurrency: number,
  execute: (index: number) => Promise<BoundedTaskOutcome<T>>,
  onOrderedResult: (index: number, outcome: BoundedTaskOutcome<T>) => void,
  isInterrupted: () => boolean = () => false,
  keepGoing = false,
): Promise<BoundedTaskRun<T>> {
  const codes: (number | undefined)[] = Array(count).fill(undefined);
  const completed = new Map<number, BoundedTaskOutcome<T>>();
  let next = 0;
  let nextToEmit = 0;
  let failed = false;
  let wakeProgress!: () => void;
  let progress = new Promise<void>((resolve) => { wakeProgress = resolve; });
  const signalProgress = (): void => {
    wakeProgress();
    progress = new Promise<void>((resolve) => { wakeProgress = resolve; });
  };
  const worker = async (): Promise<void> => {
    while ((!failed || keepGoing) && !isInterrupted()) {
      if (next >= count) return;
      // Keep workers busy behind a slow fixture while bounding retained ordered output.
      if (next >= nextToEmit + concurrency * 4) {
        await progress;
        continue;
      }
      const index = next++;
      const result = await execute(index);
      codes[index] = result.code;
      completed.set(index, result);
      const before = nextToEmit;
      while (completed.has(nextToEmit)) {
        const ready = completed.get(nextToEmit)!;
        completed.delete(nextToEmit);
        onOrderedResult(nextToEmit++, ready);
      }
      if (nextToEmit !== before) signalProgress();
      if (result.code !== 0) {
        failed = true;
        signalProgress();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  return { codes, failed, interrupted: isInterrupted() };
}
