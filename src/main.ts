import { AnalysisClient, AnalysisClientError } from './analysis-client';
import { AnalysisErrorCode, AnalysisPhase } from './analysis-types';
import { AudioPlayer, AudioPlayerError, AudioPlayerErrorCode } from './audio-player';
import { analyzeFastSpectrum } from './fast-spectrum';
import { PianoRollRenderer } from './piano-roll-renderer';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('Application root is missing');
}

app.innerHTML = `
  <main class="application">
    <header class="application__header">
      <div>
        <p class="application__eyebrow">Локальный анализ аудио</p>
        <h1>SPECTRAL SCORE</h1>
      </div>
      <p class="application__privacy">Аудио обрабатывается только на вашем устройстве и никуда не загружается.</p>
    </header>
    <section class="workspace" id="workspace" aria-busy="false">
      <p class="visually-hidden" id="status" role="status" aria-live="polite"></p>
      <div class="drop-zone" id="drop-zone" role="button" tabindex="0" aria-controls="file-input">
        <input id="file-input" type="file" accept="audio/*" hidden>
        <span class="drop-zone__icon">♪</span>
        <strong id="drop-title">Перетащите аудиофайл сюда</strong>
        <span id="drop-description">или выберите файл с устройства</span>
      </div>
      <div class="error-message" id="error-message" role="alert" hidden>
        <span id="error-text"></span>
        <button class="button button--secondary" id="recovery-button" type="button">Выбрать другой файл</button>
      </div>
      <section class="player" id="player" hidden>
        <div class="player__topline">
          <strong id="file-name"></strong>
          <span id="time-label">0:00 / 0:00</span>
        </div>
        <canvas id="piano-roll" tabindex="0" aria-label="Спектральная партитура. Стрелки перемещают позицию на пять секунд."></canvas>
        <div class="player__controls">
          <button class="button" id="play-button" type="button">Воспроизвести</button>
          <input id="timeline" type="range" min="0" max="0" value="0" step="0.01" aria-label="Позиция воспроизведения">
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
  canvas: requiredElement<HTMLCanvasElement>('piano-roll'),
  playButton: requiredElement<HTMLButtonElement>('play-button'),
  timeline: requiredElement<HTMLInputElement>('timeline'),
  timeLabel: requiredElement<HTMLElement>('time-label'),
};

const analysisClient = new AnalysisClient();
const audioPlayer = new AudioPlayer();
const renderer = new PianoRollRenderer(elements.canvas);
let phase = AnalysisPhase.Idle;
let analysisGeneration = 0;
let animationFrameId: number | null = null;
let scrubbing = false;
let disposed = false;

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

window.addEventListener('beforeunload', () => {
  disposed = true;
  analysisGeneration += 1;
  cancelAnimation();
  analysisClient.dispose();
  audioPlayer.dispose();
  renderer.dispose();
});

async function loadFile(file: File): Promise<void> {
  if (disposed) {
    return;
  }
  const generation = ++analysisGeneration;
  analysisClient.cancel();
  audioPlayer.reset();
  renderer.clear();
  cancelAnimation();
  elements.fileName.textContent = file.name;
  elements.player.hidden = true;
  clearError();
  setPhase(AnalysisPhase.Loading);

  try {
    const decoded = await audioPlayer.load(file);
    if (generation !== analysisGeneration) {
      return;
    }

    setPhase(AnalysisPhase.FastAnalyzing);
    const fastResult = await analyzeFastSpectrum(decoded.samples);
    if (generation !== analysisGeneration) {
      return;
    }

    renderer.setAnalysis(fastResult, decoded.durationSeconds);
    elements.timeline.max = String(decoded.durationSeconds);
    elements.timeline.value = '0';
    elements.player.hidden = false;
    setPhase(AnalysisPhase.FastReady);
    updatePlaybackUi();

    await yieldToBrowser();
    if (generation !== analysisGeneration) {
      return;
    }

    setPhase(AnalysisPhase.Refining, 0);
    const result = await analysisClient.analyze(decoded.samples, {
      onProgress: progress => {
        if (generation === analysisGeneration) {
          setPhase(AnalysisPhase.Refining, progress);
        }
      },
    });
    if (generation !== analysisGeneration) {
      return;
    }

    renderer.setAnalysis(result, decoded.durationSeconds);
    setPhase(AnalysisPhase.Complete);
    updatePlaybackUi();
  } catch (error) {
    if (generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    if (isPlaybackReady()) {
      setPhase(AnalysisPhase.FastReady);
      elements.status.textContent = 'Быстрый спектр готов. Уточнение нот моделью недоступно.';
      return;
    }
    setPhase(AnalysisPhase.Failed);
    showError(toErrorMessage(error));
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
  elements.workspace.setAttribute(
    'aria-busy',
    String(
      phase === AnalysisPhase.Loading ||
      phase === AnalysisPhase.FastAnalyzing ||
      phase === AnalysisPhase.Refining,
    ),
  );
  if (phase === AnalysisPhase.Idle) {
    elements.dropTitle.textContent = 'Перетащите аудиофайл сюда';
    elements.dropDescription.textContent = 'или выберите файл с устройства';
    elements.status.textContent = 'Можно выбрать аудиофайл.';
  } else if (phase === AnalysisPhase.Loading) {
    elements.dropTitle.textContent = 'Декодируем аудио…';
    elements.dropDescription.textContent = 'Подготавливаем дорожку для локального анализа';
    elements.status.textContent = 'Декодируем аудио.';
  } else if (phase === AnalysisPhase.FastAnalyzing) {
    elements.dropTitle.textContent = 'Строим быстрый спектр…';
    elements.dropDescription.textContent = 'Сопоставляем частоты с 88 клавишами пианино';
    elements.status.textContent = 'Строим быстрый спектр.';
  } else if (phase === AnalysisPhase.FastReady) {
    elements.dropTitle.textContent = 'Быстрый спектр готов';
    elements.dropDescription.textContent = 'Воспроизведение доступно, уточняем ноты в фоне';
    elements.status.textContent = 'Быстрый спектр готов. Можно воспроизводить и перематывать.';
  } else if (phase === AnalysisPhase.Refining) {
    const percentage = Math.round(progress * 100);
    elements.dropTitle.textContent = `Уточняем ноты моделью: ${percentage}%`;
    elements.dropDescription.textContent = 'Быстрый спектр уже доступен для воспроизведения';
    elements.status.textContent = `Быстрый спектр готов. Уточняем ноты моделью: ${percentage}%.`;
  } else if (phase === AnalysisPhase.Complete) {
    elements.dropTitle.textContent = 'Выберите другой аудиофайл';
    elements.dropDescription.textContent = 'Новый файл заменит текущую партитуру';
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
  elements.playButton.textContent = audioPlayer.isPlaying ? 'Пауза' : 'Воспроизвести';
  elements.timeline.value = String(currentTime);
  elements.timeLabel.textContent = `${formatTime(currentTime)} / ${formatTime(audioPlayer.durationSeconds)}`;
  renderer.render(currentTime);
}

function isPlaybackReady(): boolean {
  return (
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

function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

function requiredElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Element #${id} is missing`);
  }
  return element as ElementType;
}
