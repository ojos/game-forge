/**
 * 試用の録画（#978）のブラウザ側——画面とマイクを合わせて MediaRecorder で録り、5 秒ごとの断片を送る。
 *
 * ## なぜ段の移り目をページの読み込みにしないのか
 *
 * **ページを読み込み直すと、画面の取り込みと MediaRecorder が止まる。** `/trial` の段は素のフォーム送信
 * （303 → GET）で進む（`src/trial.ts`）が、録画の準備〜振り返り 5 の間はそれでは録画が切れる。このスクリプトは
 * 段を進めるフォームの送信を横取りし、同じ口へ `fetch` で送って、返ってきた `/trial` の HTML から段の部分
 * （`#trial-stage`）だけを差し替える。**口も段の判定もサーバーのまま**で、変わるのは画面の差し替え方だけである。
 *
 * ## 送り方
 *
 * - 断片は連番の順に 1 つずつ送る（`src/trial-recording.ts` の受け取り方に合わせる）。
 * - **送れなかった断片は手元（メモリ）に溜めて、間を空けて送り直す**（2 秒から倍々で 30 秒まで）。溜まっている
 *   件数と大きさを画面に出す。
 * - 口が「抜けがある」（409 `gap`）と返したら、口が持っている番号まで捨てて続ける。上限などで断られたら、
 *   その録画の残りを捨てて、録画を止める。
 *
 * ## 止め方
 *
 * - **アンケートの段に入ったら止める**（`finished`）。残りを送り切るまで、アンケートの送信を待たせる。
 * - **試用者が「共有を停止」を押したら**、映像の線が `ended` になる。録画を止め（`share-ended`）、口へ伝え、
 *   「録画を再開する」を出す。
 * - **60 分で止める**（`time-limit`）。
 *
 * ## 形式
 *
 * `config.candidates`（`src/trial-recording-store.ts` の `recordingMimeCandidates`）のうち、
 * `MediaRecorder.isTypeSupported` が通る最初のものを使う（`pickRecordingMimeType` と同じ選び方）。
 *
 * **文言はスクリプトに書かない**（`src/trial-text.ts` の `TRIAL_RECORDER_MESSAGES` を設定として受け取る）。
 */
import { TRIAL_RECORDER_MESSAGES } from './trial-text.js';
import type { TrialBrowser } from './trial-recording-store.js';
import { isTrialRecordingStage, recordingMimeCandidates } from './trial-recording-store.js';
import { TRIAL_STAGES } from './trial-store.js';
import {
  TRIAL_RECORDING_CHUNK_API_PATH,
  TRIAL_RECORDING_ID_PARAM,
  TRIAL_RECORDING_SEQ_PARAM,
  TRIAL_RECORDING_START_API_PATH,
  TRIAL_RECORDING_STOP_API_PATH,
  TRIAL_STEP_API_PATH,
} from './trial-paths.js';

/** 段の部分（差し替える範囲）の id。 */
export const TRIAL_STAGE_ELEMENT_ID = 'trial-stage';

/** 録画の状態の欄の id。 */
export const TRIAL_RECORDER_ELEMENT_ID = 'trial-recorder';

/** 録画を始めるボタンの id（録画の準備の段）。 */
export const TRIAL_RECORD_START_ID = 'trial-record-start';

/** 録画を再開するボタンの id（状態の欄）。 */
export const TRIAL_RECORD_RESTART_ID = 'trial-record-restart';

/** アンケートのフォームの id。 */
export const TRIAL_SURVEY_FORM_ID = 'trial-survey-form';

/** 録画の残りを待たずにアンケートを送るボタンの id。 */
export const TRIAL_SURVEY_SKIP_ID = 'trial-survey-skip';

/** 録画を始めた後に出す要素に付ける属性（録画の準備の段の「次へ」）。 */
export const TRIAL_AFTER_RECORDING_ATTR = 'data-trial-after-recording';

