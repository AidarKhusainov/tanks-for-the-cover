# AI Firing and Self-defense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute the approved work without repeating design approval.

**Goal:** Fix the stalled firing column and give medium/heavy tanks contextual self-defense, then validate late waves on both maps.

**Architecture:** Keep the existing bundled Game core. Separate group time-to-first-shot estimates from each actor's movement; add bounded cooperative movement at blocked firing exits. Share observed attack state between target choice and breach estimates.

**Tech Stack:** Plain JavaScript, autonomous HTML, Node built-in tests, existing Chrome acceptance helpers.

**Spec:** `docs/superpowers/specs/2026-11-16-ai-firing-self-defense-design.md` (user approved behavior in chat).

## Global Constraints

- Baseline `027ac93804687f1c60e7d95a879698385a72f0f5`; branch `codex/ai-firing-self-defense` in the active checkout.
- Preserve autonomous HTML, public Game API, collision rules, projectile range and cooldown, light pressure/dodge and protected return.
- No new dependencies or geometry/stat/wave-composition changes. Recalibrate static starts only if measured existing pacing contract requires it; report old/new values.
- Counterfire requires observed incoming player fire or recent direct hit, actual own range/LOS; 0.6 s attack memory; no distant pursuit. Existing heavy near-base aim threat remains.
- Heavy reachable finish horizon 2.75 s and its earlier-than-death requirement remain. A distracted shooter must not contribute phantom breach damage.
- Preserve private user evidence outside Git. Controlled reconstruction is explicitly diagnostic, not exact human input replay. #14 human series remains pending.

## Review Focus

- An armed front tank in a corner can move only by a bent path; test feasible multi-tank release without clipping or false permanent queue.
- A truly one-tank corridor cannot create extra firing positions; test queued handover without friendly fire obstruction.
- Player fires outside base neighborhood or beyond enemy range; test response in the former, no impossible response in the latter.
- Player aim/LOS changes during reload; test stable memory, immediate range/LOS gate and unchanged cooldown.
- Group routes are evaluated while a member fights player; test that estimated clearing time does not count that member's gun.

### Task 1: Correct firing movement and contextual self-defense

**Files:** Modify `index.html`, relevant `tests/shared-firing.test.cjs`, `tests/shared-breach.test.cjs`, `tests/heavy-priority.test.cjs`, `tests/movement.test.cjs`; create focused tests/fixture helper when needed. Update `docs/prototype-design-document.md`, `docs/shared-combat-checks.md`, relevant README rules.

**Interfaces:** Existing `Game.update(dt,input)`, `_chooseTarget`, `_chooseHeavyTarget`, `_estimateShotPath`, `debugRoute`, `_firingManeuver`, `_followRoute`. Keep public exports compatible. Add private helpers only for reusable own-position planning or shared self-defense state; no test-only runtime switches.

- [ ] Add the magnetic A reconstruction: base and wreck geometry from submitted log, heavy `(7.375,11.375)`, lights `(7.375,9.9)`/`(7.375,8.9)`; assert their own routing makes progress and multiple reachable shooters fire within a bounded observation window. Include a clear-space variant and genuine one-tank corridor handover. Store only minimal nonpersonal fixture fields in tests.
- [ ] Add self-defense tests for medium/heavy, near/far base, incoming projectile and recent hit, occluded/out-of-range player, attack cessation, no pursuit, cooldown preservation and heavy finish-vs-death. Replace only test expectations explicitly superseded by the approved rule.
- [ ] Add breach-estimate regression with one member counterfiring; actual feasible shooting participants and observed clearance must agree. Test target flips without stale indefinitely reserved positions.
- [ ] Run new regression tests against baseline and save meaningful failures before production edits. Save test-only patch and logs under the plan workspace for reproducibility.
- [ ] Correct own-path selection independently of group's first-shot estimate; cooperate to open feasible exits, preserve hard queue when space is insufficient. Implement shared observed-attack memory/target response and exclude distracted shooters from group clearing estimates. Keep bounded per-frame work and avoid repeated full-world path searches.
- [ ] Run focused tests then `npm test`; document exact output, source hash and any unresolved failure. Update PDD/check descriptions to match runtime; record any meaningful performance change.
- [ ] Commit scoped implementation, tests and rules documentation. Report full results and own review in the task report; no push or external mutation by the implementer.

### Task 2: Validate both campaigns and publish reproducible evidence

**Files:** Existing `tools/calibrate-maps.cjs`, `tools/verify-maps.cjs`, `tools/verify-maps-campaign.cjs` are reused. Create `docs/ai-firing-self-defense-verification.md` and compact evidence JSON if needed. Any helper additions must be justified by acceptance evidence, with no duplicated game behavior.

**Interfaces:** Consumes the committed Task 1 HTML. `node tools/calibrate-maps.cjs <html> <out.json> [map]`, `node tools/verify-maps-campaign.cjs <html> <map> <engine|barrel> <new-output-dir>`. Existing controls restore explicitly labelled prep snapshots only.

- [ ] Freeze exact HTML SHA-256. Run four full ordinary-input campaigns (both maps × engine/barrel); preserve wins and failures, recorded inputs, late-wave observations and preparation snapshots.
- [ ] Recompute both maps' timing/calibration including V6–V8: first actual spawn, first base shot/hit, pairwise overlap and required player travel windows. Compare to baseline configuration; report unchanged timing if no correction is needed.
- [ ] Repeat relevant wreck/calendar controls at late V7/V8 with/without useful wrecks and after spending/expiration; relate resources to actual earlier waves, not artificial abundance. Reuse existing helpers and flag every diagnostic fixture.
- [ ] Exercise the two regression scenes in browser and both map selectors/offline startup with exact changed HTML. Distinguish controlled AI checks, automated campaigns and actual user pilot.
- [ ] Write concise technical report with exact commands, hashes, outcomes, timing differences and remaining human acceptance. Update plan ledger and private Baton/#14 pilot record. Do not overwrite historical evidence.
- [ ] Independent review of the exact integrated diff; fix confirmed findings, run affected checks. Publish branch/PR within continuing task authorization, verify exact CI input and results. Merge remains a separate owner decision.
