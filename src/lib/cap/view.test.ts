import { describe, expect, it } from 'vitest';
import type { CapDocument } from './types.js';
import {
  buildCapThreadPlan,
  capCommentPostId,
  capDocType,
  capThreadTitle,
  composeBodyMd,
  composeCommentMd,
  composeOpeningMd,
  composeReferences,
  composeRevisionHistory,
  composeRevisions,
  composeVersionBodyMd,
  isoToMs,
  mapComments,
  sectionLabels,
} from './view.js';

function doc(
  overrides: Partial<CapDocument['body']['cap']> = {},
  body: Partial<CapDocument['body']> = {},
): CapDocument {
  return {
    body: {
      title: 'The Bundling Gap',
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
        currentVersion: 4,
        portalContentHash: 'abc123',
        proposedRevisions: [],
        versionHistory: [],
        discussion: [],
        ...overrides,
      },
      ...body,
    },
  };
}

describe('capDocType', () => {
  it('normalizes to CAP or CIS, defaulting unknown to CAP', () => {
    expect(capDocType('CIS')).toBe('CIS');
    expect(capDocType('cis')).toBe('CIS');
    expect(capDocType('CAP')).toBe('CAP');
    expect(capDocType('whatever')).toBe('CAP');
    expect(capDocType(null)).toBe('CAP');
  });
});

describe('sectionLabels', () => {
  it('uses CIS labels for statements and CAP labels otherwise', () => {
    expect(sectionLabels('CIS').motivation).toBe('Problem');
    expect(sectionLabels('CIS').analysis).toBe('Context');
    expect(sectionLabels('CAP').motivation).toBe('Why is this change needed?');
    expect(sectionLabels('CAP').analysis).toBe('Analysis and test');
  });
});

describe('isoToMs', () => {
  it('parses ISO strings and rejects junk', () => {
    expect(isoToMs('2026-08-07T11:20:00+00:00')).toBe(Date.parse('2026-08-07T11:20:00+00:00'));
    expect(isoToMs(null)).toBeNull();
    expect(isoToMs('not a date')).toBeNull();
  });
});

describe('capThreadTitle', () => {
  it('prefixes with the type and number', () => {
    expect(capThreadTitle('CIS', 4, 'The Bundling Gap')).toBe('CIS-4: The Bundling Gap');
    expect(capThreadTitle('CAP', 3, '')).toBe('CAP-3');
  });
});

describe('capCommentPostId', () => {
  it('is stable and namespaced by CAP number', () => {
    expect(capCommentPostId(4, 12)).toBe('cap-4-c12');
    expect(capCommentPostId(4, 12)).toBe(capCommentPostId(4, 12));
    expect(capCommentPostId(5, 12)).not.toBe(capCommentPostId(4, 12));
  });
});

describe('composeOpeningMd', () => {
  it('leads with type/category and closes with a portal pointer', () => {
    const md = composeOpeningMd(doc());
    expect(md).toContain('**CIS-4 · Procedural**, mirrored from the CAP portal.');
    expect(md).toContain('### Summary');
    expect(md).toContain('### Problem'); // CIS motivation label
    expect(md).toContain('### Context'); // CIS analysis label
    expect(md).toContain('https://cap.intersectmbo.org/#/detail/4');
    expect(md).toContain('currently v4');
  });

  it('includes an Impact section only when impact is present', () => {
    expect(composeOpeningMd(doc({}, { impact: 'The impact.' }))).toContain('### Impact');
    expect(composeOpeningMd(doc())).not.toContain('### Impact');
  });

  it('uses CAP section labels for a CAP document', () => {
    const md = composeOpeningMd(doc({ documentType: 'CAP', number: 3 }));
    expect(md).toContain('### Why is this change needed?');
    expect(md).toContain('### Analysis and test');
  });
});

