/** Every external data source implements this shape, so jobs never care
 *  whether a value came from the network or the cache. */
export type Source<P, R> = {
  /** Stable name; also the cache namespace. */
  readonly name: string;
  /** Deterministic cache key for a set of params. */
  key(params: P): string;
  /** How long a fetched value stays fresh. */
  ttlMinutes(params: P): number;
  /** The live call. Never invoked when a fresh cached value exists. */
  fetch(params: P): Promise<R>;
};

export type Fetched<R> = {
  value: R;
  /** true when the value came from SQLite rather than the network. */
  cached: boolean;
  fetchedAt: string;
};
