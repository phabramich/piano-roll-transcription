import { AnalysisClient, AnalysisClientError } from './analysis-client';
import { AnalysisErrorCode, AnalysisPhase, type AnalysisResult, type AnalyzedNote, type FastSpectrumOptions, RecognitionMode } from './analysis-types';
import { AudioPlayer, AudioPlayerError, AudioPlayerErrorCode } from './audio-player';
import { cachePrecise, clearPreciseCache, fingerprintFile, getCachedPrecise, midiFromBase64, midiToBase64, type CachedPrecise } from './precise-cache';
import { PianoRollRenderer } from './piano-roll-renderer';
import { PianoAudition } from './piano-audition';
import { WaveformTimeline } from './waveform-timeline';
import { applyDesignTheme } from './design-colors';
import { ICONS } from './icons';
import { formatTime } from './util';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
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

/* ── i18n ─────────────────────────────────────────────── */

const STRINGS = {
  ru: {
    dropH: 'Загрузите аудио для транскрибации',
    dropMeta: 'MP3 · WAV · M4A · до 200 МБ · до 10 минут · файл не покидает устройство',
    cta: 'Выбрать файл',
    loadingH: 'Открываем аудио…',
    loadingSub: 'Подготавливаем дорожку',
    analyzingH: 'Подготавливаем ноты…',
    analyzingSub: 'Это займёт немного времени',
    failH: 'Не удалось обработать файл',
    failSub: 'Попробуйте выбрать другой аудиофайл',
    statusIdle: 'Можно выбрать аудиофайл.',
    statusLoading: 'Открываем аудио.',
    statusAnalyzing: 'Подготавливаем ноты.',
    statusPreview: 'Первые ноты готовы. Продолжаем подготовку.',
    statusPreviewPartial: 'Первые ноты готовы. Полная лента сейчас недоступна.',
    statusFastReady: 'Быстрый вариант готов. Можно воспроизводить и перематывать.',
    statusFastOnly: 'Быстрый вариант готов. Точный вариант сейчас недоступен.',
    statusComplete: 'Точный вариант готов. Партитура готова.',
    statusFail: 'Не удалось обработать файл.',
    analysisPreview: 'Первые ноты готовы',
    updatingNotes: 'Обновляем ноты',
    statusUpdating: 'Обновляем ноты с новыми настройками.',
    statusUpdated: 'Ноты обновлены с новыми настройками.',
    errReanalyze: 'Не удалось пересчитать ноты с новыми настройками. Показан прежний вариант.',
    statusUpdateFail: 'Не удалось обновить ноты.',
    stageModel: 'Скачиваем модель',
    stagePrepare: 'Готовим модель',
    stageRecognize: 'Распознаём ноты',
    errPrecise: 'Не удалось подготовить точные ноты. Показан быстрый вариант — можно продолжать слушать запись.',
    statusPreciseFail: 'Точный вариант не готов. Быстрый вариант сохранён.',
    errPlay: 'Не удалось запустить воспроизведение. Проверьте разрешение браузера на звук и попробуйте ещё раз.',
    statusPlayFail: 'Не удалось запустить воспроизведение.',
    errTooLarge: 'Файл больше 200 МБ. Выберите файл меньшего размера.',
    errTooLong: 'Длительность записи больше 10 минут. Выберите более короткий файл.',
    errFormat: 'Формат не поддерживается или аудиофайл повреждён.',
    errModel: 'Не удалось подготовить точные ноты.',
    errBackend: 'Браузер не смог продолжить распознавание.',
    errWorker: 'Распознавание неожиданно остановилось.',
    errInvalid: 'Запись пуста или не подходит для распознавания.',
    errAnalysis: 'Распознавание не завершилось.',
    errGeneric: 'Произошла непредвиденная ошибка. Попробуйте ещё раз.',
    recovery: 'Выбрать другой файл',
    fileActions: 'Действия с аудиофайлом',
    speed: 'Скорость',
    speedAria: 'Скорость воспроизведения',
    speedTitle: 'Скорость воспроизведения — высота звука сохраняется',
    settings: 'Настройки',
    sens: 'Чувствительность',
    sensAria: 'Чувствительность анализа',
    sensTitle: 'Выше — больше нот, ниже — строже отбор',
    minDur: 'Мин. длительность ноты',
    minDurAria: 'Минимальная длительность ноты',
    maxNotes: 'Макс. нот одновременно',
    maxNotesAria: 'Максимум нот одновременно',
    contrast: 'Контраст нот',
    contrastAria: 'Контраст нот — влияет только на отображение',
    settingsHint: 'Применяются к быстрому анализу — ноты пересчитываются автоматически.',
    theme: 'Тема',
    tAuto: 'Авто',
    tLight: 'Светлая',
    tDark: 'Тёмная',
    lang: 'Язык',
    recMode: 'Режим распознавания',
    fast: 'Быстро',
    precise: 'Точнее',
    preciseHint: 'Первый точный анализ скачает модель MuScriptor — около 110 МБ, дальше она берётся из кэша.',
    midiAria: 'Скачать MIDI',
    midiTitle: 'Скачать результат точного анализа как MIDI-файл',
    replace: 'Новый файл',
    play: 'Воспроизвести',
    pause: 'Пауза',
    spaceKey: 'Пробел',
    timelineAria: 'Позиция воспроизведения',
    stageAria: 'Навигация по партитуре',
    stageToolbarAria: 'Масштаб и диапазон партитуры',
    zoomOut: 'Уменьшить временной масштаб',
    zoomIn: 'Увеличить временной масштаб',
    pitchRange: 'Диапазон',
    pitchRangeAria: 'Изменить видимый диапазон клавиш',
    follow: 'Следование',
    toPosition: 'Следовать',
    followOn: 'Следование включено',
    followOff: 'Включить следование',
    kbdAria: 'Горячие клавиши',
    canvasAria: 'Падающая партитура. Перетаскивайте для обзора, нажимайте для перехода к позиции и удерживайте, чтобы услышать ноту. Стрелки перемещают позицию на пять секунд.',
    hints: '<kbd>Space</kbd> пауза&ensp;·&ensp;<kbd>←</kbd><kbd>→</kbd> ±5&thinsp;с&ensp;·&ensp;перетащить — обзор&ensp;·&ensp;нажать — позиция&ensp;·&ensp;удерживать — нота',
    ms: 'мс',
    clearCache: 'Очистить кэш',
    clearCacheTitle: 'Удалить скачанную модель и сохранённые ноты',
    cacheCleared: 'Кэш очищен',
  },
  en: {
    dropH: 'Upload audio for transcription',
    dropMeta: 'MP3 · WAV · M4A · up to 200 MB · up to 10 min · file never leaves your device',
    cta: 'Choose file',
    loadingH: 'Opening audio…',
    loadingSub: 'Preparing the track',
    analyzingH: 'Preparing notes…',
    analyzingSub: 'This takes a moment',
    failH: 'Could not process the file',
    failSub: 'Try a different audio file',
    statusIdle: 'You can pick an audio file.',
    statusLoading: 'Opening audio.',
    statusAnalyzing: 'Preparing notes.',
    statusPreview: 'First notes are ready. Still preparing.',
    statusPreviewPartial: 'First notes are ready. Full roll is unavailable right now.',
    statusFastReady: 'Fast result ready. You can play and scrub.',
    statusFastOnly: 'Fast result ready. Precise mode is unavailable right now.',
    statusComplete: 'Precise result ready. The score is done.',
    statusFail: 'Could not process the file.',
    analysisPreview: 'First notes ready',
    updatingNotes: 'Updating notes',
    statusUpdating: 'Updating notes with the new settings.',
    statusUpdated: 'Notes updated with the new settings.',
    errReanalyze: 'Could not recompute notes with the new settings. Showing the previous result.',
    statusUpdateFail: 'Could not update notes.',
    stageModel: 'Downloading model',
    stagePrepare: 'Preparing model',
    stageRecognize: 'Recognizing notes',
    errPrecise: 'Could not prepare precise notes. Showing the fast result — you can keep listening.',
    statusPreciseFail: 'Precise result not ready. Fast result kept.',
    errPlay: 'Could not start playback. Check the browser sound permission and try again.',
    statusPlayFail: 'Could not start playback.',
    errTooLarge: 'File is over 200 MB. Pick a smaller file.',
    errTooLong: 'Recording is longer than 10 minutes. Pick a shorter file.',
    errFormat: 'Format is not supported or the audio file is damaged.',
    errModel: 'Could not prepare precise notes.',
    errBackend: 'The browser could not continue recognition.',
    errWorker: 'Recognition stopped unexpectedly.',
    errInvalid: 'The recording is empty or unsuitable for recognition.',
    errAnalysis: 'Recognition did not finish.',
    errGeneric: 'Something went wrong. Try again.',
    recovery: 'Choose another file',
    fileActions: 'Audio file actions',
    speed: 'Speed',
    speedAria: 'Playback speed',
    speedTitle: 'Playback speed — pitch is preserved',
    settings: 'Settings',
    sens: 'Sensitivity',
    sensAria: 'Analysis sensitivity',
    sensTitle: 'Higher — more notes, lower — stricter selection',
    minDur: 'Min. note duration',
    minDurAria: 'Minimum note duration',
    maxNotes: 'Max simultaneous notes',
    maxNotesAria: 'Maximum simultaneous notes',
    contrast: 'Note contrast',
    contrastAria: 'Note contrast — affects display only',
    settingsHint: 'Applied to fast analysis — notes are recomputed automatically.',
    theme: 'Theme',
    tAuto: 'Auto',
    tLight: 'Light',
    tDark: 'Dark',
    lang: 'Language',
    recMode: 'Recognition mode',
    fast: 'Fast',
    precise: 'Precise',
    preciseHint: 'The first precise analysis downloads the MuScriptor model — about 110 MB, cached afterwards.',
    midiAria: 'Download MIDI',
    midiTitle: 'Download the precise analysis result as a MIDI file',
    replace: 'New file',
    play: 'Play',
    pause: 'Pause',
    spaceKey: 'Space',
    timelineAria: 'Playback position',
    stageAria: 'Score navigation',
    stageToolbarAria: 'Score scale and range',
    zoomOut: 'Decrease time scale',
    zoomIn: 'Increase time scale',
    pitchRange: 'Range',
    pitchRangeAria: 'Change the visible key range',
    follow: 'Follow',
    toPosition: 'Follow',
    followOn: 'Follow enabled',
    followOff: 'Resume following',
    kbdAria: 'Keyboard shortcuts',
    canvasAria: 'Falling score. Drag to browse, tap to seek, hold to hear a note. Arrow keys move the position by five seconds.',
    hints: '<kbd>Space</kbd> play/pause&ensp;·&ensp;<kbd>←</kbd><kbd>→</kbd> ±5&thinsp;s&ensp;·&ensp;drag — pan&ensp;·&ensp;tap — seek&ensp;·&ensp;hold — note',
    ms: 'ms',
    clearCache: 'Clear cache',
    clearCacheTitle: 'Delete the downloaded model and saved scores',
    cacheCleared: 'Cache cleared',
  },
};

