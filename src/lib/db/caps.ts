/// <reference types="@cloudflare/workers-types" />
// D1 access for the `caps` table: the mirror's record of every CAP/CIS pulled
// from the portal, and the link from a proposal to the forum topic that holds
// its thread. All writes are idempotent upserts keyed by the portal proposal
// number, so a re-sync updates in place. Parameterized throughout; never
// string-concatenated SQL.

import type { CapVersion } from '../cap/types.js';
import { type Topic, type TopicRow, rowToTopic } from './forum.js';
import type { TopicGuard } from './forum.js';

export interface CapRow {
  number: number;
  doc_type: string;
  title: string | null;
  category: string | null;
  status: string | null;
  content_hash: string | null;
  current_version: number | null;
  source_url: string | null;
  submitted_at: number | null;
  topic_id: string | null;
  created_at: number;
  last_synced_at: number;
  /** The CIP-100 versionHistory as JSON (each entry with its content), or null. */
  versions_json: string | null;
}

/** Metadata written on every reconcile. `topic_id` and `created_at` are managed
 * separately (the claim sets the topic, the first insert sets created_at), so a
 * metadata upsert never clobbers either. */
export interface CapMeta {
  number: number;
  docType: string;
  title: string;
  category: string | null;
  status: string | null;
  contentHash: string | null;
  currentVersion: number | null;
  sourceUrl: string | null;
  submittedAt: number | null;
  /** The version history as JSON (each entry with its content), or null. */
  versionsJson: string | null;
}

export async function getCapByNumber(db: D1Database, number: number): Promise<CapRow | null> {
  return (
    (await db.prepare('SELECT * FROM caps WHERE number = ?').bind(number).first<CapRow>()) ?? null
  );
}

export async function getCapByTopicId(db: D1Database, topicId: string): Promise<CapRow | null> {
  return (
    (await db.prepare('SELECT * FROM caps WHERE topic_id = ?').bind(topicId).first<CapRow>()) ??
    null
  );
}

/** Upserts the metadata row, preserving `topic_id` and `created_at` on conflict:
 * the thread link is owned by the claim, and the creation time by the first
 * insert. Returns nothing; the caller reads back state it needs separately. */
export async function upsertCapMeta(db: D1Database, meta: CapMeta, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO caps
         (number, doc_type, title, category, status, content_hash, current_version,
          source_url, submitted_at, versions_json, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(number) DO UPDATE SET
         doc_type = excluded.doc_type,
         title = excluded.title,
         category = excluded.category,
         status = excluded.status,
         content_hash = excluded.content_hash,
         current_version = excluded.current_version,
         source_url = excluded.source_url,
         submitted_at = excluded.submitted_at,
         versions_json = excluded.versions_json,
         last_synced_at = excluded.last_synced_at`,
    )
    .bind(
      meta.number,
      meta.docType,
      meta.title,
      meta.category,
      meta.status,
      meta.contentHash,
      meta.currentVersion,
      meta.sourceUrl,
      meta.submittedAt,
      meta.versionsJson,
      now,
      now,
    )
    .run();
}

/** The claim a CAP's thread is opened under: the topic and its opening post are
 * inserted only while the row still has no topic (so two overlapping runs cannot
 * both open one), and the same batch stamps the new topic id onto the row. */
const UNCLAIMED = 'number = ? AND topic_id IS NULL';

export function buildCapClaim(
  db: D1Database,
  number: number,
): { guard: TopicGuard; batchWith: (topicId: string) => D1PreparedStatement[] } {
  return {
    guard: { sql: `SELECT 1 FROM caps WHERE ${UNCLAIMED}`, binds: [number] },
    batchWith: topicId => [
      db.prepare(`UPDATE caps SET topic_id = ? WHERE ${UNCLAIMED}`).bind(topicId, number),
    ],
  };
}

/** Topics in the CAPs category, newest activity first, optionally filtered to a
 * single document type ('CAP' or 'CIS'). Joins through the caps row that owns
 * each topic, so a topic with no caps row (impossible in practice) is excluded. */
export async function getCapTopics(
  db: D1Database,
  opts: { docType?: 'CAP' | 'CIS' | null; limit?: number; offset?: number } = {},
): Promise<Topic[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const typeClause = opts.docType ? ' AND c.doc_type = ?' : '';
  const binds: unknown[] = opts.docType ? [opts.docType, limit, offset] : [limit, offset];
  const rows = await db
    .prepare(
      `SELECT t.* FROM topics t JOIN caps c ON c.topic_id = t.id
       WHERE t.deleted = 0${typeClause}
       ORDER BY t.pinned DESC, t.last_post_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds)
    .all<TopicRow>();
  return rows.results.map(rowToTopic);
}

/** Parses the stored version history, newest version first, tolerating a null,
 * malformed, or non-array value by returning an empty list (the thread page
 * then simply shows no switcher). */
