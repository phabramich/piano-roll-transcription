# pianorolltranscribe visual and interaction polish

## Goal

Bring the falling-note trainer to a contemporary 2026 product finish, rename it consistently to `pianorolltranscribe`, make time zoom predictable, reduce false-positive keyboard highlights, and keep the true playback position visible while browsing.

## Visual direction

Use a light soft-glass studio aesthetic:

- cool pearl page background with restrained violet and aqua ambient gradients;
- translucent white surfaces with thin inner borders and soft layered shadows;
- 16–20 px radii for major cards and 10–12 px radii for controls;
- near-black graphite text, electric violet primary, aqua secondary, magenta playback marker;
- lower-case `pianorolltranscribe` wordmark with compact geometric icon;
- subtle hover lift and focus rings, without decorative animation on the piano roll.

The canvas palette follows the same system: off-white roll, quiet lavender grid, violet notes, graphite black keys, and magenta playback position.

## Interaction fixes

### Time zoom

`Ctrl/Command + wheel` zooms time in both directions around the pointer. Wheel delta is converted to pixels and applied exponentially, so trackpads are smooth and mouse wheels are controlled:

```ts
const factor = Math.exp(clamp(deltaPixels, -240, 240) * 0.0018);
nextVisibleSeconds = clamp(visibleSeconds * factor, 2, 20);
```

Negative wheel delta zooms in; positive delta zooms out.

### Confident active keys

Only activations at or above `168/255` illuminate a key. Key opacity is remapped from that threshold to full confidence rather than reusing the much more permissive spectrum alpha curve. This keeps the spectrum detailed while the keyboard communicates only strong note evidence.

### Real playback position

The playback line is based on `currentTimeSeconds`, not viewport anchor time. It is drawn as a 2 px magenta line with a compact `NOW m:ss` label. If current playback is outside the manually browsed viewport, the line pins to the nearest viewport edge and the label gets an up/down arrow.

## Naming scope

Change the visible wordmark, accessible label, document title, package name, README heading, and Docker example image tag to `pianorolltranscribe`.

## Constraints

- No new dependencies.
- Preserve light theme, mobile layout, FFT/ML pipeline, playback, seek, drag, pinch, audition, and contrast control.
- Do not run lint, tests, typecheck, or build.
