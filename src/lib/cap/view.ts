// Pure mapping from a CAP portal CIP-100 document to a forum thread: the topic
// title, the opening post markdown, and one mirrored post per portal comment.
// No I/O and no database, so the shaping is unit-tested on its own and the sync
// module only has to be tested for its database effects.
//
// Every string that ends up stored is run through the shared external-text
// sanitizers first: the portal is a trusted peer, but its content is still
// user-authored prose arriving over the network, and it is rendered through the
// same hardened markdown path as on-chain anchor text.

import {
  MAX_EXTERNAL_TITLE_LEN,
  sanitizeExternalMultiline,
  sanitizeExternalText,
} from '../validation/input.js';
import type { CapComment, CapDocument, CapReference, CapRevision, CapVersion } from './types.js';

/** A section of prose is capped well above any real CAP field but far below a
 * runaway body: a mirror post is a pointer to the portal, not a place to store
 * an unbounded document. */
const MAX_SECTION_LEN = 16_000;

export type CapDocType = 'CAP' | 'CIS';

/** One portal comment, mapped to a post ready to store. */
export interface MirroredComment {
  /** Deterministic id, so a re-sync updates the same post instead of adding one. */
  postId: string;
  /** Top-level parent post id, or null for a top-level comment. */
  parentPostId: string | null;
  /** Comment time in unix ms, or null when the portal gave none. */
  createdAt: number | null;
  bodyMd: string;
}

/** Everything a sync run needs to open or reconcile one CAP's thread. */
export interface CapThreadPlan {
  number: number;
  docType: CapDocType;
  title: string;
  category: string | null;
  status: string | null;
  contentHash: string | null;
  currentVersion: number | null;
  sourceUrl: string | null;
  /** First-submission time in unix ms (the thread's post date), or null. */
  submittedAt: number | null;
  openingMd: string;
  comments: MirroredComment[];
}

/** Normalizes the portal's documentType to the two kinds the mirror knows;
 * anything unexpected is treated as a CAP (the general document kind). */
export function capDocType(raw: string | null | undefined): CapDocType {
  return String(raw ?? '').toUpperCase() === 'CIS' ? 'CIS' : 'CAP';
}

/** Section headings differ by document type, matching the CAP portal's own
 * labels: a CIS states a Problem, its Context and its Impact, where a CAP argues
 * why a change is needed and shows its analysis. */
export function sectionLabels(docType: CapDocType): {
  motivation: string;
  analysis: string;
} {
  return docType === 'CIS'
    ? { motivation: 'Problem', analysis: 'Context' }
    : { motivation: 'Why is this change needed?', analysis: 'Analysis and test' };
}

/** ISO 8601 (or anything Date.parse accepts) to unix ms, or null. */
export function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The thread title: "CAP-3: <title>" / "CIS-4: <title>", sanitized and capped. */
export function capThreadTitle(docType: CapDocType, number: number, rawTitle: string): string {
  const title = sanitizeExternalText(rawTitle, MAX_EXTERNAL_TITLE_LEN);
  const prefix = `${docType}-${number}`;
  return title ? `${prefix}: ${title}` : prefix;
}

/** Deterministic post id for a mirrored comment. Stable across runs so the
 * mirror upserts rather than duplicates, and namespaced by CAP number so two
 * proposals cannot collide on a shared portal comment id. */
export function capCommentPostId(number: number, commentId: number | string): string {
  return `cap-${number}-c${commentId}`;
}

function section(heading: string, body: string | null | undefined): string[] {
  const text = sanitizeExternalMultiline(String(body ?? ''), MAX_SECTION_LEN);
  return text ? [`### ${heading}`, '', text, ''] : [];
}

/** A blockquote of untrusted multi-line text, or null when empty. Each line is
 * prefixed so a blank line inside does not end the quote. */
function quote(text: string | null | undefined): string | null {
  const t = sanitizeExternalMultiline(String(text ?? ''), MAX_SECTION_LEN);
  if (!t) return null;
  return t
    .split('\n')
    .map(l => (l ? `> ${l}` : '>'))
    .join('\n');
}

/** The proposed changes to the constitution's text, the "suggested changes" the
 * portal shows: each revision under its section, rendered as the current text
 * and its replacement, or the anchor and the text to insert after it. */