/** スクリプトへ渡す設定。 */
interface TrialRecorderConfig {
  readonly startPath: string;
  readonly chunkPath: string;
  readonly stopPath: string;
  readonly stepPath: string;
  readonly idParam: string;
  readonly seqParam: string;
  readonly candidates: readonly string[];
  readonly displaySurface: 'browser' | 'window';
  readonly recordingStages: readonly string[];
  readonly messages: typeof TRIAL_RECORDER_MESSAGES;
}

/**
 * スクリプトへ渡す設定を組み立てる。
 *
 * @param browser 録画に使うブラウザ
 * @returns 設定
 */
export function trialRecorderConfig(browser: TrialBrowser): TrialRecorderConfig {
  return {
    startPath: TRIAL_RECORDING_START_API_PATH,
    chunkPath: TRIAL_RECORDING_CHUNK_API_PATH,
    stopPath: TRIAL_RECORDING_STOP_API_PATH,
    stepPath: TRIAL_STEP_API_PATH,
    idParam: TRIAL_RECORDING_ID_PARAM,
    seqParam: TRIAL_RECORDING_SEQ_PARAM,
    candidates: recordingMimeCandidates(browser),
    displaySurface: browser === 'chrome' || browser === 'edge' ? 'browser' : 'window',
    recordingStages: TRIAL_STAGES.filter(isTrialRecordingStage),
    messages: TRIAL_RECORDER_MESSAGES,
  };
}

/**
 * `<script>` の中へ JSON を置ける形にする（`</script>` で閉じられないよう `<` を逃がす）。
 *
 * @param value 値
 * @returns JSON 文字列
 */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

