'use client';

import { useEffect, useState } from 'react';
import { getJson, isAbort, type Wire } from './api';

export type ApiState<T> = { data: Wire<T> | null; error: unknown; loading: boolean };

// Fetches `url` whenever it (or `version`) changes. The previous data stays on screen while the next answer loads
// and after a failed one (with `error` set), and an answer that arrives after a newer request started is dropped
// (the request is aborted).
export function useApi<T>(url: string | null, version: number): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: url !== null });
  useEffect(() => {
    if (url === null) return;
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    getJson<T>(url, { signal: ctl.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: unknown) => {
        if (!isAbort(error)) setState((s) => ({ data: s.data, error, loading: false }));
      });
    return () => ctl.abort();
  }, [url, version]);
  return state;
}
