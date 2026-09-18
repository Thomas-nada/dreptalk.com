// CAP portal mirror: pull the portal's CIP-100 feed and open one system thread
// per CAP/CIS, its body the opening post and its portal comments the replies.
// The portal is off-chain, so this is a document mirror, not a chain read: there
// is no anchor to verify and no tally to compute, only a thread to keep in step
// with a source of record that lives elsewhere.
//
// Every reconcile is idempotent and isolated per proposal. The metadata row is
// rewritten first (so the thread's page always states the current status and
// version), the thread is opened once under a claim (so two overlapping runs
// cannot double it), the opening post is corrected only when the portal content
// hash moved, and the comment posts are reconciled to match. One proposal
// failing (a portal hiccup on its document) is logged and skipped; the rest of
// the run still reconciles.

import { CAPS_CATEGORY_SLUG } from '../../../config/categories.js';
import { getCapByNumber, reconcileCapThreadPosts, upsertCapMeta } from '../db/caps.js';
import { buildCapClaim } from '../db/caps.js';
import { createTopic, setGovTopicTitleAndBody } from '../db/forum.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { renderMarkdown } from '../markdown.js';
import type { CapSource } from './types.js';
import { buildCapThreadPlan } from './view.js';

export interface CapSyncDeps {
  db: D1Database;
  source: CapSource;
  now: number;
  /** Slug-suffix source (injected for deterministic tests). */
  rand: () => string;
}

export interface CapSyncResult {
  /** Proposals seen in the feed this run. */
  scanned: number;
  /** Threads opened this run. */
  opened: number;
  /** Threads whose opening post was rewritten (portal content moved). */
  bodiesUpdated: number;
  /** Comment posts inserted, updated, and soft-deleted across all threads. */
  commentsInserted: number;
  commentsUpdated: number;
  commentsRemoved: number;
  /** Proposals that failed to reconcile (logged, skipped). */
  failed: number;
}

async function reconcileOne(
  deps: CapSyncDeps,
  number: number,
  result: CapSyncResult,
): Promise<void> {
  const { db, source, now, rand } = deps;
  const doc = await source.getDocument(number);
  const plan = buildCapThreadPlan(doc);

  // Read the row as it stands (topic link + last content hash) before the
  // metadata upsert overwrites the hash, so the opening-post rewrite below can
  // tell whether the portal content actually moved.
  const prev = await getCapByNumber(db, plan.number);
  await upsertCapMeta(
    db,
    {
      number: plan.number,
      docType: plan.docType,
      title: plan.title,
      category: plan.category,
      status: plan.status,
      contentHash: plan.contentHash,
      currentVersion: plan.currentVersion,
      sourceUrl: plan.sourceUrl,
      submittedAt: plan.submittedAt,
      // The full version history, stored verbatim for the thread page's version
      // switcher. An empty history stores an empty array, not null, so a proposal
      // that later loses its history is not read as "never had one".
      versionsJson: JSON.stringify(doc.body.cap.versionHistory ?? []),
    },
    now,
  );

  const openingHtml = renderMarkdown(plan.openingMd);
  let topicId = prev?.topic_id ?? null;

  if (!topicId) {
    const created = await createTopic(db, {
      categorySlug: CAPS_CATEGORY_SLUG,
      authorId: GOV_SYNC_AUTHOR,
      title: plan.title,
      bodyMd: plan.openingMd,
      bodyHtml: openingHtml,
      source: 'cap',
      now,
      postedAt: plan.submittedAt ?? now,
      rand: rand(),
      ...buildCapClaim(db, plan.number),
    });
    if (created) {
      topicId = created.topic.id;
      result.opened++;
    } else {
      // Lost the claim to a concurrent run; that run owns the thread. Re-read the
      // row to pick up the topic id it set, so comments still reconcile here.
      topicId = (await getCapByNumber(db, plan.number))?.topic_id ?? null;
    }
  } else if (prev && (prev.content_hash !== plan.contentHash || prev.title !== plan.title)) {
    await setGovTopicTitleAndBody(db, {
      topicId,
      title: plan.title,
      bodyMd: plan.openingMd,
      bodyHtml: openingHtml,
    });
    result.bodiesUpdated++;
  }

  if (!topicId) return;

  const posts = plan.comments.map(c => ({
    postId: c.postId,
    parentPostId: c.parentPostId,
    createdAt: c.createdAt,
    bodyMd: c.bodyMd,
    bodyHtml: renderMarkdown(c.bodyMd),
  }));
  const reconciled = await reconcileCapThreadPosts(db, {
    topicId,
    authorId: GOV_SYNC_AUTHOR,
    posts,
    now,
  });
  result.commentsInserted += reconciled.inserted;
  result.commentsUpdated += reconciled.updated;
  result.commentsRemoved += reconciled.removed;
}

export async function syncCaps(deps: CapSyncDeps): Promise<CapSyncResult> {
  const result: CapSyncResult = {
    scanned: 0,
    opened: 0,
    bodiesUpdated: 0,
    commentsInserted: 0,
    commentsUpdated: 0,
    commentsRemoved: 0,
    failed: 0,
  };

  const feed = await deps.source.listDocuments();
  for (const entry of feed) {
    if (typeof entry.number !== 'number') continue;
    result.scanned++;
    try {
      await reconcileOne(deps, entry.number, result);
    } catch (err) {
      console.error(`[caps] reconcile of CAP ${entry.number} failed`, err);
      result.failed++;
    }
  }
  return result;
}
