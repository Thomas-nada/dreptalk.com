// The network implementation of CapSource: the CAP portal's public CIP-100
// endpoints, read anonymously. No key, no write; the portal serves these to any
// origin (open CORS on the CIP-100 routes), and the mirror only ever reads them.
// The pure mapping from a document to a thread lives in ./view.ts, so this file
// is just fetch + shape-guarding and never has to be exercised in a unit test.

import { fetchWithTimeout } from '../http/fetchWithTimeout.js';
import type { CapDocument, CapFeedEntry, CapSource } from './types.js';

/** Ten seconds per request: the portal is a single small app, and a stalled
 * body must not park the whole governance run behind it. */
const TIMEOUT_MS = 10_000;

/** The feed and each document are small (a handful of proposals, one thread
 * each), but the discussion is untrusted external JSON, so cap the body a run
 * will buffer rather than trust Content-Length. 4 MiB is far above any real
 * CAP thread and far below anything that could exhaust the worker. */
const MAX_BYTES = 4 * 1024 * 1024;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`CAP portal ${what} responded ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES)
    throw new Error(`CAP portal ${what} body exceeds ${MAX_BYTES} bytes`);
  return JSON.parse(text) as T;
}

/**
 * A CapSource backed by the live portal at `baseUrl` (e.g.
 * https://cap-portal-api.onrender.com). The feed shape is
 * `{ documents: CapFeedEntry[] }`; a missing or non-array `documents` is treated
 * as an empty feed rather than an error, so a portal that is up but has nothing
 * to serve simply reconciles nothing.
 */
export function createCapSource(baseUrl: string): CapSource {
  const base = trimTrailingSlash(baseUrl);
  return {
    baseUrl: base,
    async listDocuments(): Promise<CapFeedEntry[]> {
      const res = await fetchWithTimeout(`${base}/cip100`, {
        timeoutMs: TIMEOUT_MS,
        headers: { accept: 'application/json' },
      });
      const body = await readJson<{ documents?: unknown }>(res, 'feed');
      return Array.isArray(body.documents) ? (body.documents as CapFeedEntry[]) : [];
    },
    async getDocument(number: number): Promise<CapDocument> {
      const res = await fetchWithTimeout(`${base}/proposals/${number}/cip100`, {
        timeoutMs: TIMEOUT_MS,
        headers: { accept: 'application/ld+json, application/json' },
      });
      const doc = await readJson<CapDocument>(res, `document ${number}`);
      if (!doc || typeof doc !== 'object' || !doc.body || !doc.body.cap) {
        throw new Error(`CAP portal document ${number} is not a CIP-100 CAP document`);
      }
      return doc;
    },
  };
}
