/**
 * 作品ページの「遊ぶ」の部分（M14-3 / #502 / 仕様 3.9.4）。**ゲームの iframe と、タッチ端末の全画面の覆い**を組み立てる。
 *
 * # なぜ iframe を HTML に直接置かないのか
 *
 * **タッチ端末（`pointer: coarse`）の作品ページは、開いた時点ではゲームを読み込まない**（3.9.4）。隠しただけの iframe も
 * 読み込まれるので、iframe はスクリプトが作る。
 *
 * | 環境 | iframe を作る時点と場所 |
 * |---|---|
 * | デスクトップ（`pointer: coarse` でない） | スクリプトが**すぐに**、今と同じ位置（`<noscript>` の直前）に作る |
 * | タッチ端末 | スクリーンショットをタップして覆いを開いたときに、覆いの中に作る。閉じると取り除く |
 * | JavaScript が無い | `<noscript>` の中の今の埋め込みで遊べる |
 *
 * **判定は幅ではなく、スクリプトが開いた時点の `matchMedia('(pointer: coarse)')` の 1 回だけ**である（3.9.4）。
 *
 * # iframe の属性は 1 か所から組み立てる（3.9.8 の 6）
 *
 * **`<noscript>` 用の HTML も、スクリプトが作る iframe も、{@link playFrameAttributes} の同じ配列から作る。**
 * 写しを 2 つ持つと、片方にだけ `sandbox` の値が足される日が来る。スクリプトへは配列を JSON で埋め、
 * `setAttribute` を同じ順で呼ぶ。**`allowfullscreen` は付けない**——全画面にするのは親の文書の覆いの要素である（3.9.4 / 7.2）。
 *
 * # 起動の合図とプレイ数（#377）を変えない
 *
 * 計上のスクリプト（`src/plays.ts` の `playReportScript`）は、**合図が届いた時点で** `iframe.gf-frame` を引き、
 * `event.source === frame.contentWindow` を見る。覆いの中の iframe も同じ `class` を持つので、後から作っても、
 * 閉じて作り直しても同じ受け手が受け、**同じページでは 1 回しか数えない**（あちらの `reported`）。
 *
 * # 仮想パッド（M14-5 / #494 / 仕様 3.9.6 / 3.9.7）
 *
 * **パッドのボタンは HTML に置く**（覆いの中の 2 つの置き場所。{@link padKeysHtml}）。どのキーを出すかは作品ページが D1 から読んだ
 * キーの集合と表示規則（`src/virtual-pad.ts`）で決まり、スクリプトはボタンの `data-code` を読むだけである——**スクリプトの本文は
 * 作品によらず同じ**で、UGC もキーの集合も埋めない。覆いは `hidden` で配るので、**デスクトップと JavaScript の無い形ではパッドは出ない。**
 * 表示規則の結果が空（マウスだけの作品）なら置き場所は空のままで、ゲームが覆いの全体を使う。
 *
 * - **押下**: ボタンごとに `pointerdown` で `preventDefault`（フォーカスを動かさない。動くと canvas の `blur` で Ebitengine が
 *   押しているキーをすべて離す）と `setPointerCapture` をしてから `down` を送る。`pointerup` / `pointercancel` /
 *   `lostpointercapture` で `up` を送る。ボタンごとに指を覚えるので、同時押しが成り立つ
 * - **キーボード・支援技術**（`click` の `detail === 0`）: `down` と `up` を続けて送る
 * - **すべて離す**: `visibilitychange`（`hidden`）・`pagehide`・`window` の `blur` と、覆いを閉じるとき（`releasePad`）
 * - **送信**: `iframe.contentWindow.postMessage({ type: 'gf-pad', op, code }, '*')`。宛先は `'*'` で、確認は受け手
 *   （`src/sandbox-loader.ts` の `padReceiverScript`）が行う。**送り始めるのは、その iframe から起動の合図を受けた後**
 *   （検査は `src/plays.ts` と同じ `event.source === frame.contentWindow`）。**2 回目の `load`（遷移）の後は送らない**
 *
 * # このモジュールは画面の文字列だけを持つ
 *
 * 文言は固定で、**UGC を含まない。** 遊ぶ URL は配信側が組み立てた値で、HTML へは `escapeHtml` を通して入れる。
 * スクリプトはビルド工程を通らずそのままブラウザへ届く（`src/plays.ts` と同じ）ので、素朴な書き方（`var` と関数式）に寄せる。
 */
