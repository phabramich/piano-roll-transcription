# Flat Follow and Waveform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make canvas seeking stable, expose a self-disabling follow toggle, replace technical recognition actions with two understandable modes, add a SoundCloud-style waveform timeline, and restyle the application as a flat modern tool.

**Architecture:** `PianoRollRenderer` remains the owner of viewport and follow state. `main.ts` coordinates recognition modes and cached results. A new `WaveformTimeline` owns peak reduction and timeline drawing while the native range input remains the accessible seek surface.

**Tech Stack:** TypeScript, Vite, Web Audio API, Canvas 2D, existing Basic Pitch worker, CSS.

## Global Constraints

- No backend and no new runtime dependency.
- Prefer enums to type unions.
- Visible recognition copy must use `Быстро` and `Точнее`, not `FFT`, `ML`, `быстрый спектр`, or `уточнить`.
- First precise-mode explanation must state that it can take several minutes and downloads about `0,9 МБ`.
- Short canvas click seeks without moving the viewport.
- Any manual canvas navigation disables following.
- Keep the existing magenta `NOW` style and apply a flat, Figma-like visual language elsewhere.
- Do not run lint, tests, typecheck, or build.

---

### Task 1: Stable seek and explicit follow state

**Files:**
- Modify: `src/piano-roll-renderer.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `PianoRollRenderer.onFollowChange: ((following: boolean) => void) | null`
- Produces: `PianoRollRenderer.toggleFollow(): void`
- Keeps: `PianoRollRenderer.followPlayback(): void` only if still needed internally; otherwise replace it with the toggle interface.

- [ ] Add a single `setFollowing(next: boolean)` path that updates renderer state, resets `timeOffsetSeconds` only when enabling, reports changes, and redraws.
- [ ] Before canvas seek, capture `anchorTimeSeconds`, disable follow, and set the relative offset against the target time so the next `render(target)` keeps the viewport fixed:

```ts
const viewportAnchor = this.anchorTimeSeconds;
this.setFollowing(false, false);
this.timeOffsetSeconds = viewportAnchor - targetTime;
this.clampTimeOffsetFor(targetTime);
this.onSeek?.(targetTime);
```

- [ ] Route wheel zoom, wheel pan, drag, and pinch through the same follow-disabling path. Disable it at the beginning of meaningful navigation, including pitch-only navigation, so the UI state never claims to follow while the user is exploring.
- [ ] Wire `onFollowChange` to `main.ts`, give the button `aria-pressed`, selected copy (`Следовать` / `Следование включено`), and a `data-following` attribute on `.piano-stage`.
- [ ] Make the button a toggle: enabling follows immediately; disabling freezes the current absolute viewport.
- [ ] Inspect the diff for the click/hold/drag arbitration and confirm long-press audition behavior was not removed.

### Task 2: Human recognition modes and cached results

**Files:**
- Modify: `src/main.ts`
- Modify: `src/analysis-types.ts`

**Interfaces:**
- Produces enum:

```ts
enum RecognitionMode {
  Instant = 'instant',
  Precise = 'precise',
}
```

- Stores: `fastAnalysisResult: AnalysisResult | null`
- Stores: `preciseAnalysisResult: AnalysisResult | null`
- Stores device hint: `localStorage['pianorolltranscribe.precise-model-ready'] === '1'`

- [ ] Replace the refine button with a two-button segmented control using `role="radiogroup"`, `aria-checked`, and labels `Быстро` / `Точнее`.
- [ ] Add an adjacent explanation line. Before first use: `Первый точный анализ может занять несколько минут и скачает модель распознавания — около 0,9 МБ.` After prior success: `Точный анализ уже использовался на этом устройстве — повторная загрузка обычно не нужна.`
- [ ] Store the complete fast result before rendering it. On `Быстро`, render that cached result immediately.
- [ ] On first `Точнее`, start the existing Basic Pitch analysis and keep its progress in nontechnical copy (`Распознаём ноты: 42%`). Do not cancel it if the user switches back to `Быстро`.
- [ ] When precise analysis finishes, cache it, persist the device hint, and render it only if precise mode remains selected.
- [ ] If it fails, select and render `Быстро`, keep playback usable, and show a plain recovery message.
- [ ] Update every phase/status string so no visible technical term from the global constraint remains.

### Task 3: Waveform timeline component

**Files:**
- Create: `src/waveform-timeline.ts`
- Modify: `src/main.ts`
- Modify: `src/design-colors.ts`

**Interfaces:**
- Produces:

```ts
export class WaveformTimeline {
  public constructor(canvas: HTMLCanvasElement);
  public setSamples(samples: Float32Array, durationSeconds: number): void;
  public setCurrentTime(seconds: number): void;
  public clear(): void;
  public dispose(): void;
}
```

- [ ] Implement peak reduction into at most 1200 columns. For each column, scan its sample window and retain the maximum absolute amplitude; do not keep a second copy of the source samples.
- [ ] Resize with `ResizeObserver` and device pixel ratio. Draw symmetric rounded vertical bars: neutral unplayed bars, magenta played bars, and a 2 px magenta playhead.
- [ ] Add the canvas inside a `.waveform-timeline` wrapper and position the existing range input across it as the native, keyboard-accessible interaction layer.
- [ ] Call `setSamples` immediately after audio decode, `setCurrentTime` from `updatePlaybackUi`, `clear` on new load/reset, and `dispose` before unload.
- [ ] Keep pointer seeking owned by the range input so waveform rendering introduces no competing pointer state.

### Task 4: Flat visual system and responsive polish

**Files:**
- Modify: `src/style.css`
- Modify: `src/design-colors.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `.recognition-mode`, `.recognition-mode__option`, `.recognition-help`, `.waveform-timeline`, `.piano-stage[data-following="true"]`.

- [ ] Replace translucent gradients, blur, and large shadows with solid off-white/white surfaces, graphite borders, 10–14 px radii, and flat color fills.
- [ ] Use purple/blue for actions, magenta for playback and the active follow frame, and teal only for confident piano-key activation.
- [ ] Make the stage follow state unmistakable with a magenta 2 px outer frame and selected button fill; keep the canvas itself uncluttered.
- [ ] Style the waveform as the primary transport target, with a minimum 56 px desktop height and 64 px mobile height; make the overlaid range thumb accessible and visible without covering the peaks.
- [ ] Ensure the mode switch and explanation wrap on narrow screens, every mobile button/range remains at least 38 px tall, and the stage toolbar can scroll horizontally.
- [ ] Update the help rail copy to Russian (`Перетащить — обзор · Нажать — позиция · Удерживать — нота`).
- [ ] Inspect desktop and mobile CSS for old glass/gradient declarations and remove those that affect loaded-player UI.

### Task 5: Integration review and bounded verification

**Files:**
- Review: all changed files

- [ ] Trace load → instant analysis → playback → canvas seek → manual pan → follow re-enable → precise switch → fast switch → precise completion.
- [ ] Verify error flow keeps the instant result and playback after precise analysis failure.
- [ ] Run `git diff --check` only; do not run lint, tests, typecheck, or build.
- [ ] If a Vite server is already available, inspect the live app at desktop and mobile widths and exercise pointer behavior without invoking the prohibited commands.
