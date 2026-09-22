import { AnalysisClient, AnalysisClientError } from './analysis-client';
import { AnalysisErrorCode, AnalysisPhase, type AnalysisResult, type AnalyzedNote, RecognitionMode } from './analysis-types';
import { AudioPlayer, AudioPlayerError, AudioPlayerErrorCode } from './audio-player';
import { FastSpectrumClient, FastSpectrumClientError } from './fast-spectrum';
import type { FastSpectrumOptions } from './fast-spectrum-analysis';
import { cachePrecise, fingerprintFile, getCachedPrecise, midiFromBase64, midiToBase64, type CachedPrecise } from './precise-cache';
import { PianoRollRenderer } from './piano-roll-renderer';
import { PianoAudition } from './piano-audition';
import { WaveformTimeline } from './waveform-timeline';
import { ICONS } from './icons';
import '@fontsource-variable/unbounded';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('Application root is missing');
}

// Pointer clicks on buttons must not move focus — otherwise Space stops
// toggling playback after any UI interaction. Keyboard focus is unaffected.
app.addEventListener('mousedown', event => {
  if (event.target instanceof Element && event.target.closest('button') !== null) {
    event.preventDefault();
  }
});

app.innerHTML = `
  <main class="application">
    <header class="application__header">
      <div class="application__brand" aria-label="pianorolltranscribe">
        <span class="application__mark" aria-hidden="true"><span class="application__mark-keys"><i></i><i></i><i></i><i></i></span><span class="application__mark-note"></span></span>
        <h1>pianorolltranscribe</h1>
      </div>
      <p class="application__privacy" title="Аудио декодируется и анализируется в браузере — ничего не отправляется">${ICONS.shieldCheck}<span>Локальная обработка</span></p>
    </header>
    <section class="workspace" id="workspace" aria-busy="false">
      <p class="visually-hidden" id="status" role="status" aria-live="polite"></p>
      <div class="drop-zone" id="drop-zone" role="button" tabindex="0" aria-controls="file-input" aria-describedby="drop-description">
        <input id="file-input" type="file" accept="audio/*" hidden>
        <span class="drop-zone__motif" aria-hidden="true">
          <svg viewBox="0 0 232 120" fill="none">
            <rect x="1" y="1" width="230" height="118" rx="14" stroke="currentColor" opacity=".28"/>
            <g opacity=".12" stroke="currentColor">
              <path d="M32 8v104M64 8v104M96 8v104M128 8v104M160 8v104M192 8v104"/>
            </g>
            <g fill="currentColor">
              <rect x="20" y="18" width="12" height="30" rx="6"/>
              <rect x="40" y="12" width="12" height="44" rx="6" opacity=".75"/>
              <rect x="60" y="30" width="12" height="24" rx="6"/>
              <rect x="80" y="14" width="12" height="52" rx="6" opacity=".75"/>
              <rect x="100" y="36" width="12" height="30" rx="6"/>
              <rect x="120" y="16" width="12" height="42" rx="6" opacity=".75"/>
              <rect x="140" y="44" width="12" height="20" rx="6"/>
              <rect x="160" y="20" width="12" height="48" rx="6" opacity=".75"/>
              <rect x="180" y="34" width="12" height="30" rx="6"/>
              <rect x="200" y="14" width="12" height="50" rx="6" opacity=".75"/>
            </g>
            <rect x="10" y="92" width="212" height="3" rx="1.5" style="fill: var(--playback);"/>
          </svg>
        </span>
        <div class="drop-zone__copy">
          <strong id="drop-title">Открыть аудиодорожку</strong>
          <span id="drop-description">Перетащите файл или выберите с устройства — ноты появятся на падающей ленте над клавиатурой</span>
          <span class="drop-zone__meta">MP3 · WAV · M4A&ensp;·&ensp;до 200 МБ&ensp;·&ensp;до 10 минут&ensp;·&ensp;файл не покидает устройство</span>
        </div>
        <span class="drop-zone__cta">${ICONS.upload}Выбрать файл</span>
        <span class="drop-zone__progress" aria-hidden="true"><i></i></span>
      </div>
      <div class="error-message" id="error-message" role="alert" hidden>
        ${ICONS.circleAlert}
        <span id="error-text"></span>
        <button class="button button--secondary" id="recovery-button" type="button">Выбрать другой файл</button>
      </div>
      <section class="player" id="player" hidden>
        <div class="player__deck">
          <div class="player__toolbar" aria-label="Действия с аудиофайлом">
            <div class="player__file">
              <span class="player__file-icon" aria-hidden="true">${ICONS.fileMusic}</span>
              <strong id="file-name"></strong>
            </div>
            <div class="player__actions">
              <span class="player__analysis-status" id="analysis-status" aria-live="polite"></span>
              <label class="control-chip" for="playback-rate">
                <span class="control-chip__label">Скорость</span>
                <span class="control-chip__select">
                  <select id="playback-rate" aria-label="Скорость воспроизведения" title="Скорость воспроизведения — высота звука сохраняется">
                    <option value="0.2">0,2×</option>
                    <option value="0.3">0,3×</option>
                    <option value="0.4">0,4×</option>
                    <option value="0.5">0,5×</option>
                    <option value="0.6">0,6×</option>
                    <option value="0.7">0,7×</option>
                    <option value="0.8">0,8×</option>
                    <option value="0.9">0,9×</option>
                    <option value="1" selected>1×</option>
                  </select>
                  ${ICONS.chevronDown}
                </span>
              </label>
              <label class="control-chip control-chip--range" for="sensitivity">
                <span class="control-chip__label">Чувствительность</span>
                <input id="sensitivity" type="range" min="0" max="1" value="0.5" step="0.05" aria-label="Чувствительность анализа" aria-valuetext="Чувствительность: 50%" title="Выше — больше нот, ниже — строже отбор">
                <output class="control-chip__value" id="sensitivity-value" for="sensitivity">50%</output>
              </label>
              <div class="analysis-settings" id="analysis-settings">
                <button class="button button--neutral" id="settings-toggle" type="button" aria-expanded="false" aria-controls="analysis-settings-panel" aria-label="Настройки анализа" title="Настройки анализа">${ICONS.slidersHorizontal}<span class="button__label">Настройки</span></button>
                <div class="analysis-settings__panel" id="analysis-settings-panel" role="group" aria-label="Настройки анализа" hidden>
                  <label class="control-chip control-chip--range" for="min-note-ms">
                    <span class="control-chip__label">Мин. длительность ноты</span>
                    <input id="min-note-ms" type="range" min="50" max="500" value="150" step="10" aria-label="Минимальная длительность ноты" aria-valuetext="Минимальная длительность: 150 мс">
                    <output class="control-chip__value" id="min-note-ms-value" for="min-note-ms">150 мс</output>
                  </label>
                  <label class="control-chip control-chip--range" for="max-notes">
                    <span class="control-chip__label">Макс. нот одновременно</span>
                    <input id="max-notes" type="range" min="1" max="8" value="8" step="1" aria-label="Максимум нот одновременно" aria-valuetext="Максимум одновременно: 8">
                    <output class="control-chip__value" id="max-notes-value" for="max-notes">8</output>
                  </label>
                  <label class="control-chip control-chip--range" for="contrast">
                    <span class="control-chip__label">Контраст нот</span>
                    <input id="contrast" type="range" min="0.7" max="2.2" value="1.4" step="0.05" aria-label="Контраст нот — влияет только на отображение" aria-valuetext="Контраст: 1,4">
                    <output class="control-chip__value" id="contrast-value" for="contrast">1,4×</output>
                  </label>
                  <p class="analysis-settings__hint">Применяются к быстрому анализу — ноты пересчитываются автоматически.</p>
                </div>
              </div>
              <div class="recognition-mode" id="recognition-mode" role="radiogroup" aria-label="Режим распознавания" hidden>
                <button class="button recognition-mode__option recognition-mode__option--selected" id="instant-mode-button" type="button" role="radio" aria-checked="true" tabindex="0">Быстро</button>
                <button class="button recognition-mode__option" id="precise-mode-button" type="button" role="radio" aria-checked="false" tabindex="-1">Точнее</button>
                <p class="recognition-help" id="recognition-mode-hint"></p>
              </div>
              <button class="button button--neutral" id="midi-download-button" type="button" aria-label="Скачать MIDI" title="Скачать результат точного анализа как MIDI-файл" hidden>${ICONS.download}<span class="button__label">MIDI</span></button>
              <button class="button button--neutral" id="replace-button" type="button" aria-label="Заменить файл" title="Заменить файл">${ICONS.replace}<span class="button__label">Заменить файл</span></button>
            </div>
          </div>
          <div class="player__controls">
            <button class="play-button" id="play-button" type="button" aria-label="Воспроизвести" title="Воспроизвести (Пробел)">${ICONS.play}</button>
            <span class="player__time" id="current-time">0:00</span>
            <div class="waveform-timeline">
              <canvas id="waveform" aria-hidden="true"></canvas>
              <input id="timeline" type="range" min="0" max="0" value="0" step="0.01" aria-label="Позиция воспроизведения">
            </div>
            <span class="player__time player__time--duration" id="duration-time">0:00</span>
          </div>
        </div>
        <section class="piano-stage" data-following="true" aria-label="Навигация по партитуре">
          <div class="piano-stage__toolbar" role="toolbar" aria-label="Масштаб и диапазон партитуры">
            <button class="piano-stage__button" id="zoom-out-button" type="button" aria-label="Уменьшить временной масштаб" title="Уменьшить временной масштаб">${ICONS.minus}</button>
            <button class="piano-stage__button" id="zoom-in-button" type="button" aria-label="Увеличить временной масштаб" title="Увеличить временной масштаб">${ICONS.plus}</button>
            <button class="piano-stage__button piano-stage__button--wide" id="pitch-range-button" type="button" aria-label="Изменить видимый диапазон клавиш" title="Изменить видимый диапазон клавиш">${ICONS.piano}<span>Диапазон</span></button>
            <button class="piano-stage__button piano-stage__button--wide" id="follow-button" type="button" aria-label="Следование включено" aria-pressed="true" title="Следование включено">${ICONS.locateFixed}<span>Следование</span></button>
          </div>
          <canvas id="piano-roll" tabindex="0" aria-label="Падающая партитура. Перетаскивайте для обзора, нажимайте для перехода к позиции и удерживайте, чтобы услышать ноту. Стрелки перемещают позицию на пять секунд." aria-describedby="player-rail"></canvas>
        </section>
        <div class="player__rail" id="player-rail">
          <span class="player__rail-hints"><kbd>Space</kbd> пауза&ensp;·&ensp;<kbd>←</kbd><kbd>→</kbd> ±5&thinsp;с&ensp;·&ensp;перетащить — обзор&ensp;·&ensp;нажать — позиция&ensp;·&ensp;удерживать — нота</span>
          <span class="player__rail-duration" id="rail-duration">0:00</span>
        </div>
      </section>
    </section>
  </main>
`;

