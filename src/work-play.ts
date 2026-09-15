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
 * - **すべて離す**: `visibilitychange`（`hidden`）・`pagehide`・`window` の `blur` と、覆いを閉じるとき（`releasePad`）。
 *   **`blur` は、フォーカスの行き先が自分のゲームの iframe なら離さない**（押したままゲームをタップする操作を壊さない）。
 *   **閉じるときの release は、直後に iframe を取り除くので作品へは届かない**（実測）。押したまま閉じたときの keyup は、取り除かれた
 *   ローダー自身の `pagehide`（`src/sandbox-loader.ts` の `padReceiverScript`）が送る。親の release が効くのは iframe を残す場面である
 * - **送信**: `iframe.contentWindow.postMessage({ type: 'gf-pad', op, code }, '*')`。宛先は `'*'` で、確認は受け手
 *   （`src/sandbox-loader.ts` の `padReceiverScript`）が行う。**送り始めるのは、その iframe から起動の合図を受けた後**
 *   （検査は `src/plays.ts` と同じ `event.source === frame.contentWindow`）。**2 回目の `load`（遷移）の後は送らない**
 *
 * # 方向の操作の形: スティックと十字（#530 / 仕様 3.9.6 の「方向の操作の形」）
 *
 * **2 つの形の中身を両方とも HTML に置き、推定した形でない方を `hidden` で配る**（{@link padKeysHtml}。推定は `src/virtual-pad.ts` の `padPlanOf`）。
 *
 * - **スティック**: 置き場所の全体が受け付ける範囲で、触れた位置が中心になる（フローティング）。倒した向きから押しているキーの集合を
 *   `STICK_KEYS_SOURCE`（`src/virtual-pad.ts`。埋め込む本文は 1 つだけ）で決め、**集合が変わったときだけ、外れたキーの `up` を先に、加わったキーの
 *   `down` を後に**送る。離すと押しているキーをすべて `up` する。すべて離す（上の契機）ではスティックの指も忘れる
 * - **切り替え**: 上の行の控えめのボタン。**覚えた形（作品 id ごとの `localStorage`）は推定より優先**し、読み書きに失敗する環境では推定した形で出す。
 *   押しているキーを離してから形を変える
 *
 * # このモジュールは画面の文字列だけを持つ
 *
 * 文言は固定で、**UGC を含まない。** 遊ぶ URL は配信側が組み立てた値で、HTML へは `escapeHtml` を通して入れる。
 * スクリプトはビルド工程を通らずそのままブラウザへ届く（`src/plays.ts` と同じ）ので、素朴な書き方（`var` と関数式）に寄せる。
 */
import { escapeHtml } from './html.js';
import { LOADER_STARTED_MESSAGE, PAD_MESSAGE_TYPE } from './sandbox-loader.js';
import type { PadKey, PadPlan, PadShape, PadStick } from './virtual-pad.js';
import { PAD_STICK_DEAD_ZONE_RATIO, PAD_STICK_RADIUS_PX, STICK_KEYS_SOURCE, padPlanOf } from './virtual-pad.js';

/** 副のボタンの部品（仕様 2.5.5）。**主は作品ページの「フォークする」のまま**で、ここは副と控えめだけを使う。 */
const SECONDARY_BUTTON = 'gf-button gf-button-secondary';

/** 控えめのボタンの部品（仕様 2.5.5）。方向の操作の形の切り替え（#528 / #530）に使う。 */
const TERTIARY_BUTTON = 'gf-button gf-button-tertiary';

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

/** パッドのスティックの置き場所（受け付ける範囲）の `class`（#530 / 仕様 3.9.6 の「スティックの振る舞い」）。 */
export const PLAY_PAD_STICK_CLASS = 'gf-play-pad-stick';

/** スティックの中心の円の `class`（触れているあいだだけ見せる）。 */
export const PLAY_PAD_STICK_RING_CLASS = 'gf-play-stick-ring';

/** スティックのつまみの `class`（円の中に置く）。 */
export const PLAY_PAD_STICK_KNOB_CLASS = 'gf-play-stick-knob';

/**
 * スティックが受け付ける方向の `code` を持つ属性の接頭辞（`data-stick-up` など）。**受け付けない方向は属性を持たない。**
 */
export const PLAY_PAD_STICK_ATTRIBUTE_PREFIX = 'data-stick-';

/** 方向の操作の形を切り替えるボタンの `class`（部品のクラスの後ろに足す）。 */
export const PLAY_PAD_TOGGLE_CLASS = 'gf-play-pad-toggle';

