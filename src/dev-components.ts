/**
 * 部品の一覧（`/__dev/components`。#457 / 仕様 2.5）。
 *
 * ## 何のための画面か
 *
 * **#457 は部品（`public/assets/app.css` の `.gf-button` / `.gf-chip` / `.gf-tabs` / `.gf-block` / `.gf-kv` など）を
 * 足すだけで、どの画面にもまだ当てない**（当てるのは M13-6〜M13-11）。**当てる前に、部品が規約どおりに描かれることを
 * 確かめる場所が要る。** 承認したモックアップ（Version 6）の「部品の一覧」と同じ並びにしてあるので、明暗の両テーマで
 * 撮影して見比べられる。後続の issue も、ここで部品を確かめてから画面に当てる。
 *
 * ## 本番には出ない
 *
 * **`src/app.ts` の `devRoutes` に置く**ので、`DEV_ROUTES` が `enabled` のとき（ローカル）だけ登録される。
 * `/__dev/` は画面の一覧（`src/page-paths.ts` の `NON_PAGE_PREFIXES`）から外れているので、外枠と幅の検査の対象にも
 * ならない——**ヘッダもフッタも持たない**（部品だけを並べる）。
 *
 * ## 状態は `data-state` で固定して見せる
 *
 * ホバーと焦点はマウスやキーボードを当てないと出ないので、**`app.css` の部品の規則は `[data-state='hover']` /
 * `[data-state='focus']` にも同じ見た目を与えてある。** 画面ではこの属性を付けない。
 */

import { APP_CSS_PATH, escapeHtml } from './html.js';

/** 部品の一覧の経路。 */
export const DEV_COMPONENTS_PATH = '/__dev/components';

/** 色の見本に並べるトークン（名前と役割。仕様 2.5.2 の表の順）。 */
const COLOR_TOKENS: readonly (readonly [token: string, role: string])[] = [
  ['--gf-ground', '地'],
  ['--gf-surface', '面（ブロック・ホバーの地）'],
  ['--gf-rule-soft', '区切りの罫線'],
  ['--gf-rule', '枠線（副ボタン・チップ）'],
  ['--gf-rule-strong', '枠線のホバー'],
  ['--gf-rule-input', '入力欄の枠線（地に 3:1）'],
  ['--gf-ink', '主の文字・主ボタンの地'],
  ['--gf-ink-soft', '補助の文字'],
  ['--gf-ink-faint', '三次の文字'],
  ['--gf-danger', 'エラー'],
];

/** ボタンの段と、並べる状態。 */
const BUTTON_KINDS: readonly (readonly [cls: string, label: string])[] = [
  ['gf-button-primary', '主'],
  ['gf-button-secondary', '副'],
  ['gf-button-tertiary', '控えめ'],
];

/**
 * 部品のクラスを持たない `<button>` の見本（#473。既定は副の見た目）。
 *
 * **この画面だけが、クラスを持たない `<button>` を置いてよい**——既定の見た目を確かめるための見本だからである。
 * `test/button-parts.test.ts` は `data-dev-sample="default"` を持つものを、このファイルの中でだけ許す。
 * 状態は通常・ホバー（`data-state` で固定する）・押せないで、隣に副のボタンの部品を置いて見比べる。
 */
const DEFAULT_BUTTON_SAMPLES = [
  '<button type="button" data-dev-sample="default">もっと見る</button>',
  '<button type="button" data-dev-sample="default" data-state="hover">ホバー時</button>',
  '<button type="button" data-dev-sample="default" disabled>押せない</button>',
  '<button type="button" class="gf-button gf-button-secondary">副（見比べる）</button>',
].join('');

/**
 * ボタンを 1 つ描く。
 *
 * @param cls 段のクラス
 * @param size 大きさ（`sm` なら小）
 * @param state 固定して見せる状態
 * @returns HTML
 */
function buttonOf(cls: string, size: 'md' | 'sm', state: 'normal' | 'hover' | 'focus' | 'disabled'): string {
  const sizeClass = size === 'sm' ? ' gf-button-sm' : '';
  const stateAttr = state === 'hover' || state === 'focus' ? ` data-state="${state}"` : '';
  const disabled = state === 'disabled' ? ' disabled' : '';
  return `<button type="button" class="gf-button ${cls}${sizeClass}"${stateAttr}${disabled}>${size === 'sm' ? '検索' : 'もっと見る'}</button>`;
}

/**
 * 部品の一覧の HTML を組み立てる。
 *
 * @returns 完全な HTML 文書
 */
export function renderDevComponentsPage(): string {
  const swatches = COLOR_TOKENS.map(
    ([token, role]) => `<div class="dev-swatch"><span style="background: var(${token})"></span><code>${escapeHtml(token)}</code><small>${escapeHtml(role)}</small></div>`,
  ).join('\n');

  const buttonRows = BUTTON_KINDS.flatMap(([cls, label]) =>
    (['md', 'sm'] as const).map(
      (size) => `<tr><th scope="row">${escapeHtml(label)} / ${size === 'md' ? '中 40px' : '小 32px'}</th>${(['normal', 'hover', 'focus', 'disabled'] as const)
        .map((state) => `<td>${buttonOf(cls, size, state)}</td>`)
        .join('')}</tr>`,
    ),
  ).join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${APP_CSS_PATH}">
<title>部品の一覧（local dev）</title>
<style>
  /* この画面の並べ方だけ。部品の見た目はすべて app.css が持つ（ここで部品の値を書かない）。 */
  .dev-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: var(--gf-gap-3); max-width: none; }
  .dev-swatch { display: flex; flex-direction: column; gap: var(--gf-gap-1); }
  .dev-swatch span { display: block; height: 2.5rem; border: 1px solid var(--gf-rule); border-radius: var(--gf-radius); }
  .dev-table { border-collapse: collapse; }
  .dev-table th, .dev-table td { padding: var(--gf-gap-2) var(--gf-gap-3) var(--gf-gap-2) 0; text-align: left; font-weight: 400; vertical-align: middle; }
  .dev-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gf-gap-2); }
  .dev-section { margin-top: var(--gf-gap-5); padding-top: var(--gf-gap-4); border-top: 1px solid var(--gf-rule-soft); max-width: none; }