import { escapeHtml } from './html.js';
import { LOADER_STARTED_MESSAGE, PAD_MESSAGE_TYPE } from './sandbox-loader.js';
import type { PadKey, PadLayout } from './virtual-pad.js';
import { padLayoutOf } from './virtual-pad.js';

/** 副のボタンの部品（仕様 2.5.5）。**主は作品ページの「改造する」のまま**で、ここは副だけを使う。 */
const SECONDARY_BUTTON = 'gf-button gf-button-secondary';

/** ゲームの iframe の `class`。**計上のスクリプト（`src/plays.ts`）がこの綴りで iframe を引く。** */
export const PLAY_FRAME_CLASS = 'gf-frame';

/** 「遊ぶ」の口（スクリーンショットと「遊ぶ」のボタンを包む要素）の `class`。 */
export const PLAY_ENTRY_CLASS = 'gf-play-entry';

/**
 * タッチ端末で口に付ける `class`（スクリプトが付ける）。撮影中の固定の文言のパネルでは、文言を「遊ぶ」のボタンの上へ逃がす
 * （`public/assets/app.css` の `@section work`）。**デスクトップと JavaScript の無い形では付かない**ので、版面は変わらない。
 */
export const PLAY_ENTRY_TOUCH_CLASS = 'gf-play-entry-touch';

/** 「遊ぶ」のボタンの `class`（部品のクラスの後ろに足す）。 */
export const PLAY_OPEN_CLASS = 'gf-play-open';

/** 全画面の覆いの `class`。 */
export const PLAY_OVERLAY_CLASS = 'gf-play-overlay';

/** 覆いの中のゲームの領域の `class`。 */
export const PLAY_STAGE_CLASS = 'gf-play-stage';

/** 「閉じる」のボタンの `class`（部品のクラスの後ろに足す）。 */
export const PLAY_CLOSE_CLASS = 'gf-play-close';

/** JavaScript が無いときの埋め込みを包む `<noscript>` の `class`。 */
export const PLAY_NOSCRIPT_CLASS = 'gf-play-noscript';

/** 覆いを開いているあいだ、`<html>` に付けて下のページをスクロールさせない `class`。 */
export const PLAY_LOCKED_CLASS = 'gf-play-locked';

/** パッドの置き場所（十字とボタンの 2 つ）に共通の `class`。 */
export const PLAY_PAD_CLASS = 'gf-play-pad';

/** パッドの十字の置き場所の `class`。 */
export const PLAY_PAD_DPAD_CLASS = 'gf-play-pad-dpad';

/** パッドのボタンの置き場所の `class`。 */
export const PLAY_PAD_BUTTONS_CLASS = 'gf-play-pad-buttons';

/** パッドのキー（ボタン）の `class`（部品のクラスの後ろに足す）。**スクリプトはこの綴りでボタンを引く。** */
export const PLAY_PAD_KEY_CLASS = 'gf-play-pad-key';

/** パッドのキーが送る `code` を持つ属性。 */
export const PLAY_PAD_CODE_ATTRIBUTE = 'data-code';

/**
 * 押しているあいだパッドのキーに付ける `class`（見た目だけに使う）。
 *
 * **属性ではなく `class` にする。** スクリプトの `setAttribute` は iframe の属性の配列にしか使わない（属性の写しを持たないことを
 * `test/work-play.test.ts` が綴りで見ている）。
 */
