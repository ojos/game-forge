/**
 * 利用規約と、権利者向けの削除依頼フォーム（5.6 / 8.4 / #41）。
 *
 * ## 共通フッターはここが持つ
 *
 * #41 の acceptance は「**削除依頼フォームが全ページのフッターから到達できる**」を
 * 求めている。**各ページが自分でリンクを書く形にすると、次に画面を足した日に
 * 書き忘れる**——書き忘れても見た目は正しいので、動作では気づけない。
 * {@link siteFooter} を 1 か所に置き、**全 SSR 画面がそれを呼ぶことを
 * `test/legal.test.ts` が経路表から導いて機械照合する。**
 *
 * ## 規約は法的助言ではない
 *
 * **書いたのは弁護士ではない**（2026-09-04 / #41）。5.6 と 8.4 が名指しした項目は
 * 仕様に紐づいているが、**一般条項（免責・準拠法・管轄・変更手続き）は根拠のない
 * 雛形である。** β 公開前に専門家の確認を受けること。**この但し書きは規約の画面にも
 * 出す**——読む人が「確認済みのもの」と誤解しないようにするため。
 */
import type { Route } from './routes.js';
import { html } from './routes.js';
import type { NavItem, SiteViewer } from './html.js';
import {
  READING_CLASS,
  escapeHtml,
  newsBreadcrumbParents,
  resolveSiteViewer,
  siteHead,
  siteLogo,
} from './html.js';
import {
  FAQ_PATH,
  PRIVACY_PATH,
  TAKEDOWN_PATH,
  TAKEDOWN_THANKS_PATH,
  TERMS_PATH,
} from './legal-paths.js';
import type { NewsArticle } from './news-articles.js';
import { NEWS_ARTICLES } from './news-articles.js';
import { CONTACT_MAILTO } from './service-contact.js';
import { MAX_BODY_LENGTH, MAX_CLAIMANT_LENGTH } from './takedown.js';

// 画面の綴りの正本は値だけの葉である（外枠がパンくずのために借りる。`src/legal-paths.ts`）。
// ここから再輸出するのは、既存の import（`src/takedown-routes.ts` やテスト）を動かさないため。
export { TAKEDOWN_PATH, TAKEDOWN_THANKS_PATH, TERMS_PATH } from './legal-paths.js';

/** 削除依頼の受け口。 */
export const TAKEDOWN_SUBMIT_PATH = '/api/takedown';

/** フォームの項目名（`name` と JSON の鍵の両方）。 */
export const TAKEDOWN_FIELDS = {
  gameId: 'game_id',
  name: 'claimant_name',
  contact: 'claimant_contact',
  body: 'body',
} as const;

/**
 * フッタの項目を並べる（2.3.7 の #435 注記 / 仕様 2.5.7 / #469）。
 *
 * ## 見出しの無い 6 項目である
 *
 * **お知らせ / よくある質問 / 利用規約 / プライバシーポリシー / お問い合わせ（メール） / 削除依頼（権利者の方）**
 * の順に並べ、**区画の見出しを置かない**（#331 の 3 区画を #435 が覆した）。並びと文言の正本は仕様 2.3.7 の
 * #435 注記で、ここはその写しである。
 *
 * - **「作品をさがす」「つくる」を置かない**——全画面のヘッダにあり、同じ行き先を 1 画面に 2 度並べない
 * - **お問い合わせのラベルにアドレスを出さない**（#373 の実装注記を #435 が覆した）。アドレスは FAQ と
 *   `/privacy` の窓口に文字で出ている。ラベルは「押すとメールが開く」ことを伝える役に絞り、2 列の幅を押し広げない
 * - **削除依頼は窓口の名前を先に置く**（「削除依頼（権利者の方）」）。6 項目がどれも行き先の名前から始まる
 * - **会社情報・SNS は置かない**（行き先が実在しない。2.3.14）
 *
 * ## お知らせの記事が 0 本なら「お知らせ」を出さない
 *
 * **そのとき `src/news.ts` は一覧の経路を登録しない**（空の一覧を置かない。2.3.1 の #375 注記）ので、残すと
 * 行き先の無いリンクになる（4.4 / 2.2）。パンくずの親と同じ条件で決める（`src/html.ts` の `newsBreadcrumbParents`）。
 *
 * **`/takedown` と一般の問い合わせ（`mailto:`）を混ぜない。** 前者は権利者向けの窓口で、一般の利用者の
 * 不具合報告の行き先ではない（2.3.7 v1.57 の注記）——別の項目として並べる。
 *
 * @param articles お知らせの記事（画面が使う {@link NEWS_ARTICLES} を渡す。検査は 0 本も渡す）
 * @returns 並べる項目（6 項目。記事が 0 本なら 5 項目）
 */
