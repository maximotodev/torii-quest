// tests/mvp-approval-state.test.js — pure MVP APPROVAL STATE logic (tools/mvpApproval.mjs,
// v0.2.220). Covers the buildApprovalState coercion (status defaults to pending; never silently
// approves), the validateApprovalState safety floor (an 'approved' status REQUIRES non-empty
// approved_by/approved_at + a concrete version; a 'pending' status must NOT carry approver
// fields), isApproved strictness, the formatter, the next-action summary fold, and degraded
// inputs. Also asserts the committed MVP_APPROVAL_STATE.json is pending + valid. No fs/network in
// the pure cases — every input is plain data, fully node-deterministic.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MVP_APPROVAL_BADGE, MVP_APPROVAL_SCHEMA, MVP_APPROVAL_SCHEMA_VERSION, MVP_APPROVAL_FILE,
  MVP_APPROVAL_STATUSES, APPROVAL_REQUIRED_FIELDS,
  buildApprovalState, validateApprovalState, isApproved, formatApprovalState,
  summarizeApprovalForState,
} from '../tools/mvpApproval.mjs';
import { VERSION } from '../src/config.js';

const V = 'v0.2.220-alpha';

describe('buildApprovalState — coercion + defaults', () => {
  it('defaults to pending and is valid with a version', () => {
    const s = buildApprovalState({ status: 'pending', version: V });
    expect(s.kind).toBe(MVP_APPROVAL_SCHEMA);
    expect(s.schemaVersion).toBe(MVP_APPROVAL_SCHEMA_VERSION);
    expect(s.status).toBe('pending');
    expect(s.version).toBe(V);
    expect(s.approved_by).toBeNull();
    expect(s.approved_at).toBeNull();
    expect(validateApprovalState(s).ok).toBe(true);
  });

  it('coerces ANY non-"approved" value to pending (never silently approves)', () => {
    for (const bad of [undefined, null, '', 'Approved', 'APPROVED', 'yes', 'true', 'done', 1, {}]) {
      expect(buildApprovalState({ status: bad, version: V }).status).toBe('pending');
    }
  });

  it('keeps an explicit "approved" status (to be gated by validation, not the builder)', () => {
    const s = buildApprovalState({ status: 'approved', version: V, approved_by: 'user', approved_at: '2026-06-26' });
    expect(s.status).toBe('approved');
  });

  it('pins the standing safety posture all-false and supplies an evidence-neutral pending note', () => {
    const s = buildApprovalState({ status: 'pending', version: V });
    expect(s.safety).toEqual({
      deploy: false, publish: false, push: false, tag: false,
      networkWrite: false, nostrWrite: false, godMode: false,
    });
    expect(s.notes).toMatch(/Awaiting EXPLICIT user MVP approval/);
    expect(s.notes).toMatch(/Automated gate status is tracked separately/);
    expect(s.notes).not.toMatch(/gates are green/i);
  });

  it('trims blank provenance fields to null', () => {
    const s = buildApprovalState({ status: 'pending', version: V, approved_by: '   ', commit: '' });
    expect(s.approved_by).toBeNull();
    expect(s.commit).toBeNull();
  });
});

describe('validateApprovalState — safety floor', () => {
  it('passes a freshly built pending state', () => {
    expect(validateApprovalState(buildApprovalState({ status: 'pending', version: V })).ok).toBe(true);
  });

  it('ERRORS when approved is missing the required provenance fields', () => {
    const s = buildApprovalState({ status: 'approved', version: V });
    const r = validateApprovalState(s);
    expect(r.ok).toBe(false);
    for (const f of APPROVAL_REQUIRED_FIELDS) {
      expect(r.errors.join(' ')).toContain(f);
    }
  });

  it('passes an approved state once who/when/version are all present', () => {
    const s = buildApprovalState({ status: 'approved', version: V, approved_by: 'chiefmonkey', approved_at: '2026-06-26T12:00:00Z' });
    expect(validateApprovalState(s).ok).toBe(true);
    expect(isApproved(s)).toBe(true);
  });

  it('ERRORS when approved has no concrete version marker', () => {
    const s = buildApprovalState({ status: 'approved', approved_by: 'u', approved_at: 't' });
    expect(validateApprovalState(s).ok).toBe(false);
  });

  it('ERRORS when a pending state carries approver provenance (half-approved)', () => {
    const s = buildApprovalState({ status: 'pending', version: V, approved_by: 'sneaky', approved_at: '2026-06-26' });
    const r = validateApprovalState(s);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/pending.*must not carry/);
  });

  it('ERRORS on a bad version marker and a non-string commit', () => {
    const a = buildApprovalState({ status: 'pending' }); a.version = 'nope';
    expect(validateApprovalState(a).ok).toBe(false);
    const b = buildApprovalState({ status: 'pending', version: V }); b.commit = 42;
    expect(validateApprovalState(b).ok).toBe(false);
  });

  it('ERRORS on a wrong kind / schemaVersion / status', () => {
    const s = buildApprovalState({ status: 'pending', version: V });
    expect(validateApprovalState({ ...s, kind: 'x' }).ok).toBe(false);
    expect(validateApprovalState({ ...s, schemaVersion: 99 }).ok).toBe(false);
    expect(validateApprovalState({ ...s, status: 'maybe' }).ok).toBe(false);
  });

  it('warns (not errors) when a pending state has a null version', () => {
    const s = buildApprovalState({ status: 'pending' });
    const r = validateApprovalState(s);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/version is null/);
  });

  it('is safe on degraded inputs (null / non-object / array)', () => {
    expect(validateApprovalState(null).ok).toBe(false);
    expect(validateApprovalState('x').ok).toBe(false);
    expect(validateApprovalState([]).ok).toBe(false);
    expect(validateApprovalState({}).ok).toBe(false);
  });
});

