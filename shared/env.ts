export function ensureEnvs<const T extends readonly string[]>(
  keys: T,
  source: Record<string, string | undefined> = process.env,
) {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = source[key];
    if (value) {
      env[key] = value;
    } else {
      missing.push(key);
    }
  }
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  return env as Record<T[number], string>;
}