type Lang = keyof typeof STRINGS;
type Strings = Record<keyof (typeof STRINGS)['ru'], string>;
type LangPref = 'auto' | Lang;
type ThemePref = 'auto' | 'light' | 'dark';

function storedPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage[key];
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function systemPrefersRussian(): boolean {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some(l => l.toLowerCase().startsWith('ru'));
}

let langPref = storedPref<LangPref>('pianotape.lang', ['auto', 'ru', 'en'], 'auto');
let lang: Lang = langPref === 'auto' ? (systemPrefersRussian() ? 'ru' : 'en') : langPref;
let t: Strings = STRINGS[lang];
let themePref = storedPref<ThemePref>('pianotape.theme', ['auto', 'light', 'dark'], 'auto');
const prefersDark = matchMedia('(prefers-color-scheme: dark)');

document.documentElement.lang = lang;
applyDesignTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function dec(text: string): string {
  return lang === 'ru' ? text.replace('.', ',') : text;
}

function formatRate(value: number): string {
  return `${dec(value.toFixed(1))}×`;
}

/* mark = the punched tape strip itself — holes use --surface so they
   punch through to whatever card it sits on. */
const MARK = `<svg viewBox="8.5 1 13 28" aria-hidden="true"><rect x="9" y="1.5" width="12" height="27" rx="3.5" fill="var(--accent)"/><g fill="var(--surface)"><circle cx="12.6" cy="7" r="1.7"/><circle cx="17.4" cy="11.6" r="1.7"/><circle cx="12.6" cy="16.2" r="1.7"/><circle cx="17.4" cy="20.8" r="1.7"/></g></svg>`;

