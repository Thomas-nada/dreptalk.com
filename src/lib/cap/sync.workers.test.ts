import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getCapByNumber, parseCapVersions } from '../db/caps.js';
import type { CapDocument, CapFeedEntry, CapSource } from './types.js';
import { syncCaps } from './sync.js';

const DB = env.DB as D1Database;

/** A CapSource over an in-memory map of documents the test mutates between runs. */
function fakeSource(docs: Map<number, CapDocument>): CapSource {
  return {
    baseUrl: 'https://portal.test',
    async listDocuments(): Promise<CapFeedEntry[]> {
      return [...docs.values()].map(d => ({
        number: d.body.cap.number,
        documentType: d.body.cap.documentType,
        title: d.body.title,
        category: d.body.cap.category,
        status: d.body.cap.status,
        updatedAt: null,
        contentHash: d.body.cap.portalContentHash,
        cip100: `https://portal.test/proposals/${d.body.cap.number}/cip100`,
      }));
    },
    async getDocument(number: number): Promise<CapDocument> {
      const d = docs.get(number);
      if (!d) throw new Error(`no doc ${number}`);
      return d;
    },
  };
}

function makeDoc(
  over: Partial<CapDocument['body']['cap']> & { title?: string; hash?: string } = {},
): CapDocument {
  const { title = 'The Bundling Gap', hash = 'h1', ...cap } = over;
  return {
    body: {
      title,
      abstract: 'A summary.',
      motivation: 'The why.',
      rationale: 'The analysis.',
      impact: null,
      references: [],
      cap: {
        number: 4,
        documentType: 'CIS',
        category: 'Procedural',
        status: 'consultation',
        sourceUrl: 'https://cap.intersectmbo.org/#/detail/4',
        submittedAt: '2026-08-07T11:20:00+00:00',
        currentVersion: 1,
        portalContentHash: hash,
        proposedRevisions: [],
        versionHistory: [],
        discussion: [
          { id: 1, author: 'Styg', date: '2026-08-08T10:00:00+00:00', body: 'Top comment.' },
          {
            id: 2,
            author: 'Alice',
            date: '2026-08-09T10:00:00+00:00',
            body: 'A reply.',
            inReplyTo: 1,
          },
        ],
        ...cap,
      },
    },
  };
}

async function threadPosts(topicId: string) {
  const rows = await DB.prepare(
    'SELECT id, source, parent_post_id, deleted, body_md FROM posts WHERE topic_id = ? ORDER BY created_at',
  )
    .bind(topicId)
    .all<{
      id: string;
      source: string | null;
      parent_post_id: string | null;
      deleted: number;
      body_md: string | null;
    }>();
  return rows.results;
}

async function topicRow(topicId: string) {
  return DB.prepare('SELECT source, category_slug, title, post_count FROM topics WHERE id = ?')
    .bind(topicId)
    .first<{ source: string; category_slug: string; title: string; post_count: number }>();
}

const deps = (source: CapSource, now = 1_000_000) => ({
  db: DB,
  source,
  now,
  rand: () => 'seed1234',
});