export function footerItems(articles: readonly NewsArticle[]): readonly NavItem[] {
  return [
    ...newsBreadcrumbParents(articles),
    { path: FAQ_PATH, label: 'よくある質問' },
    { path: TERMS_PATH, label: '利用規約' },
    { path: PRIVACY_PATH, label: 'プライバシーポリシー' },
    { path: CONTACT_MAILTO, label: 'お問い合わせ（メール）' },
    { path: TAKEDOWN_PATH, label: '削除依頼（権利者の方）' },
  ];
}

/**
 * 全ページ共通のフッター（#41 の acceptance 2。#469 で仕様 2.5.7 の形にした）。
 *
 * **各ページで組み立てない。** 1 か所に置き、全画面がこれを呼ぶ。
 *
 * ## 左にロゴ、右に項目を 2 列（仕様 2.5.7）
 *
 * 並べる項目は {@link footerItems} が持つ。**上の罫線は器の端から端まで**で、フッタ自身の上の線として引く
 * （#469 の前は `<hr>` を置いていた。`<hr>` は `@section base` の余白と濃い線を持ち、ヘッダの下の線と揃わない）。
 * **項目は文章の外のリンク**（`.gf-link-quiet`。仕様 2.5.5）。組み方（2 列の格子・狭い段で縦に積む）は
 * app.css の `@section footer` と `@section shell` が持つ。
 *
 * ## ログイン状態で出し分けない
 *
 * **フッタに本人だけの画面を置いていない**ので、ここは誰に対しても同じものになる
 * （出し分けはヘッダだけが持つ。`src/html.ts` の `siteHeader`）。引数を取らない形を
 * 保てば、**POST の結果を返す画面も同じフッタに乗る。**
 *
 * ## 「トップへ」を持たない
 *
 * **ヘッダのロゴが `/` を指しており、それが全画面に出る**（`src/html.ts`）。#331 まで
 * フッタが持っていたのは、ヘッダがサービス名 1 行だけだった時期の名残である。
 * 同じ行き先への導線を 1 画面に 2 つ置かない。
 *
 * **だからフッタのロゴ（#440）はリンクにしない。** 置くのはサービスの印としての画像だけで、
 * `/` への導線はヘッダのロゴが持つ（PR #442 の Copilot code review）。
 *
 * @returns HTML
 */
export function siteFooter(): string {
  const items = footerItems(NEWS_ARTICLES)
    .map((item) => `      <li><a class="gf-link-quiet" href="${item.path}">${escapeHtml(item.label)}</a></li>`)
    .join('\n');
  return `
<footer class="gf-footer">
  <div class="gf-footer-logo">${siteLogo()}</div>
  <nav class="gf-footer-nav" aria-label="フッタの行き先">
    <ul>
${items}
    </ul>
  </nav>
</footer>`;
}

/**
 * 規約が「まだ専門家の確認を受けていない」ことの但し書き。
 *
 * **画面にも出す**（冒頭の理由）。文言を 1 か所に置くのは、規約と削除依頼の両方へ
 * 出すためである。
 *
 * **見た目はブロック（`.gf-block`）である**（仕様 2.5.3 / 2.5.4 / #471）。器の幅いっぱいに面を置き、左の太い線は
 * 持たない（app.css の `@section legal`）。
 */
const DRAFT_NOTICE = `<p class="gf-block gf-draft-notice"><strong>この規約はクローズドβ向けの暫定版です。</strong>
   法律の専門家による確認を受ける前の文面であり、正式公開までに変更されることがあります。</p>`;

/**
 * ロゴの書体の表示（#440 / `docs/logo.md` 5 章）。
 *
 * **ロゴの文字は DotGothic16（SIL Open Font License 1.1）のグリフで描いてある。** ロゴの画像に
 * 表示が要るかは断定していない（法的助言ではない）が、`docs/logo.md` 5 章は**安全側に倒して、
 * 画像を 1 枚だけ使う場面では表示を添える**と決めている。サイトのヘッダとフッタはその場面に
 * あたるので、**全画面のフッタから 1 手で届く利用規約の末尾に置く**（#440 の intake で利用者が
 * 選んだ。フッタの項目は増やさない）。
 *
 * **著作権表示の文字列は `third_party/dotgothic16/NOTICE.md` と同じにする。**
 */