/** ブラウザで動く本体（設定は `window.__trialRecorderConfig` から読む）。 */
const TRIAL_RECORDER_SCRIPT = `
(function () {
  'use strict';
  var config = window.__trialRecorderConfig;
  if (!config) { return; }
  var M = config.messages;
  var panel = document.getElementById('${TRIAL_RECORDER_ELEMENT_ID}');
  if (!panel) { return; }
  var stateEl = panel.querySelector('[data-trial-recorder-state]');
  var pendingEl = panel.querySelector('[data-trial-recorder-pending]');
  var restartButton = document.getElementById('${TRIAL_RECORD_RESTART_ID}');

  /** いまの録画（無ければ null）。 */
  var session = null;
  /** 送れていない断片（連番の順）。 */
  var queue = [];
  /** 送り終えたら口へ伝える「止まった」の知らせ。 */
  var pendingStops = [];
  var sending = false;
  var retryDelay = 0;
  /** 最後に止まった理由（再開のボタンを出すかを決める）。 */
  var lastEndReason = null;
  /** 口に断られた（上限など）。録り直しても断られるので、再開のボタンを出さない。 */
  var blocked = false;
  /** 送り終えたらアンケートを送る。 */
  var submitSurveyWhenDrained = false;
  /** 自分でページを離れる（アンケートを送る）ときは、離れる確認を出さない。 */
  var leaving = false;

  function format(text, values) {
    return text.replace(/\\{(\\w+)\\}/g, function (_, key) { return values[key] === undefined ? '' : String(values[key]); });
  }
  function setState(text) { if (stateEl) { stateEl.textContent = text; } }
  function megabytes(bytes) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
  function pendingBytes() { var total = 0; for (var i = 0; i < queue.length; i += 1) { total += queue[i].blob.size; } return total; }
  function currentStage() {
    var stage = document.getElementById('${TRIAL_STAGE_ELEMENT_ID}');
    return stage ? stage.getAttribute('data-trial-stage') : null;
  }
  function isRecordingStage(stage) { return config.recordingStages.indexOf(stage) >= 0; }
  function recording() { return session !== null && session.recorder.state !== 'inactive'; }

  function renderPending() {
    if (!pendingEl) { return; }
    if (queue.length === 0) {
      pendingEl.textContent = session !== null || pendingStops.length > 0 || lastEndReason !== null ? M.allSent : '';
      pendingEl.setAttribute('data-pending', '0');
    } else {
      pendingEl.textContent = format(retryDelay > 0 ? M.pending : M.sending, { pending: queue.length, size: megabytes(pendingBytes()) });
      pendingEl.setAttribute('data-pending', String(queue.length));
    }
    panel.setAttribute('data-trial-pending', String(queue.length));
  }

  function renderRestart() {
    if (!restartButton) { return; }
    var show = !recording() && isRecordingStage(currentStage()) && currentStage() !== 'recording'
      && lastEndReason !== 'time-limit' && !blocked && session === null && config.supported;
    toggle(restartButton, show);
  }

  function renderElapsed() {
    if (!recording()) { return; }
    var seconds = Math.floor((Date.now() - session.startedAt) / 1000);
    var text = ' ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    setState(format(M.recording, { elapsed: text }));
  }

  /** ボタンを出し入れする（部品の display は [hidden] に勝つので、包みの要素で隠す）。 */
  function toggle(element, visible) {
    if (!element) { return; }
    var wrap = element.closest('[data-trial-toggle]') || element;
    wrap.hidden = !visible;
  }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function dropRecording(recordingId) {
    queue = queue.filter(function (item) { return item.recordingId !== recordingId; });
  }

  async function postJson(path, body) {
    var response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    return { status: response.status, data: data };
  }

  async function flushStops() {
    while (pendingStops.length > 0) {
      var stop = pendingStops[0];
      if (queue.some(function (item) { return item.recordingId === stop.recordingId; })) { return; }
      try {
        var result = await postJson(config.stopPath, stop);
        if (result.status >= 500) { return; }
      } catch (error) { return; }
      pendingStops.shift();
    }
  }

  /** 溜まった断片を、連番の順に 1 つずつ送る。 */
  async function pump() {
    if (sending) { return; }
    sending = true;
    try {
      while (queue.length > 0) {
        var item = queue[0];
        var url = config.chunkPath + '?' + config.idParam + '=' + encodeURIComponent(item.recordingId)
          + '&' + config.seqParam + '=' + item.seq;
        var outcome = 'retry';
        var data = null;
        var status = 0;
        try {
          var response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': item.blob.type || 'application/octet-stream' },
            body: item.blob,
          });
          status = response.status;
          try { data = await response.json(); } catch (error) { data = null; }
          if (response.ok && data && data.ok) {
            outcome = 'sent';
          } else if (status === 409 && data && data.error === 'gap' && typeof data.nextSeq === 'number') {
            outcome = 'gap';
          } else if (status === 401 || status === 408 || status === 429 || status >= 500) {
            outcome = 'retry';
          } else {
            outcome = 'rejected';
          }
        } catch (error) {
          outcome = 'retry';
        }
        if (outcome === 'sent') {
          queue.shift();
          retryDelay = 0;
        } else if (outcome === 'gap') {
          if (data.nextSeq > item.seq) {
            var next = data.nextSeq;
            queue = queue.filter(function (q) { return q.recordingId !== item.recordingId || q.seq >= next; });
          } else {
            // 口が手元に無い番号を待っている。つないでも再生できないので、この録画の残りを捨てる。
            dropRecording(item.recordingId);
            reject(item.recordingId);
          }
          retryDelay = 0;
        } else if (outcome === 'rejected') {
          dropRecording(item.recordingId);
          reject(item.recordingId);
          retryDelay = 0;
        } else {
          retryDelay = retryDelay === 0 ? 2000 : Math.min(retryDelay * 2, 30000);
          renderPending();
          await sleep(retryDelay);
        }
        renderPending();
      }
      await flushStops();
    } finally {
      sending = false;
    }
    renderPending();
    if (queue.length === 0) {
      onDrained();
    } else {
      void pump();
    }
  }

  function reject(recordingId) {
    blocked = true;
    if (session !== null && session.recordingId === recordingId && recording()) {
      stopRecording('error', M.rejected);
    }
    setState(M.rejected);
    renderRestart();
  }

  function enqueue(recordingId, blob) {
    if (!blob || blob.size === 0 || session === null || session.recordingId !== recordingId) { return; }
    queue.push({ recordingId: recordingId, seq: session.nextSeq, blob: blob });
    session.nextSeq += 1;
    renderPending();
    void pump();
  }

  function pickMime() {
    for (var i = 0; i < config.candidates.length; i += 1) {
      if (window.MediaRecorder.isTypeSupported(config.candidates[i])) { return config.candidates[i]; }
    }
    return null;
  }

  function stopTracks(stream) { if (stream) { stream.getTracks().forEach(function (track) { track.stop(); }); } }

  /** 録画を止める（理由を残し、最後の断片を送ってから口へ伝える）。 */
  function stopRecording(reason, message) {
    if (!recording()) { return; }
    session.reason = reason;
    session.message = message;
    session.recorder.stop();
  }

  /** 録画を始める。始められたら true。 */
  async function startRecording() {
    if (recording()) { return true; }
    setState(M.starting);
    var display = null;
    var mic = null;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: config.displaySurface },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (error) {
      setState(M.displayDenied);
      return false;
    }
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      stopTracks(display);
      setState(M.micDenied);
      return false;
    }
    var mimeType = pickMime();
    var video = display.getVideoTracks()[0];
    var settings = video && video.getSettings ? video.getSettings() : {};
    var started = null;
    try {
      started = await postJson(config.startPath, { mimeType: mimeType, displaySurface: settings.displaySurface || null });
    } catch (error) {
      started = null;
    }
    if (!started || started.status !== 201 || !started.data || !started.data.ok) {
      stopTracks(display);
      stopTracks(mic);
      setState(M.startFailed);
      return false;
    }
    var info = started.data;
    var stream = new MediaStream(display.getVideoTracks().concat(mic.getAudioTracks()));
    var recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mimeType,
        videoBitsPerSecond: info.videoBitsPerSecond,
        audioBitsPerSecond: info.audioBitsPerSecond,
      });
    } catch (error) {
      stopTracks(stream);
      setState(M.startFailed);
      return false;
    }
    var current = {
      recordingId: info.recordingId,
      recorder: recorder,
      stream: stream,
      nextSeq: 0,
      startedAt: Date.now(),
      maxMs: info.maxSeconds * 1000,
      reason: null,
      message: null,
      limit: null,
    };
    session = current;
    lastEndReason = null;
    recorder.addEventListener('dataavailable', function (event) {
      enqueue(current.recordingId, event.data);
      if (Date.now() - current.startedAt >= current.maxMs) { stopRecording('time-limit', M.timeLimit); }
    });
    recorder.addEventListener('error', function () { stopRecording('error', M.error); });
    recorder.addEventListener('stop', function () {
      stopTracks(current.stream);
      clearTimeout(current.limit);
      var reason = current.reason || 'error';
      lastEndReason = reason;
      pendingStops.push({ recordingId: current.recordingId, reason: reason });
      if (session === current) { session = null; }
      setState(current.message || (reason === 'share-ended' ? M.shareEnded : reason === 'finished' ? M.finished : M.error));
      panel.setAttribute('data-trial-recording', 'stopped');
      panel.setAttribute('data-trial-end-reason', reason);
      renderRestart();
      renderPending();
      void pump();
    });
    if (video) {
      video.addEventListener('ended', function () { stopRecording('share-ended', M.shareEnded); });
    }
    recorder.start(info.chunkMs);
    current.limit = setTimeout(function () { stopRecording('time-limit', M.timeLimit); }, current.maxMs);
    panel.setAttribute('data-trial-recording', 'active');
    panel.removeAttribute('data-trial-end-reason');
    renderElapsed();
    renderRestart();
    renderPending();
    return true;
  }

  /** 段を進めるフォームを fetch で送り、段の部分だけを差し替える。 */
  async function advance(form) {
    var button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; }
    var next = null;
    try {
      var response = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        body: new URLSearchParams(new FormData(form)),
      });
      if (response.ok) {
        var doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        next = doc.getElementById('${TRIAL_STAGE_ELEMENT_ID}');
      }
    } catch (error) {
      next = null;
    }
    if (next === null) {
      if (button) { button.disabled = false; }
      setState(M.stepFailed);
      return;
    }
    var stageEl = document.getElementById('${TRIAL_STAGE_ELEMENT_ID}');
    var imported = document.importNode(next, true);
    stageEl.replaceWith(imported);
    applyStage();
    var heading = imported.querySelector('h2');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
  }

  function bindRecordingStage() {
    var start = document.getElementById('${TRIAL_RECORD_START_ID}');
    if (!start) { return; }
    if (!config.supported) { toggle(start, false); return; }
    toggle(start, true);
    start.addEventListener('click', async function () {
      start.disabled = true;
      var ok = await startRecording();
      start.disabled = false;
      if (!ok) { return; }
      var after = document.querySelectorAll('[${TRIAL_AFTER_RECORDING_ATTR}]');
      for (var i = 0; i < after.length; i += 1) { after[i].hidden = false; }
      toggle(start, false);
      // 録画を始めたら、自由に触る段へ進める（Chrome・Edge は選んだタブへ移るので、ここへ戻らずに始められる）。
      var form = document.querySelector('#${TRIAL_STAGE_ELEMENT_ID} form[action="' + config.stepPath + '"]');
      if (form) { void advance(form); }
    });
  }

  function bindSurvey() {
    var form = document.getElementById('${TRIAL_SURVEY_FORM_ID}');
    var skip = document.getElementById('${TRIAL_SURVEY_SKIP_ID}');
    if (!form) { return; }
    form.addEventListener('submit', function (event) {
      if (queue.length === 0 && !recording()) { leaving = true; return; }
      event.preventDefault();
      submitSurveyWhenDrained = true;
      setState(M.surveyWaiting);
      toggle(skip, true);
    });
    if (skip) {
      skip.addEventListener('click', function () {
        if (!form.reportValidity()) { return; }
        leaving = true;
        form.submit();
      });
    }
  }

  function onDrained() {
    if (submitSurveyWhenDrained && !recording()) {
      var form = document.getElementById('${TRIAL_SURVEY_FORM_ID}');
      if (form) { leaving = true; form.submit(); }
    }
  }

  function applyStage() {
    var stage = currentStage();
    panel.setAttribute('data-trial-stage', stage || '');
    if (stage === 'recording') { bindRecordingStage(); }
    if (stage === 'survey') {
      stopRecording('finished', M.finished);
      bindSurvey();
    }
    if (!recording() && session === null && lastEndReason === null && stage !== 'recording' && isRecordingStage(stage)) {
      setState(M.stopped);
    }
    renderRestart();
    renderPending();
  }

  config.supported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && navigator.mediaDevices.getUserMedia
    && window.MediaRecorder && typeof window.MediaRecorder.isTypeSupported === 'function' && pickMime() !== null);
  if (!config.supported) {
    var unsupported = panel.querySelector('[data-trial-recorder-unsupported]');
    if (unsupported) { unsupported.hidden = false; }
    setState(M.unsupported);
  } else {
    setState(M.idle);
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) { return; }
    if (form.getAttribute('action') !== config.stepPath) { return; }
    event.preventDefault();
    void advance(form);
  });

  if (restartButton) {
    restartButton.addEventListener('click', async function () {
      restartButton.disabled = true;
      await startRecording();
      restartButton.disabled = false;
      renderRestart();
    });
  }

  window.addEventListener('beforeunload', function (event) {
    if (leaving || (!recording() && queue.length === 0)) { return; }
    event.preventDefault();
    event.returnValue = '';
  });

  setInterval(renderElapsed, 1000);
  applyStage();
})();
`;

/**
 * 録画のスクリプト（設定と本体の 2 つの `<script>`）。
 *
 * @param browser 録画に使うブラウザ
 * @returns HTML
 */
export function trialRecorderScript(browser: TrialBrowser): string {
  return `<script>window.__trialRecorderConfig = ${scriptSafeJson(trialRecorderConfig(browser))};</script>
<script>${TRIAL_RECORDER_SCRIPT}</script>`;
}
