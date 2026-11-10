export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const isBlob = opts.body instanceof Blob;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body === undefined ? {} : { 'content-type': isBlob ? 'audio/wav' : 'application/json' },
    body: opts.body === undefined ? undefined : isBlob ? (opts.body as Blob) : JSON.stringify(opts.body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