/** 覆いに付ける、推定した最初の形（`stick` / `dpad`）の属性。方向の操作が無い作品では付けない。 */
export const PLAY_PAD_SHAPE_ATTRIBUTE = 'data-pad-shape';

/** 覆いに付ける、覚えた形の `localStorage` のキーの属性（作品 id ごと）。 */
export const PLAY_PAD_MEMORY_ATTRIBUTE = 'data-pad-memory';

/** 覚えた形の `localStorage` のキーの接頭辞（後ろに作品 id）。 */
export const PLAY_PAD_MEMORY_PREFIX = 'gf-pad-shape:';

/** ボタンを片方の形でだけ出すときの属性（値は `stick` / `dpad`）。両方の形で出すボタンは持たない。 */
export const PLAY_PAD_ONLY_ATTRIBUTE = 'data-pad-only';

/**
 * 切り替えのボタンの文言の `<span>` に付ける、その文言を出す形の属性（値は `stick` / `dpad`）。
 *
 * **2 つの文言を両方とも HTML に置き、今の形でない方を `hidden` にする**——作品ページのスクリプトは画面の文字を書き換える口
 * （`textContent` など）を持たない（`test/loading-screen.test.ts` が見る）ので、見せ方を入れ替えるだけにする。
 */
export const PLAY_PAD_LABEL_ATTRIBUTE = 'data-pad-label';

/** 切り替えのボタンの文言（**今と逆の形の名前**。仕様 3.9.6 の「手動の切り替え」。固定の文言）。形ごとに、その形のときに出す文言。 */
export const PLAY_PAD_TOGGLE_LABELS: Readonly<Record<PadShape, string>> = { stick: '十字にする', dpad: 'スティックにする' };

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
function padKeyHtml(key: PadKey, position: string | null, only: { shape: PadShape; hidden: boolean } | null = null): string {
  const positionClass = position === null ? '' : ` gf-play-pad-${position}`;
  const ariaLabel = key.ariaLabel === null ? '' : ` aria-label="${escapeHtml(key.ariaLabel)}"`;
  const onlyAttribute = only === null ? '' : ` ${PLAY_PAD_ONLY_ATTRIBUTE}="${only.shape}"${only.hidden ? ' hidden' : ''}`;
  return `<button type="button" class="${SECONDARY_BUTTON} ${PLAY_PAD_KEY_CLASS}${positionClass}" ${PLAY_PAD_CODE_ATTRIBUTE}="${escapeHtml(key.code)}"${ariaLabel}${onlyAttribute}>${escapeHtml(key.label)}</button>`;
}

/**
 * スティックの置き場所の HTML（#530 / 仕様 3.9.6 の「スティックの振る舞い」）。
 *
 * **受け付ける方向の `code` を属性に持つ**（受け付けない方向は属性を持たない。スクリプトはこれを読むだけ）。中身は、触れているあいだだけ
 * 見せる中心の円（`hidden` で配る）とつまみで、**待機中は何も描かない。**
 *
 * @param stick 受け付ける方向
 * @param hidden 最初は隠すか（推定した形が十字なら隠す）
 * @returns HTML
 */
function padStickHtml(stick: PadStick, hidden: boolean): string {
  const attributes = (['up', 'down', 'left', 'right'] as const)
    .map((direction) => {
      const code = stick[direction];
      return code === null ? '' : ` ${PLAY_PAD_STICK_ATTRIBUTE_PREFIX}${direction}="${escapeHtml(code)}"`;
    })
    .join('');
  return `<div class="${PLAY_PAD_CLASS} ${PLAY_PAD_STICK_CLASS}"${attributes}${hidden ? ' hidden' : ''}><div class="${PLAY_PAD_STICK_RING_CLASS}" hidden><div class="${PLAY_PAD_STICK_KNOB_CLASS}"></div></div></div>`;
}

/**
 * パッドの置き場所（十字・スティック・ボタン）の HTML（仕様 3.9.6）。
 *
 * **2 つの形の中身を両方とも置き、推定した形でない方を `hidden` にする**（スクリプトは覚えた形があれば見せ方を入れ替えるだけで、
 * ボタンを作らない）。十字とスティックは同じ置き場所（左）を使い、ボタンは 2 つの形の和を 1 つの置き場所に並べて、片方の形でだけ出す
 * ボタンに `data-pad-only` を付ける。
 *
 * **キーが無い置き場所は中を空のまま置く**（空白も入れない。`public/assets/app.css` の `:empty` で余白を持たせない）。
 * 方向キーを読まない作品にはスティックの置き場所を置かない。表示規則の結果が空なら、パッドは出ず、ゲームが覆いの全体を使う。
 *
 * @param plan パッドの計画（`src/virtual-pad.ts` の `padPlanOf`）
 * @returns HTML
 */