describe('isApproved — strict', () => {
  it('is false for pending, invalid-approved, and garbage; true only for valid approved', () => {
    expect(isApproved(buildApprovalState({ status: 'pending', version: V }))).toBe(false);
    expect(isApproved(buildApprovalState({ status: 'approved', version: V }))).toBe(false); // missing fields
    expect(isApproved(null)).toBe(false);
    expect(isApproved(buildApprovalState({ status: 'approved', version: V, approved_by: 'u', approved_at: 't' }))).toBe(true);
  });
});

describe('formatApprovalState', () => {
  it('renders a block with the badge, status, and validity line', () => {
    const out = formatApprovalState(buildApprovalState({ status: 'pending', version: V }));
    expect(out).toContain(MVP_APPROVAL_BADGE);
    expect(out).toContain('pending');
    expect(out).toContain('✓ approval state valid.');
  });

  it('shows the error line for an invalid (partial) approval', () => {
    expect(formatApprovalState(buildApprovalState({ status: 'approved', version: V }))).toMatch(/✗ \d+ error/);
  });

  it('is safe on null', () => {
    expect(formatApprovalState(null)).toBe('mvp-approval-state: (no state)');
  });
});

describe('summarizeApprovalForState — next-action fold', () => {
  it('summarises a pending state with approved:false', () => {
    const s = summarizeApprovalForState(buildApprovalState({ status: 'pending', version: V }));
    expect(s).toEqual({ status: 'pending', approved: false, approvedBy: null, approvedAt: null, version: V });
  });

  it('summarises a valid approved state with approved:true + provenance', () => {
    const s = summarizeApprovalForState(buildApprovalState({ status: 'approved', version: V, approved_by: 'u', approved_at: 't' }));
    expect(s.approved).toBe(true);
    expect(s.approvedBy).toBe('u');
  });

  it('reports approved:false for an invalid/partial approved record', () => {
    expect(summarizeApprovalForState(buildApprovalState({ status: 'approved', version: V })).approved).toBe(false);
  });

  it('degrades to unknown/false on null or garbled input', () => {
    expect(summarizeApprovalForState(null)).toEqual({ status: 'unknown', approved: false, approvedBy: null, approvedAt: null, version: null });
    expect(summarizeApprovalForState([1, 2]).status).toBe('unknown');
  });
});

// The committed artifact must stay PENDING + valid and track the live config VERSION — so this
// slice can never accidentally ship an "approved" record, and a version bump can't leave it
// behind.
describe('committed MVP_APPROVAL_STATE.json', () => {
  it('is present, pending, valid, evidence-neutral, and tracks the config VERSION', () => {
    let raw = null;
    try { raw = readFileSync(join(process.cwd(), MVP_APPROVAL_FILE), 'utf8'); } catch { raw = null; }
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe(MVP_APPROVAL_STATUSES.PENDING);
    expect(parsed.version).toBe(VERSION);
    expect(parsed.notes).toMatch(/Automated gate status is tracked separately/);
    expect(parsed.notes).not.toMatch(/gates are green/i);
    expect(validateApprovalState(parsed).ok).toBe(true);
    expect(isApproved(parsed)).toBe(false);
  });
});
