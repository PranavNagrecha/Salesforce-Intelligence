### Added

- **The platform's permission dependency graph (`sfi refresh --with-tooling-api`).**
  `sfi.effective_permissions` computed access from DECLARED grants only.
  Salesforce publishes a `PermissionDependency` graph saying which permissions
  imply which others, so a declared-only answer systematically **UNDERSTATES**
  effective access — grant `ManageUsers` and the holder silently also gets
  `ResetPasswords`. Adds the tooling fetcher, a vault artifact
  (`meta/permission-dependencies.json`), fail-soft refresh wiring, a cycle-safe
  transitive closure, and consumption in `effective_permissions`. An implied row
  carries `impliedBy` and an EMPTY `grantedBy` — nothing *declares* it.

  Verified against a live org, which corrected three assumptions the
  implementation had been built on:

  - **`LIMIT` is silently IGNORED on this object.** `WHERE Id > 'x'` and
    `ORDER BY Id ASC` *are* honoured, so keyset walking works where `LIMIT`
    does not. Termination is now purely cursor-based; the previous
    `batch.length < pageSize` page-fill signal would have ended a walk early
    and reported the partial capture as COMPLETE.
  - **Paging re-serves rows** (measured ~5x). Raw wire count and distinct edge
    count are separate types so they cannot be reconfused: `rawRowsReceived` is
    a diagnostic, `edges.length` is the only headline. A duplicate re-serve on
    the un-paged path is itself a truncation signal.
  - **`PermissionType`/`RequiredPermissionType` is a closed two-value domain.**
    The declared label is authoritative and name shape is a cross-check only; a
    disagreement or unrecognised label is recorded and disclosed, never
    defaulted.

### Changed

- **The four sibling tools now disclose that they do NOT expand dependencies.**
  `what_if_assign_permset`, `what_if_revoke_permset`, `why_cant_user_see_record`
  and `user_ability` still answer from declared grants, and the roster
  previously claimed one of them "composes the SAME effective-permissions engine
  as `sfi.effective_permissions`" — true of the engine, materially false of the
  answer. This fails silently, plausibly, and in the UNDER-stating direction,
  which is the direction where a least-privilege reviewer approves a grant they
  would have blocked. The disclosure is built once so the four surfaces cannot
  drift apart, and two carry measured specifics rather than generic text.

- **Object-level share is disclosed as a proportion, not a footnote.** Roughly
  nine in ten captured edges are object-level, and object requirements are
  reported but NOT merged into `objectPermissions` (object grants are also not
  closure roots), so the disclosure leads with that percentage — computed live
  per org, never baked in.

- **`ModifyAllData`/`ViewAllData` reachability is COMPUTED, not asserted.** The
  disclosure previously ended with a hardcoded claim that both "have ZERO
  dependency edges", i.e. a per-org empirical fact stated as a constant, in the
  reassuring direction, about the two most dangerous permissions in Salesforce —
  forty lines below code noting the graph is org-VARIABLE. Both directions are
  now read from the captured graph via a `requiredBy` reverse index.

### Known limitation

- `computeEffectiveGrants` is unchanged, so the four sibling tools DISCLOSE the
  understatement without fixing it. Making them expand the closure is the real
  fix and is not done.