export const LOGO_FONT_NOTICE =
  'ロゴの文字: DotGothic16（Copyright 2020 The DotGothic16 Project Authors、SIL Open Font License 1.1）';

/**
 * 利用規約の本文（5.6 / 8.4）。
 *
 * **仕様が名指しした項目には、どの節が求めているかを添えてある。** あとから読む人が
 * 「これは仕様に紐づいた条項か、一般的な雛形か」を見分けられるようにするため
 * （冒頭の但し書き）。
 *
 * **読み物の器（`.gf-legal`）で包む**（#471）。`/privacy` と `/faq` と同じ器に乗せ、但し書きのブロックと小見出しの
 * 見た目を 3 画面で揃える（app.css の `@section legal`）。**器は読み物の器**（`READING_CLASS`。画面の器と同じ幅で左端から組む。
 * 仕様 2.5.3 / #564 / #761）。
 */
const TERMS_BODY = `<div class="gf-legal ${READING_CLASS}">
<h1>利用規約</h1>
${DRAFT_NOTICE}

<h2>1. 適用</h2>
<p>本規約は、Game Forge（以下「本サービス」）の利用条件を定めるものです。
   本サービスを利用した時点で、本規約に同意したものとみなします。</p>

<h2>2. 招待制</h2>
<p>本サービスはクローズドβとして運営しています。<strong>作品の生成には招待コードが必要です。</strong>
   遊ぶことと URL の共有に招待は要りません。</p>

<h2>3. 生成物の権利</h2>
<p><strong>本サービスで生成された作品の権利は、生成した利用者に帰属します。</strong></p>
<p>利用者は本サービスに対し、作品を本サービス上で表示・配信・保存するために必要な範囲で、
   <strong>非独占的かつ無償の利用許諾</strong>を与えるものとします。この許諾は、
   本サービスの運営に必要な範囲を超えて利用者の権利を制限するものではありません。</p>

<h2>4. 改変と再配布の許諾</h2>
<p><strong>公開された作品は、他の利用者が改変（フォーク）し、その結果を自分の作品として
   公開することを許諾するものとします。</strong></p>
<p>これは本サービスの中心的な仕組みであり、<strong>作品を「公開」する操作は、この許諾を
   与える意思表示を含みます。</strong>公開したくない作品は、公開せずに保持できます。
   公開した作品は、作品ページからいつでも公開をやめて下書きに戻せます。</p>
<p>ただし<strong>公開をやめても、既にフォークされた作品には及びません。</strong>
   派生した作品は独立した作品として存続し、元の作品は「まだ公開されていない作品から派生」と
   表示されます。</p>
<p>利用者は、<strong>自分の作品のうち、公開していない作品（下書き）を、
   作品ページから削除できます。</strong>削除した作品は元に戻せません。
   <strong>削除も、既にフォークされた作品には及びません。</strong></p>

<h2>5. 生成物の正確性</h2>
<p><strong>生成された内容に含まれる事実の主張については、正確性を独自に確認することなく
   依拠しないでください。</strong>本サービスは大規模言語モデルを用いており、
   生成物が事実と異なる場合があります。</p>

<h2>6. 禁止事項</h2>
<p>次の行為を禁止します。</p>
<ul>
  <li>法令または公序良俗に違反する内容の生成・公開</li>
  <li>他者の著作権・商標権その他の権利を侵害する内容の生成・公開</li>
  <li>他者を誹謗中傷し、または差別を助長する内容の生成・公開</li>
  <li>本サービスの運営を妨害する行為</li>
  <li>招待コードの販売・譲渡</li>
</ul>

<h2>7. 削除および利用停止</h2>
<p><strong>本サービスは、本規約に違反する内容、または権利侵害の申し立てを受けた内容について、
   事前の通知なく削除または非表示にすることができます。</strong></p>
<p>あわせて、違反した利用者のアカウントを停止し、その利用者を招待した利用者の招待枠を
   停止することがあります。</p>
<p>権利者の方からの削除依頼は、<a href="${TAKEDOWN_PATH}">削除依頼フォーム</a>で受け付けます。</p>

<h2>8. 退会</h2>
<p><strong>利用者は、自分の意思で退会できます。</strong>ただし、<strong>生成中・リフォージ中の
   作品があるあいだは退会できません</strong>（費用の記録を欠かさないためです。終わってから
   お手続きください）。退会すると、本サービスへログイン
   できなくなり、<strong>利用者の作品はすべて取り下げたうえで削除されます。</strong>
   登録情報（Google アカウントとの結び付き・メールアドレス・表示名・自己紹介・外部リンク・
   アイコン）も削除または匿名化します。詳しくは<a href="${PRIVACY_PATH}">プライバシーポリシー</a>の
   「保存期間」をご覧ください。</p>
<p><strong>退会は取り消せません。</strong>同じ Google アカウントでもう一度参加する場合も、
   新しい招待コードが必要であり、退会前のアカウント・作品・招待枠には戻れません。</p>
<p><strong>退会も、既にフォークされた作品には及びません。</strong>派生した作品は独立した作品として
   存続し、元の作品は「削除済みの作品から派生」と表示されます。</p>
<p>本規約に違反した利用者について、運営者が上の 7 に基づく措置を行うことは、
   その利用者が退会したかどうかにかかわりません。</p>

<h2>9. 免責</h2>
<p>本サービスは現状有姿で提供され、特定の目的への適合性、継続的な提供、
   データの保全について保証しません。<strong>本サービスはクローズドβであり、
   予告なく仕様の変更・機能の停止・サービスの終了を行うことがあります。</strong></p>
<p>本サービスの利用により利用者に生じた損害について、
   運営者の故意または重過失による場合を除き、責任を負いません。</p>

<h2>10. 規約の変更</h2>
<p>本規約は変更されることがあります。変更後の規約は本ページに掲示した時点で効力を生じます。
   重要な変更については、可能な範囲で事前に周知します。</p>

<h2>11. 準拠法および管轄</h2>
<p>本規約は日本法に準拠します。本サービスに関して紛争が生じた場合、
   運営者の所在地を管轄する裁判所を第一審の専属的合意管轄裁判所とします。</p>

<h2>ロゴの書体について</h2>
<p>${LOGO_FONT_NOTICE}</p>
</div>`;