export function padKeysHtml(plan: PadPlan): string {
  const shape = plan.estimated;
  const dpad = plan.dpad.map((key) => padKeyHtml(key, key.direction)).join('');
  const buttons = plan.buttons
    .map((key) => padKeyHtml(key, null, key.only === null ? null : { shape: key.only, hidden: key.only !== shape }))
    .join('');
  // 推定した形で出すボタンが 1 つも無い（もう一方の形でだけ出すボタンがある）なら、置き場所ごと隠す（余白を持たせない）。
  const buttonsHidden = plan.buttons.length > 0 && plan.buttons.every((key) => key.only !== null && key.only !== shape);
  const stick = plan.stick === null ? '' : `
${padStickHtml(plan.stick, shape !== 'stick')}`;
  return `<div class="${PLAY_PAD_CLASS} ${PLAY_PAD_DPAD_CLASS}"${shape === 'stick' ? ' hidden' : ''}>${dpad}</div>${stick}
<div class="${PLAY_PAD_CLASS} ${PLAY_PAD_BUTTONS_CLASS}"${buttonsHidden ? ' hidden' : ''}>${buttons}</div>`;
}

/**
 * 方向の操作の形を切り替えるボタン（#530 / 仕様 3.9.6 の「手動の切り替え」）。**控えめのボタン**で、文言は今と逆の形の名前（固定）。
 *
 * @param estimated 推定した最初の形
 * @returns `<button>` 要素
 */
function padToggleHtml(estimated: PadShape): string {
  const labels = (['stick', 'dpad'] as const)
    .map((shape) => `<span ${PLAY_PAD_LABEL_ATTRIBUTE}="${shape}"${shape === estimated ? '' : ' hidden'}>${PLAY_PAD_TOGGLE_LABELS[shape]}</span>`)
    .join('');
  return `<button type="button" class="${TERTIARY_BUTTON} ${PLAY_PAD_TOGGLE_CLASS}">${labels}</button>`;
}

/**
 * 全画面の覆いの骨組み（3.9.4）。**`hidden` で配り、タッチ端末でタップしたときにだけ開く。**
 *
 * 並べ方（縦持ちは上に閉じる・中にゲーム・下にパッド、横持ちは左に十字・中央にゲーム・右にボタンと右上に閉じる）は
 * `public/assets/app.css` の `@section work` が `@media (orientation: …)` で決める。パッドの中身は {@link padKeysHtml}
 * （M14-5 / #494。3.9.6）。
 *
 * **方向の操作がある作品では**、覆いに推定した形（`data-pad-shape`）と覚えた形のキー（`data-pad-memory`。作品 id ごと）を持たせ、
 * 上の行の「閉じる」の隣（前）に切り替えのボタンを置く（#530）。
 *
 * @param plan パッドの計画
 * @param workId 作品 id（覚えた形のキーに使う）
 * @returns HTML
 */
