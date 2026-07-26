import { AnalysisClient, AnalysisClientError } from './analysis-client';
import { AnalysisErrorCode, AnalysisPhase } from './analysis-types';
import { AudioPlayer, AudioPlayerError, AudioPlayerErrorCode } from './audio-player';
import { FastSpectrumClient, FastSpectrumClientError } from './fast-spectrum';
import { PianoRollRenderer } from './piano-roll-renderer';
import { PianoAudition } from './piano-audition';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('Application root is missing');
}

app.innerHTML = `
  <main class="application">
    <header class="application__header">
      <div class="application__brand" aria-label="Spectral Score">
        <span class="application__mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <h1>SPECTRAL SCORE</h1>
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
              <button class="button button--accent" id="refine-button" type="button" hidden>Уточнить ML</button>
              <button class="button button--neutral" id="replace-button" type="button" aria-label="Заменить аудиофайл" title="Заменить аудиофайл"><span aria-hidden="true">↗</span><span class="button__label">Заменить</span></button>
            </div>
          </div>
          <div class="player__controls">
            <button class="play-button" id="play-button" type="button" aria-label="Воспроизвести"><span aria-hidden="true">▶</span></button>
            <span class="player__time" id="current-time">0:00</span>
            <input id="timeline" type="range" min="0" max="0" value="0" step="0.01" aria-label="Позиция воспроизведения">
            <span class="player__time player__time--duration" id="duration-time">0:00</span>
          </div>
        </div>
        <canvas id="piano-roll" tabindex="0" aria-label="Спектральная партитура. Кликните по ленте, чтобы перемотать. Удерживайте клавишу или строку спектра, чтобы услышать ноту. Стрелки перемещают позицию на пять секунд."></canvas>
        <div class="player__rail"><span>Клик — перемотка&nbsp;&nbsp;·&nbsp;&nbsp;Удержание — нота</span><span class="player__rail-duration" id="rail-duration">0:00</span></div>
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
  refineButton: requiredElement<HTMLButtonElement>('refine-button'),
  replaceButton: requiredElement<HTMLButtonElement>('replace-button'),
  canvas: requiredElement<HTMLCanvasElement>('piano-roll'),
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
let phase = AnalysisPhase.Idle;
let analysisGeneration = 0;
let animationFrameId: number | null = null;
let scrubbing = false;
let disposed = false;
let decodedSamples: Float32Array | null = null;
let fullFastSpectrumReady = false;

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

elements.refineButton.addEventListener('click', () => {
  void refineWithModel();
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
  cancelAnimation();
  decodedSamples = null;
  fullFastSpectrumReady = false;
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
        elements.status.textContent = 'Предварительный спектр готов. Строим полную ленту.';
        updatePlaybackUi();
      },
    });
    if (generation !== analysisGeneration) {
      return;
    }
    hasFullFastSpectrum = true;
    fullFastSpectrumReady = true;

    renderer.setAnalysis(fastResult, decoded.durationSeconds);
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
      elements.status.textContent = 'Быстрый спектр готов. Уточнение нот моделью недоступно.';
      return;
    }
    if (isPlaybackReady() && hasFastPreview) {
      setPhase(AnalysisPhase.PreviewReady);
      elements.status.textContent = 'Предварительный спектр готов. Полная лента недоступна.';
      return;
    }
    elements.dropZone.hidden = false;
    setPhase(AnalysisPhase.Failed);
    showError(toErrorMessage(error));
  }
}

async function refineWithModel(): Promise<void> {
  const samples = decodedSamples;
  if (
    disposed ||
    !fullFastSpectrumReady ||
    samples === null ||
    phase === AnalysisPhase.Refining ||
    phase === AnalysisPhase.Complete
  ) {
    return;
  }

  const generation = analysisGeneration;
  clearError();
  setPhase(AnalysisPhase.Refining, 0);
  try {
    const result = await analysisClient.analyze(samples.slice(), {
      onProgress: progress => {
        if (generation === analysisGeneration) {
          setPhase(AnalysisPhase.Refining, progress);
        }
      },
    });
    if (disposed || generation !== analysisGeneration) {
      return;
    }
    renderer.setAnalysis(result, audioPlayer.durationSeconds);
    setPhase(AnalysisPhase.Complete);
    updatePlaybackUi();
  } catch (error) {
    if (disposed || generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    setPhase(AnalysisPhase.FastReady);
    showError(`${toErrorMessage(error)} Быстрый спектр сохранён — можно повторить уточнение.`);
    elements.status.textContent = 'Уточнение ML не завершилось. Быстрый спектр сохранён.';
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
    elements.dropTitle.textContent = 'Декодируем аудио…';
    elements.dropDescription.textContent = 'Подготавливаем дорожку для локального анализа';
    elements.status.textContent = 'Декодируем аудио.';
  } else if (phase === AnalysisPhase.FastAnalyzing) {
    elements.dropTitle.textContent = 'Строим быстрый спектр…';
    elements.dropDescription.textContent = 'Сопоставляем частоты с 88 клавишами пианино';
    elements.status.textContent = 'Строим быстрый спектр.';
  } else if (phase === AnalysisPhase.PreviewReady) {
    elements.analysisStatus.textContent = 'Предварительный спектр готов';
    elements.refineButton.hidden = true;
    elements.refineButton.disabled = true;
    elements.status.textContent = 'Предварительный спектр готов. Строим полную ленту.';
  } else if (phase === AnalysisPhase.FastReady) {
    elements.analysisStatus.textContent = 'Быстрый спектр готов';
    elements.refineButton.hidden = !fullFastSpectrumReady;
    elements.refineButton.disabled = !fullFastSpectrumReady;
    elements.refineButton.textContent = 'Уточнить ML';
    elements.status.textContent = 'Быстрый спектр готов. Можно воспроизводить и перематывать.';
  } else if (phase === AnalysisPhase.Refining) {
    const percentage = Math.round(progress * 100);
    elements.analysisStatus.textContent = `Уточняем ML: ${percentage}%`;
    elements.refineButton.hidden = false;
    elements.refineButton.disabled = true;
    elements.refineButton.textContent = 'Уточняем ML…';
    elements.status.textContent = `Быстрый спектр готов. Уточняем ноты моделью: ${percentage}%.`;
  } else if (phase === AnalysisPhase.Complete) {
    elements.analysisStatus.textContent = 'Уточнение готово';
    elements.refineButton.hidden = false;
    elements.refineButton.disabled = true;
    elements.refineButton.textContent = 'Уточнение готово';
    elements.status.textContent = 'Анализ завершён. Партитура готова.';
  } else {
    elements.dropTitle.textContent = 'Не удалось обработать файл';
    elements.dropDescription.textContent = 'Попробуйте выбрать другой аудиофайл';
    elements.status.textContent = 'Не удалось обработать файл.';
  }
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
  renderer.render(currentTime);
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
      return 'Не удалось загрузить локальную модель анализа.';
    }
    if (error.code === AnalysisErrorCode.BackendUnavailable) {
      return 'Браузер не смог запустить вычислительный модуль.';
    }
    if (error.code === AnalysisErrorCode.WorkerFailed) {
      return 'Рабочий процесс анализа остановился.';
    }
    if (error.code === AnalysisErrorCode.InvalidAudio) {
      return 'Аудиоданные пусты или не подходят для анализа.';
    }
    return 'Анализ аудио не завершился.';
  }
  return 'Произошла непредвиденная ошибка. Попробуйте ещё раз.';
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function requiredElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Element #${id} is missing`);
  }
  return element as ElementType;
}
