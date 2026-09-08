export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: { attempts: number; baseMs: number; label: string },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === options.attempts) {
        throw error;
      }
      const delay = options.baseMs * 2 ** (attempt - 1);
      console.log(
        JSON.stringify({
          level: 'warn',
          msg: 'transient_retry',
          label: options.label,
          attempt,
          delayMs: delay,
        }),
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  const code = e.code ?? '';
  const message = (e.message ?? '').toLowerCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === '57P01' ||
    code === '40001' ||
    code === '40P01' ||
    message.includes('connection terminated') ||
    message.includes('timeout') ||
    message.includes('temporarily unavailable')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