function playOverlay(plan: PadPlan, workId: string): string {
  const shape =
    plan.estimated === null
      ? ''
      : ` ${PLAY_PAD_SHAPE_ATTRIBUTE}="${plan.estimated}" ${PLAY_PAD_MEMORY_ATTRIBUTE}="${escapeHtml(`${PLAY_PAD_MEMORY_PREFIX}${workId}`)}"`;
  const toggle = plan.estimated === null ? '' : padToggleHtml(plan.estimated);
  return `<div class="${PLAY_OVERLAY_CLASS}" role="dialog" aria-modal="true" aria-label="ゲーム"${shape} hidden>
<div class="gf-play-bar">${toggle}<button type="button" class="${SECONDARY_BUTTON} ${PLAY_CLOSE_CLASS}">閉じる</button></div>
<div class="${PLAY_STAGE_CLASS}"></div>
${padKeysHtml(plan)}
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
  // ── スティック（#530 / 仕様 3.9.6 の「スティックの振る舞い」）────────────────────────
  // 受け付ける方向の code は置き場所の属性が持つ（受け付けない方向は null）。**方向の決め方の本文は src/virtual-pad.ts の 1 つだけ。**
  var stickArea = overlay.querySelector(${literal(`.${PLAY_PAD_STICK_CLASS}`)});
  var stickRing = stickArea === null ? null : stickArea.querySelector(${literal(`.${PLAY_PAD_STICK_RING_CLASS}`)});
  var stickKnob = stickArea === null ? null : stickArea.querySelector(${literal(`.${PLAY_PAD_STICK_KNOB_CLASS}`)});
  var stickKeysOf = ${STICK_KEYS_SOURCE};
  var stickRadius = ${literal(PAD_STICK_RADIUS_PX)};
  var stickDeadZone = ${literal(PAD_STICK_DEAD_ZONE_RATIO)};
  var stickPointer = null;
  var stickCenterX = 0;
  var stickCenterY = 0;
  var stickHeld = [];
  // **押している方向のキーの集合が変わったときだけ送る。外れたキーの up を先に、加わったキーの down を後に**（仕様 3.9.6 の「送り方」）。
  var setStickKeys = function (next) {
    var index;
    for (index = 0; index < stickHeld.length; index += 1) {
      if (next.indexOf(stickHeld[index]) === -1) { sendPad('up', stickHeld[index]); }
    }
    for (index = 0; index < next.length; index += 1) {
      if (stickHeld.indexOf(next[index]) === -1) { sendPad('down', next[index]); }
    }
    stickHeld = next;
  };
  // 指を忘れ、円を隠す（キーは送らない。送るのは呼ぶ側）。**忘れた指の後の pointermove / pointerup は何も送らない。**
  var dropStick = function () {
    stickPointer = null;
    stickHeld = [];
    if (stickRing !== null) { stickRing.hidden = true; }
  };
  // **パッドの「すべて離す」**（仕様 3.9.4 / 3.9.6）。押しているボタンとスティックをすべて離した扱いにし、release を 1 回送る。
  var releasePad = function (target) {
    for (var index = 0; index < padKeys.length; index += 1) {
      padHeld[index] = false;
      padKeys[index].classList.remove(${literal(PLAY_PAD_HELD_CLASS)});
    }
    dropStick();
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
  if (stickArea !== null && stickRing !== null && stickKnob !== null) {
    var stickCodes = {
      up: stickArea.getAttribute(${literal(`${PLAY_PAD_STICK_ATTRIBUTE_PREFIX}up`)}),
      down: stickArea.getAttribute(${literal(`${PLAY_PAD_STICK_ATTRIBUTE_PREFIX}down`)}),
      left: stickArea.getAttribute(${literal(`${PLAY_PAD_STICK_ATTRIBUTE_PREFIX}left`)}),
      right: stickArea.getAttribute(${literal(`${PLAY_PAD_STICK_ATTRIBUTE_PREFIX}right`)})
    };
    stickRing.style.width = (stickRadius * 2) + 'px';
    stickRing.style.height = (stickRadius * 2) + 'px';
    // **フローティング**: 受け付ける範囲のどこかに触れた位置が中心になる。指が円の外へ出ても中心は動かない（つまみは縁で止める）。
    stickArea.addEventListener('pointerdown', function (event) {
      // フォーカスを親の文書へ移さない（十字のキーと同じ理由）。
      event.preventDefault();
      if (stickPointer !== null) { return; }
      try { stickArea.setPointerCapture(event.pointerId); } catch (error) {}
      var rect = stickArea.getBoundingClientRect();
      stickPointer = event.pointerId;
      stickCenterX = event.clientX;
      stickCenterY = event.clientY;
      stickHeld = [];
      stickRing.style.left = (event.clientX - rect.left) + 'px';
      stickRing.style.top = (event.clientY - rect.top) + 'px';
      stickKnob.style.transform = 'translate(0px, 0px)';
      stickRing.hidden = false;
    });
    stickArea.addEventListener('pointermove', function (event) {
      if (stickPointer === null || event.pointerId !== stickPointer) { return; }
      var dx = event.clientX - stickCenterX;
      var dy = event.clientY - stickCenterY;
      var distance = Math.sqrt(dx * dx + dy * dy);
      var scale = distance > stickRadius ? stickRadius / distance : 1;
      stickKnob.style.transform = 'translate(' + (dx * scale) + 'px, ' + (dy * scale) + 'px)';
      setStickKeys(stickKeysOf(dx, dy, stickRadius, stickDeadZone, stickCodes));
    });
    var liftStick = function (event) {
      if (stickPointer === null || event.pointerId !== stickPointer) { return; }
      setStickKeys([]);
      dropStick();
    };
    stickArea.addEventListener('pointerup', liftStick);
    stickArea.addEventListener('pointercancel', liftStick);
    stickArea.addEventListener('lostpointercapture', liftStick);
  }
  // ── 方向の操作の形（#530 / 仕様 3.9.6 の「手動の切り替え」）────────────────────────────
  // **覚えた形は推定より優先する。** 覚える先は作品 id ごとの localStorage で、読み書きに失敗する環境では覚えないだけで推定した形で出す。
  var padToggle = overlay.querySelector(${literal(`.${PLAY_PAD_TOGGLE_CLASS}`)});
  var padDpadArea = overlay.querySelector(${literal(`.${PLAY_PAD_DPAD_CLASS}`)});
  var padButtonsArea = overlay.querySelector(${literal(`.${PLAY_PAD_BUTTONS_CLASS}`)});
  var padToggleLabels = padToggle === null ? [] : padToggle.querySelectorAll(${literal(`[${PLAY_PAD_LABEL_ATTRIBUTE}]`)});
  var padMemory = overlay.getAttribute(${literal(PLAY_PAD_MEMORY_ATTRIBUTE)});
  var padShape = overlay.getAttribute(${literal(PLAY_PAD_SHAPE_ATTRIBUTE)});
  var applyPadShape = function (shape) {
    padShape = shape;
    stickArea.hidden = shape !== 'stick';
    padDpadArea.hidden = shape !== 'dpad';
    var shown = 0;
    for (var index = 0; index < padKeys.length; index += 1) {
      var only = padKeys[index].getAttribute(${literal(PLAY_PAD_ONLY_ATTRIBUTE)});
      if (only !== null) { padKeys[index].hidden = only !== shape; }
      if (padButtonsArea.contains(padKeys[index]) && !padKeys[index].hidden) { shown += 1; }
    }
    padButtonsArea.hidden = shown === 0 && padButtonsArea.firstChild !== null;
    for (var labelIndex = 0; labelIndex < padToggleLabels.length; labelIndex += 1) {
      padToggleLabels[labelIndex].hidden = padToggleLabels[labelIndex].getAttribute(${literal(PLAY_PAD_LABEL_ATTRIBUTE)}) !== shape;
    }
  };
  if (padToggle !== null && stickArea !== null && padDpadArea !== null && padButtonsArea !== null && padMemory !== null &&
      (padShape === 'stick' || padShape === 'dpad')) {
    var remembered = null;
    try { remembered = window.localStorage.getItem(padMemory); } catch (error) { remembered = null; }
    applyPadShape(remembered === 'stick' || remembered === 'dpad' ? remembered : padShape);
    padToggle.addEventListener('click', function () {
      // 押しているキーを残したまま形を変えない（隠れたボタンやスティックの押下が離れなくなる）。
      releasePad(frame);
      var next = padShape === 'stick' ? 'dpad' : 'stick';
      applyPadShape(next);
      try { window.localStorage.setItem(padMemory, next); } catch (error) {}
    });
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
  // **フォーカスが自分のゲームの iframe へ移っただけなら離さない**（パッドを押したままゲームをタップする操作。PR #524）。
  // blur の時点ではフォーカスの行き先が決まっていないので、決着を待ってから行き先を見る。それ以外（別の要素・別のウィンドウ）は離す。
  window.addEventListener('blur', function () {
    setTimeout(function () {
      if (frame !== null && document.activeElement === frame) { return; }
      releaseOnHide();
    }, 0);
  });
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
 * @param workId 作品 id（覚えた形のキーに使う。#530）
 * @param inputKeyCodes 作品が読むキーの集合（許可表で絞った値。`src/virtual-pad.ts` の `readInputKeyCodes`）。パッドの中身を決める
 * @param inputHeldCodes 押し続けて読むキーの集合（`readHeldCodes`。版 1 の行は null）。最初の形を決める（#530）
 * @param inputAliasGroups 同じ条件式で読むキーの組（`readAliasGroups`。版 2 以下の行は null）。すでにボタンに出るキーと同じ働きの方向を右のボタンに出さない（#543）
 * @returns HTML
 */
export function playEmbed(
  playUrl: string,
  workId: string,
  inputKeyCodes: readonly string[],
  inputHeldCodes: readonly string[] | null,
  inputAliasGroups: readonly (readonly string[])[] | null,
): string {
  return `<noscript class="${PLAY_NOSCRIPT_CLASS}">${playFrameHtml(playUrl)}</noscript>
${playOverlay(padPlanOf(inputKeyCodes, inputHeldCodes, inputAliasGroups), workId)}
${playFrameScript(playUrl)}`;
}
