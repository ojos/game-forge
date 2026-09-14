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
 * # このモジュールは画面の文字列だけを持つ
 *
 * 文言は固定で、**UGC を含まない。** 遊ぶ URL は配信側が組み立てた値で、HTML へは `escapeHtml` を通して入れる。
 * スクリプトはビルド工程を通らずそのままブラウザへ届く（`src/plays.ts` と同じ）ので、素朴な書き方（`var` と関数式）に寄せる。
 */
import { escapeHtml } from './html.js';

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
 * 全画面の覆いの骨組み（3.9.4）。**`hidden` で配り、タッチ端末でタップしたときにだけ開く。**
 *
 * 並べ方（縦持ちは上に閉じる・中にゲーム・下にパッド、横持ちは左に十字・中央にゲーム・右にボタンと右上に閉じる）は
 * `public/assets/app.css` の `@section work` が `@media (orientation: …)` で決める。**パッドの置き場所は空のまま置く**
 * （中身と送信は M14-5 / #494。3.9.6）。空のあいだはゲームが残りを使う。
 *
 * @returns HTML
 */
function playOverlay(): string {
  return `<div class="${PLAY_OVERLAY_CLASS}" role="dialog" aria-modal="true" aria-label="ゲーム" hidden>
<div class="gf-play-bar"><button type="button" class="${SECONDARY_BUTTON} ${PLAY_CLOSE_CLASS}">閉じる</button></div>
<div class="${PLAY_STAGE_CLASS}"></div>
<div class="gf-play-pad gf-play-pad-dpad"></div>
<div class="gf-play-pad gf-play-pad-buttons"></div>
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
 *   （`releasePad`。中身は M14-5）を通ってから iframe を取り除く。ボタン・全画面の解除・遷移で閉じたときは、
 *   積んだ履歴を `history.back()` で戻す（その `popstate` は数えて読み飛ばす）
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
  // **パッドの「すべて離す」を送る場所**（仕様 3.9.4 / 3.9.6。中身は M14-5 / #494 が入れる）。
  var releasePad = function (target) {
    void target;
  };
  var close = function (fromHistory) {
    if (frame === null) { return; }
    var closing = frame;
    frame = null;
    releasePad(closing);
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
        skipPops += 1;
        history.back();
      }
    }
    try { openButton.focus({ preventScroll: true }); } catch (error) {}
  };
  var open = function () {
    if (frame !== null) { return; }
    var opened = createFrame();
    frame = opened;
    loads = 0;
    // **2 回目の load は遷移である**（最初の load はローダーの文書。仕様 3.9.7）。
    opened.addEventListener('load', function () {
      if (opened !== frame) { return; }
      loads += 1;
      if (loads >= 2) { close(false); }
    });
    stage.appendChild(opened);
    overlay.hidden = false;
    root.classList.add(${literal(PLAY_LOCKED_CLASS)});
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
 * @returns HTML
 */
export function playEmbed(playUrl: string): string {
  return `<noscript class="${PLAY_NOSCRIPT_CLASS}">${playFrameHtml(playUrl)}</noscript>
${playOverlay()}
${playFrameScript(playUrl)}`;
}
