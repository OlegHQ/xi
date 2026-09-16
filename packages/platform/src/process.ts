import type {
  CancellationToken,
  Disposable,
  ProcessExit,
  ProcessHandle,
  ProcessInput,
  ProcessPort,
  ProcessSpec,
  PlatformFailure,
  Result,
} from '../../contracts/src/index.ts';

/** Bun subprocess adapter. All process effects stay behind the platform port. */
export class NodeProcessPort implements ProcessPort {
  spawn(spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
    if (spec.argv.length === 0 || spec.argv[0].length === 0) return Promise.resolve(failure('invalid-argv', 'process argv must not be empty', false));
    if (!Number.isSafeInteger(spec.timeoutMilliseconds) || spec.timeoutMilliseconds < 1) return Promise.resolve(failure('invalid-timeout', 'process timeout must be positive', false));
    if (spec.cancellation.isCancelled) return Promise.resolve(failure('cancelled', 'process launch was cancelled', false));
    try {
      const child = Bun.spawn({
        cmd: [...spec.argv],
        cwd: spec.cwd,
        env: { ...spec.env },
        stdin: spec.stdin ?? 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const input = child.stdin === null || typeof child.stdin === 'number' || child.stdin === undefined
        ? null
        : createInput(child.stdin);
      const exit = this.track(child, spec.cancellation, spec.timeoutMilliseconds);
      return Promise.resolve({
        ok: true,
        value: Object.freeze({
          stdin: input,
          stdout: streamChunks(child.stdout),
          stderr: streamChunks(child.stderr),
          exit,
          terminate: async (forceAfterMilliseconds: number) => {
            child.kill('SIGTERM');
            const boundedForceAfter = Number.isSafeInteger(forceAfterMilliseconds) && forceAfterMilliseconds >= 0 ? forceAfterMilliseconds : 250;
            await Promise.race([exit, delay(boundedForceAfter)]);
            if (child.exitCode === null) child.kill('SIGKILL');
            await exit;
          },
          dispose: () => {
            if (child.exitCode === null) child.kill('SIGTERM');
          },
        }),
      });
    } catch (error: unknown) {
      return Promise.resolve(failure('spawn-failed', error instanceof Error ? error.message : String(error), true));
    }
  }

  private track(child: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>, cancellation: CancellationToken, timeoutMilliseconds: number): Promise<Result<ProcessExit, PlatformFailure>> {
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    }, timeoutMilliseconds);
    const cancellationSubscription = cancellation.onCancel(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    });
    return child.exited.then((code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      cancellationSubscription.dispose();
      return { ok: true, value: { code, signal: child.signalCode === null ? null : String(child.signalCode) } };
    }, (error: unknown) => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      cancellationSubscription.dispose();
      return failure('process-exit-failed', error instanceof Error ? error.message : String(error), true);
    });
  }
}

function createInput(sink: Bun.FileSink): ProcessInput {
  let closed = false;
  return Object.freeze({
    async write(bytes: Uint8Array): Promise<Result<void, PlatformFailure>> {
      if (closed) return failure('stdin-closed', 'process stdin is closed', false);
      try {
        sink.write(bytes);
        return { ok: true, value: undefined };
      } catch (error: unknown) {
        return failure('stdin-write-failed', error instanceof Error ? error.message : String(error), true);
      }
    },
    async close(): Promise<Result<void, PlatformFailure>> {
      if (closed) return { ok: true, value: undefined };
      closed = true;
      try {
        await sink.end();
        return { ok: true, value: undefined };
      } catch (error: unknown) {
        return failure('stdin-close-failed', error instanceof Error ? error.message : String(error), true);
      }
    },
    dispose(): void {
      if (!closed) {
        closed = true;
        try { void sink.end(); } catch { /* process exit closes the pipe */ }
      }
    },
  });
}

async function* streamChunks(stream: ReadableStream<Uint8Array<ArrayBuffer>> | null): AsyncIterable<Uint8Array> {
  if (stream === null) return;
  for await (const chunk of stream) yield new Uint8Array(chunk);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function failure(code: string, message: string, retryable: boolean): Result<never, PlatformFailure> {
  return { ok: false, error: { code, message, retryable } };
}