describe('composeCommentMd', () => {
  it('names the portal author and date in a header above the body', () => {
    const md = composeCommentMd(
      { id: 1, author: 'Styg', date: '2026-08-10T09:00:00+00:00', body: 'A point.' },
      'https://cap.intersectmbo.org/#/detail/4',
    );
    expect(md).toContain(
      '**Styg** commented on [CAP portal](https://cap.intersectmbo.org/#/detail/4) · 2026-08-10',
    );
    expect(md).toContain('A point.');
  });

  it('falls back to Anonymous and omits a missing date', () => {
    const md = composeCommentMd({ id: 2, author: null, date: null, body: 'x' }, null);
    expect(md).toContain('**Anonymous** commented on the CAP portal');
    expect(md).not.toContain('·');
  });
});

describe('mapComments', () => {
  it('maps top-level comments with no parent, replies to their parent post id', () => {
    const mapped = mapComments(
      doc({
        discussion: [
          { id: 1, author: 'A', date: null, body: 'root' },
          { id: 2, author: 'B', date: null, body: 'reply', inReplyTo: 1 },
        ],
      }),
    );
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ postId: 'cap-4-c1', parentPostId: null });
    expect(mapped[1]).toMatchObject({ postId: 'cap-4-c2', parentPostId: 'cap-4-c1' });
  });

  it('lifts a reply-to-a-reply onto the top-level ancestor (one level deep)', () => {
    const mapped = mapComments(
      doc({
        discussion: [
          { id: 1, author: 'A', date: null, body: 'root' },
          { id: 2, author: 'B', date: null, body: 'mid', inReplyTo: 1 },
          { id: 3, author: 'C', date: null, body: 'deep', inReplyTo: 2 },
        ],
      }),
    );
    expect(mapped[2]).toMatchObject({ postId: 'cap-4-c3', parentPostId: 'cap-4-c1' });
  });

  it('skips comments the portal has moderated', () => {
    const mapped = mapComments(
      doc({
        discussion: [
          { id: 1, author: 'A', date: null, body: 'shown' },
          { id: 2, author: 'B', date: null, body: 'hidden', moderationStatus: 'removed' },
        ],
      }),
    );
    expect(mapped.map(m => m.postId)).toEqual(['cap-4-c1']);
  });
});

describe('composeRevisions', () => {
  it('renders a replacement as current vs proposed text', () => {
    const md = composeRevisions([
      { section: 'Defined Terms', original: 'The old text.', proposed: 'The new text.' },
    ]).join('\n');
    expect(md).toContain('### Proposed changes');
    expect(md).toContain('**Defined Terms**');
    expect(md).toContain('_Current text:_');
    expect(md).toContain('> The old text.');
    expect(md).toContain('_Proposed:_');
    expect(md).toContain('> The new text.');
  });

  it('renders an addition as an insert-after anchor and new text', () => {
    const md = composeRevisions([
      {
        type: 'addition',
        section: 'Article II',
        insert_after: 'Anchor clause.',
        proposed: 'Inserted clause.',
      },
    ]).join('\n');
    expect(md).toContain('_Insert after:_');
    expect(md).toContain('> Anchor clause.');
    expect(md).toContain('_New text:_');
    expect(md).toContain('> Inserted clause.');
    expect(md).not.toContain('_Current text:_');
  });

  it('renders nothing for an empty list', () => {
    expect(composeRevisions([])).toEqual([]);
    expect(composeRevisions(undefined)).toEqual([]);
  });
});

describe('composeReferences', () => {
  it('renders each reference as a link, wrapping the uri in angle brackets', () => {
    const md = composeReferences([
      {
        '@type': 'Other',
        label: 'CAP Portal page',
        uri: 'https://cap.intersectmbo.org/#/detail/3',
      },
    ]).join('\n');
    expect(md).toContain('### Links');
    expect(md).toContain('- [CAP Portal page](<https://cap.intersectmbo.org/#/detail/3>)');
  });

  it('skips references with no uri and renders nothing when empty', () => {
    expect(composeReferences([{ label: 'x', uri: null }])).toEqual([]);
    expect(composeReferences(undefined)).toEqual([]);
  });
});

