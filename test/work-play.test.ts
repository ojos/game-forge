import { describe, expect, it } from 'vitest';
import { playReportScript } from '../src/plays.js';
import { LOADER_STARTED_MESSAGE, PAD_MESSAGE_TYPE } from '../src/sandbox-loader.js';
import { padLayoutOf } from '../src/virtual-pad.js';
import {
  PLAY_CLOSE_CLASS,
  PLAY_ENTRY_CLASS,
  PLAY_ENTRY_TOUCH_CLASS,
  PLAY_FRAME_CLASS,
  PLAY_LOCKED_CLASS,
  PLAY_NOSCRIPT_CLASS,
  PLAY_OPEN_CLASS,
  PLAY_OVERLAY_CLASS,
  PLAY_PAD_KEY_CLASS,
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
    const embed = playEmbed(PLAY_URL, NO_KEYS);
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
    const embed = playEmbed(PLAY_URL, NO_KEYS);
    expect(embed.startsWith(`<noscript class="${PLAY_NOSCRIPT_CLASS}">${playFrameHtml(PLAY_URL)}</noscript>\n`)).toBe(true);
    expect(embed.split('<iframe').length - 1).toBe(1);
  });

  it('覆いは hidden で配り、中にゲームの領域・閉じるのボタン・パッドの置き場所を持つ（キーを読まない作品では空）', () => {
    const embed = playEmbed(PLAY_URL, NO_KEYS);
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
    const html = `${playEntry('', true)}${playEmbed(PLAY_URL, NO_KEYS)}`;
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
    expect(script.split('matchMedia(').length - 1).toBe(1);
    expect(script).toContain("window.matchMedia('(pointer: coarse)').matches");
    expect(script).not.toMatch(/innerWidth|clientWidth|screen\.width|min-width|max-width|orientation/u);
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
    const embed = playEmbed(PLAY_URL, codes);
    expect(embed).toContain(padKeysHtml(padLayoutOf(codes)));
    expect(padKeysHtml(padLayoutOf(codes))).toBe(
      '<div class="gf-play-pad gf-play-pad-dpad">' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-up" data-code="ArrowUp" aria-label="上">↑</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-left" data-code="ArrowLeft" aria-label="左">←</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-right" data-code="ArrowRight" aria-label="右">→</button>' +
        '<button type="button" class="gf-button gf-button-secondary gf-play-pad-key gf-play-pad-down" data-code="ArrowDown" aria-label="下">↓</button>' +
        '</div>\n<div class="gf-play-pad gf-play-pad-buttons">' +
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
    const withKeys = playEmbed(PLAY_URL, codes);
    const withoutKeys = playEmbed(PLAY_URL, NO_KEYS);
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

  it('すべて離すは visibilitychange（hidden）・pagehide・window の blur と閉じるときで、release を 1 回送る', () => {
    const release = functionBody('releasePad');
    expect(release.split('postPad(').length - 1).toBe(1);
    expect(release).toContain(`op: 'release'`);
    expect(script).toMatch(/document\.addEventListener\('visibilitychange', function \(\) \{\n\s+if \(document\.visibilityState === 'hidden'\) \{ releaseOnHide\(\); \}/u);
    expect(script).toContain("window.addEventListener('pagehide', releaseOnHide);");
    expect(script).toContain("window.addEventListener('blur', releaseOnHide);");
  });

  it('長押しのメニューを抑える', () => {
    expect(script).toContain("addEventListener('contextmenu', function (event) { event.preventDefault(); });");
  });
});
