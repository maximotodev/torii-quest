// tools/mvpApproval.mjs — PURE, node-safe MVP APPROVAL STATE helpers (v0.2.220).
// A single, auditable source of truth for whether the live-browser MVP has received EXPLICIT
// user approval. Automated local gates (npm run test:release) can prove the code is green, but
// they can NEVER prove a human ran the playtest and SAID "MVP approved" — that is the one
// outstanding manual blocker the Continuum dashboard surfaces. This module SHAPES + VALIDATES
// the approval-state object; the thin CLI (tools/mvp-approval-state.mjs) does the fs/git I/O and
// the (flag-gated, in-repo) write. Build-time only — never imported by the game; NO
// fs/network/child_process/THREE/DOM in here. Deterministic + plain-data so the logic is unit-
// testable (tests/mvp-approval-state.test.js).
//
// SAFETY CONTRACT (enforced by validateApprovalState):
//   - The DEFAULT and the ONLY status this slice ever writes is 'pending'. buildApprovalState
//     coerces ANY value that is not exactly 'approved' to 'pending', so the state can never
//     SILENTLY flip to approved through a typo, a truthy object, or a partial edit.
//   - A status of 'approved' is INVALID (validator ERROR) unless EVERY required field
//     (approved_by, approved_at) is a non-empty string AND `version` is a real version marker.
//     So approval cannot be recorded without the who/when provenance a human must supply.
//   - Recording approval is descriptive bookkeeping only: it NEVER triggers a
//     deploy/publish/push/tag/network/Nostr write (the pinned `safety` block is all-false).

export const MVP_APPROVAL_BADGE =
  'MVP APPROVAL STATE · LOCAL · READ-ONLY · PENDING UNTIL EXPLICIT USER APPROVAL';

// Stable schema id + integer version for the machine-readable artifact. Bump on a breaking
// shape change.
export const MVP_APPROVAL_SCHEMA = 'torii.mvp-approval-state';
export const MVP_APPROVAL_SCHEMA_VERSION = 1;

// Canonical in-repo path the CLI writes (with --write).
export const MVP_APPROVAL_FILE = 'MVP_APPROVAL_STATE.json';

// The only two statuses. 'pending' is the default/floor; 'approved' requires the fields below.
export const MVP_APPROVAL_STATUSES = Object.freeze({ PENDING: 'pending', APPROVED: 'approved' });

// Fields that MUST be present (non-empty strings) before a status of 'approved' is valid.
export const APPROVAL_REQUIRED_FIELDS = Object.freeze(['approved_by', 'approved_at']);

// Human-facing wording carried IN the artifact so any surface that renders it inherits the
// "pending until a human explicitly approves" contract verbatim. Automated gate evidence is
// intentionally not asserted here: that status belongs to the separately generated gate data.
export const MVP_APPROVAL_PENDING_NOTE =
  'Awaiting EXPLICIT user MVP approval. Automated gate status is tracked separately; the ' +
  'live-browser playtest + sign-off is a human step. Do NOT set status to "approved" until the ' +
  'user says so; an approval must also record approved_by and approved_at.';

const VERSION_MARKER_RE = /^v\d+\.\d+\.\d+(?:-[a-z][a-z0-9.]*)?$/i;

function isVersionMarker(s) {
  return typeof s === 'string' && VERSION_MARKER_RE.test(s.trim());
}

// _str(x) → trimmed non-empty string or null. Defensive; never throws.
function _str(x) { return typeof x === 'string' && x.trim() ? x.trim() : null; }

// buildApprovalState(inputs) → a plain, JSON-serialisable approval state. All inputs are plain
// data. The status is COERCED: anything that is not exactly the string 'approved' becomes
// 'pending', so the state can never silently flip to approved. Provenance fields are carried
// through verbatim (trimmed); the validator — not the builder — enforces that an 'approved'
// state actually supplied them, so a half-filled approval FAILS loudly rather than being
// quietly sanitised into a valid-looking record.
export function buildApprovalState({
  status, version = null, commit = null,
  approved_by = null, approved_at = null, notes = null, generatedAt = null,
} = {}) {
  const normStatus = _str(status) === MVP_APPROVAL_STATUSES.APPROVED
    ? MVP_APPROVAL_STATUSES.APPROVED
    : MVP_APPROVAL_STATUSES.PENDING;
  return {
    kind: MVP_APPROVAL_SCHEMA,
    schemaVersion: MVP_APPROVAL_SCHEMA_VERSION,
    badge: MVP_APPROVAL_BADGE,
    generatedAt: _str(generatedAt),
    status: normStatus,
    version: _str(version),
    commit: _str(commit),
    approved_by: _str(approved_by),
    approved_at: _str(approved_at),
    notes: _str(notes) || MVP_APPROVAL_PENDING_NOTE,
    // Standing safety posture — recording approval is bookkeeping only; it NEVER triggers a
    // deploy/publish/push/tag/network/Nostr write, and gameplay godMode stays false. Pinned
    // false so a reviewer can confirm this artifact changes no runtime behaviour.
    safety: {
      deploy: false, publish: false, push: false, tag: false,
      networkWrite: false, nostrWrite: false, godMode: false,
    },
  };
}

