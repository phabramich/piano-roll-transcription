# Falling Piano Trainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить горизонтальный piano roll на падающие к нижней клавиатуре ноты с DAW-подобной навигацией и удобным mobile UX.

**Architecture:** `PianoRollRenderer` владеет временным и нотным viewport, преобразует analysis frames в вертикальные tiles и обрабатывает wheel/pointer/pinch. `main.ts` подключает небольшую панель viewport-команд; CSS строит устойчивый desktop/mobile layout.

**Tech Stack:** TypeScript 5.8, Canvas 2D, Pointer Events, Wheel Events, Vite.

## Global Constraints

- Предпочитать enum вместо type union.
- Новых runtime-зависимостей не добавлять.
- Комментарии только при реальной необходимости и только на русском.
- Не запускать lint, tests, typecheck или build.
- Сохранить tap/click seek и hold 200 мс для проигрывания синуса.
- Не менять FFT/ML анализ, AudioPlayer и PianoAudition.

---

### Task 1: Falling-notes renderer

**Files:**
- Modify: `src/piano-roll-renderer.ts`

**Interfaces:**
- Produces: `zoomTime(direction: number): void`, `cyclePitchRange(): void`, `followPlayback(): void`, `resetViewport(): void`.
- Preserves public analysis, contrast, render, dispose methods and existing callbacks.

- [ ] Перенести время на Y, MIDI на X; playhead разместить над закреплённой снизу клавиатурой.
- [ ] Добавить viewport: 2–20 видимых будущих секунд, 36/48/60/84 видимых клавиш, горизонтальный MIDI offset, временной offset, follow.
- [ ] Рисовать белые и чёрные клавиши как настоящую горизонтальную клавиатуру; active keys подсвечивать интенсивностью.
- [ ] Рисовать frame probabilities и note outlines вертикальными блоками, обрезая по roll area.
- [ ] Добавить wheel: Y pan time, X pan pitch, Ctrl/Meta time zoom, Alt pitch zoom.
- [ ] Добавить pointer: tap seek, hold audition, drag pan; два pointer — pinch time/pitch zoom без seek/audition.
- [ ] Публичные команды масштабируют время, циклят диапазон клавиш, возвращают follow и сбрасывают viewport.
- [ ] Удалить все listeners в dispose и выполнить только `git diff --check`.

### Task 2: Trainer controls and responsive UI

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes renderer commands from Task 1.

- [ ] Обернуть canvas в stage и добавить toolbar: `−`, `+`, `Клавиши`, `К позиции`.
- [ ] Подключить команды renderer и обновить ARIA/title.
- [ ] Обновить rail: `Drag — обзор · Tap — позиция · Hold — нота`.
- [ ] На mobile дать кнопкам touch target не меньше 38 px, stage высотой около 68vh, controls с горизонтальным overflow.
- [ ] Добавить `touch-action: none` canvas, cursor grab/grabbing states и современный полупрозрачный toolbar.
- [ ] Выполнить только `git diff --check`.

### Task 3: Static integration review

**Files:**
- Review: `src/piano-roll-renderer.ts`
- Review: `src/main.ts`
- Review: `src/style.css`

- [ ] Проверить совпадение id и публичных методов.
- [ ] Проверить отсутствие старой горизонтальной математики и утечек event listeners.
- [ ] Проверить edge cases: нет анализа, duration 0, крайние MIDI, resize, mouse, single touch, pinch.
- [ ] Исправить только найденные дефекты; не запускать build/typecheck/tests.
- [ ] Выполнить `git diff --check`.