const elements = {
  workspace: requiredElement<HTMLElement>('workspace'),
  status: requiredElement<HTMLElement>('status'),
  dropZone: requiredElement<HTMLElement>('drop-zone'),
  fileInput: requiredElement<HTMLInputElement>('file-input'),
  dropTitle: requiredElement<HTMLElement>('drop-title'),
  dropDescription: requiredElement<HTMLElement>('drop-description'),
  errorMessage: requiredElement<HTMLElement>('error-message'),
  errorText: requiredElement<HTMLElement>('error-text'),
  recoveryButton: requiredElement<HTMLButtonElement>('recovery-button'),
  player: requiredElement<HTMLElement>('player'),
  fileName: requiredElement<HTMLElement>('file-name'),
  analysisStatus: requiredElement<HTMLElement>('analysis-status'),
  recognitionMode: requiredElement<HTMLElement>('recognition-mode'),
  instantModeButton: requiredElement<HTMLButtonElement>('instant-mode-button'),
  preciseModeButton: requiredElement<HTMLButtonElement>('precise-mode-button'),
  recognitionModeHint: requiredElement<HTMLElement>('recognition-mode-hint'),
  midiDownloadButton: requiredElement<HTMLButtonElement>('midi-download-button'),
  replaceButton: requiredElement<HTMLButtonElement>('replace-button'),
  playbackRate: requiredElement<HTMLSelectElement>('playback-rate'),
  sensitivity: requiredElement<HTMLInputElement>('sensitivity'),
  sensitivityValue: requiredElement<HTMLOutputElement>('sensitivity-value'),
  analysisSettings: requiredElement<HTMLElement>('analysis-settings'),
  settingsToggle: requiredElement<HTMLButtonElement>('settings-toggle'),
  settingsPanel: requiredElement<HTMLElement>('analysis-settings-panel'),
  minNoteMs: requiredElement<HTMLInputElement>('min-note-ms'),
  minNoteMsValue: requiredElement<HTMLOutputElement>('min-note-ms-value'),
  maxNotes: requiredElement<HTMLInputElement>('max-notes'),
  maxNotesValue: requiredElement<HTMLOutputElement>('max-notes-value'),
  contrast: requiredElement<HTMLInputElement>('contrast'),
  contrastValue: requiredElement<HTMLOutputElement>('contrast-value'),
  zoomOutButton: requiredElement<HTMLButtonElement>('zoom-out-button'),
  zoomInButton: requiredElement<HTMLButtonElement>('zoom-in-button'),
  pitchRangeButton: requiredElement<HTMLButtonElement>('pitch-range-button'),
  followButton: requiredElement<HTMLButtonElement>('follow-button'),
  pianoStage: requiredElement<HTMLElement>('piano-roll').closest<HTMLElement>('.piano-stage') ?? (() => {
    throw new Error('Piano stage is missing');
  })(),
  canvas: requiredElement<HTMLCanvasElement>('piano-roll'),
  waveform: requiredElement<HTMLCanvasElement>('waveform'),
  playButton: requiredElement<HTMLButtonElement>('play-button'),
  timeline: requiredElement<HTMLInputElement>('timeline'),
  currentTime: requiredElement<HTMLElement>('current-time'),
  durationTime: requiredElement<HTMLElement>('duration-time'),
  railDuration: requiredElement<HTMLElement>('rail-duration'),
};