app.innerHTML = `
  <main class="application">
    <section class="workspace" id="workspace" aria-busy="false">
      <p class="visually-hidden" id="status" role="status" aria-live="polite"></p>
      <div class="drop-zone" id="drop-zone" role="button" tabindex="0" aria-controls="file-input" aria-describedby="drop-description">
        <input id="file-input" type="file" accept="audio/*" hidden>
        <div class="drop-zone__copy">
          <span class="brand-line"><span class="app-mark" aria-hidden="true">${MARK}</span><span class="wordmark">pianotape</span></span>
          <strong id="drop-title">${t.dropH}</strong>
          <span class="drop-zone__meta" id="drop-description">${t.dropMeta}</span>
        </div>
        <span class="drop-zone__cta">${ICONS.upload}<span data-i18n="cta">${t.cta}</span></span>
        <span class="drop-zone__progress" aria-hidden="true"><i></i></span>
      </div>
      <div class="error-message" id="error-message" role="alert" hidden>
        ${ICONS.circleAlert}
        <span id="error-text"></span>
        <button class="button button--secondary" id="recovery-button" type="button" data-i18n="recovery">${t.recovery}</button>
      </div>
      <section class="player" id="player" hidden>
        <div class="player__deck">
          <div class="player__toolbar" data-i18n-aria="fileActions" aria-label="${t.fileActions}">
            <div class="player__file">
              <span class="app-mark app-mark--sm" aria-hidden="true">${MARK}</span>
              <span class="wordmark">pianotape</span>
              <i class="dot" aria-hidden="true">·</i>
              <strong id="file-name"></strong>
            </div>
            <div class="player__actions">
              <span class="player__analysis-status" id="analysis-status" aria-live="polite"></span>
              <label class="control-chip control-chip--range">
                <span class="control-chip__label" data-i18n="speed">${t.speed}</span>
                <input id="playback-rate" type="range" min="0.2" max="1" step="0.1" value="1" data-i18n-aria="speedAria" aria-label="${t.speedAria}" title="${t.speedTitle}" data-i18n-title="speedTitle">
                <output class="control-chip__value" id="playback-rate-value" for="playback-rate">${formatRate(1)}</output>
              </label>
              <div class="recognition-mode" id="recognition-mode" role="radiogroup" data-i18n-aria="recMode" aria-label="${t.recMode}" hidden>
                <button class="button recognition-mode__option recognition-mode__option--selected" id="instant-mode-button" type="button" role="radio" aria-checked="true" tabindex="0" data-i18n="fast">${t.fast}</button>
                <button class="button recognition-mode__option" id="precise-mode-button" type="button" role="radio" aria-checked="false" tabindex="-1" data-i18n="precise">${t.precise}</button>
              </div>
              <button class="button button--neutral" id="midi-download-button" type="button" data-i18n-aria="midiAria" aria-label="${t.midiAria}" title="${t.midiTitle}" data-i18n-title="midiTitle" hidden>${ICONS.download}<span class="button__label">MIDI</span></button>
              <button class="button button--neutral button--icon" id="replace-button" type="button" data-i18n-aria="replace" aria-label="${t.replace}" title="${t.replace}" data-i18n-title="replace">${ICONS.refreshCw}</button>
              <div class="analysis-settings" id="analysis-settings">
                <button class="button button--neutral button--icon" id="settings-toggle" type="button" aria-expanded="false" aria-controls="analysis-settings-panel" data-i18n-aria="settings" aria-label="${t.settings}" title="${t.settings}" data-i18n-title="settings">${ICONS.settings}</button>
                <div class="analysis-settings__panel" id="analysis-settings-panel" role="group" aria-label="${t.settings}" data-i18n-aria="settings" hidden>
                  <label class="control-chip control-chip--range">
                    <span class="control-chip__label" data-i18n="sens">${t.sens}</span>
                    <input id="sensitivity" type="range" min="0" max="1" value="0.5" step="0.05" data-i18n-aria="sensAria" aria-label="${t.sensAria}" title="${t.sensTitle}" data-i18n-title="sensTitle">
                    <output class="control-chip__value" id="sensitivity-value" for="sensitivity">50%</output>
                  </label>
                  <label class="control-chip control-chip--range">
                    <span class="control-chip__label" data-i18n="minDur">${t.minDur}</span>
                    <input id="min-note-ms" type="range" min="50" max="500" value="150" step="10" data-i18n-aria="minDurAria" aria-label="${t.minDurAria}">
                    <output class="control-chip__value" id="min-note-ms-value" for="min-note-ms">150 ${t.ms}</output>
                  </label>
                  <label class="control-chip control-chip--range">
                    <span class="control-chip__label" data-i18n="maxNotes">${t.maxNotes}</span>
                    <input id="max-notes" type="range" min="1" max="8" value="8" step="1" data-i18n-aria="maxNotesAria" aria-label="${t.maxNotesAria}">
                    <output class="control-chip__value" id="max-notes-value" for="max-notes">8</output>
                  </label>
                  <label class="control-chip control-chip--range">
                    <span class="control-chip__label" data-i18n="contrast">${t.contrast}</span>
                    <input id="contrast" type="range" min="0.7" max="2.2" value="1.4" step="0.05" data-i18n-aria="contrastAria" aria-label="${t.contrastAria}">
                    <output class="control-chip__value" id="contrast-value" for="contrast">${dec('1.4')}×</output>
                  </label>
                  <div class="seg"><span data-i18n="theme">${t.theme}</span>
                    <span class="seg__opts" id="theme-seg">
                      <button type="button" data-theme-opt="auto" data-i18n="tAuto">${t.tAuto}</button>
                      <button type="button" data-theme-opt="light" data-i18n="tLight">${t.tLight}</button>
                      <button type="button" data-theme-opt="dark" data-i18n="tDark">${t.tDark}</button>
                    </span>
                  </div>
                  <div class="seg"><span data-i18n="lang">${t.lang}</span>
                    <span class="seg__opts" id="lang-seg">
                      <button type="button" data-lang-opt="auto">Auto</button>
                      <button type="button" data-lang-opt="ru">Рус</button>
                      <button type="button" data-lang-opt="en">Eng</button>
                    </span>
                  </div>
                  <p class="analysis-settings__hint" data-i18n="settingsHint">${t.settingsHint}</p>
                  <button class="button button--neutral" id="clear-cache-button" type="button" data-i18n-aria="clearCacheTitle" aria-label="${t.clearCacheTitle}" title="${t.clearCacheTitle}" data-i18n-title="clearCacheTitle">${ICONS.trash2}<span data-i18n="clearCache">${t.clearCache}</span></button>
                </div>
              </div>
            </div>
          </div>
          <div class="player__controls">
            <button class="play-button" id="play-button" type="button" aria-label="${t.play}" title="${t.play} (${t.spaceKey})">${ICONS.play}</button>
            <span class="player__time"><span id="current-time">0:00</span><span class="player__time--duration" id="duration-time">/ 0:00</span></span>
            <div class="waveform-timeline">
              <canvas id="waveform" aria-hidden="true"></canvas>
              <input id="timeline" type="range" min="0" max="0" value="0" step="0.01" data-i18n-aria="timelineAria" aria-label="${t.timelineAria}">
            </div>
          </div>
        </div>
        <section class="piano-stage" data-following="true" data-i18n-aria="stageAria" aria-label="${t.stageAria}">
          <div class="piano-stage__toolbar" role="toolbar" data-i18n-aria="stageToolbarAria" aria-label="${t.stageToolbarAria}">
            <button class="piano-stage__button" id="zoom-out-button" type="button" data-i18n-aria="zoomOut" aria-label="${t.zoomOut}" title="${t.zoomOut}" data-i18n-title="zoomOut">${ICONS.minus}</button>
            <button class="piano-stage__button" id="zoom-in-button" type="button" data-i18n-aria="zoomIn" aria-label="${t.zoomIn}" title="${t.zoomIn}" data-i18n-title="zoomIn">${ICONS.plus}</button>
            <button class="piano-stage__button piano-stage__button--wide" id="pitch-range-button" type="button" data-i18n-aria="pitchRangeAria" aria-label="${t.pitchRangeAria}" title="${t.pitchRangeAria}" data-i18n-title="pitchRangeAria">${ICONS.piano}<span data-i18n="pitchRange">${t.pitchRange}</span></button>
            <button class="piano-stage__button piano-stage__button--wide" id="follow-button" type="button" aria-label="${t.followOn}" aria-pressed="true" title="${t.followOn}">${ICONS.locateFixed}<span data-i18n="follow">${t.follow}</span></button>
            <button class="piano-stage__button" id="hints-button" type="button" aria-expanded="false" aria-controls="stage-hints" data-i18n-aria="kbdAria" aria-label="${t.kbdAria}" title="${t.kbdAria}" data-i18n-title="kbdAria">${ICONS.keyboard}</button>
            <div class="stage-hints" id="stage-hints" hidden><span id="stage-hints-list">${t.hints}</span></div>
          </div>
          <canvas id="piano-roll" tabindex="0" data-i18n-aria="canvasAria" aria-label="${t.canvasAria}" aria-describedby="stage-hints"></canvas>
        </section>
      </section>
    </section>
    <div class="notice" id="notice" role="status" hidden></div>
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
  midiDownloadButton: requiredElement<HTMLButtonElement>('midi-download-button'),
  replaceButton: requiredElement<HTMLButtonElement>('replace-button'),
  clearCacheButton: requiredElement<HTMLButtonElement>('clear-cache-button'),
  notice: requiredElement<HTMLElement>('notice'),
  playbackRate: requiredElement<HTMLInputElement>('playback-rate'),
  playbackRateValue: requiredElement<HTMLOutputElement>('playback-rate-value'),
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
  themeSeg: requiredElement<HTMLElement>('theme-seg'),
  langSeg: requiredElement<HTMLElement>('lang-seg'),
  hintsButton: requiredElement<HTMLButtonElement>('hints-button'),
  hintsPanel: requiredElement<HTMLElement>('stage-hints'),
  hintsList: requiredElement<HTMLElement>('stage-hints-list'),
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
};

const muscriptorClient = new AnalysisClient(
  () => new Worker(new URL('./muscriptor-worker.ts', import.meta.url), { type: 'module' }),
);
const fastSpectrumClient = new AnalysisClient(
  () => new Worker(new URL('./fast-spectrum-worker.ts', import.meta.url), { type: 'module' }),
);
const audioPlayer = new AudioPlayer();
const pianoAudition = new PianoAudition();
const renderer = new PianoRollRenderer(elements.canvas);
const waveformTimeline = new WaveformTimeline(elements.waveform);
let phase = AnalysisPhase.Idle;
let analysisGeneration = 0;
let animationFrameId: number | null = null;
let scrubbing = false;
let decodedSamples: Float32Array | null = null;
let currentFileHash: string | null = null;
let fullFastSpectrumReady = false;
let recognitionMode = RecognitionMode.Instant;
let fastAnalysisResult: AnalysisResult | null = null;
let preciseAnalysisResult: AnalysisResult | null = null;
let preciseAnalysisInProgress = false;
let preciseAnalysisProgress = 0;
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
  updatePlaybackUi();
  requestAnimation();
};

renderer.onSeek = seconds => {
  if (!isPlaybackReady()) {
    return;
  }
  audioPlayer.seek(seconds);
  updatePlaybackUi();
  requestAnimation();
};
renderer.onFollowChange = following => {
  updateFollowUi(following);
};
renderer.onPianoKeyPrepare = () => {
  pianoAudition.prepare();
};
renderer.onPianoKeyStart = midi => {
  pianoAudition.start(midi);
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
  elements.fileInput.click();
});
elements.dropZone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    elements.fileInput.click();
  }
});
elements.dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  elements.dropZone.classList.add('drop-zone--dragging');
});
elements.dropZone.addEventListener('dragleave', () => {
  elements.dropZone.classList.remove('drop-zone--dragging');
});
elements.dropZone.addEventListener('drop', event => {
  event.preventDefault();
  elements.dropZone.classList.remove('drop-zone--dragging');
  const [file] = event.dataTransfer?.files ?? [];
  if (file !== undefined) {
    void loadFile(file);
  }
});

elements.playButton.addEventListener('click', () => {
  if (!isPlaybackReady()) {
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
  if (!isPlaybackReady()) {
    return;
  }
  scrubbing = true;
  requestAnimation();
});
elements.timeline.addEventListener('input', () => {
  if (!isPlaybackReady()) {
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
  if (!isPlaybackReady()) {
    return;
  }
  const seekOffset = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : null;
  if (seekOffset === null) {
    return;
  }
  event.preventDefault();
  seekBy(seekOffset);
});

let playbackRatePointerActive = false;
restorePlaybackRate();
elements.playbackRate.addEventListener('pointerdown', () => {
  playbackRatePointerActive = true;
});
elements.playbackRate.addEventListener('input', () => {
  const rate = Number(elements.playbackRate.value);
  audioPlayer.setPlaybackRate(rate);
  syncOutput(elements.playbackRate, elements.playbackRateValue, t.speed, formatRate(rate));
  persistPlaybackRate();
});
elements.playbackRate.addEventListener('change', () => {
  if (playbackRatePointerActive) {
    elements.playbackRate.blur();
  }
  playbackRatePointerActive = false;
});

/* ── Theme & language ─────────────────────────────────── */

function resolvedTheme(): 'light' | 'dark' {
  return themePref === 'auto' ? (prefersDark.matches ? 'dark' : 'light') : themePref;
}

function applyTheme(): void {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  applyDesignTheme(resolved);
  elements.themeSeg.querySelectorAll('button').forEach(button => {
    button.classList.toggle('on', button.dataset.themeOpt === themePref);
  });
  renderer.render(audioPlayer.currentTimeSeconds);
  waveformTimeline.setCurrentTime(audioPlayer.currentTimeSeconds);
}

function applyLanguage(): void {
  t = STRINGS[lang];
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    el.textContent = t[el.dataset.i18n as keyof Strings];
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t[el.dataset.i18nAria as keyof Strings]);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
    el.title = t[el.dataset.i18nTitle as keyof Strings];
  });
  elements.hintsList.innerHTML = t.hints;
  elements.langSeg.querySelectorAll('button').forEach(button => {
    button.classList.toggle('on', button.dataset.langOpt === langPref);
  });
  refreshSettingOutputs();
  updateRecognitionModeUi();
  updateFollowUi(elements.pianoStage.dataset.following === 'true');
  playIconPlaying = null;
  setPhase(phase, phaseProgress, phaseLabel);
  updatePlaybackUi();
}

function syncOutput(
  input: HTMLInputElement,
  output: HTMLOutputElement,
  label: string,
  text: string,
): void {
  output.value = text;
  output.textContent = text;
  input.setAttribute('aria-valuetext', `${label}: ${text}`);
}

function refreshSettingOutputs(): void {
  syncOutput(elements.playbackRate, elements.playbackRateValue, t.speed, formatRate(Number(elements.playbackRate.value)));
  syncOutput(elements.sensitivity, elements.sensitivityValue, t.sens, formatSensitivity(analysisSensitivity));
  syncOutput(elements.minNoteMs, elements.minNoteMsValue, t.minDur, `${analysisMinNoteMs} ${t.ms}`);
  syncOutput(elements.maxNotes, elements.maxNotesValue, t.maxNotes, String(analysisMaxNotesPerFrame));
  syncOutput(elements.contrast, elements.contrastValue, t.contrast, formatContrast(Number(elements.contrast.value)));
}

elements.themeSeg.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-theme-opt]');
  if (button === null) {
    return;
  }
  themePref = button.dataset.themeOpt as ThemePref;
  try {
    localStorage['pianotape.theme'] = themePref;
  } catch { /* private mode */ }
  applyTheme();
});

elements.langSeg.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-lang-opt]');
  if (button === null) {
    return;
  }
  langPref = button.dataset.langOpt as LangPref;
  lang = langPref === 'auto' ? (systemPrefersRussian() ? 'ru' : 'en') : langPref;
  try {
    localStorage['pianotape.lang'] = langPref;
  } catch { /* private mode */ }
  applyLanguage();
});

prefersDark.addEventListener('change', () => {
  if (themePref === 'auto') {
    applyTheme();
  }
});

/* ── Notice toast + cache clearing ────────────────────── */

let noticeTimer = 0;

function showNotice(text: string): void {
  elements.notice.textContent = text;
  elements.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    elements.notice.hidden = true;
  }, 8000);
}

elements.notice.addEventListener('click', () => {
  elements.notice.hidden = true;
  clearTimeout(noticeTimer);
});

// One-time heads-up about the ~110 MB precise-model download.
function maybeShowModelNotice(): void {
  try {
    if (localStorage['pianotape.model-notice'] === '1') {
      return;
    }
    localStorage['pianotape.model-notice'] = '1';
  } catch { /* private mode — show anyway, session-scoped */ }
  showNotice(t.preciseHint);
}

elements.clearCacheButton.addEventListener('click', () => {
  clearPreciseCache();
  if ('caches' in window) {
    void Promise.all(['muscriptor-gguf-v2', 'muscriptor-gguf-v1'].map(name => caches.delete(name)))
      .catch(() => undefined);
  }
  updateRecognitionModeUi();
  showNotice(t.cacheCleared);
});

/* ── Keyboard hints popover ───────────────────────────── */

function setHintsOpen(open: boolean): void {
  elements.hintsPanel.hidden = !open;
  elements.hintsButton.setAttribute('aria-expanded', String(open));
}

elements.hintsButton.addEventListener('click', () => {
  setHintsOpen(elements.hintsPanel.hidden);
});

elements.canvas.addEventListener('keydown', event => {
  if (!isPlaybackReady()) {
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    seekBy(event.key === 'ArrowLeft' ? -5 : 5);
  } else if (event.key === 'Home') {
    event.preventDefault();
    audioPlayer.seek(0);
    updatePlaybackUi();
    requestAnimation();
  } else if (event.key === 'End') {
    event.preventDefault();
    audioPlayer.seek(audioPlayer.durationSeconds);
    updatePlaybackUi();
    requestAnimation();
  }
});

elements.recoveryButton.addEventListener('click', () => {
  elements.fileInput.click();
});

elements.replaceButton.addEventListener('click', () => {
  elements.fileInput.click();
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
  syncOutput(elements.sensitivity, elements.sensitivityValue, t.sens, formatSensitivity(analysisSensitivity));
  persistAnalysisSettings();
  queueFastReanalyze();
});

elements.minNoteMs.addEventListener('input', () => {
  analysisMinNoteMs = Number(elements.minNoteMs.value);
  syncOutput(elements.minNoteMs, elements.minNoteMsValue, t.minDur, `${analysisMinNoteMs} ${t.ms}`);
  persistAnalysisSettings();
  queueFastReanalyze();
});

elements.maxNotes.addEventListener('input', () => {
  analysisMaxNotesPerFrame = Number(elements.maxNotes.value);
  syncOutput(elements.maxNotes, elements.maxNotesValue, t.maxNotes, String(analysisMaxNotesPerFrame));
  persistAnalysisSettings();
  queueFastReanalyze();
});

elements.contrast.addEventListener('input', () => {
  const contrast = Number(elements.contrast.value);
  renderer.setContrast(contrast);
  syncOutput(elements.contrast, elements.contrastValue, t.contrast, formatContrast(contrast));
  persistContrastSetting();
});

elements.settingsToggle.addEventListener('click', () => {
  setSettingsOpen(elements.settingsPanel.hidden);
});

// Outside pointer closes whichever popover is open.
document.addEventListener('pointerdown', event => {
  if (!(event.target instanceof Node)) {
    return;
  }
  if (
    !elements.hintsPanel.hidden &&
    !elements.hintsPanel.contains(event.target) &&
    !elements.hintsButton.contains(event.target)
  ) {
    setHintsOpen(false);
  }
  if (!elements.settingsPanel.hidden && !elements.analysisSettings.contains(event.target)) {
    setSettingsOpen(false);
  }
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') {
    return;
  }
  if (!elements.hintsPanel.hidden) {
    setHintsOpen(false);
    elements.hintsButton.focus();
  } else if (!elements.settingsPanel.hidden) {
    setSettingsOpen(false);
    elements.settingsToggle.focus();
  }
});

elements.zoomOutButton.addEventListener('click', () => {
  renderer.zoomTime(-1);
});

elements.zoomInButton.addEventListener('click', () => {
  renderer.zoomTime(1);
});

elements.pitchRangeButton.addEventListener('click', () => {
  renderer.cyclePitchRange();
});

elements.followButton.addEventListener('click', () => {
  renderer.toggleFollow();
});

elements.midiDownloadButton.addEventListener('click', () => {
  const midiBytes = preciseAnalysisResult?.midiBytes;
  if (midiBytes === undefined) {
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

async function loadFile(file: File): Promise<void> {
  const generation = ++analysisGeneration;
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
    // Slice: the client transfers the buffer to the worker — decodedSamples
    // must stay attached for later re-analysis.
    const fastResult = await fastSpectrumClient.analyze(
      decoded.samples.slice(),
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
          elements.player.hidden = false;
          setPhase(AnalysisPhase.PreviewReady);
          elements.status.textContent = t.statusPreview;
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
      elements.status.textContent = t.statusFastOnly;
      return;
    }
    if (isPlaybackReady() && hasFastPreview) {
      setPhase(AnalysisPhase.PreviewReady);
      elements.status.textContent = t.statusPreviewPartial;
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
  if (samples === null || fastAnalysisRunning || !isPlaybackReady()) {
    return;
  }
  const generation = analysisGeneration;
  fastSpectrumClient.cancel();
  elements.analysisStatus.textContent = t.updatingNotes;
  elements.analysisStatus.removeAttribute('title');
  elements.analysisStatus.removeAttribute('aria-label');
  elements.analysisStatus.dataset.busy = 'true';
  elements.status.textContent = t.statusUpdating;
  try {
    const result = await fastSpectrumClient.analyze(
      samples.slice(),
      {
        onPreview: preview => {
          if (
            generation !== analysisGeneration ||
            recognitionMode !== RecognitionMode.Instant
          ) {
            return;
          }
          renderer.setAnalysis(preview, audioPlayer.durationSeconds, true);
        },
      },
      currentFastSpectrumOptions(),
    );
    if (generation !== analysisGeneration) {
      return;
    }
    fastAnalysisResult = result;
    fullFastSpectrumReady = true;
    if (recognitionMode === RecognitionMode.Instant) {
      renderer.setAnalysis(result, audioPlayer.durationSeconds, true);
    }
    restoreReadyPhase();
    elements.status.textContent = t.statusUpdated;
    updatePlaybackUi();
  } catch (error) {
    if (generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    console.error('Пересчёт быстрого анализа не удался:', error);
    restoreReadyPhase();
    showError(t.errReanalyze);
    elements.status.textContent = t.statusUpdateFail;
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
  if (!fullFastSpectrumReady || fastAnalysisResult === null) {
    return;
  }

  recognitionMode = nextMode;
  if (nextMode === RecognitionMode.Instant) {
    renderer.setPreciseKeyHighlighting(false);
    renderer.setAnalysis(fastAnalysisResult, audioPlayer.durationSeconds, true);
    setPhase(AnalysisPhase.FastReady);
    updatePlaybackUi();
    return;
  }

  renderer.setPreciseKeyHighlighting(false);

  if (preciseAnalysisResult !== null) {
    renderer.setPreciseKeyHighlighting(true);
    renderer.setAnalysis(preciseAnalysisResult, audioPlayer.durationSeconds, true);
    setPhase(AnalysisPhase.Complete);
    updatePlaybackUi();
    return;
  }

  if (preciseAnalysisInProgress) {
    const partial = buildPartialResult();
    if (partial !== null) {
      renderer.setAnalysis(partial, audioPlayer.durationSeconds, true);
    }
    setPhase(AnalysisPhase.Refining, preciseAnalysisProgress);
    return;
  }

  void refineWithModel();
}

async function refineWithModel(): Promise<void> {
  const samples = decodedSamples;
  if (
    !fullFastSpectrumReady ||
    samples === null ||
    preciseAnalysisInProgress
  ) {
    return;
  }

  const generation = analysisGeneration;
  maybeShowModelNotice();
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
    if (generation !== analysisGeneration) {
      return;
    }
    preciseAnalysisInProgress = false;
    preciseAnalysisResult = result;
    elements.midiDownloadButton.hidden = result.midiBytes === undefined;
    if (recognitionMode === RecognitionMode.Precise) {
      renderer.setPreciseKeyHighlighting(true);
      renderer.setAnalysis(result, audioPlayer.durationSeconds, true);
      setPhase(AnalysisPhase.Complete);
    } else {
      setPhase(AnalysisPhase.FastReady);
    }
    updatePlaybackUi();
  } catch (error) {
    if (generation !== analysisGeneration || isCancelled(error)) {
      return;
    }
    console.error('Точный анализ не удался:', error);
    preciseAnalysisInProgress = false;
    recognitionMode = RecognitionMode.Instant;
    renderer.setPreciseKeyHighlighting(false);
    if (fastAnalysisResult !== null) {
      renderer.setAnalysis(fastAnalysisResult, audioPlayer.durationSeconds, true);
    }
    setPhase(AnalysisPhase.FastReady);
    showError(t.errPrecise);
    elements.status.textContent = t.statusPreciseFail;
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
            renderer.setAnalysis(partial, audioPlayer.durationSeconds, true);
          }
        }
        if (recognitionMode !== RecognitionMode.Precise) {
          return;
        }
        const stageLabel = stage === 'model'
          ? t.stageModel
          : stage === 'prepare'
            ? t.stagePrepare
            : t.stageRecognize;
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
    // Упавший прогон может оставить wasm-инстанс мёртвым — следующий старт с чистого модуля.
    muscriptorClient.cancel();
    throw error;
  }
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

function ensurePartialFrameBuffers(): Uint8Array | null {
  const durationSeconds = audioPlayer.durationSeconds;
  if (durationSeconds <= 0) {
    return null;
  }
  const frameCount = Math.max(1, Math.ceil(durationSeconds * PARTIAL_FRAMES_PER_SECOND));
  if (partialFrameTimestamps === null || partialFrameTimestamps.length !== frameCount) {
    partialFrameTimestamps = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      partialFrameTimestamps[frame] = frame / PARTIAL_FRAMES_PER_SECOND;
    }
    partialFrameProbabilities = new Uint8Array(frameCount * PARTIAL_PITCH_COUNT);
    return partialFrameProbabilities;
  }
  return partialFrameProbabilities;
}

function pushIncrementalNotes(notes: AnalyzedNote[]): void {
  const frameCount = partialFrameTimestamps?.length ??
    Math.max(1, Math.ceil(audioPlayer.durationSeconds * PARTIAL_FRAMES_PER_SECOND));
  for (const note of notes) {
    note.startFrame = Math.max(0, Math.floor(note.startTimeSeconds * PARTIAL_FRAMES_PER_SECOND));
    note.endFrame = Math.min(
      frameCount,
      Math.max(note.startFrame + 1, Math.ceil(note.endTimeSeconds * PARTIAL_FRAMES_PER_SECOND)),
    );
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
  const probabilities = ensurePartialFrameBuffers();
  if (probabilities === null || partialFrameTimestamps === null) {
    return null;
  }
  const frameCount = partialFrameTimestamps.length;
  const fast = fastAnalysisResult;
  const notes = incrementalNotes.slice();
  // Rebuild the grid from scratch each call — the fast fill above the
  // boundary would otherwise stay painted in regions that were since refined.
  probabilities.fill(0);
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
  // Precise notes may extend past the boundary — paint them on top.
  for (const note of incrementalNotes) {
    paintPartialNote(probabilities, frameCount, note);
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
    if (generation !== analysisGeneration) {
      return;
    }
    updatePlaybackUi();
    requestAnimation();
  } catch {
    if (generation !== analysisGeneration) {
      return;
    }
    showError(t.errPlay);
    elements.status.textContent = t.statusPlayFail;
    updatePlaybackUi();
  }
}

let phaseProgress = 0;
let phaseLabel = '';

function setPhase(nextPhase: AnalysisPhase, progress = 0, label = t.stageRecognize): void {
  phase = nextPhase;
  phaseProgress = progress;
  phaseLabel = label;
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
    elements.dropTitle.textContent = t.dropH;
    elements.dropDescription.textContent = t.dropMeta;
    elements.status.textContent = t.statusIdle;
  } else if (phase === AnalysisPhase.Loading) {
    elements.dropTitle.textContent = t.loadingH;
    elements.dropDescription.textContent = t.loadingSub;
    elements.status.textContent = t.statusLoading;
  } else if (phase === AnalysisPhase.FastAnalyzing) {
    elements.dropTitle.textContent = t.analyzingH;
    elements.dropDescription.textContent = t.analyzingSub;
    elements.status.textContent = t.statusAnalyzing;
  } else if (phase === AnalysisPhase.PreviewReady) {
    elements.analysisStatus.textContent = t.analysisPreview;
    elements.analysisStatus.removeAttribute('title');
    elements.analysisStatus.removeAttribute('aria-label');
    elements.recognitionMode.hidden = true;
    elements.status.textContent = t.statusPreview;
  } else if (phase === AnalysisPhase.FastReady) {
    elements.analysisStatus.textContent = '';
    elements.recognitionMode.hidden = !fullFastSpectrumReady;
    elements.status.textContent = t.statusFastReady;
  } else if (phase === AnalysisPhase.Refining) {
    const percentage = Math.round(progress * 100);
    elements.analysisStatus.textContent = `${label}: ${percentage}%`;
    elements.analysisStatus.removeAttribute('title');
    elements.analysisStatus.removeAttribute('aria-label');
    elements.recognitionMode.hidden = false;
    elements.status.textContent = `${label}: ${percentage}%.`;
  } else if (phase === AnalysisPhase.Complete) {
    elements.analysisStatus.textContent = '';
    elements.recognitionMode.hidden = false;
    elements.status.textContent = t.statusComplete;
  } else {
    renderer.setPreciseKeyHighlighting(false);
    elements.dropTitle.textContent = t.failH;
    elements.dropDescription.textContent = t.failSub;
    elements.status.textContent = t.statusFail;
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
    const playCopy = playIconPlaying ? t.pause : t.play;
    elements.playButton.setAttribute('aria-label', playCopy);
    elements.playButton.title = `${playCopy} (${t.spaceKey})`;
  }
  elements.timeline.value = String(currentTime);
  elements.currentTime.textContent = formatTime(currentTime);
  elements.durationTime.textContent = `/ ${formatTime(audioPlayer.durationSeconds)}`;
  waveformTimeline.setCurrentTime(currentTime);
  renderer.render(currentTime);
}

function updateFollowUi(following: boolean): void {
  const label = following ? t.follow : t.toPosition;
  const copy = following ? t.followOn : t.followOff;
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
  if (generation !== analysisGeneration) {
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
      return t.errTooLarge;
    }
    if (error.code === AudioPlayerErrorCode.DurationTooLong) {
      return t.errTooLong;
    }
    return t.errFormat;
  }
  if (error instanceof AnalysisClientError) {
    if (error.code === AnalysisErrorCode.ModelLoadFailed) {
      return t.errModel;
    }
    if (error.code === AnalysisErrorCode.BackendUnavailable) {
      return t.errBackend;
    }
    if (error.code === AnalysisErrorCode.WorkerFailed) {
      return t.errWorker;
    }
    if (error.code === AnalysisErrorCode.InvalidAudio) {
      return t.errInvalid;
    }
    return t.errAnalysis;
  }
  return t.errGeneric;
}

function formatContrast(value: number): string {
  return `${dec(value.toFixed(2).replace(/0$/, ''))}×`;
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
  elements.preciseModeButton.title = t.precise;
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

function storedNumber(key: string, min: number, max: number): number | null {
  try {
    const value = Number(localStorage[key]);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
  } catch {
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage[`pianorolltranscribe.${key}`] = value;
  } catch { /* private mode */ }
}

function restorePlaybackRate(): void {
  const rate = storedNumber('pianorolltranscribe.playback-rate', 0.2, 1);
  if (rate === null) {
    return;
  }
  elements.playbackRate.value = String(rate);
  audioPlayer.setPlaybackRate(rate);
  refreshSettingOutputs();
}

function persistPlaybackRate(): void {
  persist('playback-rate', elements.playbackRate.value);
}

function restoreAnalysisSettings(): void {
  // Assign the input first, then read back so slider step-snapping applies.
  const sensitivity = storedNumber('pianorolltranscribe.sensitivity', 0, 1);
  if (sensitivity !== null) {
    elements.sensitivity.value = String(sensitivity);
    analysisSensitivity = Number(elements.sensitivity.value);
  }
  const minNoteMs = storedNumber('pianorolltranscribe.min-note-ms', 50, 500);
  if (minNoteMs !== null) {
    elements.minNoteMs.value = String(minNoteMs);
    analysisMinNoteMs = Number(elements.minNoteMs.value);
  }
  const maxNotes = storedNumber('pianorolltranscribe.max-notes', 1, 8);
  if (maxNotes !== null) {
    elements.maxNotes.value = String(Math.round(maxNotes));
    analysisMaxNotesPerFrame = Number(elements.maxNotes.value);
  }
  const contrast = storedNumber('pianorolltranscribe.contrast', 0.7, 2.2);
  if (contrast !== null) {
    elements.contrast.value = String(contrast);
    renderer.setContrast(Number(elements.contrast.value));
  }
  refreshSettingOutputs();
}

function persistAnalysisSettings(): void {
  persist('sensitivity', String(analysisSensitivity));
  persist('min-note-ms', String(analysisMinNoteMs));
  persist('max-notes', String(analysisMaxNotesPerFrame));
}

function persistContrastSetting(): void {
  persist('contrast', elements.contrast.value);
}

function seekBy(deltaSeconds: number): void {
  audioPlayer.seek(audioPlayer.currentTimeSeconds + deltaSeconds);
  updatePlaybackUi();
  requestAnimation();
}

function requiredElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Element #${id} is missing`);
  }
  return element as ElementType;
}

applyTheme();
applyLanguage();
