import { AnalysisClient, AnalysisClientError } from './analysis-client';
import { AnalysisErrorCode, AnalysisPhase } from './analysis-types';
import { AudioPlayer, AudioPlayerError, AudioPlayerErrorCode } from './audio-player';
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
    <section class="workspace" aria-live="polite">
      <label class="drop-zone" id="drop-zone" for="file-input">
        <input id="file-input" type="file" accept="audio/*" hidden>
        <span class="drop-zone__icon">♪</span>
        <strong id="drop-title">Перетащите аудиофайл сюда</strong>
        <span id="drop-description">или выберите файл с устройства</span>
      </label>
      <p class="error-message" id="error-message" hidden></p>
      <section class="player" id="player" hidden>
        <div class="player__topline">
          <strong id="file-name"></strong>
          <span id="time-label">0:00 / 0:00</span>
        </div>
        <canvas id="piano-roll" aria-label="Спектральная партитура"></canvas>
        <div class="player__controls">
          <button class="button" id="play-button" type="button">Воспроизвести</button>
          <input id="timeline" type="range" min="0" max="0" value="0" step="0.01" aria-label="Позиция воспроизведения">
        </div>
      </section>
    </section>
  </main>
`;

const elements = {
  dropZone: requiredElement<HTMLElement>('drop-zone'),
  fileInput: requiredElement<HTMLInputElement>('file-input'),
  dropTitle: requiredElement<HTMLElement>('drop-title'),
  dropDescription: requiredElement<HTMLElement>('drop-description'),
  errorMessage: requiredElement<HTMLElement>('error-message'),
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

audioPlayer.onStateChange = () => {
  updatePlaybackUi();
  requestAnimation();
};

renderer.onSeek = seconds => {
  audioPlayer.seek(seconds);
  updatePlaybackUi();
  requestAnimation();
};

elements.fileInput.addEventListener('change', () => {
  const [file] = elements.fileInput.files ?? [];
  if (file !== undefined) {
    void loadFile(file);
  }
});

elements.dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  elements.dropZone.classList.add('drop-zone--dragging');
});
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('drop-zone--dragging'));
elements.dropZone.addEventListener('drop', event => {
  event.preventDefault();
  elements.dropZone.classList.remove('drop-zone--dragging');
  const [file] = event.dataTransfer?.files ?? [];
  if (file !== undefined) {
    void loadFile(file);
  }
});

elements.playButton.addEventListener('click', () => {
  if (audioPlayer.isPlaying) {
    audioPlayer.pause();
  } else {
    audioPlayer.play();
  }
});

elements.timeline.addEventListener('pointerdown', () => {
  scrubbing = true;
  requestAnimation();
});
elements.timeline.addEventListener('input', () => {
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

window.addEventListener('beforeunload', () => {
  analysisClient.dispose();
  audioPlayer.dispose();
  renderer.dispose();
});

async function loadFile(file: File): Promise<void> {
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

    setPhase(AnalysisPhase.Analyzing, 0);
    const result = await analysisClient.analyze(decoded.samples, {
      onProgress: progress => {
        if (generation === analysisGeneration) {
          setPhase(AnalysisPhase.Analyzing, progress);
        }
      },
    });
    if (generation !== analysisGeneration) {
      return;
    }

    renderer.setAnalysis(result, decoded.durationSeconds);
    elements.timeline.max = String(decoded.durationSeconds);
    elements.timeline.value = '0';
    elements.player.hidden = false;
    setPhase(AnalysisPhase.Complete);
    updatePlaybackUi();
  } catch (error) {
    if (generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    setPhase(AnalysisPhase.Failed);
    showError(toErrorMessage(error));
  }
}

function setPhase(nextPhase: AnalysisPhase, progress = 0): void {
  phase = nextPhase;
  if (phase === AnalysisPhase.Idle) {
    elements.dropTitle.textContent = 'Перетащите аудиофайл сюда';
    elements.dropDescription.textContent = 'или выберите файл с устройства';
  } else if (phase === AnalysisPhase.Loading) {
    elements.dropTitle.textContent = 'Декодируем аудио…';
    elements.dropDescription.textContent = 'Подготавливаем дорожку для локального анализа';
  } else if (phase === AnalysisPhase.Analyzing) {
    elements.dropTitle.textContent = `Анализируем ноты: ${Math.round(progress * 100)}%`;
    elements.dropDescription.textContent = 'Модель работает локально в вашем браузере';
  } else if (phase === AnalysisPhase.Complete) {
    elements.dropTitle.textContent = 'Выберите другой аудиофайл';
    elements.dropDescription.textContent = 'Новый файл заменит текущую партитуру';
  } else {
    elements.dropTitle.textContent = 'Не удалось обработать файл';
    elements.dropDescription.textContent = 'Попробуйте выбрать другой аудиофайл';
  }
}

function updatePlaybackUi(): void {
  if (phase !== AnalysisPhase.Complete) {
    return;
  }
  const currentTime = audioPlayer.currentTimeSeconds;
  elements.playButton.textContent = audioPlayer.isPlaying ? 'Пауза' : 'Воспроизвести';
  elements.timeline.value = String(currentTime);
  elements.timeLabel.textContent = `${formatTime(currentTime)} / ${formatTime(audioPlayer.durationSeconds)}`;
  renderer.render(currentTime);
}

function requestAnimation(): void {
  if (animationFrameId !== null || (!audioPlayer.isPlaying && !scrubbing)) {
    return;
  }
  animationFrameId = requestAnimationFrame(animate);
}

function animate(): void {
  animationFrameId = null;
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
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = false;
}

function clearError(): void {
  elements.errorMessage.hidden = true;
  elements.errorMessage.textContent = '';
}

function isCancelled(error: unknown): boolean {
  return error instanceof AnalysisClientError && error.code === AnalysisErrorCode.Cancelled;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof AudioPlayerError) {
    if (error.code === AudioPlayerErrorCode.FileTooLarge) {
      return 'Файл больше 200 МБ. Выберите файл меньшего размера.';
    }
    if (error.code === AudioPlayerErrorCode.DurationTooLong) {
      return 'Длительность записи больше 10 минут. Выберите более короткий файл.';
    }
    return 'Этот файл не удалось декодировать как аудио.';
  }
  if (error instanceof AnalysisClientError) {
    return 'Анализ не завершился. Попробуйте выбрать файл ещё раз.';
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
