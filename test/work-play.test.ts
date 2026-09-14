import { describe, expect, it } from 'vitest';
import { playReportScript } from '../src/plays.js';
import {
  PLAY_CLOSE_CLASS,
  PLAY_ENTRY_CLASS,
  PLAY_ENTRY_TOUCH_CLASS,
  PLAY_FRAME_CLASS,
  PLAY_LOCKED_CLASS,
  PLAY_NOSCRIPT_CLASS,
  PLAY_OPEN_CLASS,
  PLAY_OVERLAY_CLASS,
  PLAY_STAGE_CLASS,
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
    const embed = playEmbed(PLAY_URL);
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
    const embed = playEmbed(PLAY_URL);
    expect(embed.startsWith(`<noscript class="${PLAY_NOSCRIPT_CLASS}">${playFrameHtml(PLAY_URL)}</noscript>\n`)).toBe(true);
    expect(embed.split('<iframe').length - 1).toBe(1);
  });

  it('覆いは hidden で配り、中にゲームの領域・閉じるのボタン・空のパッドの置き場所を持つ', () => {
    const embed = playEmbed(PLAY_URL);
    expect(embed).toContain(`<div class="${PLAY_OVERLAY_CLASS}" role="dialog" aria-modal="true" aria-label="ゲーム" hidden>`);
    expect(embed).toContain(`<div class="${PLAY_STAGE_CLASS}"></div>`);
    expect(embed).toContain(`<button type="button" class="gf-button gf-button-secondary ${PLAY_CLOSE_CLASS}">閉じる</button>`);
    // パッドは置き場所だけ（中身は M14-5 / #494）。
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
    const html = `${playEntry('', true)}${playEmbed(PLAY_URL)}`;
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
    expect(script).toContain('if (loads >= 2) { close(false); }');
    // 冪等: 開いていなければ何もしない。
    expect(script).toContain('var close = function (fromHistory) {\n    if (frame === null) { return; }');
    // パッドの「すべて離す」の場所を通ってから iframe を取り除く。
    expect(script.indexOf('releasePad(closing);')).toBeLessThan(script.indexOf('closing.parentNode.removeChild(closing);'));
  });

  it('開くときに履歴を 1 つ積み、戻る操作以外で閉じたときは積んだ履歴を戻す', () => {
    expect(script).toContain('history.pushState({ gfPlay: true }, \'\');');
    expect(script).toContain('skipPops += 1;\n        history.back();');
    expect(script.split('history.back()').length - 1).toBe(1);
  });

  it('タッチ端末でだけ「遊ぶ」のボタンを見せ、口に印を付ける（デスクトップの分岐より後ろ）', () => {
    const shown = script.indexOf('openButton.hidden = false;');
    const marked = script.indexOf(`entry.classList.add(${JSON.stringify(PLAY_ENTRY_TOUCH_CLASS)});`);
    const desktop = script.indexOf('noscript.parentNode.insertBefore(createFrame(), noscript);');
    expect(shown).toBeGreaterThan(desktop);
    expect(marked).toBeGreaterThan(desktop);
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
