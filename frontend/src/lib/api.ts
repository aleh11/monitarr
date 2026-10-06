import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/api/login")
      window.dispatchEvent(new Event("monitarr:unauthorized"));
    throw new ApiError(
      typeof data.detail === "string"
        ? data.detail
        : `Request failed (${response.status}). Please try again.`,
      response.status,
    );
  }
  return response.json();
}

export function useResource<T>(path: string, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const lastPath = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    if (lastPath.current !== path) {
      setData(undefined);
      lastPath.current = path;
    }
    setLoading(true);
    async function load() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const result = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Unable to load data");
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = interval
      ? window.setInterval(() => {
          if (!document.hidden) void load();
        }, interval)
      : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [path, interval, version]);
  return { data, error, loading, reload, replace: setData };
}

export function post<T = { ok: boolean }>(
  path: string,
  body?: unknown,
  method = "POST",
) {
  return api<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
