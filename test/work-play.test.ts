import { describe, expect, it } from 'vitest';
import { playReportScript } from '../src/plays.js';
import { LOADER_STARTED_MESSAGE, PAD_MESSAGE_TYPE } from '../src/sandbox-loader.js';
import { STICK_KEYS_SOURCE, padPlanOf } from '../src/virtual-pad.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import {
  PLAY_ORIENTATION_HINTS,
  PLAY_ORIENTATION_HINT_CLASS,
  PLAY_ORIENTATION_MEMORY_PREFIX,
  PLAY_ORIENTATION_TOGGLE_CLASS,
  PLAY_ORIENTATION_TOGGLE_LABELS,
  playOrientationOf,
  PLAY_CLOSE_CLASS,
  PLAY_ENTRY_CLASS,
  PLAY_ENTRY_TOUCH_CLASS,
  PLAY_HOST_TOUCH_CLASS,
  PLAY_FRAME_CLASS,
  PLAY_LOCKED_CLASS,
  PLAY_NOSCRIPT_CLASS,
  PLAY_OPEN_CLASS,
  PLAY_OVERLAY_CLASS,
  PLAY_PAD_KEY_CLASS,
  PLAY_PAD_MEMORY_PREFIX,
  PLAY_PAD_TOGGLE_CLASS,
  PLAY_PAD_TOGGLE_LABELS,
  PLAY_STAGE_CLASS,
  padKeysHtml,
  playEmbed,
  playEntry,
  playFrameAttributes,
  playFrameHtml,
  playFrameScript,
} from '../src/work-play.js';

/**
 * 作品ページの「遊ぶ」の部分（M14-3 / #502 / 仕様 3.9.4）。
 *
 * # ここで見るもの
 *
 * - **iframe の属性の出どころが 1 か所であること**（`<noscript>` の HTML と、スクリプトが作る iframe の両方が
 *   {@link playFrameAttributes} から来る。3.9.8 の 6）
 * - SSR の骨組み（`<noscript>` の今の埋め込み・「遊ぶ」の口・覆い・ボタンの部品のクラス）
 * - スクリプトの形（判定は `pointer: coarse` の 1 回だけ・iframe を作る箇所は 2 つだけ・閉じる手段が 1 つの処理に集まる）
 *
 * **振る舞いそのもの**（タップの前に読み込まない・開く・閉じる・合図・数え方）は、DOM とタッチの入力が要るので
 * **実ブラウザの検査の層 7**（`scripts/check-sandbox-browser.sh` / `scripts/tap-to-fullscreen-verdict.mjs`）が見る。
 * ここは workerd の中で動くので、スクリプトを実行しない（`src/plays.ts` のスクリプトの検査と同じ流儀）。
 */

const PLAY_URL = 'https://sandbox.example/g/00000000-0000-4000-8000-000000000502/';

/** 作品 id（覚えた形のキーに使う）。 */
const WORK_ID = '00000000-0000-4000-8000-000000000530';

/** キーを読まない作品（パッドを出さない）。 */
const NO_KEYS: readonly string[] = [];

describe('iframe の属性は 1 か所から組み立てる（3.9.4 / 3.9.8 の 6）', () => {
  it('属性は class・src・sandbox・title の 4 つで、sandbox は allow-scripts だけである（7.2）', () => {
    expect(playFrameAttributes(PLAY_URL)).toEqual([
      ['class', 'gf-frame'],
      ['src', PLAY_URL],
      ['sandbox', 'allow-scripts'],
      ['title', 'ゲーム'],
    ]);
  });

  it('<noscript> の HTML は #502 の前の埋め込みと 1 文字も違わない', () => {
    expect(playFrameHtml(PLAY_URL)).toBe(
      `<iframe class="gf-frame" src="${PLAY_URL}" sandbox="allow-scripts" title="ゲーム"></iframe>`,
    );
  });

  it('スクリプトは同じ配列を JSON で持ち、setAttribute だけで iframe を作る（属性の写しを持たない）', () => {
    const script = playFrameScript(PLAY_URL);
    expect(script).toContain(`var attributes = ${JSON.stringify(playFrameAttributes(PLAY_URL))};`);
    expect(script).toContain('created.setAttribute(attributes[index][0], attributes[index][1]);');
    // 属性の名前と値をスクリプトの本文に直接書いていない（配列の外に写しが無い）。
    const withoutArray = script.replace(JSON.stringify(playFrameAttributes(PLAY_URL)), '');
    expect(withoutArray).not.toContain('allow-scripts');
    expect(withoutArray).not.toContain(PLAY_URL);
    expect(withoutArray).not.toMatch(/\.(src|sandbox|title|className)\s*=/u);
    expect(withoutArray).not.toMatch(/setAttribute\(\s*['"]/u);
  });

  it('全画面を iframe に許さない（allowfullscreen も allow も足さない。3.9.8 の 6）', () => {
    const embed = playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null);
    expect(embed).not.toContain('allowfullscreen');
    expect(embed).not.toMatch(/\sallow=/u);
    expect(embed).not.toContain('allow-same-origin');
    // 全画面を求めるのは覆いの要素である。
    expect(playFrameScript(PLAY_URL)).toContain('overlay.requestFullscreen()');
    expect(playFrameScript(PLAY_URL)).not.toMatch(/(frame|opened|created)\.requestFullscreen/u);
  });

  it('計上のスクリプト（#377）が引く iframe の class と、作る iframe の class が同じである', () => {
    expect(playReportScript('00000000-0000-4000-8000-000000000502')).toContain(
      `document.querySelector('iframe.${PLAY_FRAME_CLASS}')`,
    );
    expect(playFrameAttributes(PLAY_URL)).toContainEqual(['class', PLAY_FRAME_CLASS]);
  });

  it('遊ぶ URL は属性として逃がして入れる（引用符で属性を閉じられない）', () => {
    expect(playFrameHtml('https://sandbox.example/g/"><script>/')).toContain('src="https://sandbox.example/g/&quot;&gt;&lt;script&gt;/"');
    expect(playFrameScript('https://sandbox.example/g/</script>/')).not.toContain('</script>/');
  });
});

describe('SSR の骨組み（3.9.4）', () => {
  it('iframe は <noscript> の中にだけあり、HTML に直接置かない', () => {
    const embed = playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null);
    expect(embed.startsWith(`<noscript class="${PLAY_NOSCRIPT_CLASS}">${playFrameHtml(PLAY_URL)}</noscript>\n`)).toBe(true);
    expect(embed.split('<iframe').length - 1).toBe(1);
  });

  it('覆いは hidden で配り、中にゲームの領域・閉じるのボタン・パッドの置き場所を持つ（キーを読まない作品では空）', () => {
    const embed = playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null);
    expect(embed).toContain(`<div class="${PLAY_OVERLAY_CLASS}" role="dialog" aria-modal="true" aria-label="ゲーム" hidden>`);
    expect(embed).toContain(`<div class="${PLAY_STAGE_CLASS}"></div>`);
    expect(embed).toContain(`<button type="button" class="gf-button gf-button-secondary ${PLAY_CLOSE_CLASS}">閉じる</button>`);
    // キーを読まない作品（モグラぽん）では、置き場所は空白も持たない（`:empty` で余白を持たせない。#494）。
    expect(embed).toContain('<div class="gf-play-pad gf-play-pad-dpad"></div>');
    expect(embed).toContain('<div class="gf-play-pad gf-play-pad-buttons"></div>');
    // 覆いの後ろにスクリプトがある（スクリプトの時点で覆いの要素が引ける）。
    expect(embed.indexOf(PLAY_OVERLAY_CLASS)).toBeLessThan(embed.indexOf('<script>'));
  });

  it('「遊ぶ」の口はスクリーンショットを包み、副のボタンを hidden で重ねる。遊ぶ URL が無ければボタンを出さない', () => {
    const shot = '<img class="gf-shot" src="/ogp/x.png" width="1200" height="630" alt="この作品の画面">';
    expect(playEntry(shot, true)).toBe(
      `<div class="${PLAY_ENTRY_CLASS}">\n${shot}\n<button type="button" class="gf-button gf-button-secondary ${PLAY_OPEN_CLASS}" hidden>遊ぶ</button>\n</div>`,
    );
    expect(playEntry(shot, false)).toBe(`<div class="${PLAY_ENTRY_CLASS}">\n${shot}\n</div>`);
  });

  it('足したボタンの文言は固定で、主のボタンを使わない（主は「改造する」のまま。2.5.5）', () => {
    const html = `${playEntry('', true)}${playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null)}`;
    expect(html).not.toContain('gf-button-primary');
    expect(html.match(/<button\b[^>]*>([^<]*)<\/button>/gu)).toEqual([
      `<button type="button" class="gf-button gf-button-secondary ${PLAY_OPEN_CLASS}" hidden>遊ぶ</button>`,
      `<button type="button" class="gf-button gf-button-secondary ${PLAY_CLOSE_CLASS}">閉じる</button>`,
    ]);
  });
});

