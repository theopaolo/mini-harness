/**
 * Course entre une promesse et un délai. Le timer est toujours nettoyé, sinon le
 * process resterait vivant jusqu'à son expiration.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout: ${label} dépassé ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
