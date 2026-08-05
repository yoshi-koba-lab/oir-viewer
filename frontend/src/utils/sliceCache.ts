import { fetchAllChannelsBin, type FetchChannelsOpts, type AllChannelsBinResponse } from './api';

/**
 * LRU cache for decoded channel slices, keyed by the exact fetch params.
 * Bounds memory by total pixel bytes rather than entry count, so it behaves
 * well for both small (512²) and large (2048²) images. Cached entries let
 * Z/T scrubbing and timelapse loops re-display instantly without a round-trip.
 */

const MAX_BYTES = 300 * 1024 * 1024; // ~300 MB budget

interface Entry {
  key: string;
  resp: AllChannelsBinResponse;
  bytes: number;
}

// Map preserves insertion order → front = least recently used.
const cache = new Map<string, Entry>();
let totalBytes = 0;

function keyOf(o: FetchChannelsOpts): string {
  return [
    o.id ?? '',
    `z${o.z}`,
    `t${o.t}`,
    o.mip ? 'mip' : '',
    o.proj ? `proj:${o.projMethod}:${o.projZFrom}:${o.projZTo}` : '',
  ].join('|');
}

function respBytes(resp: AllChannelsBinResponse): number {
  let n = 0;
  for (const ch of resp.channels) n += ch.data.byteLength;
  return n;
}

function touch(key: string, entry: Entry) {
  // Re-insert to move to the most-recently-used position.
  cache.delete(key);
  cache.set(key, entry);
}

function evictToBudget() {
  while (totalBytes > MAX_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const e = cache.get(oldest);
    if (e) totalBytes -= e.bytes;
    cache.delete(oldest);
  }
}

// Requests currently in flight, so concurrent asks for the same slice (e.g. the
// load effect and a prefetch racing) share one response instead of each
// inserting its own copy — which double-counted totalBytes and evicted the
// cache down to a single entry.
const inFlight = new Map<string, Promise<AllChannelsBinResponse>>();

/** Fetch channels, serving from the LRU cache when possible. */
export async function fetchAllChannelsCached(opts: FetchChannelsOpts): Promise<AllChannelsBinResponse> {
  const key = keyOf(opts);
  const hit = cache.get(key);
  if (hit) {
    touch(key, hit);
    return hit.resp;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = fetchAllChannelsBin(opts)
    .then((resp) => {
      const bytes = respBytes(resp);
      // Replacing an existing key must return its bytes to the budget first.
      const prev = cache.get(key);
      if (prev) totalBytes -= prev.bytes;
      cache.set(key, { key, resp, bytes });
      totalBytes += bytes;
      evictToBudget();
      return resp;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

/** Warm the cache for a slice without applying it (fire-and-forget). */
export function prefetchSlice(opts: FetchChannelsOpts): void {
  const key = keyOf(opts);
  if (cache.has(key)) return;
  fetchAllChannelsCached(opts).catch(() => { /* best-effort */ });
}

/** Drop all cached slices for an image (e.g. when it is closed). */
export function clearImageCache(id: string): void {
  for (const [key, entry] of cache) {
    if (key.startsWith(`${id}|`)) {
      totalBytes -= entry.bytes;
      cache.delete(key);
    }
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(`${id}|`)) inFlight.delete(key);
  }
}