describe('スクリプトの形（3.9.4）', () => {
  const script = playFrameScript(PLAY_URL);

  it('判定は matchMedia の pointer: coarse を 1 回だけ見て、幅では判定しない', () => {
    expect(script.split("matchMedia('(pointer: coarse)')").length - 1).toBe(1);
    expect(script).toContain("window.matchMedia('(pointer: coarse)').matches");
    expect(script).not.toMatch(/innerWidth|clientWidth|screen\.width|min-width|max-width/u);
    // ほかの matchMedia は、向きの案内（#514）で今の画面の向きを見る 1 つだけで、タッチ端末の判定には使わない。
    expect(script.split('matchMedia(').length - 1).toBe(2);
    expect(script.indexOf("window.matchMedia('(orientation: portrait)')")).toBeGreaterThan(script.indexOf("matchMedia('(pointer: coarse)')"));
  });

  it('iframe を作るのは「デスクトップですぐ」と「開くとき」の 2 か所だけで、タッチ端末の判定より前には作らない', () => {
    expect(script.split('createFrame()').length - 1).toBe(2);
    const judged = script.indexOf("matchMedia('(pointer: coarse)')");
    const desktop = script.indexOf('noscript.parentNode.insertBefore(createFrame(), noscript);');
    const opening = script.indexOf('var opened = createFrame();');
    expect(judged).toBeGreaterThan(0);
    expect(desktop).toBeGreaterThan(judged);
    expect(opening).toBeGreaterThan(desktop);
    // 開くのは口のクリックだけ。
    expect(script).toContain("entry.addEventListener('click', function () { open(); });");
    expect(script.split('open()').length - 1).toBe(1);
  });

  it('閉じる手段（ボタン・戻る操作・全画面の解除・2 回目の load）は同じ close に集まり、close は冪等である', () => {
    expect(script).toContain("closeButton.addEventListener('click', function () { close(false); });");
    expect(script).toMatch(/addEventListener\('popstate', function \(\) \{[\s\S]*?close\(true\);/u);
    expect(script).toMatch(/addEventListener\('fullscreenchange', function \(\) \{[\s\S]*?close\(false\);/u);
    expect(script).toMatch(/if \(loads >= 2\) \{\n\s+padFrame = null;\n\s+close\(false\);/u);
    // 冪等: 開いていなければ何もしない。
    expect(script).toContain('var close = function (fromHistory) {\n    if (frame === null) { return; }');
    // パッドの「すべて離す」の場所を通ってから iframe を取り除く。
    expect(script.indexOf('releasePad(closing);')).toBeLessThan(script.indexOf('closing.parentNode.removeChild(closing);'));
  });

  it('開くときに履歴を 1 つ積み、戻る操作以外で閉じたときは積んだ履歴を戻す', () => {
    expect(script).toContain('history.pushState({ gfPlay: true }, \'\');');
    expect(script).toMatch(/skipPops \+= 1;[\s\S]*?history\.back\(\);/u);
    expect(script.split('history.back()').length - 1).toBe(1);
  });

  it('タッチ端末でだけ「遊ぶ」のボタンを見せ、口に印を付ける（デスクトップの分岐より後ろ）', () => {
    const shown = script.indexOf('openButton.hidden = false;');
    const marked = script.indexOf(`entry.classList.add(${JSON.stringify(PLAY_ENTRY_TOUCH_CLASS)});`);
    const desktop = script.indexOf('noscript.parentNode.insertBefore(createFrame(), noscript);');
    expect(shown).toBeGreaterThan(desktop);
    expect(marked).toBeGreaterThan(desktop);
    // **口を包む器にも印を付ける**（#665 / PR #674。作品ページは器を既定で隠し、`:has()` を使わずにこの印で見せる）。
    const host = script.indexOf(`entry.parentElement.classList.add(${JSON.stringify(PLAY_HOST_TOUCH_CLASS)});`);
    expect(host).toBeGreaterThan(desktop);
  });

  it('開くと焦点を「閉じる」へ移し、全画面の要求は同じ処理の中で後に呼ぶ。閉じると「遊ぶ」へ戻す（PR #508）', () => {
    const shown = script.indexOf('overlay.hidden = false;');
    const focused = script.indexOf('closeButton.focus({ preventScroll: true });');
    const fullscreen = script.indexOf('overlay.requestFullscreen()');
    expect(shown).toBeGreaterThan(0);
    expect(focused).toBeGreaterThan(shown);
    expect(fullscreen).toBeGreaterThan(focused);
    expect(script.indexOf('openButton.focus({ preventScroll: true });')).toBeLessThan(script.indexOf('var open = function'));
  });

  it('閉じるときに始めた戻りが決着するまで開き直さず、決着しなくても上限で解く（PR #508）', () => {
    expect(script).toContain('if (frame !== null || skipPops > 0) { return; }');
    expect(script).toMatch(/skipTimer = setTimeout\(function \(\) \{\n\s+skipPops = 0;/u);
    expect(script.indexOf('skipPops += 1;')).toBeLessThan(script.indexOf('history.back();'));
  });

  it('開いているあいだは下のページをスクロールさせない印を付け、閉じると外す', () => {
    expect(script).toContain(`root.classList.add(${JSON.stringify(PLAY_LOCKED_CLASS)});`);
    expect(script).toContain(`root.classList.remove(${JSON.stringify(PLAY_LOCKED_CLASS)});`);
  });

  it('全画面は呼べる環境でだけ重ね、断られても続ける', () => {
    expect(script).toContain("if (typeof overlay.requestFullscreen === 'function') {");
    expect(script).toContain('entering.catch(function () {});');
  });

  it('UGC を入れない（埋め込む値は遊ぶ URL と固定の綴りだけ）', () => {
    const other = playFrameScript('https://sandbox.example/g/11111111-1111-4111-8111-111111111111/');
    expect(other.replace('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-000000000502')).toBe(script);
  });
});

describe('仮想パッドの HTML（#494 / 仕様 3.9.6）', () => {
  const codes = ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Enter', 'KeyZ', 'Space'];

  it('覆いの 2 つの置き場所に、表示規則の結果を副のボタンの部品で出す（十字は位置のクラスと読み上げの名前を持つ）', () => {
    const embed = playEmbed(PLAY_URL, WORK_ID, codes, null, null);
    expect(embed).toContain(padKeysHtml(padPlanOf(codes, null)));
    // 版 1 の行（held が null）は十字で出す。スティックの置き場所は隠して置き（切り替え用）、読む軸をすべて受け付ける。
    expect(padKeysHtml(padPlanOf(codes, null))).toBe(
      '<div class="gf-play-pad gf-play-pad-dpad">' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-up" data-code="ArrowUp" aria-label="上">↑</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-left" data-code="ArrowLeft" aria-label="左">←</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-right" data-code="ArrowRight" aria-label="右">→</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-down" data-code="ArrowDown" aria-label="下">↓</button>' +
        '</div>\n<div class="gf-play-pad gf-play-pad-stick" data-stick-up="ArrowUp" data-stick-down="ArrowDown" data-stick-left="ArrowLeft" data-stick-right="ArrowRight" hidden>' +
        '<div class="gf-play-stick-ring" hidden><div class="gf-play-stick-knob"></div></div></div>' +
        '\n<div class="gf-play-pad gf-play-pad-buttons">' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key" data-code="Space">Space</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key" data-code="KeyZ">Z</button>' +
        '</div>',
    );
    // パッドは覆いの中にあり、覆いは hidden で配る（デスクトップと JavaScript の無い形では出ない）。
    const overlayStart = embed.indexOf(`<div class="${PLAY_OVERLAY_CLASS}"`);
    const overlayEnd = embed.indexOf('</div>\n<script>');
    expect(embed.slice(overlayStart, overlayStart + 200)).toContain(' hidden>');
    expect(embed.indexOf(PLAY_PAD_KEY_CLASS)).toBeGreaterThan(overlayStart);
    expect(embed.lastIndexOf(`class="gf-button gf-button-secondary ${PLAY_PAD_KEY_CLASS}`)).toBeLessThan(overlayEnd);
    // 主のボタンを使わない（主は「改造する」のまま）。
    expect(embed).not.toContain('gf-button-primary');
  });

  it('スクリプトの本文はキーの集合によらず同じ（キーの集合も UGC も埋めない）', () => {
    const withKeys = playEmbed(PLAY_URL, WORK_ID, codes, null, null);
    const withoutKeys = playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null);
    expect(withKeys.slice(withKeys.indexOf('<script>'))).toBe(withoutKeys.slice(withoutKeys.indexOf('<script>')));
  });
});

describe('仮想パッドのスクリプトの形（#494 / 仕様 3.9.6 / 3.9.7）', () => {
  const script = playFrameScript(PLAY_URL);

  /**
   * スクリプトから、`var name = function (...) {` で始まる関数の本文を取り出す。
   *
   * @param name 変数名
   * @returns 本文
   */
  function functionBody(name: string): string {
    const start = script.indexOf(`var ${name} = function`);
    expect(start, name).toBeGreaterThan(0);
    return script.slice(start, script.indexOf('\n  };\n', start));
  }

  it('パッドは覆いの中のボタンから引き、タッチ端末の判定より後ろで結ぶ（デスクトップでは付けない）', () => {
    const desktop = script.indexOf('noscript.parentNode.insertBefore(createFrame(), noscript);');
    expect(script).toContain(`var padKeys = overlay.querySelectorAll(${JSON.stringify(`.${PLAY_PAD_KEY_CLASS}`)});`);
    expect(script.indexOf('var padKeys')).toBeGreaterThan(desktop);
  });

  it('送信は contentWindow.postMessage の宛先 * だけで、合図を受けた iframe にしか送らない', () => {
    expect(script.split('postMessage(').length - 1).toBe(1);
    expect(functionBody('postPad')).toContain("if (target === null || padFrame !== target || target.contentWindow === null) { return; }");
    expect(functionBody('postPad')).toContain("target.contentWindow.postMessage(message, '*');");
    expect(script).toContain(`type: ${JSON.stringify(PAD_MESSAGE_TYPE)}, op: op, code: code`);
  });

  it('送ってよい iframe は、その iframe の窓から届いた起動の合図で決まる（src/plays.ts と同じ検査）', () => {
    expect(script).toContain("if (frame === null || event.source !== frame.contentWindow || event.origin !== 'null') { return; }");
    expect(script).toContain(`if (event.data !== ${JSON.stringify(LOADER_STARTED_MESSAGE)}) { return; }`);
    // padFrame に iframe を入れるのは、合図の受け手の 1 か所だけ。
    expect(script.match(/padFrame = (?!null)/gu)).toEqual(['padFrame = ']);
  });

  it('2 回目の load（遷移）では、送信を止めてから閉じる（閉じる処理の release も送らない）', () => {
    const load = script.slice(script.indexOf("opened.addEventListener('load'"));
    expect(load.indexOf('padFrame = null;')).toBeLessThan(load.indexOf('close(false);'));
    // 閉じる処理は release を送ってから送信を止め、iframe を取り除く。
    const close = functionBody('close');
    expect(close.indexOf('releasePad(closing);')).toBeLessThan(close.indexOf('padFrame = null;'));
    expect(close.indexOf('padFrame = null;')).toBeLessThan(close.indexOf('removeChild(closing)'));
  });

  it('pointerdown は preventDefault と setPointerCapture をしてから押下を送り、pointerup / pointercancel / lostpointercapture で離す', () => {
    const bind = functionBody('bindPadKey');
    const down = bind.slice(bind.indexOf("addEventListener('pointerdown'"));
    expect(down.indexOf('event.preventDefault();')).toBeLessThan(down.indexOf('setPointerCapture(event.pointerId)'));
    expect(down.indexOf('setPointerCapture(event.pointerId)')).toBeLessThan(down.indexOf("sendPad('down', padCodes[index]);"));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      expect(bind).toContain(`button.addEventListener('${type}', lift);`);
    }
    // 離しは、押したときの指（pointerId）だけで起きる（ボタンごとに覚えるので同時押しが成り立つ）。
    expect(bind).toContain('if (padHeld[index] && event.pointerId === padPointers[index]) { liftPad(index); }');
  });

  it('click の detail === 0（キーボード・支援技術）では、押下と離しを続けて送る', () => {
    const bind = functionBody('bindPadKey');
    const click = bind.slice(bind.indexOf("addEventListener('click'"));
    expect(click).toContain('if (event.detail !== 0 || padHeld[index]) { return; }');
    expect(click.indexOf("sendPad('down', padCodes[index]);")).toBeLessThan(click.indexOf("sendPad('up', padCodes[index]);"));
  });

  it('すべて離すは visibilitychange（hidden）・pagehide・window の blur（行き先がゲームの iframe なら除く）と閉じるときで、release を 1 回送る', () => {
    const release = functionBody('releasePad');
    expect(release.split('postPad(').length - 1).toBe(1);
    expect(release).toContain(`op: 'release'`);
    expect(script).toMatch(/document\.addEventListener\('visibilitychange', function \(\) \{\n\s+if \(document\.visibilityState === 'hidden'\) \{ releaseOnHide\(\); \}/u);
    expect(script).toContain("window.addEventListener('pagehide', releaseOnHide);");
    // blur はフォーカスの行き先の決着を待ち、自分のゲームの iframe なら離さない（PR #524）。
    expect(script).toMatch(/window\.addEventListener\('blur', function \(\) \{\n\s+setTimeout\(function \(\) \{\n\s+if \(frame !== null && document\.activeElement === frame\) \{ return; \}\n\s+releaseOnHide\(\);\n\s+\}, 0\);/u);
    expect(script).not.toContain("window.addEventListener('blur', releaseOnHide);");
  });

  it('長押しのメニューを抑える', () => {
    expect(script).toContain("addEventListener('contextmenu', function (event) { event.preventDefault(); });");
  });
});

describe('方向の操作の形: スティックと切り替えの HTML（#530 / 仕様 3.9.6）', () => {
  /** ←→ H・↑ J・Space（ピヨピヨジャンプの形）。 */
  const jump = { codes: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space'], held: ['ArrowLeft', 'ArrowRight'] };

  /**
   * 覆いの開始タグと上の行を取り出す。
   *
   * @param embed 埋め込みの HTML
   * @returns 覆いの開始タグ・上の行
   */
  function overlayOf(embed: string): { open: string; bar: string } {
    const start = embed.indexOf(`<div class="${PLAY_OVERLAY_CLASS}"`);
    const open = embed.slice(start, embed.indexOf('>', start) + 1);
    const barStart = embed.indexOf('<div class="gf-play-bar">');
    return { open, bar: embed.slice(barStart, embed.indexOf('</div>', barStart) + '</div>'.length) };
  }

  it('推定がスティックなら、スティックの置き場所を見せ、十字を隠し、スティックの形でだけ出すボタンを見せる', () => {
    const html = padKeysHtml(padPlanOf(jump.codes, jump.held));
    expect(html).toBe(
      '<div class="gf-play-pad gf-play-pad-dpad" hidden>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-up" data-code="ArrowUp" aria-label="上">↑</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-left" data-code="ArrowLeft" aria-label="左">←</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-right" data-code="ArrowRight" aria-label="右">→</button>' +
        '</div>\n' +
        // 横だけ: 受け付ける方向は左右だけ（上下の属性を持たない）。
        '<div class="gf-play-pad gf-play-pad-stick" data-stick-left="ArrowLeft" data-stick-right="ArrowRight">' +
        '<div class="gf-play-stick-ring" hidden><div class="gf-play-stick-knob"></div></div></div>\n' +
        '<div class="gf-play-pad gf-play-pad-buttons">' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key" data-code="Space">Space</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key" data-code="ArrowUp" aria-label="上" data-pad-only="stick">↑</button>' +
        '</div>',
    );
  });

  it('推定が十字なら、スティックの置き場所とスティックの形でだけ出すボタンを隠す。出すボタンが無ければ置き場所ごと隠す', () => {
    const plan = padPlanOf(['ArrowLeft', 'ArrowRight', 'ArrowUp'], ['ArrowLeft', 'ArrowRight']);
    // スティックでは ↑ のボタンだけ、十字ではボタンが無い。推定はスティックなので、ボタンの置き場所は見える。
    expect(padKeysHtml(plan)).toContain('<div class="gf-play-pad gf-play-pad-buttons"><button');
    const dpadFirst = { ...plan, estimated: 'dpad' as const };
    const html = padKeysHtml(dpadFirst);
    expect(html).toContain('<div class="gf-play-pad gf-play-pad-dpad"><button');
    expect(html).toMatch(/<div class="gf-play-pad gf-play-pad-stick"[^>]* hidden>/u);
    expect(html).toContain('data-pad-only="stick" hidden>↑</button>');
    expect(html).toContain('<div class="gf-play-pad gf-play-pad-buttons" hidden><button');
  });

  it('方向の操作がある作品では、覆いに推定した形と覚えた形のキー（作品 id ごと）を持たせ、「閉じる」の前に控えめの切り替えを置く', () => {
    const stickEmbed = playEmbed(PLAY_URL, WORK_ID, jump.codes, jump.held, null);
    expect(overlayOf(stickEmbed).open).toBe(
      `<div class="${PLAY_OVERLAY_CLASS}" role="dialog" aria-modal="true" aria-label="ゲーム" data-pad-shape="stick" data-pad-memory="${PLAY_PAD_MEMORY_PREFIX}${WORK_ID}" hidden>`,
    );
    expect(overlayOf(stickEmbed).bar).toBe(
      `<div class="gf-play-bar"><button type="button" class="gf-button gf-button-tertiary ${PLAY_PAD_TOGGLE_CLASS}">` +
        '<span data-pad-label="stick">十字にする</span><span data-pad-label="dpad" hidden>スティックにする</span></button>' +
        `<button type="button" class="gf-button gf-button-secondary ${PLAY_CLOSE_CLASS}">閉じる</button></div>`,
    );
    const dpadEmbed = playEmbed(PLAY_URL, WORK_ID, jump.codes, null, null);
    expect(overlayOf(dpadEmbed).open).toContain('data-pad-shape="dpad"');
    expect(overlayOf(dpadEmbed).bar).toContain('<span data-pad-label="stick" hidden>十字にする</span><span data-pad-label="dpad">スティックにする</span></button>');
    expect(PLAY_PAD_TOGGLE_LABELS).toEqual({ stick: '十字にする', dpad: 'スティックにする' });
  });

  it('方向の操作が無い作品（キーを読まない・ボタンだけ）では、切り替えもスティックの置き場所も出さない', () => {
    for (const codes of [[], ['Space', 'KeyZ']]) {
      const full = playEmbed(PLAY_URL, WORK_ID, codes, ['Space'], null);
      // スクリプトは作品によらず同じで、部品の綴りを持つ。見るのは HTML の骨組み。
      const embed = full.slice(0, full.indexOf('<script>'));
      expect(embed).not.toContain(PLAY_PAD_TOGGLE_CLASS);
      expect(embed).not.toContain('gf-play-pad-stick');
      expect(embed).not.toContain('data-pad-shape');
      expect(embed).not.toContain('data-pad-memory');
      expect(overlayOf(embed).bar).toBe(`<div class="gf-play-bar"><button type="button" class="gf-button gf-button-secondary ${PLAY_CLOSE_CLASS}">閉じる</button></div>`);
    }
  });

  it('足したボタンは部品のクラスを持ち、主を使わず、文言に旧い呼び名が出ない（2.5.5 / #513）', () => {
    const embed = playEmbed(PLAY_URL, WORK_ID, jump.codes, jump.held, null);
    expect(embed).not.toContain('gf-button-primary');
    for (const tag of embed.match(/<button\b[^>]*>/gu) ?? []) {
      expect(tag).toMatch(/class="gf-button gf-button-(secondary|tertiary) /u);
    }
    expect(oldOperationNamesIn(embed)).toEqual([]);
  });

  it('作品 id は属性として逃がして入れる', () => {
    expect(playEmbed(PLAY_URL, '"><script>', jump.codes, jump.held, null)).toContain('data-pad-memory="gf-pad-shape:&quot;&gt;&lt;script&gt;"');
  });
});

describe('スティックと切り替えのスクリプトの形（#530 / 仕様 3.9.6）', () => {
  const script = playFrameScript(PLAY_URL);

  /**
   * スクリプトから、`var name = function (...) {` で始まる関数の本文を取り出す。
   *
   * @param name 変数名
   * @returns 本文
   */
  function functionBody(name: string): string {
    const start = script.indexOf(`var ${name} = function`);
    expect(start, name).toBeGreaterThan(0);
    return script.slice(start, script.indexOf('\n  };\n', start));
  }

  it('方向の決め方は src/virtual-pad.ts の本文をそのまま埋め込む（写しを持たない）', () => {
    expect(script).toContain(`var stickKeysOf = ${STICK_KEYS_SOURCE};`);
    expect(script.split('Math.atan2').length - 1).toBe(1);
    expect(script).toContain('var stickRadius = 56;');
    expect(script).toContain('var stickDeadZone = 0.3;');
  });

  it('送り方: 集合が変わったときだけ、外れたキーの up を先に、加わったキーの down を後に送る', () => {
    const body = functionBody('setStickKeys');
    expect(body.indexOf("sendPad('up', stickHeld[index]);")).toBeGreaterThan(0);
    expect(body.indexOf("sendPad('up', stickHeld[index]);")).toBeLessThan(body.indexOf("sendPad('down', next[index]);"));
    expect(body).toContain('if (next.indexOf(stickHeld[index]) === -1)');
    expect(body).toContain('if (stickHeld.indexOf(next[index]) === -1)');
  });

  it('pointerdown で preventDefault と setPointerCapture をし、触れた位置を中心にする。離すと押しているキーをすべて up する', () => {
    const down = script.slice(script.indexOf("stickArea.addEventListener('pointerdown'"));
    expect(down.indexOf('event.preventDefault();')).toBeLessThan(down.indexOf('stickArea.setPointerCapture(event.pointerId)'));
    expect(down).toMatch(/stickCenterX = event\.clientX;\n\s+stickCenterY = event\.clientY;/u);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      expect(script).toContain(`stickArea.addEventListener('${type}', liftStick);`);
    }
    expect(functionBody('liftStick')).toMatch(/setStickKeys\(\[\]\);\n\s+dropStick\(\);/u);
    // つまみは円の縁で止める。
    expect(script).toContain('var scale = distance > stickRadius ? stickRadius / distance : 1;');
  });

  it('すべて離すは、スティックの指も忘れる（その後に指を動かしても離しても送らない）', () => {
    expect(functionBody('releasePad')).toContain('dropStick();');
    expect(functionBody('dropStick')).toContain('stickPointer = null;');
    expect(script).toContain("if (stickPointer === null || event.pointerId !== stickPointer) { return; }");
  });

  it('覚えた形は推定より優先し、読み書きの失敗は握りつぶす。切り替えは押しているキーを離してから形を変えて覚える', () => {
    expect(script).toContain('try { remembered = window.localStorage.getItem(padMemory); } catch (error) { remembered = null; }');
    expect(script).toContain("applyPadShape(remembered === 'stick' || remembered === 'dpad' ? remembered : padShape);");
    const click = script.slice(script.indexOf("padToggle.addEventListener('click'"));
    expect(click.indexOf('releasePad(frame);')).toBeLessThan(click.indexOf('applyPadShape(next);'));
    expect(click.indexOf('applyPadShape(next);')).toBeLessThan(click.indexOf('window.localStorage.setItem(padMemory, next)'));
    expect(click).toContain('try { window.localStorage.setItem(padMemory, next); } catch (error) {}');
    // 文言は固定（今と逆の形の名前）で、HTML に置いた 2 つの見せ方を入れ替えるだけ（画面の文字を書き換える口を持たない）。
    expect(functionBody('applyPadShape')).toContain(
      "padToggleLabels[labelIndex].hidden = padToggleLabels[labelIndex].getAttribute(\"data-pad-label\") !== shape;",
    );
    expect(script).not.toMatch(/innerHTML|outerHTML|textContent|insertAdjacent|document\.write/u);
  });

  it('スティックと切り替えは、タッチ端末の判定より後ろで結ぶ（デスクトップでは付けない）', () => {
    const desktop = script.indexOf('noscript.parentNode.insertBefore(createFrame(), noscript);');
    expect(script.indexOf("stickArea.addEventListener('pointerdown'")).toBeGreaterThan(desktop);
    expect(script.indexOf('window.localStorage.getItem')).toBeGreaterThan(desktop);
  });
});

describe('作品のおすすめの向き: 規則と HTML（#514 / 仕様 3.9.4）', () => {
  it('論理解像度が横長なら landscape、縦長なら portrait、正方形・分からない・壊れた値なら null', () => {
    expect(playOrientationOf(320, 240)).toBe('landscape');
    expect(playOrientationOf(480, 270)).toBe('landscape');
    expect(playOrientationOf(320, 480)).toBe('portrait');
    expect(playOrientationOf(480, 640)).toBe('portrait');
    expect(playOrientationOf(480, 480)).toBeNull();
    // 版 3 以下の行・拾えなかった行（NULL）と、D1 の壊れた値。
    for (const [width, height] of [
      [null, null],
      [320, null],
      [null, 240],
      ['320', '240'],
      [320.5, 240],
      [0, 240],
      [-320, 240],
      [Number.NaN, 240],
    ] as const) {
      expect(playOrientationOf(width, height), `${String(width)}x${String(height)}`).toBeNull();
    }
  });

  it('向きの操作をする作品では、覆いにおすすめの向きと入れ替えた向きのキーを持たせ、上の行の先頭に hidden の案内と控えめのボタンを置く', () => {
    const landscape = playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null, 'landscape');
    expect(landscape).toContain(
      `<div class="${PLAY_OVERLAY_CLASS}" role="dialog" aria-modal="true" aria-label="ゲーム" data-orientation="landscape" data-orientation-memory="${PLAY_ORIENTATION_MEMORY_PREFIX}${WORK_ID}" hidden>`,
    );
    expect(landscape).toContain(
      '<div class="gf-play-bar">' +
        `<p class="${PLAY_ORIENTATION_HINT_CLASS}" role="status" hidden><span>横にすると</span><span>大きく遊べます</span></p>` +
        `<button type="button" class="gf-button gf-button-tertiary ${PLAY_ORIENTATION_TOGGLE_CLASS}" hidden>` +
        '<span data-orient-label="landscape">縦向きにする</span><span data-orient-label="portrait" hidden>横向きにする</span></button>' +
        `<button type="button" class="gf-button gf-button-secondary ${PLAY_CLOSE_CLASS}">閉じる</button></div>`,
    );
    const portrait = playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null, 'portrait');
    expect(portrait).toContain('data-orientation="portrait"');
    expect(portrait).toContain(`<p class="${PLAY_ORIENTATION_HINT_CLASS}" role="status" hidden><span>縦にすると</span><span>大きく遊べます</span></p>`);
    expect(portrait).toContain('<span data-orient-label="landscape" hidden>縦向きにする</span><span data-orient-label="portrait">横向きにする</span></button>');
    expect(PLAY_ORIENTATION_TOGGLE_LABELS).toEqual({ landscape: '縦向きにする', portrait: '横向きにする' });
    expect(Object.fromEntries(Object.entries(PLAY_ORIENTATION_HINTS).map(([key, phrases]) => [key, phrases.join('')]))).toEqual({
      landscape: '横にすると大きく遊べます',
      portrait: '縦にすると大きく遊べます',
    });
  });

  it('向きのボタンは十字 / スティックの切り替えと「閉じる」より前に並ぶ（同じ上の行）', () => {
    const jump = playEmbed(PLAY_URL, WORK_ID, ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space'], ['ArrowLeft', 'ArrowRight'], null, 'landscape');
    const bar = jump.slice(jump.indexOf('<div class="gf-play-bar">'), jump.indexOf('<div class="gf-play-stage">'));
    expect(bar.indexOf(PLAY_ORIENTATION_TOGGLE_CLASS)).toBeGreaterThan(bar.indexOf(PLAY_ORIENTATION_HINT_CLASS));
    expect(bar.indexOf('gf-play-pad-toggle')).toBeGreaterThan(bar.indexOf(PLAY_ORIENTATION_TOGGLE_CLASS));
    expect(bar.indexOf(PLAY_CLOSE_CLASS)).toBeGreaterThan(bar.indexOf('gf-play-pad-toggle'));
  });

  it('向きの操作をしない作品（正方形・解像度が分からない）では、属性もボタンも案内も置かない。スクリプトの本文は向きによらず同じ', () => {
    for (const embed of [playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null), playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null, null)]) {
      const html = embed.slice(0, embed.indexOf('<script>'));
      expect(html).not.toContain('data-orientation');
      expect(html).not.toContain(PLAY_ORIENTATION_TOGGLE_CLASS);
      expect(html).not.toContain(PLAY_ORIENTATION_HINT_CLASS);
    }
    const scriptOf = (embed: string): string => embed.slice(embed.indexOf('<script>'));
    expect(scriptOf(playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null, 'landscape'))).toBe(scriptOf(playEmbed(PLAY_URL, WORK_ID, NO_KEYS, null, null)));
  });

  it('足したボタンは控えめの部品で主を使わず、作品 id は属性として逃がして入れる', () => {
    const embed = playEmbed(PLAY_URL, '"><script>', NO_KEYS, null, null, 'portrait');
    expect(embed).toContain('data-orientation-memory="gf-orientation:&quot;&gt;&lt;script&gt;"');
    expect(embed).not.toContain('gf-button-primary');
    expect(oldOperationNamesIn(embed)).toEqual([]);
  });
});

describe('作品のおすすめの向き: スクリプトの形（#514 / 仕様 3.9.4）', () => {
  const script = playFrameScript(PLAY_URL);

  /**
   * スクリプトから、`var name = function (...) {` で始まる関数の本文を取り出す。
   *
   * @param name 変数名
   * @returns 本文
   */
  function functionBody(name: string): string {
    const start = script.indexOf(`var ${name} = function`);
    expect(start, name).toBeGreaterThan(0);
    return script.slice(start, script.indexOf('\n  };\n', start));
  }

  it('全画面の要求の後で向きの処理を始め、全画面に入った（要求が決着した）後でだけ固定を頼む。入れなければ案内に回る', () => {
    const open = functionBody('open');
    expect(open.indexOf('entering = overlay.requestFullscreen();')).toBeGreaterThan(0);
    expect(open.indexOf('startOrientation(entering);')).toBeGreaterThan(open.indexOf('entering = overlay.requestFullscreen();'));
    const start = functionBody('startOrientation');
    expect(start).toContain("if (orientWanted === null) { return; }");
    expect(start).toMatch(/if \(!entering \|\| typeof entering\.then !== 'function'\) \{\n\s+hintOrientation\(round\);/u);
    expect(start).toMatch(/entering\.then\(function \(\) \{\n\s+if \(round !== orientRound \|\| frame === null\) \{ return; \}\n\s+if \(lockOrientation\(target, round, hintOrientation\)\) \{\n\s+showOrientationToggle\(round\);\n\s+\} else \{\n\s+hintOrientation\(round\);\n\s+\}\n\s+\}, function \(\) \{\n\s+hintOrientation\(round\);/u);
  });

  it('覚えた向きはおすすめの向きより優先し、読み書きの失敗は握りつぶす', () => {
    const start = functionBody('startOrientation');
    expect(start).toContain('try { remembered = window.localStorage.getItem(orientMemory); } catch (error) { remembered = null; }');
    expect(start).toContain("var target = remembered === 'landscape' || remembered === 'portrait' ? remembered : orientWanted;");
  });

  it('固定は screen.orientation.lock があるときだけ頼み、決着を待たずに「頼めた」を返す。API が無い・投げた・Promise でないときは頼めなかったを返す（#572）', () => {
    const lock = functionBody('lockOrientation');
    expect(lock).toContain("if (!orientation || typeof orientation.lock !== 'function') { return false; }");
    expect(lock).toContain('try { locking = orientation.lock(target); } catch (error) { locking = null; }');
    expect(lock).toMatch(/if \(!locking \|\| typeof locking\.then !== 'function'\) \{ return false; \}/u);
    expect(lock).toMatch(/return true;$/u);
    // 解決を待つ処理は、閉じた後の解決で unlock する後始末だけで、ボタンを見せない。
    const resolved = lock.slice(lock.indexOf('locking.then(function () {'), lock.indexOf('}, function (error) {'));
    expect(resolved).not.toContain('showOrientationToggle');
    expect(resolved).not.toContain('onRefused');
    // ボタンを見せるのは showOrientationToggle の 1 か所だけで、それを呼ぶのは固定を頼めた直後の 1 か所だけ。
    expect(script.split('orientToggle.hidden = false;').length - 1).toBe(1);
    expect(functionBody('showOrientationToggle')).toContain('orientToggle.hidden = false;');
    expect(script.split('showOrientationToggle(').length - 1).toBe(1);
    // 案内の回はボタンを隠す。
    expect(functionBody('hintOrientation')).toContain('orientToggle.hidden = true;');
  });

  it('固定の拒否は、その回の最新の固定の要求のときだけ扱い、新しい固定を頼んだ後に届いた古い拒否（AbortError）は捨てる（#572）', () => {
    const lock = functionBody('lockOrientation');
    expect(lock).toMatch(/orientLockSeq \+= 1;\n\s+var seq = orientLockSeq;/u);
    // 通し番号は lock を呼ぶより前に進める。
    expect(lock.indexOf('orientLockSeq += 1;')).toBeLessThan(lock.indexOf('orientation.lock(target)'));
    // 取り消し（AbortError。閉じるときの unlock も含む）は拒否として扱わず、回の判定は onRefused の側に任せる（PR #573 の Copilot の指摘）。
    expect(lock).toMatch(/\}, function \(error\) \{\n\s+if \(seq !== orientLockSeq \|\| \(error && error\.name === 'AbortError'\)\) \{ return; \}\n\s+onRefused\(round\);/u);
    expect(functionBody('hintOrientation')).toMatch(/\{\n\s*if \(round !== orientRound \|\| frame === null\) \{ return; \}/u);
  });

  it('ボタンの文言は HTML に置いた 2 つの見せ方を今見えている向き（orientation: portrait）で入れ替え、向きが変わるたびに見直す（#572）', () => {
    expect(functionBody('currentOrientation')).toContain("return portraitQuery === null ? orientRequested : portraitQuery.matches ? 'portrait' : 'landscape';");
    const update = functionBody('updateOrientToggle');
    expect(update).toContain('var current = currentOrientation();');
    expect(update).toContain('orientLabels[index].hidden = orientLabels[index].getAttribute("data-orient-label") !== current;');
    expect(functionBody('showOrientationToggle')).toContain('updateOrientToggle();');
    const change = functionBody('onOrientationChange');
    expect(change).toContain('updateOrientHint();');
    expect(change).toContain('updateOrientToggle();');
    expect(script).toContain("portraitQuery.addEventListener('change', onOrientationChange);");
    // 文言を固定を頼んだ向きから決めない。
    expect(update).not.toContain('orientRequested');
  });

  it('押すと今見えている向きの逆で固定を頼み、押した時点で入れ替え先を覚え、拒まれたら押す前の値に戻す（ボタンは出したまま。#572）', () => {
    const click = script.slice(script.indexOf("orientToggle.addEventListener('click'"));
    expect(click).toContain('if (!orientToggling || frame === null) { return; }');
    expect(click).toContain("var next = currentOrientation() === 'landscape' ? 'portrait' : 'landscape';");
    expect(click).toContain('try { previous = window.localStorage.getItem(orientMemory); } catch (error) { previous = null; }');
    expect(click.indexOf('try { window.localStorage.setItem(orientMemory, next); } catch (error) {}')).toBeGreaterThan(click.indexOf('var previous'));
    expect(click.indexOf('window.localStorage.setItem(orientMemory, next)')).toBeLessThan(click.indexOf('lockOrientation(next, orientRound, restore)'));
    const restore = click.slice(click.indexOf('var restore = function () {'), click.indexOf('if (!lockOrientation(next, orientRound, restore)) { restore(); }'));
    expect(restore).toMatch(/if \(previous === null\) \{\n\s+window\.localStorage\.removeItem\(orientMemory\);\n\s+\} else \{\n\s+window\.localStorage\.setItem\(orientMemory, previous\);/u);
    // 拒まれてもボタンを隠さず、案内にも回らない。
    expect(restore).not.toMatch(/hidden|hintOrientation/u);
    expect(click).toContain('if (!lockOrientation(next, orientRound, restore)) { restore(); }');
    expect(script).not.toMatch(/innerHTML|outerHTML|textContent|insertAdjacent|document\.write/u);
  });

  it('案内は固定できなかった回で、今の向き（orientation: portrait）がおすすめと違うときだけ出し、向きが変わるたびに見直す', () => {
    expect(functionBody('updateOrientHint')).toContain(
      'orientHint.hidden = !(orientHinting && frame !== null && current !== null && current !== orientWanted);',
    );
    expect(functionBody('updateOrientHint')).toContain("var current = portraitQuery === null ? null : portraitQuery.matches ? 'portrait' : 'landscape';");
    expect(functionBody('onOrientationChange')).toContain('updateOrientHint();');
  });

  it('閉じると、この回の決着を捨て、ボタンと案内を隠し、向きの操作をする作品では固定を外す（unlock は存在を確かめて例外を握りつぶす）', () => {
    const close = functionBody('close');
    expect(close).toMatch(/orientRound \+= 1;\n\s+orientToggling = false;\n\s+orientHinting = false;\n\s+hideOrientationBar\(\);\n\s+if \(orientWanted !== null\) \{ unlockOrientation\(\); \}/u);
    // 閉じる処理は冪等のまま（開いていなければ何もしない）で、unlock は全画面の解除より前。
    expect(close.indexOf('unlockOrientation();')).toBeLessThan(close.indexOf('document.exitFullscreen()'));
    const unlock = functionBody('unlockOrientation');
    expect(unlock).toContain("if (orientation && typeof orientation.unlock === 'function') {");
    expect(unlock).toContain('try { orientation.unlock(); } catch (error) {}');
    // 閉じた後に決着した固定は、閉じたままなら外す。
    expect(functionBody('lockOrientation')).toMatch(/locking\.then\(function \(\) \{\n\s+if \(round !== orientRound\) \{\n[^\n]*\n\s+if \(frame === null\) \{ unlockOrientation\(\); \}/u);
  });

  it('向きの処理はタッチ端末の判定より後ろで結ぶ（デスクトップでは固定しない）', () => {
    const desktop = script.indexOf('noscript.parentNode.insertBefore(createFrame(), noscript);');
    expect(script.indexOf('var orientWanted')).toBeGreaterThan(desktop);
    expect(script.indexOf('orientation.lock(')).toBeGreaterThan(desktop);
  });
});