describe('composeRevisionHistory', () => {
  it('lists versions newest-first with summary, date and author', () => {
    const md = composeRevisionHistory([
      {
        version: 1,
        changeSummary: 'Initial submission',
        date: '2026-08-06T00:00:00+00:00',
        author: 'Thomas',
      },
      {
        version: 2,
        changeSummary: 'Reworded terms',
        date: '2026-08-25T00:00:00+00:00',
        author: 'Thomas',
      },
    ]).join('\n');
    expect(md).toContain('### Revision history');
    const v2 = md.indexOf('**v2**');
    const v1 = md.indexOf('**v1**');
    expect(v2).toBeGreaterThanOrEqual(0);
    expect(v2).toBeLessThan(v1); // newest first
    expect(md).toContain('**v2** Reworded terms (2026-08-25, Thomas)');
  });

  it('renders nothing for a single-version proposal', () => {
    expect(composeRevisionHistory([{ version: 1, changeSummary: 'Initial' }])).toEqual([]);
  });
});

describe('composeOpeningMd includes proposed changes, links and history', () => {
  it('carries the revisions, references and version list into the opening post', () => {
    const d = doc(
      {
        proposedRevisions: [{ section: 'Terms', original: 'Old.', proposed: 'New.' }],
        versionHistory: [
          { version: 1, changeSummary: 'Initial', date: null, author: 'A' },
          { version: 2, changeSummary: 'Revised', date: null, author: 'A' },
        ],
      },
      {
        references: [{ label: 'CAP Portal page', uri: 'https://cap.intersectmbo.org/#/detail/4' }],
      },
    );
    const md = composeOpeningMd(d);
    expect(md).toContain('### Proposed changes');
    expect(md).toContain('> Old.');
    expect(md).toContain('### Links');
    expect(md).toContain('### Revision history');
  });
});

describe('composeBodyMd vs composeOpeningMd', () => {
  it('the body carries the sections; the opening post adds history and the portal pointer', () => {
    const d = doc({
      versionHistory: [
        { version: 1, changeSummary: 'Initial', date: null, author: 'A' },
        { version: 2, changeSummary: 'Revised', date: null, author: 'A' },
      ],
    });
    const body = composeBodyMd(d);
    const opening = composeOpeningMd(d);
    expect(body).toContain('### Summary');
    expect(body).not.toContain('### Revision history');
    expect(body).not.toContain('mirrored from the CAP portal. The full text');
    expect(opening).toContain('### Revision history');
    expect(opening).toContain('The full text, every revision');
  });
});

describe('composeVersionBodyMd', () => {
  it('renders a stored version through the same body pipeline', () => {
    const md = composeVersionBodyMd(
      { number: 4, docType: 'CIS', category: 'Procedural', sourceUrl: 'https://x/4' },
      {
        abstract: 'Old summary.',
        motivation: 'Old problem.',
        rationale: 'Old context.',
        impact: 'Old impact.',
        references: [{ label: 'Ref', uri: 'https://x/4' }],
        proposedRevisions: [{ section: 'S', original: 'a', proposed: 'b' }],
      },
    );
    expect(md).toContain('**CIS-4 · Procedural**, mirrored from the CAP portal.');
    expect(md).toContain('### Summary');
    expect(md).toContain('Old summary.');
    expect(md).toContain('### Problem'); // CIS motivation label
    expect(md).toContain('### Impact');
    expect(md).toContain('### Proposed changes');
    expect(md).toContain('### Links');
    // The version body is standalone: no history, no portal pointer.
    expect(md).not.toContain('### Revision history');
    expect(md).not.toContain('The full text, every revision');
  });
});

describe('buildCapThreadPlan', () => {
  it('carries metadata, title, opening post and comments through', () => {
    const plan = buildCapThreadPlan(
      doc({ discussion: [{ id: 1, author: 'A', date: null, body: 'hi' }] }),
    );
    expect(plan).toMatchObject({
      number: 4,
      docType: 'CIS',
      title: 'CIS-4: The Bundling Gap',
      category: 'Procedural',
      status: 'consultation',
      contentHash: 'abc123',
      currentVersion: 4,
      sourceUrl: 'https://cap.intersectmbo.org/#/detail/4',
    });
    expect(plan.submittedAt).toBe(Date.parse('2026-08-07T11:20:00+00:00'));
    expect(plan.comments).toHaveLength(1);
  });
});