/**
 * 利用規約の画面を組み立てる。
 *
 * **本文（{@link TERMS_BODY}）は定数のままにする。** 変わるのは外枠だけで、規約の
 * 文面はログイン状態に依存しない。
 *
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
function termsPage(viewer: SiteViewer): string {
  return `${siteHead({ title: '利用規約 - Game Forge', viewer, reading: true })}
${TERMS_BODY}
${siteFooter()}
`;
}

/**
 * 削除依頼フォーム（8.4 / #41 の acceptance 2）。
 *
 * **ログインを要求しない。** 権利者は本サービスの利用者とは限らない。
 *
 * **JavaScript を要求しない**（素の `<form>`。`src/publish.ts` と同じ形）。
 *
 * **入力欄は面のブロック（`.gf-block`）に置き、「依頼を送る」はこの画面で 1 つだけの主のボタンにする**（仕様 2.5.4 / 2.5.5 / #473）。
 * **`gf-form-fields` は、入力欄を `<p>` で包んだフォームの印**で、送信ボタンを行の右端に置く（app.css の `@section forms`。#767）。
 * 項目とその並びは変えていない（承認したモックアップ Version 6 は広い段で先頭の 2 欄を横に並べるが、縦に積んだまま。#473 の PR の本文）。
 *
 * @param error 直前の依頼が断られた理由（無ければ null）
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
function takedownPage(error: string | null, viewer: SiteViewer): string {
  const message =
    error === null ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`;
  return `${siteHead({ title: '削除依頼 - Game Forge', viewer })}
<h1>権利者の方へ（削除依頼）</h1>
${message}
<p>本サービス上の作品が、あなたの権利を侵害していると思われる場合、
   このフォームからご連絡ください。<strong>ログインは不要です。</strong></p>
<p>お送りいただいた内容は記録され、運営者が確認します。
   <strong>依頼をいただいた時点で作品が自動的に消えることはありません</strong>——
   内容を確認したうえで、削除・表示制限・依頼を認めない、のいずれかを判断し、
   その結果を記録します。</p>

<!-- 入力欄に size / cols を置かない。size="50" は幅 390px の端末で layout viewport を
     498px へ広げ、ページ全体を縮めたうえで欄がはみ出す（#282 で実測）。文字数の上限は
     maxlength が持ち、見た目の幅は M8-1 の app.css が与える。 -->
<form class="gf-block gf-form-fields" method="post" action="${TAKEDOWN_SUBMIT_PATH}">
  <p><label>対象の作品 URL または作品 ID<br>
    <input type="text" name="${TAKEDOWN_FIELDS.gameId}" required>
  </label><br>
  <small>作品ページの URL（<code>/works/…</code>）に含まれる ID です。</small></p>

  <p><label>お名前または団体名（${MAX_CLAIMANT_LENGTH} 文字まで）<br>
    <input type="text" name="${TAKEDOWN_FIELDS.name}" required maxlength="${MAX_CLAIMANT_LENGTH}">
  </label></p>

  <p><label>ご連絡先（メールアドレス等。${MAX_CLAIMANT_LENGTH} 文字まで）<br>
    <input type="text" name="${TAKEDOWN_FIELDS.contact}" required maxlength="${MAX_CLAIMANT_LENGTH}">
  </label></p>

  <p><label>依頼の内容（どの権利に基づき、何を求めるか。${MAX_BODY_LENGTH} 文字まで）<br>
    <textarea name="${TAKEDOWN_FIELDS.body}" required maxlength="${MAX_BODY_LENGTH}" rows="8"></textarea>
  </label></p>

  <button type="submit" class="gf-button gf-button-primary">依頼を送る</button>
</form>
${siteFooter()}
`;
}

/**
 * 受け付けたあとの画面。
 *
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
function takedownThanksPage(viewer: SiteViewer): string {
  // **検索避けする**（#610）。**操作を終えた人だけが見る画面**で、検索から来ても
  // その人には何も起きていない（依頼は送られていない）。サイトマップからも外してある
  // （`src/sitemap.ts` の `SITEMAP_EXCLUDED_PATHS`）が、**載せないことと索引に載せないことは別**
  // ——サイトマップに無くても、クローラは辿り着けば載せる。
  return `${siteHead({ title: '削除依頼を受け付けました - Game Forge', noindex: true, viewer })}
<h1>削除依頼を受け付けました</h1>
<p>ご連絡ありがとうございます。内容を確認し、記録したうえで対応します。</p>
<p><strong>確認には数日いただくことがあります。</strong>
   緊急を要する場合は、その旨を追記のうえ再度お送りください。</p>
${siteFooter()}
`;
}

/**
 * 規約と削除依頼の経路。
 *
 * **受け口（POST）はここに置かない。** `src/takedown-routes.ts` が持つ——
 * このモジュールは画面（GET）だけを持ち、**D1 に触らない。**
 */
