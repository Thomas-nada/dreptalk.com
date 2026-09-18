// The subset of the CAP portal's CIP-100 responses this mirror reads. The portal
// serves a CIP-100 JSON-LD document per proposal at /proposals/{n}/cip100 and a
// feed of all of them at /cip100 (see cap.intersectmbo.org). Only the fields
// used to build a thread are typed here; unknown fields are ignored, so the
// portal can add to the document without breaking the mirror.

/** One entry in the portal's /cip100 feed: enough to decide what to reconcile. */
export interface CapFeedEntry {
  number: number;
  documentType: string; // 'CAP' | 'CIS'
  title: string;
  category: string | null;
  status: string | null;
  updatedAt: string | null; // ISO 8601
  contentHash: string | null;
  /** Absolute URL of this proposal's CIP-100 document. */
  cip100: string;
}

/** A single comment in a proposal's discussion thread. */
export interface CapComment {
  id: number | string;
  author: string | null;
  date: string | null; // ISO 8601
  body: string;
  /** The id of the comment this one replies to, when it is a reply. */
  inReplyTo?: number | string | null;
  /** Present (and not 'visible') only when the portal has moderated the comment. */
  moderationStatus?: string | null;
}

/** The CAP-specific extension block on the CIP-100 document body. */
/** One proposed change to the constitution's text. Two shapes: a replacement
 * carries `original` (the current text) and `proposed` (what replaces it); an
 * addition carries `insert_after` (the anchor text) and `proposed` (the new text
 * to insert after it), with `type` naming the kind. `section` is the clause the
 * change touches. */
export interface CapRevision {
  type?: string | null; // e.g. 'addition'; absent for a plain replacement
  section?: string | null;
  original?: string | null;
  insert_after?: string | null;
  proposed?: string | null;
}

/** A reference/link on the document. */
export interface CapReference {
  '@type'?: string | null;
  label?: string | null;
  uri?: string | null;
}

/** The per-version body content, same field set as the document body. */
export interface CapVersionContent {
  abstract?: string | null;
  motivation?: string | null;
  rationale?: string | null;
  impact?: string | null;
  references?: CapReference[];
  proposedRevisions?: CapRevision[];
}

/** One entry in the proposal's version chain. `content` is present in the full
 * document (used by the thread page's version switcher) and absent from the
 * summary lists that only need version/date/author. */
export interface CapVersion {
  version: number;
  changeSummary?: string | null;
  date?: string | null; // ISO 8601
  author?: string | null;
  title?: string | null;
  content?: CapVersionContent;
}

export interface CapExtension {
  number: number;
  documentType: string; // 'CAP' | 'CIS'
  category: string | null;
  status: string | null;
  sourceUrl: string | null;
  submittedAt: string | null; // ISO 8601
  currentVersion: number | null;
  portalContentHash: string | null;
  proposedRevisions?: CapRevision[];
  versionHistory?: CapVersion[];
  discussion?: CapComment[];
}

/** A CIP-100 governance-metadata document as served by the CAP portal. */
export interface CapDocument {
  body: {
    title: string;
    abstract?: string | null;
    motivation?: string | null;
    rationale?: string | null;
    impact?: string | null;
    references?: CapReference[];
    cap: CapExtension;
  };
}

/** Read-only view of the CAP portal the mirror depends on. Injected so the sync
 * is tested against a fake rather than the network. */
export interface CapSource {
  /** Base origin of the portal API, for reference/logging. */
  readonly baseUrl: string;
  /** The /cip100 feed: every visible proposal, newest activity first. */
  listDocuments(): Promise<CapFeedEntry[]>;
  /** One proposal's full CIP-100 document, body plus versions and discussion. */
  getDocument(number: number): Promise<CapDocument>;
}