const analysisClient = new AnalysisClient();
const muscriptorClient = new AnalysisClient(
  () => new Worker(new URL('./muscriptor-worker.ts', import.meta.url), { type: 'module' }),
);
const fastSpectrumClient = new FastSpectrumClient();
const audioPlayer = new AudioPlayer();
const pianoAudition = new PianoAudition();
const renderer = new PianoRollRenderer(elements.canvas);
const waveformTimeline = new WaveformTimeline(elements.waveform);
let phase = AnalysisPhase.Idle;
let analysisGeneration = 0;
let animationFrameId: number | null = null;
let scrubbing = false;
let disposed = false;
let decodedSamples: Float32Array | null = null;
let currentFileHash: string | null = null;
let fullFastSpectrumReady = false;
let recognitionMode = RecognitionMode.Instant;
let fastAnalysisResult: AnalysisResult | null = null;
let preciseAnalysisResult: AnalysisResult | null = null;
let preciseAnalysisInProgress = false;
let preciseAnalysisProgress = 0;
let preciseModelReadyOnDevice = readPreciseModelReadyHint();
let muscriptorUnavailable = false;
let incrementalNotes: AnalyzedNote[] = [];
let refinedUpToSeconds = 0;
let partialFrameTimestamps: Float32Array | null = null;
let partialFrameProbabilities: Uint8Array | null = null;
let analysisSensitivity = 0.5;
let analysisMinNoteMs = 150;
let analysisMaxNotesPerFrame = 8;
let fastAnalysisRunning = false;
let fastReanalyzePending = false;
let reanalyzeTimer: number | null = null;

audioPlayer.onStateChange = () => {
  if (disposed) {
    return;
  }
  updatePlaybackUi();
  requestAnimation();
};

renderer.onSeek = seconds => {
  if (disposed || !isPlaybackReady()) {
    return;
  }
  audioPlayer.seek(seconds);
  updatePlaybackUi();
  requestAnimation();
};
renderer.onFollowChange = following => {
  if (!disposed) {
    updateFollowUi(following);
  }
};
renderer.onPianoKeyPrepare = () => {
  if (!disposed) {
    pianoAudition.prepare();
  }
};
renderer.onPianoKeyStart = midi => {
  if (!disposed) {
    pianoAudition.start(midi);
  }
};
renderer.onPianoKeyStop = () => {
  pianoAudition.stop();
};

elements.fileInput.addEventListener('change', () => {
  const [file] = elements.fileInput.files ?? [];
  elements.fileInput.value = '';
  if (file !== undefined) {
    void loadFile(file);
  }
});

elements.dropZone.addEventListener('click', () => {
  if (!disposed) {
    elements.fileInput.click();
  }
});
elements.dropZone.addEventListener('keydown', event => {
  if (disposed) {
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    elements.fileInput.click();
  }
});
elements.dropZone.addEventListener('dragover', event => {
  if (disposed) {
    return;
  }
  event.preventDefault();
  elements.dropZone.classList.add('drop-zone--dragging');
});
elements.dropZone.addEventListener('dragleave', () => {
  elements.dropZone.classList.remove('drop-zone--dragging');
});
elements.dropZone.addEventListener('drop', event => {
  event.preventDefault();
  elements.dropZone.classList.remove('drop-zone--dragging');
  if (disposed) {
    return;
  }
  const [file] = event.dataTransfer?.files ?? [];
  if (file !== undefined) {
    void loadFile(file);
  }
});

elements.playButton.addEventListener('click', () => {
  if (disposed || !isPlaybackReady()) {
    return;
  }
  if (audioPlayer.isPlaying) {
    audioPlayer.pause();
  } else {
    void startPlayback();
  }
});

document.addEventListener('keydown', event => {
  if (
    disposed ||
    event.key !== ' ' ||
    event.repeat ||
    !isPlaybackReady() ||
    isInteractiveElement(event.target)
  ) {
    return;
  }
  event.preventDefault();
  if (audioPlayer.isPlaying) {
    audioPlayer.pause();
  } else {
    void startPlayback();
  }
});

elements.timeline.addEventListener('pointerdown', () => {
  if (disposed || !isPlaybackReady()) {
    return;
  }
  scrubbing = true;
  requestAnimation();
});
elements.timeline.addEventListener('input', () => {
  if (disposed || !isPlaybackReady()) {
    return;
  }
  audioPlayer.seek(Number(elements.timeline.value));
  updatePlaybackUi();
  requestAnimation();
});
for (const eventName of ['pointerup', 'pointercancel', 'change']) {
  elements.timeline.addEventListener(eventName, () => {
    scrubbing = false;
    stopAnimationIfIdle();
  });
}

elements.timeline.addEventListener('keydown', event => {
  if (disposed || !isPlaybackReady()) {
    return;
  }
  const seekOffset = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : null;
  if (seekOffset === null) {
    return;
  }
  event.preventDefault();
  audioPlayer.seek(audioPlayer.currentTimeSeconds + seekOffset);
  updatePlaybackUi();
  requestAnimation();
});

let playbackRatePointerActive = false;
restorePlaybackRate();
elements.playbackRate.addEventListener('pointerdown', () => {
  playbackRatePointerActive = true;
});
elements.playbackRate.addEventListener('change', () => {
  audioPlayer.setPlaybackRate(Number(elements.playbackRate.value));
  persistPlaybackRate();
  if (playbackRatePointerActive) {
    elements.playbackRate.blur();
  }
  playbackRatePointerActive = false;
});

elements.canvas.addEventListener('keydown', event => {
  if (disposed || !isPlaybackReady()) {
    return;
  }
  const seekOffset = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : null;
  if (seekOffset !== null) {
    event.preventDefault();
    audioPlayer.seek(audioPlayer.currentTimeSeconds + seekOffset);
  } else if (event.key === 'Home') {
    event.preventDefault();
    audioPlayer.seek(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    audioPlayer.seek(audioPlayer.durationSeconds);
  } else {
    return;
  }
  updatePlaybackUi();
  requestAnimation();
});

elements.recoveryButton.addEventListener('click', () => {
  if (!disposed) {
    elements.fileInput.click();
  }
});

elements.replaceButton.addEventListener('click', () => {
  if (!disposed) {
    elements.fileInput.click();
  }
});

elements.instantModeButton.addEventListener('click', () => {
  selectRecognitionMode(RecognitionMode.Instant);
});

elements.preciseModeButton.addEventListener('click', () => {
  selectRecognitionMode(RecognitionMode.Precise);
});

elements.recognitionMode.addEventListener('keydown', event => {
  let nextMode: RecognitionMode | null = null;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextMode = RecognitionMode.Instant;
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextMode = RecognitionMode.Precise;
  }
  if (nextMode === null) {
    return;
  }
  event.preventDefault();
  selectRecognitionMode(nextMode);
  if (nextMode === RecognitionMode.Instant) {
    elements.instantModeButton.focus();
  } else {
    elements.preciseModeButton.focus();
  }
});

restoreAnalysisSettings();

elements.sensitivity.addEventListener('input', () => {
  analysisSensitivity = Number(elements.sensitivity.value);
  const text = formatSensitivity(analysisSensitivity);
  elements.sensitivityValue.value = text;
  elements.sensitivityValue.textContent = text;
  elements.sensitivity.setAttribute('aria-valuetext', `Чувствительность: ${text}`);
  persistAnalysisSettings();
  queueFastReanalyze();
});

elements.minNoteMs.addEventListener('input', () => {
  analysisMinNoteMs = Number(elements.minNoteMs.value);
  const text = `${analysisMinNoteMs} мс`;
  elements.minNoteMsValue.value = text;
  elements.minNoteMsValue.textContent = text;
  elements.minNoteMs.setAttribute('aria-valuetext', `Минимальная длительность: ${text}`);
  persistAnalysisSettings();
  queueFastReanalyze();
});

elements.maxNotes.addEventListener('input', () => {
  analysisMaxNotesPerFrame = Number(elements.maxNotes.value);
  const text = String(analysisMaxNotesPerFrame);
  elements.maxNotesValue.value = text;
  elements.maxNotesValue.textContent = text;
  elements.maxNotes.setAttribute('aria-valuetext', `Максимум одновременно: ${text}`);
  persistAnalysisSettings();
  queueFastReanalyze();
});