// validateApprovalState(state) → { ok, errors, warnings }. Pure; never throws. `ok` is true iff
// there are zero errors. The approved-requires-provenance rule is an ERROR, not an advisory —
// it is the safety floor that stops a silent/partial approval.
export function validateApprovalState(state) {
  const errors = [];
  const warnings = [];
  const add = (e) => errors.push(e);
  const warn = (w) => warnings.push(w);

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, errors: ['approval state is not an object'], warnings };
  }

  if (state.kind !== MVP_APPROVAL_SCHEMA) add(`kind must be "${MVP_APPROVAL_SCHEMA}"`);
  if (state.schemaVersion !== MVP_APPROVAL_SCHEMA_VERSION) {
    add(`schemaVersion must be ${MVP_APPROVAL_SCHEMA_VERSION}`);
  }

  const validStatuses = new Set(Object.values(MVP_APPROVAL_STATUSES));
  if (!validStatuses.has(state.status)) {
    add(`status must be one of ${[...validStatuses].join(', ')}`);
  }

  if (state.version !== null && !isVersionMarker(state.version)) {
    add('version must be a valid version marker (vX.Y.Z[-tag]) or null');
  }
  if (state.commit !== null && (typeof state.commit !== 'string' || !state.commit)) {
    add('commit must be a non-empty string or null');
  }

  if (state.status === MVP_APPROVAL_STATUSES.APPROVED) {
    // The safety floor: an approval MUST carry its who/when provenance and a concrete version.
    for (const field of APPROVAL_REQUIRED_FIELDS) {
      if (typeof state[field] !== 'string' || !state[field].trim()) {
        add(`status "approved" requires a non-empty ${field}`);
      }
    }
    if (!isVersionMarker(state.version)) add('status "approved" requires a concrete version marker');
  } else if (state.status === MVP_APPROVAL_STATUSES.PENDING) {
    // A pending state must NOT carry approver provenance — that would be a half-recorded
    // approval. Surface it as an error so it can't masquerade as "almost approved".
    for (const field of APPROVAL_REQUIRED_FIELDS) {
      if (state[field] !== null && state[field] !== undefined && state[field] !== '') {
        add(`status "pending" must not carry ${field} (clear it or set status to "approved")`);
      }
    }
    if (state.version === null) warn('version is null — set it to the current version marker');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// isApproved(state) → strict boolean. True ONLY when the status is exactly 'approved' AND the
// state passes validation. Consumers should use THIS rather than reading state.status directly,
// so an invalid/partial "approved" record is treated as NOT approved.
export function isApproved(state) {
  return !!state && state.status === MVP_APPROVAL_STATUSES.APPROVED && validateApprovalState(state).ok;
}

// formatApprovalState(state) → a concise text block for the terminal. Pure; safe on null.
export function formatApprovalState(state) {
  if (!state || typeof state !== 'object') return 'mvp-approval-state: (no state)';
  const L = [];
  L.push('Torii Quest — MVP approval state');
  L.push('─'.repeat(60));
  L.push(MVP_APPROVAL_BADGE);
  L.push(`status:     ${state.status ?? '(unknown)'}${isApproved(state) ? '  ✓ APPROVED' : '  (pending)'}`);
  L.push(`version:    ${state.version ?? '(unset)'}`);
  L.push(`commit:     ${state.commit ?? '(none)'}`);
  L.push(`approved by: ${state.approved_by ?? '(—)'}`);
  L.push(`approved at: ${state.approved_at ?? '(—)'}`);
  if (state.generatedAt) L.push(`generated:  ${state.generatedAt}`);
  if (state.notes) L.push(`notes:      ${state.notes}`);
  const { ok, errors, warnings } = validateApprovalState(state);
  L.push('');
  L.push(ok ? '✓ approval state valid.' : `✗ ${errors.length} error(s): ${errors.join('; ')}`);
  if (warnings.length) L.push(`· ${warnings.length} warning(s): ${warnings.join('; ')}`);
  L.push('─'.repeat(60));
  return L.join('\n');
}

// summarizeApprovalForState(state) → the compact block folded into the machine-readable
// next-action state (tools/nextActionState.mjs). Pure; safe on null/garbled. Uses isApproved()
// so a partial/invalid "approved" record reports approved:false.
export function summarizeApprovalForState(state) {
  const s = state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  return {
    status: s ? (_str(s.status) || 'unknown') : 'unknown',
    approved: isApproved(s),
    approvedBy: s ? _str(s.approved_by) : null,
    approvedAt: s ? _str(s.approved_at) : null,
    version: s ? _str(s.version) : null,
  };
}