</style>
<h1>部品の一覧</h1>
<p>仕様 2.5 の部品（#457）。承認したモックアップ（Version 6）の「部品の一覧」と見比べるための画面で、本番には出ません。明暗は端末の設定で切り替わります。</p>

<section class="dev-section" aria-labelledby="dev-colors">
<h2 id="dev-colors">色の段</h2>
<div class="dev-grid">
${swatches}
</div>
</section>

<section class="dev-section" aria-labelledby="dev-buttons">
<h2 id="dev-buttons">ボタン（強さ 3 段 × 大きさ 2 つ）</h2>
<div style="overflow-x: auto">
<table class="dev-table">
<thead><tr><th scope="col"></th><th scope="col">通常</th><th scope="col">ホバー</th><th scope="col">焦点</th><th scope="col">押せない</th></tr></thead>
<tbody>
${buttonRows}
</tbody>
</table>
</div>
<p class="dev-row"><a class="gf-button gf-button-primary" href="#dev-buttons">移動なら a 要素（主）</a><a class="gf-button gf-button-secondary gf-button-sm" href="#dev-buttons">a 要素（副・小）</a></p>
<h3 id="dev-button-default">部品のクラスを持たない button 要素（既定）</h3>
<p>既定は<strong>副と同じ見た目</strong>です（#473）。主の見た目は <code>gf-button-primary</code> だけが持ちます。画面のボタンは既定に寄りかからず、必ず部品のクラスを付けます（<code>test/button-parts.test.ts</code> が見ます）。</p>
<p class="dev-row">${DEFAULT_BUTTON_SAMPLES}</p>
</section>

<section class="dev-section" aria-labelledby="dev-links">
<h2 id="dev-links">リンクの見せ方</h2>
<p>文章の中のリンクは<a href="#dev-links">下線を常に出します</a>（<code>a</code> の既定のまま）。</p>
<p class="dev-row"><a class="gf-link-quiet" href="#dev-links">文章の外のリンク</a><a class="gf-link-quiet" href="#dev-links" data-state="hover">文章の外（ホバー時）</a><a class="gf-link-quiet" href="#dev-links" data-state="focus">文章の外（焦点）</a></p>
<nav aria-label="タブの見本">
<ul class="gf-tabs">
  <li><span aria-current="page">新着</span></li>
  <li><a href="#dev-links">改造された数</a></li>
  <li><a href="#dev-links" data-state="hover">いいねの数（ホバー時）</a></li>
  <li><a href="#dev-links" data-state="focus">プレイ数（焦点）</a></li>
</ul>
</nav>
</section>

<section class="dev-section" aria-labelledby="dev-chips">
<h2 id="dev-chips">チップ</h2>
<p class="dev-row"><a class="gf-chip" href="#dev-chips">アクション</a><a class="gf-chip" href="#dev-chips" data-state="hover">パズル（ホバー時）</a><a class="gf-chip gf-chip-current" href="#dev-chips" aria-current="true">選んでいるタグ</a><a class="gf-chip gf-chip-current" href="#dev-chips" aria-current="true" data-state="hover">選んでいるタグ（ホバー時）</a><a class="gf-chip" href="#dev-chips" data-state="focus">シューティング（焦点）</a></p>
<p class="dev-row"><span class="gf-chip">生成枠</span><span class="gf-chip gf-chip-emphasis">生成中</span><span class="gf-chip">下書き</span></p>
</section>

<section class="dev-section" aria-labelledby="dev-blocks">
<h2 id="dev-blocks">ブロックと、項目名と値の並び</h2>
<div class="dev-grid" style="grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr))">
<div class="gf-block">
  <p style="margin-top: 0"><strong>面のブロック</strong>。枠線も影も持たず、面の色と角丸で区切ります。</p>
  <p class="dev-row" style="margin-bottom: 0"><a class="gf-button gf-button-secondary gf-button-sm" href="#dev-blocks">面の上の副ボタン</a><a class="gf-chip" href="#dev-blocks" data-state="hover">面の上のチップ（ホバー時）</a></p>
</div>
<div class="gf-block">
  <dl class="gf-kv">
    <div><dt>作品 ID</dt><dd>01J9ZK7Q2M</dd></div>
    <div><dt>公開日時</dt><dd>2026-09-13 16:23</dd></div>
    <div><dt>Wasm のサイズ</dt><dd>1.2MB（配信時の圧縮後）</dd></div>
    <div><dt>いいね</dt><dd>3</dd></div>
  </dl>
</div>
</div>
<div class="gf-block gf-block-rows" style="margin-top: var(--gf-gap-3)">
  <div>行の区切り 1</div>
  <div>行の区切り 2</div>
</div>
</section>

<section class="dev-section" aria-labelledby="dev-forms">
<h2 id="dev-forms">入力欄</h2>
<form>
  <p><label for="dev-input">つくりたいゲーム</label><input id="dev-input" type="text" placeholder="例: 上から落ちてくるブロックを避けるゲーム"></p>
  <p><label for="dev-textarea">説明</label><textarea id="dev-textarea"></textarea></p>
  <p><button type="button" class="gf-button gf-button-primary">生成する</button></p>
</form>
</section>
`;
}