export const PLAY_PAD_HELD_CLASS = 'gf-play-pad-held';

/**
 * 閉じたときに始めた `history.back()` の決着（その `popstate`）を待つ上限（ミリ秒）。待っているあいだは開き直しを受け付けない。
 * **普通は 1 フレームほどで届く。** 届かない環境で開けなくなったままにしないための上限である。
 */
const PLAY_BACK_SETTLE_LIMIT_MS = 1000;

/** 覆いを開くときに `history.pushState` で積む状態（戻る操作で閉じる。3.9.4）。 */
const PLAY_HISTORY_STATE_KEY = 'gfPlay';

/** iframe の属性 1 つ（名前と値）。 */
export type PlayFrameAttribute = readonly [name: string, value: string];

/**
 * ゲームの iframe の属性（**順序も含めて、これが唯一の出どころ**。3.9.4 / 3.9.8 の 6）。
 *
 * @param playUrl 遊ぶ URL（配信側が組み立てた `/g/<id>/`）
 * @returns 属性の並び
 */
export function playFrameAttributes(playUrl: string): readonly PlayFrameAttribute[] {
  return [
    ['class', PLAY_FRAME_CLASS],
    ['src', playUrl],
    // **`sandbox` は `allow-scripts` だけである**（7.2）。属性を足すときは 7.2 と 3.9.8 を先に読むこと。
    ['sandbox', 'allow-scripts'],
    ['title', 'ゲーム'],
  ];
}

/**
 * ゲームの iframe の HTML（`<noscript>` の中身）。{@link playFrameAttributes} から組み立てる。
 *
 * @param playUrl 遊ぶ URL
 * @returns `<iframe>` 要素
 */
export function playFrameHtml(playUrl: string): string {
  const attributes = playFrameAttributes(playUrl)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(' ');
  return `<iframe ${attributes}></iframe>`;
}

/**
 * 「遊ぶ」のボタン（タッチ端末でだけスクリプトが見せる。3.9.4）。
 *
 * **`hidden` で配る。** JavaScript が無い環境とデスクトップでは出ない（押しても何も起きないボタンを出さない。4.4）。
 * スクリーンショットの上に重ねる位置は `public/assets/app.css` の `@section work` が持つ。
 *
 * @returns `<button>` 要素
 */
export function playOpenButton(): string {
  return `<button type="button" class="${SECONDARY_BUTTON} ${PLAY_OPEN_CLASS}" hidden>遊ぶ</button>`;
}

/**
 * 「遊ぶ」の口で包む（スクリーンショットと「遊ぶ」のボタン）。
 *
 * **遊ぶ URL が無い（組み立てられなかった）ときも同じ入れ物で包む**——版面をデータの状態で変えない。ボタンは出さない。
 *
 * @param screenshot スクリーンショット（または固定の文言のパネル）の HTML
 * @param playable 遊ぶ URL があるか
 * @returns HTML
 */
export function playEntry(screenshot: string, playable: boolean): string {
  return `<div class="${PLAY_ENTRY_CLASS}">
${screenshot}${playable ? `\n${playOpenButton()}` : ''}
</div>`;
}

/**
 * パッドのキー 1 つ（`<button>`）。**副のボタンの部品**を使う（仕様 3.9.6 / 2.5.5）。
 *
 * 文字と `code` は表示規則（`src/virtual-pad.ts`）が許可表の値から決めた固定の文字列だが、**埋め込みの安全は埋め込む側で閉じる**
 * （`escapeHtml` を通す）。十字のキーは位置の `class`（`gf-play-pad-up` など）と読み上げの名前を持つ。
 *
 * @param key キー
 * @param position 十字の位置（ボタンなら null）
 * @returns `<button>` 要素
 */