export function parseCapVersions(versionsJson: string | null): CapVersion[] {
  if (!versionsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(versionsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as CapVersion[])
    .filter(v => v && typeof v.version === 'number')
    .sort((a, b) => b.version - a.version);
}

/** Per-type counts for the CAPs listing tabs: total, CAPs, and CISs. */
export async function getCapTypeCounts(
  db: D1Database,
): Promise<{ all: number; cap: number; cis: number }> {
  const rows = await db
    .prepare('SELECT doc_type, COUNT(*) AS n FROM caps GROUP BY doc_type')
    .all<{ doc_type: string; n: number }>();
  let cap = 0;
  let cis = 0;
  for (const r of rows.results) {
    if (r.doc_type === 'CIS') cis += r.n;
    else cap += r.n;
  }
  return { all: cap + cis, cap, cis };
}

/** One mirrored comment ready to store: id and body already composed by the
 * pure view layer, html already rendered by the sync layer. */
export interface CapMirrorPost {
  postId: string;
  parentPostId: string | null;
  createdAt: number | null;
  bodyMd: string;
  bodyHtml: string;
}

export interface CapReconcileResult {
  inserted: number;
  updated: number;
  removed: number;
}

/**
 * Reconciles a CAP topic's mirrored comment posts to match the portal: inserts
 * new comments, rewrites changed ones, and soft-deletes any cap-sourced post no
 * longer present upstream (removed or moderated on the portal). Then recomputes
 * the topic's post_count and last_post_at from the live rows so the denormalized
 * counters cannot drift. Idempotent: a run with nothing changed writes only the
 * counter recompute.
 *
 * Comments are authored by `authorId` (the gov-sync system author); a portal
 * commenter is not a wallet-verified DRepTalk writer, so their name lives in the
 * post body, not in a post identity. No activity-feed events are emitted: this
 * is a historical mirror, not a stream of live replies, and emitting one event
 * per imported comment would swamp the feed on the first sync.
 */
export async function reconcileCapThreadPosts(
  db: D1Database,
  args: { topicId: string; authorId: string; posts: CapMirrorPost[]; now: number },
): Promise<CapReconcileResult> {
  const { topicId, authorId, posts, now } = args;
  const existing = await db
    .prepare(
      `SELECT id, body_md, parent_post_id, created_at, deleted
         FROM posts WHERE topic_id = ? AND source = 'cap'`,
    )
    .bind(topicId)
    .all<{
      id: string;
      body_md: string | null;
      parent_post_id: string | null;
      created_at: number;
      deleted: number;
    }>();

  const existingById = new Map(existing.results.map(r => [r.id, r]));
  const desired = new Set(posts.map(p => p.postId));
  const statements: D1PreparedStatement[] = [];
  let inserted = 0;
  let updated = 0;
  let removed = 0;

  for (const p of posts) {
    const ex = existingById.get(p.postId);
    // Fall back to the existing time on update (never a fresh `now`, which would
    // re-flag the row as changed every run), and to `now` only on first insert.
    const createdAt = p.createdAt ?? ex?.created_at ?? now;
    if (!ex) {
      statements.push(
        db
          .prepare(
            `INSERT INTO posts
               (id, topic_id, author_id, parent_post_id, body_md, body_html, created_at, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'cap')`,
          )
          .bind(p.postId, topicId, authorId, p.parentPostId, p.bodyMd, p.bodyHtml, createdAt),
      );
      inserted++;
      continue;
    }
    const changed =
      ex.deleted === 1 ||
      ex.body_md !== p.bodyMd ||
      ex.parent_post_id !== p.parentPostId ||
      ex.created_at !== createdAt;
    if (changed) {
      statements.push(
        db
          .prepare(
            `UPDATE posts SET parent_post_id = ?, body_md = ?, body_html = ?, created_at = ?,
               deleted = 0, deleted_at = NULL
             WHERE id = ?`,
          )
          .bind(p.parentPostId, p.bodyMd, p.bodyHtml, createdAt, p.postId),
      );
      updated++;
    }
  }

  for (const r of existing.results) {
    if (!desired.has(r.id) && r.deleted !== 1) {
      statements.push(
        db.prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(now, r.id),
      );
      removed++;
    }
  }

  // Recompute the denormalized counters from the live rows (opening post plus
  // every non-deleted mirrored comment). Runs last so it sees the writes above.
  statements.push(
    db
      .prepare(
        `UPDATE topics SET
           post_count = (SELECT COUNT(*) FROM posts WHERE topic_id = ? AND deleted = 0),
           last_post_at = COALESCE(
             (SELECT MAX(created_at) FROM posts WHERE topic_id = ? AND deleted = 0),
             last_post_at)
         WHERE id = ?`,
      )
      .bind(topicId, topicId, topicId),
  );

  if (statements.length > 0) await db.batch(statements);
  return { inserted, updated, removed };
}