export const legalRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: TERMS_PATH,
    handler: async (request, env) => html(termsPage(await resolveSiteViewer(request, env))),
  },
  {
    method: 'GET',
    path: TAKEDOWN_PATH,
    handler: async (request, env) => {
      // 断られたときは `?reason=` で戻ってくる（POST-redirect-GET）。
      const reason = new URL(request.url).searchParams.get('reason');
      return html(
        takedownPage(
          reason === null ? null : takedownMessageOf(reason),
          await resolveSiteViewer(request, env),
        ),
      );
    },
  },
  {
    method: 'GET',
    path: TAKEDOWN_THANKS_PATH,
    handler: async (request, env) =>
      html(takedownThanksPage(await resolveSiteViewer(request, env))),
  },
];

/**
 * 断られた理由を、画面に出す文言へ写す。
 *
 * **`reason` は query から来るため、表に無い値は既定の文言へ倒す**
 * （`src/invite-issuance.ts` と同じ規律。未知の値を出力へ通すと反射型の差し込みになる）。
 *
 * @param reason 断られた理由
 * @returns 表示する文言
 */
export function takedownMessageOf(reason: string): string {
  const messages: Readonly<Record<string, string>> = {
    'invalid-game-id': '対象の作品 URL または ID をご確認ください。',
    'missing-field': 'すべての項目にご記入ください。',
    'claimant-too-long': `お名前とご連絡先は ${MAX_CLAIMANT_LENGTH} 文字までです。`,
    'body-too-long': `依頼の内容は ${MAX_BODY_LENGTH} 文字までです。`,
  };
  return Object.prototype.hasOwnProperty.call(messages, reason)
    ? messages[reason]!
    : '依頼を受け付けられませんでした。内容をご確認ください。';
}