describe('syncCaps', () => {
  it('opens one thread per CAP with the body as the opening post and comments mirrored', async () => {
    const docs = new Map([[4, makeDoc()]]);
    const r = await syncCaps(deps(fakeSource(docs)));
    expect(r).toMatchObject({ scanned: 1, opened: 1, commentsInserted: 2, failed: 0 });

    const cap = await getCapByNumber(DB, 4);
    expect(cap?.topic_id).toBeTruthy();
    expect(cap?.doc_type).toBe('CIS');

    const topic = await topicRow(cap!.topic_id as string);
    expect(topic).toMatchObject({
      source: 'cap',
      category_slug: 'caps',
      title: 'CIS-4: The Bundling Gap',
    });
    expect(topic?.post_count).toBe(3); // opening + 2 comments

    const posts = await threadPosts(cap!.topic_id as string);
    const opening = posts.find(p => p.source === null);
    expect(opening?.body_md).toContain('### Summary');
    const capPosts = posts.filter(p => p.source === 'cap');
    expect(capPosts.map(p => p.id)).toEqual(['cap-4-c1', 'cap-4-c2']);
    const reply = capPosts.find(p => p.id === 'cap-4-c2');
    expect(reply?.parent_post_id).toBe('cap-4-c1');
  });

  it('is idempotent: a second run with identical data opens and inserts nothing', async () => {
    const docs = new Map([[4, makeDoc()]]);
    const source = fakeSource(docs);
    await syncCaps(deps(source));
    const second = await syncCaps(deps(source, 2_000_000));
    expect(second).toMatchObject({
      opened: 0,
      commentsInserted: 0,
      commentsUpdated: 0,
      commentsRemoved: 0,
    });

    const cap = await getCapByNumber(DB, 4);
    const topic = await topicRow(cap!.topic_id as string);
    expect(topic?.post_count).toBe(3);
  });

  it('rewrites the opening post and title when the portal content hash moves', async () => {
    const docs = new Map([[4, makeDoc()]]);
    const source = fakeSource(docs);
    await syncCaps(deps(source));

    docs.set(4, makeDoc({ title: 'The Bundling Gap, revised', hash: 'h2', currentVersion: 2 }));
    const r = await syncCaps(deps(source, 2_000_000));
    expect(r.bodiesUpdated).toBe(1);

    const cap = await getCapByNumber(DB, 4);
    expect(cap?.content_hash).toBe('h2');
    expect(cap?.current_version).toBe(2);
    const topic = await topicRow(cap!.topic_id as string);
    expect(topic?.title).toBe('CIS-4: The Bundling Gap, revised');
    const opening = (await threadPosts(cap!.topic_id as string)).find(p => p.source === null);
    expect(opening?.body_md).toContain('currently v2');
  });

  it('inserts newly added comments and soft-deletes ones removed upstream', async () => {
    const docs = new Map([[4, makeDoc()]]);
    const source = fakeSource(docs);
    await syncCaps(deps(source));

    // Add a third comment.
    const withExtra = makeDoc();
    withExtra.body.cap.discussion = [
      ...withExtra.body.cap.discussion!,
      { id: 3, author: 'Bob', date: '2026-08-10T10:00:00+00:00', body: 'Late comment.' },
    ];
    docs.set(4, withExtra);
    const added = await syncCaps(deps(source, 2_000_000));
    expect(added.commentsInserted).toBe(1);
    const cap = await getCapByNumber(DB, 4);
    expect((await topicRow(cap!.topic_id as string))?.post_count).toBe(4);

    // Remove the reply (id 2) upstream.
    const removed = makeDoc();
    removed.body.cap.discussion = [
      { id: 1, author: 'Styg', date: '2026-08-08T10:00:00+00:00', body: 'Top comment.' },
      { id: 3, author: 'Bob', date: '2026-08-10T10:00:00+00:00', body: 'Late comment.' },
    ];
    docs.set(4, removed);
    const afterRemoval = await syncCaps(deps(source, 3_000_000));
    expect(afterRemoval.commentsRemoved).toBe(1);
    const posts = await threadPosts(cap!.topic_id as string);
    expect(posts.find(p => p.id === 'cap-4-c2')?.deleted).toBe(1);
    expect((await topicRow(cap!.topic_id as string))?.post_count).toBe(3); // opening + c1 + c3
  });

  it('stores the version history so the thread page can switch versions', async () => {
    const d = makeDoc();
    d.body.cap.versionHistory = [
      {
        version: 1,
        changeSummary: 'Initial submission',
        date: '2026-08-06T00:00:00+00:00',
        author: 'Styg',
        content: { abstract: 'v1 summary', motivation: 'v1 problem', proposedRevisions: [] },
      },
      {
        version: 2,
        changeSummary: 'Revised',
        date: '2026-08-25T00:00:00+00:00',
        author: 'Styg',
        content: { abstract: 'v2 summary', motivation: 'v2 problem', proposedRevisions: [] },
      },
    ];
    const docs = new Map([[4, d]]);
    await syncCaps(deps(fakeSource(docs)));

    const cap = await getCapByNumber(DB, 4);
    const versions = parseCapVersions(cap!.versions_json);
    expect(versions.map(v => v.version)).toEqual([2, 1]); // newest first
    expect(versions[0].content?.abstract).toBe('v2 summary');
    expect(versions[1].content?.abstract).toBe('v1 summary');
  });

  it('isolates a failing document so the rest of the feed still reconciles', async () => {
    const docs = new Map([
      [4, makeDoc()],
      [9, makeDoc({ number: 9, documentType: 'CAP' })],
    ]);
    const source = fakeSource(docs);
    // Make document 4 fail on fetch, 9 still succeeds.
    const broken: CapSource = {
      ...source,
      async getDocument(n: number) {
        if (n === 4) throw new Error('portal 500');
        return source.getDocument(n);
      },
    };
    const r = await syncCaps(deps(broken));
    expect(r.failed).toBe(1);
    expect(r.opened).toBe(1);
    expect(await getCapByNumber(DB, 9)).toBeTruthy();
  });
});
