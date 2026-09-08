/** REST client：统一 { data } / { error } 响应约定（方案 §4.3） */
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json as any).error ?? { code: 'E_INTERNAL', message: `HTTP ${res.status}` };
    throw new ApiError(err.code, err.message, res.status);
  }
  return (json as any).data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),

  /** multipart 文件上传 */
  uploadFile: async <T>(path: string, file: Blob, filename: string): Promise<T> => {
    const fd = new FormData();
    fd.append('file', file, filename);
    const res = await fetch(`${BASE}${path}`, { method: 'POST', body: fd });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as any).error ?? { code: 'E_INTERNAL', message: `HTTP ${res.status}` };
      throw new ApiError(err.code, err.message, res.status);
    }
    return (json as any).data as T;
  },
};
