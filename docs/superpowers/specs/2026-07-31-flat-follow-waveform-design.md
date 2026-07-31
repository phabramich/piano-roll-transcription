# Flat Follow and Waveform Design

## Goal

Make navigation predictable for musicians, explain the two recognition qualities without technical vocabulary, and bring the whole interface into the flat visual language already established by the `NOW` marker.

## Interaction model

- A short click in the falling-note canvas seeks playback but keeps the current viewport fixed. The clicked time moves under the existing viewport; the canvas does not recenter.
- `Следовать` is a real toggle, not a one-shot “return” action. When enabled, the viewport follows `NOW`; the stage has a visible colored frame and the button has a persistent selected state.
- Drag, wheel navigation, Ctrl/Meta-wheel zoom, Alt-wheel pitch zoom, or pinch navigation disable following immediately. A click-to-seek also disables following so the viewport can remain fixed.
- Enabling following immediately brings the playback marker back to the live viewport.
- Holding anywhere in the roll still auditions the pitch under the pointer; dragging still wins over holding after the existing movement threshold.

The renderer owns follow state and reports it through `onFollowChange(isFollowing)`. Before emitting a seek, it preserves the current absolute viewport anchor:

```ts
const preservedAnchor = this.anchorTimeSeconds;
this.setFollowing(false);
this.timeOffsetSeconds = preservedAnchor - targetTimeSeconds;
this.onSeek?.(targetTimeSeconds);
```

## Recognition modes

Replace `Быстрый спектр` and `Уточнить ML` with one two-position segmented control:

- `Быстро` — available immediately after the frequency analysis completes.
- `Точнее` — runs the local recognition model on demand.

The explanatory text is written for a nontechnical user. Before the first successful model run on the device it says that the first switch can take several minutes and downloads about `0,9 МБ`. After a successful run, a local preference records that the model has already been used on the device and the copy says that a repeat download is usually unnecessary.

Keep both analysis results in memory. Switching back to `Быстро` immediately restores the frequency result. If precise recognition is still running, it continues in the background; when it finishes, its result is displayed only if `Точнее` is still selected. Switching to an already completed precise result is instant.

Internal enum names may remain technical, but all visible copy must avoid `FFT`, `ML`, `спектр`, and `модель` except in the one plain-language download explanation where `модель распознавания` is meaningful.

## Waveform timeline

Add a focused `WaveformTimeline` canvas component above the piano stage. It receives the already decoded mono samples, computes a bounded set of peak amplitudes, and redraws on resize without rerunning audio analysis. The unplayed waveform uses a quiet neutral color, the played section uses the same magenta as `NOW`, and a thin playhead marks the exact seek position.

The existing range input remains as an accessible transparent interaction layer over the waveform. Keyboard seeking and native pointer behavior therefore stay intact while the canvas provides SoundCloud-style context.

## Visual system

- Flat off-white application background and solid white surfaces.
- Dark graphite text and thin neutral borders.
- Figma-like purple/blue for controls, magenta only for playback/current-position semantics, and teal for confident detected keys.
- No glass blur, decorative gradients, or floating shadows. Depth comes from 1–2 px borders, simple color blocks, and small radius differences.
- The player becomes a clear stacked tool: file and recognition row, waveform transport, framed falling-note stage, compact help rail.
- Mobile controls remain at least 38 px tall; the recognition switch and its explanation wrap cleanly rather than compressing.

## State and failure behavior

- Fast analysis remains the mandatory initial path and playback remains available if precise recognition fails.
- A precise-recognition failure returns the control to `Быстро`, keeps the fast result visible, and shows a plain recovery message.
- Loading a new file clears both cached in-memory results, waveform peaks, and precise progress, but does not clear the device-level “model used before” hint.
- No backend or new dependency is introduced.

## Verification boundary

Per repository instructions, do not run lint, tests, typecheck, or build unless explicitly requested. Review the diff, run `git diff --check`, and use the live Vite page for interaction and responsive visual inspection if the dev server is available.