elements.contrast.addEventListener('input', () => {
  const contrast = Number(elements.contrast.value);
  renderer.setContrast(contrast);
  const text = formatContrast(contrast);
  elements.contrastValue.value = text;
  elements.contrastValue.textContent = text;
  elements.contrast.setAttribute('aria-valuetext', `Контраст: ${text}`);
  persistContrastSetting();
});

elements.settingsToggle.addEventListener('click', () => {
  if (!disposed) {
    setSettingsOpen(elements.settingsPanel.hidden);
  }
});

document.addEventListener('pointerdown', event => {
  if (elements.settingsPanel.hidden) {
    return;
  }
  if (event.target instanceof Node && elements.analysisSettings.contains(event.target)) {
    return;
  }
  setSettingsOpen(false);
});

document.addEventListener('keydown', event => {
  if (disposed || event.key !== 'Escape' || elements.settingsPanel.hidden) {
    return;
  }
  setSettingsOpen(false);
  elements.settingsToggle.focus();
});

elements.zoomOutButton.addEventListener('click', () => {
  if (!disposed) {
    renderer.zoomTime(-1);
  }
});

elements.zoomInButton.addEventListener('click', () => {
  if (!disposed) {
    renderer.zoomTime(1);
  }
});

elements.pitchRangeButton.addEventListener('click', () => {
  if (!disposed) {
    renderer.cyclePitchRange();
  }
});

elements.followButton.addEventListener('click', () => {
  if (!disposed) {
    renderer.toggleFollow();
  }
});

