import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncValue<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

export function useAsync<T>(loader: () => Promise<T>, dependencies: readonly unknown[] = []): AsyncValue<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loaderRef.current()
      .then((value) => { if (active) setData(value); })
      .catch((reason: unknown) => { if (active) setError(reason); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [...dependencies, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, reload, setData };
}
