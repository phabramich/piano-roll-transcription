import { AnalysisClient, AnalysisClientError } from './analysis-client';
import { AnalysisErrorCode, AnalysisPhase, type AnalysisResult, RecognitionMode } from './analysis-types';
import { AudioPlayer, AudioPlayerError, AudioPlayerErrorCode } from './audio-player';
import { FastSpectrumClient, FastSpectrumClientError } from './fast-spectrum';
import { PianoRollRenderer } from './piano-roll-renderer';
import { PianoAudition } from './piano-audition';
import { WaveformTimeline } from './waveform-timeline';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('Application root is missing');
}

app.innerHTML = `
  <main class="application">
    <header class="application__header">
      <div class="application__brand" aria-label="pianorolltranscribe">
        <span class="application__mark" aria-hidden="true"><span class="application__mark-keys"><i></i><i></i><i></i><i></i></span><span class="application__mark-note"></span></span>
        <h1>pianorolltranscribe</h1>
      </div>
      <p class="application__privacy"><span aria-hidden="true">●</span> Локальная обработка</p>
    </header>
    <section class="workspace" id="workspace" aria-busy="false">
      <p class="visually-hidden" id="status" role="status" aria-live="polite"></p>
      <div class="drop-zone" id="drop-zone" role="button" tabindex="0" aria-controls="file-input">
        <input id="file-input" type="file" accept="audio/*" hidden>
        <span class="drop-zone__motif" aria-hidden="true">
          <svg viewBox="0 0 500 112" fill="none" preserveAspectRatio="none"><path d="M0 57h500M0 33h500M0 81h500" stroke="currentColor" opacity=".12"/><path d="M0 74c14-2 19-37 33-37 14 0 20 62 35 62 16 0 21-74 36-74 13 0 18 50 31 50 14 0 19-22 33-22 15 0 19 34 33 34 14 0 20-67 35-67 14 0 19 43 33 43 14 0 20-29 35-29 13 0 19 54 32 54 15 0 20-44 35-44 15 0 20 28 35 28 14 0 20-20 35-20 15 0 19 42 34 42 14 0 19-69 34-69 15 0 20 45 35 45 14 0 19-22 33-22 15 0 20 35 34 35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </span>
        <div class="drop-zone__copy">
          <strong id="drop-title">Открыть аудиодорожку</strong>
          <span id="drop-description">Перетащите файл или выберите с устройства</span>
        </div>
        <span class="drop-zone__cta">Выбрать файл <b aria-hidden="true">→</b></span>
        <span class="drop-zone__meta">MP3 · WAV · M4A &nbsp; / &nbsp; до 200 МБ</span>
      </div>
      <div class="error-message" id="error-message" role="alert" hidden>
        <span id="error-text"></span>
        <button class="button button--secondary" id="recovery-button" type="button">Выбрать другой файл</button>
      </div>
      <section class="player" id="player" hidden>
        <div class="player__deck">
          <div class="player__toolbar" aria-label="Действия с аудиофайлом">
            <div class="player__file">
              <span class="player__file-icon" aria-hidden="true">♬</span>
              <strong id="file-name"></strong>
            </div>
            <div class="player__actions">
              <span class="player__analysis-status" id="analysis-status" aria-live="polite"></span>
              <label class="contrast-control" for="contrast">
                <span class="contrast-control__label">Контраст нот</span>
                <input id="contrast" type="range" min="0.7" max="2.2" value="1.4" step="0.05" aria-label="Контраст нот" aria-valuetext="Контраст: 1,4">
                <output class="contrast-control__value" id="contrast-value" for="contrast">1,4×</output>
              </label>
              <div class="recognition-mode" id="recognition-mode" role="radiogroup" aria-label="Режим распознавания" hidden>
                <button class="button recognition-mode__option recognition-mode__option--selected" id="instant-mode-button" type="button" role="radio" aria-checked="true" tabindex="0">Быстро</button>
                <button class="button recognition-mode__option" id="precise-mode-button" type="button" role="radio" aria-checked="false" tabindex="-1">Точнее</button>
                <p class="recognition-help" id="recognition-mode-hint"></p>
              </div>
              <button class="button button--neutral" id="replace-button" type="button" aria-label="Заменить файл" title="Заменить файл"><span aria-hidden="true">↗</span><span class="button__label">Заменить файл</span></button>
            </div>
          </div>
          <div class="player__controls">
            <button class="play-button" id="play-button" type="button" aria-label="Воспроизвести"><span aria-hidden="true">▶</span></button>
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
            <button class="piano-stage__button" id="zoom-out-button" type="button" aria-label="Уменьшить временной масштаб" title="Уменьшить временной масштаб">−</button>
            <button class="piano-stage__button" id="zoom-in-button" type="button" aria-label="Увеличить временной масштаб" title="Увеличить временной масштаб">+</button>
            <button class="piano-stage__button piano-stage__button--wide" id="pitch-range-button" type="button" aria-label="Изменить видимый диапазон клавиш" title="Изменить видимый диапазон клавиш">Клавиши</button>
            <button class="piano-stage__button piano-stage__button--wide" id="follow-button" type="button" aria-label="Следование включено" aria-pressed="true" title="Следование включено">Следование включено</button>
          </div>
          <canvas id="piano-roll" tabindex="0" aria-label="Падающая партитура. Перетаскивайте для обзора, нажимайте для перехода к позиции и удерживайте, чтобы услышать ноту. Стрелки перемещают позицию на пять секунд."></canvas>
        </section>
        <div class="player__rail"><span>Перетащить — обзор · Нажать — позиция · Удерживать — нота</span><span class="player__rail-duration" id="rail-duration">0:00</span></div>
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
  replaceButton: requiredElement<HTMLButtonElement>('replace-button'),
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
let fullFastSpectrumReady = false;
let recognitionMode = RecognitionMode.Instant;
let fastAnalysisResult: AnalysisResult | null = null;
let preciseAnalysisResult: AnalysisResult | null = null;
let preciseAnalysisInProgress = false;
let preciseAnalysisProgress = 0;
let preciseModelReadyOnDevice = readPreciseModelReadyHint();

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

elements.contrast.addEventListener('input', () => {
  const contrast = Number(elements.contrast.value);
  renderer.setContrast(contrast);
  const text = formatContrast(contrast);
  elements.contrastValue.value = text;
  elements.contrastValue.textContent = text;
  elements.contrast.setAttribute('aria-valuetext', `Контраст: ${text}`);
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

window.addEventListener('beforeunload', () => {
  disposed = true;
  analysisGeneration += 1;
  cancelAnimation();
  analysisClient.dispose();
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
  fastSpectrumClient.cancel();
  audioPlayer.reset();
  renderer.clear();
  waveformTimeline.clear();
  cancelAnimation();
  decodedSamples = null;
  fullFastSpectrumReady = false;
  fastAnalysisResult = null;
  preciseAnalysisResult = null;
  preciseAnalysisInProgress = false;
  preciseAnalysisProgress = 0;
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
    const decoded = await audioPlayer.load(file);
    if (generation !== analysisGeneration) {
      return;
    }

    decodedSamples = decoded.samples;
    waveformTimeline.setSamples(decoded.samples, decoded.durationSeconds);
    elements.dropZone.hidden = true;
    setPhase(AnalysisPhase.FastAnalyzing);
    const fastResult = await fastSpectrumClient.analyze(decoded.samples, {
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
    });
    if (generation !== analysisGeneration) {
      return;
    }
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
  } catch (error) {
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
      return;
    }
    elements.dropZone.hidden = false;
    setPhase(AnalysisPhase.Failed);
    showError(toErrorMessage(error));
  }
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

  renderer.setPreciseKeyHighlighting(true);

  if (preciseAnalysisResult !== null) {
    renderer.setAnalysisPreservingViewport(preciseAnalysisResult, audioPlayer.durationSeconds);
    setPhase(AnalysisPhase.Complete);
    updatePlaybackUi();
    return;
  }

  if (preciseAnalysisInProgress) {
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
  clearError();
  setPhase(AnalysisPhase.Refining, 0);
  try {
    const result = await analysisClient.analyze(samples.slice(), {
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
    if (disposed || generation !== analysisGeneration) {
      return;
    }
    preciseAnalysisInProgress = false;
    preciseAnalysisResult = result;
    persistPreciseModelReadyHint();
    if (recognitionMode === RecognitionMode.Precise) {
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

function setPhase(nextPhase: AnalysisPhase, progress = 0): void {
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
    elements.analysisStatus.textContent = `Распознаём ноты: ${percentage}%`;
    elements.analysisStatus.removeAttribute('title');
    elements.analysisStatus.removeAttribute('aria-label');
    elements.recognitionMode.hidden = false;
    elements.status.textContent = `Распознаём ноты: ${percentage}%.`;
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
  updateRecognitionModeUi();
}

function updatePlaybackUi(): void {
  if (!isPlaybackReady()) {
    return;
  }
  const currentTime = audioPlayer.currentTimeSeconds;
  elements.playButton.innerHTML = `<span aria-hidden="true">${audioPlayer.isPlaying ? 'Ⅱ' : '▶'}</span>`;
  elements.playButton.setAttribute('aria-label', audioPlayer.isPlaying ? 'Пауза' : 'Воспроизвести');
  elements.playButton.title = audioPlayer.isPlaying ? 'Пауза' : 'Воспроизвести';
  elements.timeline.value = String(currentTime);
  elements.currentTime.textContent = formatTime(currentTime);
  elements.durationTime.textContent = formatTime(audioPlayer.durationSeconds);
  elements.railDuration.textContent = formatTime(audioPlayer.durationSeconds);
  waveformTimeline.setCurrentTime(currentTime);
  renderer.render(currentTime);
}

function updateFollowUi(following: boolean): void {
  const copy = following ? 'Следование включено' : 'Следовать';
  elements.followButton.textContent = copy;
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
    : 'Первый точный анализ может занять несколько минут и скачает модель распознавания — около 0,9 МБ.';
  elements.preciseModeButton.title = preciseModelReadyOnDevice
    ? `Точнее. ${preciseModelReadyText}`
    : 'Точнее';
}

function setReadyAnalysisStatus(label: string): void {
  elements.analysisStatus.textContent = '';
  elements.analysisStatus.title = label;
  elements.analysisStatus.setAttribute('aria-label', label);
}

function isInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest('input, button, textarea, select, [role="button"]') !== null ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
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

function requiredElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Element #${id} is missing`);
  }
  return element as ElementType;
}
