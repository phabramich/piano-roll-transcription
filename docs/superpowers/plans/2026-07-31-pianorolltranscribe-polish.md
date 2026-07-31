# pianorolltranscribe Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the product identity and fix zoom, active-key confidence, and actual playback position visibility.

**Architecture:** Brand and presentation remain in HTML/CSS plus the shared canvas color tokens. Renderer behavior stays inside `PianoRollRenderer`, where time zoom, key confidence, and true playback marker share the existing viewport transforms.

**Tech Stack:** TypeScript 5.8, Canvas 2D, CSS, Vite.

## Global Constraints

- Prefer enum over type unions.
- Add no runtime dependencies.
- Comments only when necessary and only in Russian.
- Do not run lint, tests, typecheck, or build.
- Preserve FFT/ML analysis, AudioPlayer, seek, drag, pinch, audition, contrast control, and mobile behavior.
- Product name is exactly `pianorolltranscribe`.

---

### Task 1: Brand and 2026 visual system

**Files:**
- Modify: `src/design-colors.ts`
- Modify: `src/main.ts`
- Modify: `src/style.css`
- Modify: `index.html`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Produces the existing `DESIGN_COLORS` keys plus optional `keyActive` and `canvasBackground` tokens for Task 2.
- Does not rename DOM IDs consumed by application logic.

- [ ] Rename visible and metadata occurrences to `pianorolltranscribe`, including the package lock root package name and Docker tag example.
- [ ] Replace the header mark with a compact piano/falling-note motif built from existing HTML/CSS; keep it accessible as decorative content.
- [ ] Update CSS tokens to pearl/graphite/electric-violet/aqua/magenta and add layered ambient background gradients.
- [ ] Apply translucent surfaces, thin inner borders, 16–20 px card radii, 10–12 px controls, refined shadows, and consistent 140–180 ms transitions.
- [ ] Keep mobile controls at least 38 px, horizontal toolbar overflow, readable player hierarchy, and focus-visible rings.
- [ ] Update canvas color tokens without changing renderer behavior.
- [ ] Run only `git diff --check`.

### Task 2: Zoom, confidence, and playback marker

**Files:**
- Modify: `src/piano-roll-renderer.ts`

**Interfaces:**
- Consumes `DESIGN_COLORS`, including the Task 1 active-key and playback colors.
- Preserves all current public renderer methods and callbacks.

- [ ] Set `KEY_ACTIVATION_THRESHOLD` to `168`.
- [ ] Remap active-key alpha from threshold to 255 and cap the visual opacity below 0.82.
- [ ] Normalize wheel delta by `deltaMode`: pixels unchanged, lines multiplied by 16, pages multiplied by roll height.
- [ ] For Ctrl/Command wheel use `factor = exp(clamp(deltaPixels, -240, 240) * 0.0018)` around the cursor anchor; negative zooms in, positive zooms out.
- [ ] Replace bottom-anchored `drawPlayhead` with actual-current-time `drawPlaybackPosition`.
- [ ] Draw a 2 px line at `timeToY(currentTimeSeconds)`, clamped to the roll viewport; add a `NOW m:ss` label and `↑`/`↓` when clamped.
- [ ] Keep the marker inside the roll and draw it above notes but before the keyboard.
- [ ] Run only `git diff --check`.

### Task 3: Static integration review

**Files:**
- Review: `src/design-colors.ts`
- Review: `src/main.ts`
- Review: `src/style.css`
- Review: `src/piano-roll-renderer.ts`
- Review: `index.html`
- Review: `package.json`
- Review: `package-lock.json`
- Review: `README.md`

- [ ] Check that no old `Spectral Score` or `spectral-score` identity remains in user-facing or package metadata.
- [ ] Check Ctrl/Command wheel direction, anchor preservation, delta-mode normalization, and min/max clamping statically.
- [ ] Check key highlight gating and opacity for values below threshold, at threshold, and at 255.
- [ ] Check playback marker for follow mode, manual past/future browsing, track start/end, and zero-duration state.
- [ ] Check CSS mobile breakpoints and all existing DOM IDs.
- [ ] Fix only concrete findings and run `git diff --check`.