export function composeRevisions(revisions: CapRevision[] | undefined): string[] {
  const items = (revisions ?? []).filter(r => r && (r.proposed || r.original));
  if (items.length === 0) return [];
  const out: string[] = ['### Proposed changes', ''];
  for (const r of items) {
    const sec = sanitizeExternalText(String(r.section ?? ''), 160);
    if (sec) out.push(`**${sec}**`, '');
    const isAddition = r.insert_after != null && String(r.insert_after).trim() !== '';
    const proposed = quote(r.proposed);
    if (isAddition) {
      const anchor = quote(r.insert_after);
      if (anchor) out.push('_Insert after:_', '', anchor, '');
      if (proposed) out.push('_New text:_', '', proposed, '');
    } else {
      const original = quote(r.original);
      if (original) out.push('_Current text:_', '', original, '');
      if (proposed) out.push('_Proposed:_', '', proposed, '');
    }
  }
  return out;
}

/** The document's references as a link list. The uri is wrapped in angle
 * brackets so a path with parentheses cannot break the markdown link. */
export function composeReferences(references: CapReference[] | undefined): string[] {
  const items = (references ?? []).filter(r => r?.uri && String(r.uri).trim() !== '');
  if (items.length === 0) return [];
  const out: string[] = ['### Links', ''];
  for (const r of items) {
    const uri = sanitizeExternalText(String(r.uri), 500);
    const label = sanitizeExternalText(String(r.label ?? ''), 160) || uri;
    out.push(`- [${label}](<${uri}>)`);
  }
  out.push('');
  return out;
}

/** The version chain as a newest-first summary list. A single-version proposal
 * has no history worth stating, so nothing is rendered; the full per-version
 * diffs live on the portal, linked from the closing pointer. */
export function composeRevisionHistory(versions: CapVersion[] | undefined): string[] {
  const items = (versions ?? []).filter(v => v && typeof v.version === 'number');
  if (items.length < 2) return [];
  const out: string[] = ['### Revision history', ''];
  for (const v of [...items].sort((a, b) => b.version - a.version)) {
    const summary = sanitizeExternalText(String(v.changeSummary ?? ''), 200) || 'Updated';
    const ms = isoToMs(v.date);
    const when = ms ? new Date(ms).toISOString().slice(0, 10) : null;
    const author = sanitizeExternalText(String(v.author ?? ''), 120);
    const meta = [when, author].filter(Boolean).join(', ');
    out.push(`- **v${v.version}** ${summary}${meta ? ` (${meta})` : ''}`);
  }
  out.push('');
  return out;
}

/** The CAP body as prose: the lead line, the type-aware sections, the proposed
 * changes and the links. Shared by the stored opening post and the thread page's
 * per-version view, so a version selected on the thread renders identically to
 * the way it was first mirrored. No revision history and no portal pointer here;
 * those frame the body and are added by composeOpeningMd. */
export function composeBodyMd(doc: CapDocument): string {
  const cap = doc.body.cap;
  const docType = capDocType(cap.documentType);
  const labels = sectionLabels(docType);
  const category = sanitizeExternalText(String(cap.category ?? ''), 80);
  const lead = category
    ? `**${docType}-${cap.number} · ${category}**`
    : `**${docType}-${cap.number}**`;

  const lines: string[] = [`${lead}, mirrored from the CAP portal.`, ''];
  lines.push(...section('Summary', doc.body.abstract));
  lines.push(...section(labels.motivation, doc.body.motivation));
  lines.push(...section(labels.analysis, doc.body.rationale));
  if (doc.body.impact) lines.push(...section('Impact', doc.body.impact));
  lines.push(...composeRevisions(cap.proposedRevisions));
  lines.push(...composeReferences(doc.body.references));
  return lines.join('\n').trim();
}

/** The stored opening post: the body, then the revision history, then a pointer
 * to the portal for the full text, every revision, and the original discussion.
 * Metadata that the thread's own page states (status, current version) is
 * repeated only in the closing pointer, never as a frozen header the row could
 * later contradict. */
export function composeOpeningMd(doc: CapDocument): string {
  const cap = doc.body.cap;
  const lines: string[] = [composeBodyMd(doc), ''];
  lines.push(...composeRevisionHistory(cap.versionHistory));

  const url = cap.sourceUrl;
  const version =
    typeof cap.currentVersion === 'number' ? ` (currently v${cap.currentVersion})` : '';
  lines.push('---', '');
  lines.push(
    url
      ? `This thread mirrors the proposal and its discussion from the CAP portal. The full text, every revision${version}, and the original discussion are at ${url}.`
      : `This thread mirrors the proposal and its discussion from the CAP portal.`,
  );
  return lines.join('\n').trim();
}