function padKeyHtml(key: PadKey, position: string | null): string {
  const positionClass = position === null ? '' : ` gf-play-pad-${position}`;
  const ariaLabel = key.ariaLabel === null ? '' : ` aria-label="${escapeHtml(key.ariaLabel)}"`;
  return `<button type="button" class="${SECONDARY_BUTTON} ${PLAY_PAD_KEY_CLASS}${positionClass}" ${PLAY_PAD_CODE_ATTRIBUTE}="${escapeHtml(key.code)}"${ariaLabel}>${escapeHtml(key.label)}</button>`;
}

/**
 * パッドの 2 つの置き場所（十字・ボタン）の HTML（仕様 3.9.6）。
 *
 * **キーが無い置き場所は中を空のまま置く**（空白も入れない。`public/assets/app.css` の `:empty` で余白を持たせない）。
 * 表示規則の結果が両方とも空なら、パッドは出ず、ゲームが覆いの全体を使う。
 *
 * @param layout パッドの中身
 * @returns HTML
 */
export function padKeysHtml(layout: PadLayout): string {
  const dpad = layout.dpad.map((key) => padKeyHtml(key, key.direction)).join('');
  const buttons = layout.buttons.map((key) => padKeyHtml(key, null)).join('');
  return `<div class="${PLAY_PAD_CLASS} ${PLAY_PAD_DPAD_CLASS}">${dpad}</div>
<div class="${PLAY_PAD_CLASS} ${PLAY_PAD_BUTTONS_CLASS}">${buttons}</div>`;
}

/**
 * 全画面の覆いの骨組み（3.9.4）。**`hidden` で配り、タッチ端末でタップしたときにだけ開く。**
 *
 * 並べ方（縦持ちは上に閉じる・中にゲーム・下にパッド、横持ちは左に十字・中央にゲーム・右にボタンと右上に閉じる）は
 * `public/assets/app.css` の `@section work` が `@media (orientation: …)` で決める。パッドの中身は {@link padKeysHtml}
 * （M14-5 / #494。3.9.6）。
 *
 * @param layout パッドの中身
 * @returns HTML
 */
function playOverlay(layout: PadLayout): string {
  return `<div class="${PLAY_OVERLAY_CLASS}" role="dialog" aria-modal="true" aria-label="ゲーム" hidden>
<div class="gf-play-bar"><button type="button" class="${SECONDARY_BUTTON} ${PLAY_CLOSE_CLASS}">閉じる</button></div>
<div class="${PLAY_STAGE_CLASS}"></div>
${padKeysHtml(layout)}
</div>`;
}

/**
 * 値を `<script>` の中の JavaScript のリテラルにする（`</script>` で閉じられないよう `<` を逃がす）。
 *
 * @param value 値
 * @returns リテラル
 */
function literal(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}

/**
 * iframe を作り、覆いを開閉するスクリプト（3.9.4）。
 *
 * **判定・作る・開く・閉じる**をこの 1 枚に置く。
 *
 * - **判定は 1 回だけ**（`matchMedia('(pointer: coarse)')`）。`pointer: coarse` でなければ、今と同じ位置
 *   （`<noscript>` の直前）に iframe を作って終わる。覆いの部品が 1 つでも欠けていても同じ（遊べない形に倒さない）
 * - **開く**: 口（スクリーンショットと「遊ぶ」のボタン）のクリックで、覆いの中に iframe を作り、覆いを見せ、
 *   `history.pushState` で 1 つ積み、**同じタップの処理の中で**覆いの要素に `requestFullscreen()` を呼ぶ（呼べる環境だけ。
 *   断られても覆いだけで続ける）
 * - **閉じる**: 「閉じる」のボタン・戻る操作（`popstate`）・全画面の解除（`fullscreenchange`）・iframe の 2 回目の `load`
 *   （遷移した。3.9.7）を、**何度呼んでも 1 回と同じ結果になる 1 つの処理**に集める。パッドの「すべて離す」を送る場所
 *   （`releasePad`）を通ってから iframe を取り除く。ボタン・全画面の解除・遷移で閉じたときは、
 *   積んだ履歴を `history.back()` で戻す（その `popstate` は数えて読み飛ばし、届くまでは開き直しを受け付けない）
 * - **焦点**: 開くと「閉じる」へ、閉じると「遊ぶ」へ移す
 * - **パッド**（M14-5 / #494）: 覆いの中の `.gf-play-pad-key` のボタンに pointer events を付け、その iframe から起動の合図を
 *   受けた後だけ `postMessage` で送る（モジュール冒頭の「仮想パッド」）
 *
 * @param playUrl 遊ぶ URL
 * @returns `<script>` 要素
 */