elements.midiDownloadButton.addEventListener('click', () => {
  const midiBytes = preciseAnalysisResult?.midiBytes;
  if (disposed || midiBytes === undefined) {
    return;
  }
  const url = URL.createObjectURL(new Blob([midiBytes], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = url;
  const baseName = elements.fileName.textContent ?? 'transcription';
  link.download = `${baseName.replace(/\.[^.]+$/, '') || 'transcription'}.mid`;
  link.click();
  URL.revokeObjectURL(url);
});

window.addEventListener('beforeunload', () => {
  disposed = true;
  analysisGeneration += 1;
  cancelAnimation();
  analysisClient.dispose();
  muscriptorClient.dispose();
  fastSpectrumClient.dispose();
  audioPlayer.dispose();
  pianoAudition.dispose();
  renderer.dispose();
  waveformTimeline.dispose();
});

async function loadFile(file: File): Promise<void> {
  if (disposed) {
    return;
  }
  const generation = ++analysisGeneration;
  analysisClient.cancel();
  muscriptorClient.cancel();
  fastSpectrumClient.cancel();
  audioPlayer.reset();
  renderer.clear();
  waveformTimeline.clear();
  cancelAnimation();
  decodedSamples = null;
  currentFileHash = null;
  fullFastSpectrumReady = false;
  fastReanalyzePending = false;
  if (reanalyzeTimer !== null) {
    window.clearTimeout(reanalyzeTimer);
    reanalyzeTimer = null;
  }
  fastAnalysisResult = null;
  preciseAnalysisResult = null;
  preciseAnalysisInProgress = false;
  preciseAnalysisProgress = 0;
  muscriptorUnavailable = false;
  incrementalNotes = [];
  refinedUpToSeconds = 0;
  partialFrameTimestamps = null;
  partialFrameProbabilities = null;
  elements.midiDownloadButton.hidden = true;
  recognitionMode = RecognitionMode.Instant;
  renderer.setPreciseKeyHighlighting(false);
  elements.analysisStatus.textContent = '';
  elements.analysisStatus.removeAttribute('title');
  elements.analysisStatus.removeAttribute('aria-label');
  elements.fileName.textContent = file.name;
  elements.player.hidden = true;
  elements.dropZone.hidden = false;
  elements.workspace.dataset.state = 'loading';
  clearError();
  setPhase(AnalysisPhase.Loading);
  let hasFastPreview = false;
  let hasFullFastSpectrum = false;

  try {
    // Fingerprint in parallel with decoding — used to look up a cached
    // precise result for this exact file later.
    void fingerprintFile(file).then(hash => {
      if (hash !== null && generation === analysisGeneration) {
        currentFileHash = hash;
      }
    });
    const decoded = await audioPlayer.load(file);
    if (generation !== analysisGeneration) {
      return;
    }

    decodedSamples = decoded.samples;
    waveformTimeline.setSamples(decoded.samples, decoded.durationSeconds);
    elements.dropZone.hidden = true;
    setPhase(AnalysisPhase.FastAnalyzing);
    fastAnalysisRunning = true;
    const fastResult = await fastSpectrumClient.analyze(
      decoded.samples,
      {
        onPreview: preview => {
          if (generation !== analysisGeneration) {
            return;
          }
          hasFastPreview = true;
          renderer.setAnalysis(preview, decoded.durationSeconds);
          elements.timeline.max = String(decoded.durationSeconds);
          elements.timeline.value = '0';
          elements.durationTime.textContent = formatTime(decoded.durationSeconds);
          elements.railDuration.textContent = formatTime(decoded.durationSeconds);
          elements.player.hidden = false;
          setPhase(AnalysisPhase.PreviewReady);
          elements.status.textContent = 'Первые ноты готовы. Продолжаем подготовку.';
          updatePlaybackUi();
        },
      },
      currentFastSpectrumOptions(),
    );
    if (generation !== analysisGeneration) {
      return;
    }
    fastAnalysisRunning = false;
    hasFullFastSpectrum = true;
    fullFastSpectrumReady = true;

    fastAnalysisResult = fastResult;
    renderer.setAnalysis(fastAnalysisResult, decoded.durationSeconds);
    elements.timeline.max = String(decoded.durationSeconds);
    elements.timeline.value = '0';
    elements.durationTime.textContent = formatTime(decoded.durationSeconds);
    elements.railDuration.textContent = formatTime(decoded.durationSeconds);
    elements.player.hidden = false;
    setPhase(AnalysisPhase.FastReady);
    updatePlaybackUi();
    if (fastReanalyzePending) {
      fastReanalyzePending = false;
      queueFastReanalyze();
    }
  } catch (error) {
    if (generation === analysisGeneration) {
      fastAnalysisRunning = false;
    }
    if (generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    if (isPlaybackReady() && hasFullFastSpectrum) {
      setPhase(AnalysisPhase.FastReady);
      elements.status.textContent = 'Быстрый вариант готов. Точный вариант сейчас недоступен.';
      return;
    }
    if (isPlaybackReady() && hasFastPreview) {
      setPhase(AnalysisPhase.PreviewReady);
      elements.status.textContent = 'Первые ноты готовы. Полная лента сейчас недоступна.';
      if (fastReanalyzePending) {
        fastReanalyzePending = false;
        queueFastReanalyze();
      }
      return;
    }
    elements.dropZone.hidden = false;
    setPhase(AnalysisPhase.Failed);
    showError(toErrorMessage(error));
  }
}

function currentFastSpectrumOptions(): FastSpectrumOptions {
  return {
    sensitivity: analysisSensitivity,
    minNoteMs: analysisMinNoteMs,
    maxNotesPerFrame: analysisMaxNotesPerFrame,
  };
}

function queueFastReanalyze(): void {
  if (disposed) {
    return;
  }
  // The initial analyze in loadFile owns the worker — never cancel it from
  // here; run after it settles instead (loadFile consumes the flag).
  if (decodedSamples !== null && fastAnalysisRunning) {
    fastReanalyzePending = true;
    return;
  }
  if (decodedSamples === null || !isPlaybackReady()) {
    return;
  }
  if (reanalyzeTimer !== null) {
    window.clearTimeout(reanalyzeTimer);
  }
  reanalyzeTimer = window.setTimeout(() => {
    reanalyzeTimer = null;
    void reanalyzeFastSpectrum();
  }, 220);
}

async function reanalyzeFastSpectrum(): Promise<void> {
  const samples = decodedSamples;
  if (disposed || samples === null || fastAnalysisRunning || !isPlaybackReady()) {
    return;
  }
  const generation = analysisGeneration;
  fastSpectrumClient.cancel();
  elements.analysisStatus.textContent = 'Обновляем ноты';
  elements.analysisStatus.removeAttribute('title');
  elements.analysisStatus.removeAttribute('aria-label');
  elements.analysisStatus.dataset.busy = 'true';
  elements.status.textContent = 'Обновляем ноты с новыми настройками.';
  try {
    const result = await fastSpectrumClient.analyze(
      samples,
      {
        onPreview: preview => {
          if (
            disposed ||
            generation !== analysisGeneration ||
            recognitionMode !== RecognitionMode.Instant
          ) {
            return;
          }
          renderer.setAnalysisPreservingViewport(preview, audioPlayer.durationSeconds);
        },
      },
      currentFastSpectrumOptions(),
    );
    if (disposed || generation !== analysisGeneration) {
      return;
    }
    fastAnalysisResult = result;
    fullFastSpectrumReady = true;
    if (recognitionMode === RecognitionMode.Instant) {
      renderer.setAnalysisPreservingViewport(result, audioPlayer.durationSeconds);
    }
    restoreReadyPhase();
    elements.status.textContent = 'Ноты обновлены с новыми настройками.';
    updatePlaybackUi();
  } catch (error) {
    if (disposed || generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    console.error('Пересчёт быстрого анализа не удался:', error);
    restoreReadyPhase();
    showError('Не удалось пересчитать ноты с новыми настройками. Показан прежний вариант.');
    elements.status.textContent = 'Не удалось обновить ноты.';
  }
}

function restoreReadyPhase(): void {
  if (recognitionMode === RecognitionMode.Precise) {
    if (preciseAnalysisInProgress) {
      setPhase(AnalysisPhase.Refining, preciseAnalysisProgress);
      return;
    }
    if (preciseAnalysisResult !== null) {
      setPhase(AnalysisPhase.Complete);
      return;
    }
  }
  setPhase(fullFastSpectrumReady ? AnalysisPhase.FastReady : AnalysisPhase.PreviewReady);
}

function setSettingsOpen(open: boolean): void {
  elements.settingsPanel.hidden = !open;
  elements.settingsToggle.setAttribute('aria-expanded', String(open));
}

function selectRecognitionMode(nextMode: RecognitionMode): void {
  if (disposed || !fullFastSpectrumReady || fastAnalysisResult === null) {
    return;
  }

  recognitionMode = nextMode;
  if (nextMode === RecognitionMode.Instant) {
    renderer.setPreciseKeyHighlighting(false);
    renderer.setAnalysisPreservingViewport(fastAnalysisResult, audioPlayer.durationSeconds);
    setPhase(AnalysisPhase.FastReady);
    updatePlaybackUi();
    return;
  }

  renderer.setPreciseKeyHighlighting(false);

  if (preciseAnalysisResult !== null) {
    renderer.setPreciseKeyHighlighting(true);
    renderer.setAnalysisPreservingViewport(preciseAnalysisResult, audioPlayer.durationSeconds);
    setPhase(AnalysisPhase.Complete);
    updatePlaybackUi();
    return;
  }

  if (preciseAnalysisInProgress) {
    const partial = buildPartialResult();
    if (partial !== null) {
      renderer.setAnalysisPreservingViewport(partial, audioPlayer.durationSeconds);
    }
    setPhase(AnalysisPhase.Refining, preciseAnalysisProgress);
    return;
  }

  void refineWithModel();
}

async function refineWithModel(): Promise<void> {
  const samples = decodedSamples;
  if (
    disposed ||
    !fullFastSpectrumReady ||
    samples === null ||
    preciseAnalysisInProgress
  ) {
    return;
  }

  const generation = analysisGeneration;
  preciseAnalysisInProgress = true;
  preciseAnalysisProgress = 0;
  incrementalNotes = [];
  refinedUpToSeconds = 0;
  partialFrameTimestamps = null;
  partialFrameProbabilities = null;
  clearError();
  setPhase(AnalysisPhase.Refining, 0);
  try {
    const result = await runPreciseAnalysis(samples, generation);
    if (disposed || generation !== analysisGeneration) {
      return;
    }
    preciseAnalysisInProgress = false;
    preciseAnalysisResult = result;
    elements.midiDownloadButton.hidden = result.midiBytes === undefined;
    persistPreciseModelReadyHint();
    if (recognitionMode === RecognitionMode.Precise) {
      renderer.setPreciseKeyHighlighting(true);
      renderer.setAnalysisPreservingViewport(result, audioPlayer.durationSeconds);
      setPhase(AnalysisPhase.Complete);
    } else {
      setPhase(AnalysisPhase.FastReady);
    }
    updatePlaybackUi();
  } catch (error) {
    if (disposed || generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    console.error('Точный анализ не удался:', error);
    preciseAnalysisInProgress = false;
    recognitionMode = RecognitionMode.Instant;
    renderer.setPreciseKeyHighlighting(false);
    if (fastAnalysisResult !== null) {
      renderer.setAnalysisPreservingViewport(fastAnalysisResult, audioPlayer.durationSeconds);
    }
    setPhase(AnalysisPhase.FastReady);
    showError('Не удалось подготовить точные ноты. Показан быстрый вариант — можно продолжать слушать запись.');
    elements.status.textContent = 'Точный вариант не готов. Быстрый вариант сохранён.';
  }
}

async function runPreciseAnalysis(samples: Float32Array, generation: number): Promise<AnalysisResult> {
  const fileHash = currentFileHash;
  if (fileHash !== null) {
    const cached = getCachedPrecise(fileHash);
    if (cached !== null) {
      return resultFromCache(cached);
    }
  }
  if (!muscriptorUnavailable) {
    try {
      const result = await muscriptorClient.analyze(samples.slice(), {
        onProgress: (progress, notes, stage, refinedSeconds) => {
          if (generation !== analysisGeneration) {
            return;
          }
          preciseAnalysisProgress = progress;
          if (refinedSeconds !== undefined) {
            refinedUpToSeconds = refinedSeconds;
          }
          if (notes !== undefined && notes.length > 0) {
            pushIncrementalNotes(notes);
          }
          if (
            recognitionMode === RecognitionMode.Precise &&
            (refinedSeconds !== undefined || (notes !== undefined && notes.length > 0))
          ) {
            const partial = buildPartialResult();
            if (partial !== null) {
              renderer.setAnalysisPreservingViewport(partial, audioPlayer.durationSeconds);
            }
          }
          if (recognitionMode !== RecognitionMode.Precise) {
            return;
          }
          const stageLabel = stage === 'model'
            ? 'Скачиваем модель'
            : stage === 'prepare'
              ? 'Готовим модель'
              : 'Распознаём ноты';
          setPhase(AnalysisPhase.Refining, progress, stageLabel);
        },
      });
      if (fileHash !== null) {
        cachePrecise(fileHash, {
          durationSeconds: audioPlayer.durationSeconds,
          notes: result.notes.map(note => ({
            pitchMidi: note.pitchMidi,
            amplitude: note.amplitude,
            startTimeSeconds: note.startTimeSeconds,
            endTimeSeconds: note.endTimeSeconds,
            instrument: note.instrument,
          })),
          midiBase64: result.midiBytes !== undefined ? midiToBase64(result.midiBytes) : undefined,
        });
      }
      return result;
    } catch (error) {
      // A failed run may leave the wasm instance aborted; recycle the worker
      // so a retry starts from a clean module instead of a dead one.
      muscriptorClient.cancel();
      if (
        error instanceof AnalysisClientError &&
        (error.code === AnalysisErrorCode.BackendUnavailable ||
          error.code === AnalysisErrorCode.ModelLoadFailed ||
          error.code === AnalysisErrorCode.WorkerFailed)
      ) {
        console.error('MuScriptor недоступен, переключаюсь на быстрый движок:', error.message);
        muscriptorUnavailable = true;
      } else {
        throw error;
      }
    }
  }
  return analysisClient.analyze(samples.slice(), {
    onProgress: progress => {
      if (generation === analysisGeneration) {
        preciseAnalysisProgress = progress;
        if (recognitionMode !== RecognitionMode.Precise) {
          return;
        }
        setPhase(AnalysisPhase.Refining, progress);
      }
    },
  });
}

const PARTIAL_FRAMES_PER_SECOND = 22050 / 256;
const PARTIAL_PITCH_COUNT = 88;
const PARTIAL_BASE_PITCH = 21;
// Fast spectrum runs at 22050 Hz with a 2048-sample hop.
const FAST_FRAMES_PER_SECOND = 22050 / 2048;

function paintPartialNote(
  probabilities: Uint8Array,
  frameCount: number,
  note: Pick<AnalyzedNote, 'pitchMidi' | 'amplitude' | 'startTimeSeconds' | 'endTimeSeconds'>,
): void {
  const startFrame = Math.max(0, Math.floor(note.startTimeSeconds * PARTIAL_FRAMES_PER_SECOND));
  const endFrame = Math.min(
    frameCount,
    Math.max(startFrame + 1, Math.ceil(note.endTimeSeconds * PARTIAL_FRAMES_PER_SECOND)),
  );
  const row = note.pitchMidi - PARTIAL_BASE_PITCH;
  if (row < 0 || row >= PARTIAL_PITCH_COUNT) {
    return;
  }
  const amplitude = Math.round(Math.max(0, Math.min(1, note.amplitude)) * 255);
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const index = frame * PARTIAL_PITCH_COUNT + row;
    if (amplitude > probabilities[index]) {
      probabilities[index] = amplitude;
    }
  }
}

function pushIncrementalNotes(notes: AnalyzedNote[]): void {
  const durationSeconds = audioPlayer.durationSeconds;
  if (durationSeconds <= 0) {
    return;
  }
  const frameCount = Math.max(1, Math.ceil(durationSeconds * PARTIAL_FRAMES_PER_SECOND));
  let reallocated = false;
  if (partialFrameTimestamps === null || partialFrameTimestamps.length !== frameCount) {
    partialFrameTimestamps = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      partialFrameTimestamps[frame] = frame / PARTIAL_FRAMES_PER_SECOND;
    }
    partialFrameProbabilities = new Uint8Array(frameCount * PARTIAL_PITCH_COUNT);
    reallocated = true;
  }
  const probabilities = partialFrameProbabilities;
  if (probabilities === null) {
    return;
  }
  const toMark = reallocated ? incrementalNotes.concat(notes) : notes;
  for (const note of toMark) {
    note.startFrame = Math.max(0, Math.floor(note.startTimeSeconds * PARTIAL_FRAMES_PER_SECOND));
    note.endFrame = Math.min(
      frameCount,
      Math.max(note.startFrame + 1, Math.ceil(note.endTimeSeconds * PARTIAL_FRAMES_PER_SECOND)),
    );
    paintPartialNote(probabilities, frameCount, note);
  }
  incrementalNotes.push(...notes);
}

// Rebuilds a full AnalysisResult from cached notes — the frame grid is
// derived data, painted the same way the worker's buildResult does.
function resultFromCache(cached: CachedPrecise): AnalysisResult {
  const frameCount = Math.max(1, Math.ceil(cached.durationSeconds * PARTIAL_FRAMES_PER_SECOND));
  const frameTimestamps = new Float32Array(frameCount);
  const frameProbabilities = new Uint8Array(frameCount * PARTIAL_PITCH_COUNT);
  for (let frame = 0; frame < frameCount; frame += 1) {
    frameTimestamps[frame] = frame / PARTIAL_FRAMES_PER_SECOND;
  }
  const notes: AnalyzedNote[] = [];
  for (const note of cached.notes) {
    const startFrame = Math.min(
      frameCount - 1,
      Math.max(0, Math.floor(note.startTimeSeconds * PARTIAL_FRAMES_PER_SECOND)),
    );
    const endFrame = Math.min(
      frameCount,
      Math.max(startFrame + 1, Math.ceil(note.endTimeSeconds * PARTIAL_FRAMES_PER_SECOND)),
    );
    const row = note.pitchMidi - PARTIAL_BASE_PITCH;
    if (row >= 0 && row < PARTIAL_PITCH_COUNT) {
      const cell = Math.round(Math.max(0, Math.min(1, note.amplitude)) * 255);
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        frameProbabilities[frame * PARTIAL_PITCH_COUNT + row] = cell;
      }
    }
    notes.push({
      pitchMidi: note.pitchMidi,
      amplitude: note.amplitude,
      startFrame,
      endFrame,
      startTimeSeconds: note.startTimeSeconds,
      endTimeSeconds: note.endTimeSeconds,
      instrument: note.instrument,
    });
  }
  const result: AnalysisResult = {
    notes,
    frameCount,
    pitchCount: PARTIAL_PITCH_COUNT,
    frameProbabilities,
    frameTimestamps,
  };
  if (cached.midiBase64 !== undefined) {
    result.midiBytes = midiFromBase64(cached.midiBase64);
  }
  return result;
}

function buildPartialResult(): AnalysisResult | null {
  if (partialFrameTimestamps === null || partialFrameProbabilities === null) {
    return null;
  }
  const frameCount = partialFrameTimestamps.length;
  const probabilities = partialFrameProbabilities;
  const fast = fastAnalysisResult;
  const notes = incrementalNotes.slice();
  if (fast !== null) {
    // Past the refined boundary the fast spectrum is still shown — resampled
    // onto the partial grid — so the view reads as refinement sweeping
    // left-to-right instead of fast notes vanishing at once.
    const boundaryFrame = Math.min(
      frameCount,
      Math.max(0, Math.ceil(refinedUpToSeconds * PARTIAL_FRAMES_PER_SECOND)),
    );
    for (let frame = boundaryFrame; frame < frameCount; frame += 1) {
      const fastFrame = Math.min(
        fast.frameCount - 1,
        Math.floor(partialFrameTimestamps[frame] * FAST_FRAMES_PER_SECOND),
      );
      probabilities.set(
        fast.frameProbabilities.subarray(
          fastFrame * fast.pitchCount,
          fastFrame * fast.pitchCount + fast.pitchCount,
        ),
        frame * PARTIAL_PITCH_COUNT,
      );
    }
    // Precise notes may extend past the boundary — repaint them on top.
    for (const note of incrementalNotes) {
      paintPartialNote(probabilities, frameCount, note);
    }
    for (const note of fast.notes) {
      if (note.startTimeSeconds < refinedUpToSeconds) {
        continue;
      }
      const startFrame = Math.max(0, Math.floor(note.startTimeSeconds * PARTIAL_FRAMES_PER_SECOND));
      notes.push({
        pitchMidi: note.pitchMidi,
        amplitude: note.amplitude,
        startFrame: Math.min(frameCount - 1, startFrame),
        endFrame: Math.min(
          frameCount,
          Math.max(startFrame + 1, Math.ceil(note.endTimeSeconds * PARTIAL_FRAMES_PER_SECOND)),
        ),
        startTimeSeconds: note.startTimeSeconds,
        endTimeSeconds: note.endTimeSeconds,
      });
    }
    notes.sort((left, right) => left.startTimeSeconds - right.startTimeSeconds);
  }
  return {
    notes,
    frameCount,
    pitchCount: PARTIAL_PITCH_COUNT,
    frameProbabilities: probabilities,
    frameTimestamps: partialFrameTimestamps,
  };
}

async function startPlayback(): Promise<void> {
  const generation = analysisGeneration;
  clearError();
  try {
    await audioPlayer.play();
    if (disposed || generation !== analysisGeneration) {
      return;
    }
    updatePlaybackUi();
    requestAnimation();
  } catch {
    if (disposed || generation !== analysisGeneration) {
      return;
    }
    showError(
      'Не удалось запустить воспроизведение. Проверьте разрешение браузера на звук и попробуйте ещё раз.',
    );
    elements.status.textContent = 'Не удалось запустить воспроизведение.';
    updatePlaybackUi();
  }
}

function setPhase(nextPhase: AnalysisPhase, progress = 0, label = 'Распознаём ноты'): void {
  phase = nextPhase;
  elements.workspace.dataset.state = phase === AnalysisPhase.Loading || phase === AnalysisPhase.FastAnalyzing ? 'loading' : 'ready';
  elements.workspace.setAttribute(
    'aria-busy',
    String(
      phase === AnalysisPhase.Loading ||
      phase === AnalysisPhase.FastAnalyzing ||
      phase === AnalysisPhase.PreviewReady ||
      phase === AnalysisPhase.Refining,
    ),
  );
  if (phase === AnalysisPhase.Idle) {
    elements.dropTitle.textContent = 'Загрузите аудиофайл';
    elements.dropDescription.textContent = 'Перетащите сюда или выберите с устройства';
    elements.status.textContent = 'Можно выбрать аудиофайл.';
  } else if (phase === AnalysisPhase.Loading) {
    elements.dropTitle.textContent = 'Открываем аудио…';
    elements.dropDescription.textContent = 'Подготавливаем дорожку';
    elements.status.textContent = 'Открываем аудио.';
  } else if (phase === AnalysisPhase.FastAnalyzing) {
    elements.dropTitle.textContent = 'Подготавливаем ноты…';
    elements.dropDescription.textContent = 'Это займёт немного времени';
    elements.status.textContent = 'Подготавливаем ноты.';
  } else if (phase === AnalysisPhase.PreviewReady) {
    elements.analysisStatus.textContent = 'Первые ноты готовы';
    elements.analysisStatus.removeAttribute('title');
    elements.analysisStatus.removeAttribute('aria-label');
    elements.recognitionMode.hidden = true;
    elements.status.textContent = 'Первые ноты готовы. Продолжаем подготовку.';
  } else if (phase === AnalysisPhase.FastReady) {
    setReadyAnalysisStatus('Быстрый вариант готов');
    elements.recognitionMode.hidden = !fullFastSpectrumReady;
    elements.status.textContent = 'Быстрый вариант готов. Можно воспроизводить и перематывать.';
  } else if (phase === AnalysisPhase.Refining) {
    const percentage = Math.round(progress * 100);
    elements.analysisStatus.textContent = `${label}: ${percentage}%`;
    elements.analysisStatus.removeAttribute('title');
    elements.analysisStatus.removeAttribute('aria-label');
    elements.recognitionMode.hidden = false;
    elements.status.textContent = `${label}: ${percentage}%.`;
  } else if (phase === AnalysisPhase.Complete) {
    setReadyAnalysisStatus('Точный вариант готов');
    elements.recognitionMode.hidden = false;
    elements.status.textContent = 'Точный вариант готов. Партитура готова.';
  } else {
    renderer.setPreciseKeyHighlighting(false);
    elements.dropTitle.textContent = 'Не удалось обработать файл';
    elements.dropDescription.textContent = 'Попробуйте выбрать другой аудиофайл';
    elements.status.textContent = 'Не удалось обработать файл.';
  }
  elements.analysisStatus.dataset.busy = String(
    phase === AnalysisPhase.PreviewReady || phase === AnalysisPhase.Refining,
  );
  updateRecognitionModeUi();
}

let playIconPlaying: boolean | null = null;

function updatePlaybackUi(): void {
  if (!isPlaybackReady()) {
    return;
  }
  const currentTime = audioPlayer.currentTimeSeconds;
  if (playIconPlaying !== audioPlayer.isPlaying) {
    playIconPlaying = audioPlayer.isPlaying;
    elements.playButton.innerHTML = playIconPlaying ? ICONS.pause : ICONS.play;
    const playCopy = playIconPlaying ? 'Пауза' : 'Воспроизвести';
    elements.playButton.setAttribute('aria-label', playCopy);
    elements.playButton.title = `${playCopy} (Пробел)`;
  }
  elements.timeline.value = String(currentTime);
  elements.currentTime.textContent = formatTime(currentTime);
  elements.durationTime.textContent = formatTime(audioPlayer.durationSeconds);
  elements.railDuration.textContent = formatTime(audioPlayer.durationSeconds);
  waveformTimeline.setCurrentTime(currentTime);
  renderer.render(currentTime);
}

function updateFollowUi(following: boolean): void {
  const label = following ? 'Следование' : 'К позиции';
  const copy = following ? 'Следование включено' : 'Вернуться к позиции воспроизведения';
  elements.followButton.innerHTML = `${ICONS.locateFixed}<span>${label}</span>`;
  elements.followButton.setAttribute('aria-label', copy);
  elements.followButton.title = copy;
  elements.followButton.setAttribute('aria-pressed', String(following));
  elements.pianoStage.dataset.following = String(following);
}

function isPlaybackReady(): boolean {
  return (
    phase === AnalysisPhase.PreviewReady ||
    phase === AnalysisPhase.FastReady ||
    phase === AnalysisPhase.Refining ||
    phase === AnalysisPhase.Complete
  );
}

function requestAnimation(): void {
  if (animationFrameId !== null || (!audioPlayer.isPlaying && !scrubbing)) {
    return;
  }
  const generation = analysisGeneration;
  animationFrameId = requestAnimationFrame(() => animate(generation));
}

function animate(generation: number): void {
  animationFrameId = null;
  if (disposed || generation !== analysisGeneration) {
    return;
  }
  updatePlaybackUi();
  if (audioPlayer.isPlaying || scrubbing) {
    requestAnimation();
  }
}

function stopAnimationIfIdle(): void {
  if (!audioPlayer.isPlaying && !scrubbing) {
    cancelAnimation();
  }
}

function cancelAnimation(): void {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function showError(message: string): void {
  elements.errorText.textContent = message;
  elements.errorMessage.hidden = false;
}

function clearError(): void {
  elements.errorMessage.hidden = true;
  elements.errorText.textContent = '';
}

function isCancelled(error: unknown): boolean {
  return (
    (error instanceof AnalysisClientError && error.code === AnalysisErrorCode.Cancelled) ||
    (error instanceof FastSpectrumClientError && error.code === AnalysisErrorCode.Cancelled) ||
    (error instanceof AudioPlayerError && error.code === AudioPlayerErrorCode.Cancelled)
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof AudioPlayerError) {
    if (error.code === AudioPlayerErrorCode.FileTooLarge) {
      return 'Файл больше 200 МБ. Выберите файл меньшего размера.';
    }
    if (error.code === AudioPlayerErrorCode.DurationTooLong) {
      return 'Длительность записи больше 10 минут. Выберите более короткий файл.';
    }
    return 'Формат не поддерживается или аудиофайл повреждён.';
  }
  if (error instanceof AnalysisClientError) {
    if (error.code === AnalysisErrorCode.ModelLoadFailed) {
      return 'Не удалось подготовить точные ноты.';
    }
    if (error.code === AnalysisErrorCode.BackendUnavailable) {
      return 'Браузер не смог продолжить распознавание.';
    }
    if (error.code === AnalysisErrorCode.WorkerFailed) {
      return 'Распознавание неожиданно остановилось.';
    }
    if (error.code === AnalysisErrorCode.InvalidAudio) {
      return 'Запись пуста или не подходит для распознавания.';
    }
    return 'Распознавание не завершилось.';
  }
  return 'Произошла непредвиденная ошибка. Попробуйте ещё раз.';
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function formatContrast(value: number): string {
  return `${value.toFixed(2).replace(/0$/, '').replace('.', ',')}×`;
}

function formatSensitivity(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function updateRecognitionModeUi(): void {
  const isInstant = recognitionMode === RecognitionMode.Instant;
  const canUseModes = fullFastSpectrumReady && fastAnalysisResult !== null;
  elements.instantModeButton.setAttribute('aria-checked', String(isInstant));
  elements.preciseModeButton.setAttribute('aria-checked', String(!isInstant));
  elements.instantModeButton.tabIndex = isInstant ? 0 : -1;
  elements.preciseModeButton.tabIndex = isInstant ? -1 : 0;
  elements.instantModeButton.classList.toggle('recognition-mode__option--selected', isInstant);
  elements.preciseModeButton.classList.toggle('recognition-mode__option--selected', !isInstant);
  elements.instantModeButton.disabled = !canUseModes;
  elements.preciseModeButton.disabled = !canUseModes;
  const preciseModelReadyText = 'Точный анализ уже использовался на этом устройстве — повторная загрузка обычно не нужна.';
  elements.recognitionModeHint.textContent = preciseModelReadyOnDevice
    ? ''
    : 'Первый точный анализ скачает модель MuScriptor — около 110 МБ, дальше она берётся из кэша.';
  elements.preciseModeButton.title = preciseModelReadyOnDevice
    ? `Точнее. ${preciseModelReadyText}`
    : 'Точнее';
}

function setReadyAnalysisStatus(label: string): void {
  elements.analysisStatus.textContent = label;
  elements.analysisStatus.removeAttribute('title');
  elements.analysisStatus.setAttribute('aria-label', label);
}

function isInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (
    target.closest('button, textarea, select, [role="button"]') !== null ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  ) {
    return true;
  }
  const input = target.closest('input');
  return input !== null && input.type !== 'range';
}

function readPreciseModelReadyHint(): boolean {
  try {
    return localStorage['pianorolltranscribe.precise-model-ready'] === '1';
  } catch {
    return false;
  }
}

function persistPreciseModelReadyHint(): void {
  preciseModelReadyOnDevice = true;
  try {
    localStorage['pianorolltranscribe.precise-model-ready'] = '1';
  } catch {
    return;
  }
}

function restorePlaybackRate(): void {
  let stored: unknown;
  try {
    stored = localStorage['pianorolltranscribe.playback-rate'];
  } catch {
    return;
  }
  if (typeof stored !== 'string') {
    return;
  }
  const isSupported = Array.from(elements.playbackRate.options).some(
    option => option.value === stored,
  );
  if (!isSupported) {
    return;
  }
  elements.playbackRate.value = stored;
  audioPlayer.setPlaybackRate(Number(stored));
}

function persistPlaybackRate(): void {
  try {
    localStorage['pianorolltranscribe.playback-rate'] = elements.playbackRate.value;
  } catch {
    return;
  }
}

function restoreAnalysisSettings(): void {
  let sensitivity: unknown;
  let minNoteMs: unknown;
  let maxNotes: unknown;
  let contrast: unknown;
  try {
    sensitivity = localStorage['pianorolltranscribe.sensitivity'];
    minNoteMs = localStorage['pianorolltranscribe.min-note-ms'];
    maxNotes = localStorage['pianorolltranscribe.max-notes'];
    contrast = localStorage['pianorolltranscribe.contrast'];
  } catch {
    return;
  }
  if (typeof sensitivity === 'string') {
    const value = Number(sensitivity);
    if (Number.isFinite(value)) {
      elements.sensitivity.value = String(Math.min(1, Math.max(0, value)));
      analysisSensitivity = Number(elements.sensitivity.value);
      const text = formatSensitivity(analysisSensitivity);
      elements.sensitivityValue.value = text;
      elements.sensitivityValue.textContent = text;
      elements.sensitivity.setAttribute('aria-valuetext', `Чувствительность: ${text}`);
    }
  }
  if (typeof minNoteMs === 'string') {
    const value = Number(minNoteMs);
    if (Number.isFinite(value)) {
      elements.minNoteMs.value = String(Math.min(500, Math.max(50, value)));
      analysisMinNoteMs = Number(elements.minNoteMs.value);
      const text = `${analysisMinNoteMs} мс`;
      elements.minNoteMsValue.value = text;
      elements.minNoteMsValue.textContent = text;
      elements.minNoteMs.setAttribute('aria-valuetext', `Минимальная длительность: ${text}`);
    }
  }
  if (typeof maxNotes === 'string') {
    const value = Number(maxNotes);
    if (Number.isFinite(value)) {
      elements.maxNotes.value = String(Math.min(8, Math.max(1, Math.round(value))));
      analysisMaxNotesPerFrame = Number(elements.maxNotes.value);
      const text = String(analysisMaxNotesPerFrame);
      elements.maxNotesValue.value = text;
      elements.maxNotesValue.textContent = text;
      elements.maxNotes.setAttribute('aria-valuetext', `Максимум одновременно: ${text}`);
    }
  }
  if (typeof contrast === 'string') {
    const value = Number(contrast);
    if (Number.isFinite(value)) {
      elements.contrast.value = String(Math.min(2.2, Math.max(0.7, value)));
      const applied = Number(elements.contrast.value);
      renderer.setContrast(applied);
      const text = formatContrast(applied);
      elements.contrastValue.value = text;
      elements.contrastValue.textContent = text;
      elements.contrast.setAttribute('aria-valuetext', `Контраст: ${text}`);
    }
  }
}

function persistAnalysisSettings(): void {
  try {
    localStorage['pianorolltranscribe.sensitivity'] = String(analysisSensitivity);
    localStorage['pianorolltranscribe.min-note-ms'] = String(analysisMinNoteMs);
    localStorage['pianorolltranscribe.max-notes'] = String(analysisMaxNotesPerFrame);
  } catch {
    return;
  }
}

function persistContrastSetting(): void {
  try {
    localStorage['pianorolltranscribe.contrast'] = elements.contrast.value;
  } catch {
    return;
  }
}

function requiredElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Element #${id} is missing`);
  }
  return element as ElementType;
}