/** Builds the markdown for a single stored version, from that version's content
 * plus the CAP's stable metadata. Used by the thread page's version switcher so
 * a past revision renders through the exact same body pipeline as the latest. */
export function composeVersionBodyMd(
  meta: { number: number; docType: CapDocType; category: string | null; sourceUrl: string | null },
  content: {
    abstract?: string | null;
    motivation?: string | null;
    rationale?: string | null;
    impact?: string | null;
    references?: CapReference[];
    proposedRevisions?: CapRevision[];
  },
): string {
  return composeBodyMd({
    body: {
      title: '',
      abstract: content.abstract ?? null,
      motivation: content.motivation ?? null,
      rationale: content.rationale ?? null,
      impact: content.impact ?? null,
      references: content.references ?? [],
      cap: {
        number: meta.number,
        documentType: meta.docType,
        category: meta.category,
        status: null,
        sourceUrl: meta.sourceUrl,
        submittedAt: null,
        currentVersion: null,
        portalContentHash: null,
        proposedRevisions: content.proposedRevisions ?? [],
        versionHistory: [],
        discussion: [],
      },
    },
  });
}

/** A mirrored comment's body: a header line naming the portal author and date,
 * then the comment prose. The author is carried in the text rather than as a
 * post identity, because a portal commenter is not a wallet-verified DRepTalk
 * writer; the mirror never presents external names as verified authors. */
export function composeCommentMd(comment: CapComment, sourceUrl: string | null): string {
  const author = sanitizeExternalText(String(comment.author ?? 'Anonymous'), 120) || 'Anonymous';
  const ms = isoToMs(comment.date);
  const when = ms ? new Date(ms).toISOString().slice(0, 10) : null;
  const link = sourceUrl ? `[CAP portal](${sourceUrl})` : 'the CAP portal';
  const header = when
    ? `**${author}** commented on ${link} · ${when}`
    : `**${author}** commented on ${link}`;
  const body = sanitizeExternalMultiline(String(comment.body ?? ''), MAX_SECTION_LEN);
  return body ? `${header}\n\n${body}` : header;
}

/**
 * Maps a document's discussion to mirrored posts, resolving each reply to its
 * top-level ancestor so the thread stays exactly one level deep, the shape
 * DRepTalk's own reply path enforces. A reply whose parent is unknown, or whose
 * chain loops, is lifted to top level rather than dropped.
 */
export function mapComments(doc: CapDocument): MirroredComment[] {
  const comments = doc.body.cap.discussion ?? [];
  const number = doc.body.cap.number;
  const sourceUrl = doc.body.cap.sourceUrl ?? null;
  const replyTo = new Map<string, string>();
  for (const c of comments) {
    if (c.inReplyTo != null) replyTo.set(String(c.id), String(c.inReplyTo));
  }

  /** Walk to the top-level ancestor id (bounded, cycle-safe). */
  const topLevel = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (replyTo.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = replyTo.get(cur) as string;
    }
    return cur;
  };

  const out: MirroredComment[] = [];
  for (const c of comments) {
    // A moderated (hidden/removed) comment is not mirrored: the portal already
    // decided it should not be shown, and the mirror does not second-guess it.
    if (c.moderationStatus && c.moderationStatus !== 'visible') continue;
    const id = String(c.id);
    const root = topLevel(id);
    const parentPostId = root === id ? null : capCommentPostId(number, root);
    out.push({
      postId: capCommentPostId(number, id),
      parentPostId,
      createdAt: isoToMs(c.date),
      bodyMd: composeCommentMd(c, sourceUrl),
    });
  }
  return out;
}

/** Builds the full plan for one CAP document. */
export function buildCapThreadPlan(doc: CapDocument): CapThreadPlan {
  const cap = doc.body.cap;
  const docType = capDocType(cap.documentType);
  return {
    number: cap.number,
    docType,
    title: capThreadTitle(docType, cap.number, doc.body.title),
    category: cap.category ?? null,
    status: cap.status ?? null,
    contentHash: cap.portalContentHash ?? null,
    currentVersion: typeof cap.currentVersion === 'number' ? cap.currentVersion : null,
    sourceUrl: cap.sourceUrl ?? null,
    submittedAt: isoToMs(cap.submittedAt),
    openingMd: composeOpeningMd(doc),
    comments: mapComments(doc),
  };
}