export function playFrameScript(playUrl: string): string {
  return `<script>
(function () {
  var attributes = ${literal(playFrameAttributes(playUrl))};
  var noscript = document.querySelector(${literal(`noscript.${PLAY_NOSCRIPT_CLASS}`)});
  if (noscript === null || noscript.parentNode === null) { return; }
  // **属性は配列の順に、差し込む前にすべて付ける**（差し込むまで読み込みは始まらない）。
  var createFrame = function () {
    var created = document.createElement('iframe');
    for (var index = 0; index < attributes.length; index += 1) {
      created.setAttribute(attributes[index][0], attributes[index][1]);
    }
    return created;
  };
  var overlay = document.querySelector(${literal(`.${PLAY_OVERLAY_CLASS}`)});
  var entry = document.querySelector(${literal(`.${PLAY_ENTRY_CLASS}`)});
  var openButton = document.querySelector(${literal(`.${PLAY_OPEN_CLASS}`)});
  var closeButton = document.querySelector(${literal(`.${PLAY_CLOSE_CLASS}`)});
  var stage = document.querySelector(${literal(`.${PLAY_STAGE_CLASS}`)});
  // **判定は開いた時点で 1 回だけ。幅では判定しない**（仕様 3.9.4）。
  var coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  if (!coarse || overlay === null || entry === null || openButton === null || closeButton === null || stage === null) {
    noscript.parentNode.insertBefore(createFrame(), noscript);
    return;
  }
  var root = document.documentElement;
  var frame = null;
  var loads = 0;
  var pushed = false;
  var skipPops = 0;
  var skipTimer = null;
  // ── 仮想パッド（M14-5 / #494 / 仕様 3.9.6 / 3.9.7）──────────────────────────
  // **送ってよい iframe**（その iframe から起動の合図を受けた）。遷移（2 回目の load）と閉じるで null に戻す。
  var padFrame = null;
  var padKeys = overlay.querySelectorAll(${literal(`.${PLAY_PAD_KEY_CLASS}`)});
  var padCodes = [];
  var padHeld = [];
  var padPointers = [];
  // **宛先は '*'**（子は不透明オリジンで、宛先に指定する綴りが無い）。確認は受け手（ローダー）が行う。
  var postPad = function (target, message) {
    if (target === null || padFrame !== target || target.contentWindow === null) { return; }
    try { target.contentWindow.postMessage(message, '*'); } catch (error) {}
  };
  var sendPad = function (op, code) {
    postPad(frame, { type: ${literal(PAD_MESSAGE_TYPE)}, op: op, code: code });
  };
  // **パッドの「すべて離す」**（仕様 3.9.4 / 3.9.6）。押しているボタンをすべて離した扱いにし、release を 1 回送る。
  var releasePad = function (target) {
    for (var index = 0; index < padKeys.length; index += 1) {
      padHeld[index] = false;
      padKeys[index].classList.remove(${literal(PLAY_PAD_HELD_CLASS)});
    }
    postPad(target, { type: ${literal(PAD_MESSAGE_TYPE)}, op: 'release' });
  };
  var liftPad = function (index) {
    if (!padHeld[index]) { return; }
    padHeld[index] = false;
    padKeys[index].classList.remove(${literal(PLAY_PAD_HELD_CLASS)});
    sendPad('up', padCodes[index]);
  };
  var bindPadKey = function (button, index) {
    padCodes[index] = button.getAttribute(${literal(PLAY_PAD_CODE_ATTRIBUTE)});
    padHeld[index] = false;
    padPointers[index] = null;
    button.addEventListener('pointerdown', function (event) {
      // **フォーカスを親の文書へ移さない**（移ると canvas の blur で、Ebitengine が押しているキーをすべて離す）。
      event.preventDefault();
      if (padHeld[index]) { return; }
      try { button.setPointerCapture(event.pointerId); } catch (error) {}
      padHeld[index] = true;
      padPointers[index] = event.pointerId;
      button.classList.add(${literal(PLAY_PAD_HELD_CLASS)});
      sendPad('down', padCodes[index]);
    });
    var lift = function (event) {
      if (padHeld[index] && event.pointerId === padPointers[index]) { liftPad(index); }
    };
    button.addEventListener('pointerup', lift);
    button.addEventListener('pointercancel', lift);
    button.addEventListener('lostpointercapture', lift);
    // **キーボードや支援技術で押されたとき**（pointer events が来ない）は、押下と離しを続けて送る。
    button.addEventListener('click', function (event) {
      if (event.detail !== 0 || padHeld[index]) { return; }
      sendPad('down', padCodes[index]);
      sendPad('up', padCodes[index]);
    });
  };
  for (var padIndex = 0; padIndex < padKeys.length; padIndex += 1) {
    bindPadKey(padKeys[padIndex], padIndex);
  }
  var pads = overlay.querySelectorAll(${literal(`.${PLAY_PAD_CLASS}`)});
  for (var padsIndex = 0; padsIndex < pads.length; padsIndex += 1) {
    // 長押しのメニューを出さない（仕様 3.9.6）。
    pads[padsIndex].addEventListener('contextmenu', function (event) { event.preventDefault(); });
  }
  // **送り始めるのは、その iframe から起動の合図を受けた後**（仕様 3.9.7）。検査は計上のスクリプト（src/plays.ts）と同じ規律で、
  // 自分の iframe の窓から届いた固定の文字列だけを受ける。
  window.addEventListener('message', function (event) {
    if (frame === null || event.source !== frame.contentWindow || event.origin !== 'null') { return; }
    if (event.data !== ${literal(LOADER_STARTED_MESSAGE)}) { return; }
    padFrame = frame;
  });
  // **押したまま画面が隠れたとき**も、すべて離す（仕様 3.9.6）。
  var releaseOnHide = function () {
    if (frame !== null) { releasePad(frame); }
  };
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { releaseOnHide(); }
  });
  window.addEventListener('pagehide', releaseOnHide);
  window.addEventListener('blur', releaseOnHide);
  var close = function (fromHistory) {
    if (frame === null) { return; }
    var closing = frame;
    frame = null;
    releasePad(closing);
    padFrame = null;
    if (closing.parentNode !== null) { closing.parentNode.removeChild(closing); }
    overlay.hidden = true;
    root.classList.remove(${literal(PLAY_LOCKED_CLASS)});
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      var exiting = document.exitFullscreen();
      if (exiting && typeof exiting.catch === 'function') { exiting.catch(function () {}); }
    }
    if (pushed) {
      pushed = false;
      if (!fromHistory) {
        // **戻りが決着する（その popstate が届く）まで、開き直しを受け付けない**（open の冒頭。PR #508 の Copilot の指摘）。
        // 決着の前に開き直すと、新しく積んだ状態と古い popstate の順序がブラウザしだいになり、覆いと履歴が食い違う。
        // 回ごとの印で popstate を結び付ける形は採らなかった——戻りと pushState の処理順が決まらないので、印を見ても
        // 「新しい回を閉じるべきか」を決められない。**popstate が来ない環境で開けなくなったままにしない**よう、上限で解く。
        skipPops += 1;
        if (skipTimer !== null) { clearTimeout(skipTimer); }
        skipTimer = setTimeout(function () {
          skipPops = 0;
          skipTimer = null;
        }, ${PLAY_BACK_SETTLE_LIMIT_MS});
        history.back();
      }
    }
    try { openButton.focus({ preventScroll: true }); } catch (error) {}
  };
  var open = function () {
    if (frame !== null || skipPops > 0) { return; }
    var opened = createFrame();
    frame = opened;
    loads = 0;
    // **2 回目の load は遷移である**（最初の load はローダーの文書。仕様 3.9.7）。
    opened.addEventListener('load', function () {
      if (opened !== frame) { return; }
      loads += 1;
      // **遷移した先へパッドを送らない**（仕様 3.9.7）。送信を止めてから閉じる（閉じる処理の release も送らない）。
      if (loads >= 2) {
        padFrame = null;
        close(false);
      }
    });
    stage.appendChild(opened);
    overlay.hidden = false;
    root.classList.add(${literal(PLAY_LOCKED_CLASS)});
    // **焦点を覆いの中（「閉じる」）へ移す**（role="dialog" / aria-modal。PR #508 の Copilot の指摘）。閉じると「遊ぶ」へ戻す。
    // 焦点を移しても利用者の操作による起動は消えないので、下の requestFullscreen() は同じタップの処理の中のままである。
    try { closeButton.focus({ preventScroll: true }); } catch (error) {}
    try {
      history.pushState({ ${PLAY_HISTORY_STATE_KEY}: true }, '');
      pushed = true;
    } catch (error) {
      pushed = false;
    }
    // **全画面は重ねるだけで、頼らない。** 呼べない・断られたときは覆いだけで続ける（仕様 3.9.4）。
    if (typeof overlay.requestFullscreen === 'function') {
      try {
        var entering = overlay.requestFullscreen();
        if (entering && typeof entering.catch === 'function') { entering.catch(function () {}); }
      } catch (error) {}
    }
  };
  entry.addEventListener('click', function () { open(); });
  closeButton.addEventListener('click', function () { close(false); });
  window.addEventListener('popstate', function () {
    if (skipPops > 0) {
      skipPops -= 1;
      if (skipPops === 0 && skipTimer !== null) {
        clearTimeout(skipTimer);
        skipTimer = null;
      }
      return;
    }
    close(true);
  });
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) {
      close(false);
    } else if (document.fullscreenElement === overlay && frame === null && typeof document.exitFullscreen === 'function') {
      // 全画面に入る前に閉じていた（要求の決着より先に閉じた）。隠れた覆いを全画面に残さない。
      var leaving = document.exitFullscreen();
      if (leaving && typeof leaving.catch === 'function') { leaving.catch(function () {}); }
    }
  });
  entry.classList.add(${literal(PLAY_ENTRY_TOUCH_CLASS)});
  openButton.hidden = false;
})();
</script>`;
}

/**
 * ゲームの埋め込み一式（`<noscript>` の今の埋め込み・覆いの骨組み・スクリプト）。
 *
 * **並びに意味がある。** 計上のスクリプト（#377）はこの前に置く（合図より先にリスナーを登録する）。
 * デスクトップの iframe は `<noscript>` の直前に作られるので、計上のスクリプトの直後——今の iframe と同じ位置——に入る。
 *
 * @param playUrl 遊ぶ URL
 * @param inputKeyCodes 作品が読むキーの集合（許可表で絞った値。`src/virtual-pad.ts` の `readInputKeyCodes`）。パッドの中身を決める
 * @returns HTML
 */
export function playEmbed(playUrl: string, inputKeyCodes: readonly string[]): string {
  return `<noscript class="${PLAY_NOSCRIPT_CLASS}">${playFrameHtml(playUrl)}</noscript>
${playOverlay(padLayoutOf(inputKeyCodes))}
${playFrameScript(playUrl)}`;
}
