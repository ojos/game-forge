/**
 * 利用規約と、権利者向けの削除申請フォーム（5.6 / 8.4 / #41）。
 *
 * ## 共通フッターはここが持つ
 *
 * #41 の acceptance は「**削除申請フォームが全ページのフッターから到達できる**」を
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
import { escapeHtml } from './signup.js';
import { MAX_BODY_LENGTH, MAX_CLAIMANT_LENGTH } from './takedown.js';

/** 利用規約のパス。 */
export const TERMS_PATH = '/terms';

/** 削除申請フォームのパス。 */
export const TAKEDOWN_PATH = '/takedown';

/** 削除申請の受け口。 */
export const TAKEDOWN_SUBMIT_PATH = '/api/takedown';

/** 削除申請を受け付けたあとの行き先。 */
export const TAKEDOWN_THANKS_PATH = '/takedown/thanks';

/** フォームの項目名（`name` と JSON の鍵の両方）。 */
export const TAKEDOWN_FIELDS = {
  gameId: 'game_id',
  name: 'claimant_name',
  contact: 'claimant_contact',
  body: 'body',
} as const;

/**
 * 全ページ共通のフッター（#41 の acceptance 2）。
 *
 * **各ページで組み立てない。** 1 か所に置き、全画面がこれを呼ぶ。
 *
 * @returns HTML
 */
export function siteFooter(): string {
  return `
<hr>
<footer class="gf-footer">
  <p><a href="/">トップへ</a>
   ・<a href="${TERMS_PATH}">利用規約</a>
   ・<a href="${TAKEDOWN_PATH}">権利者の方へ（削除申請）</a></p>
</footer>`;
}

/**
 * 規約が「まだ専門家の確認を受けていない」ことの但し書き。
 *
 * **画面にも出す**（冒頭の理由）。文言を 1 か所に置くのは、規約と削除申請の両方へ
 * 出すためである。
 */
const DRAFT_NOTICE = `<p class="gf-draft-notice"><strong>この規約はクローズドβ向けの暫定版です。</strong>
   法律の専門家による確認を受ける前の文面であり、正式公開までに変更されることがあります。</p>`;

/**
 * 利用規約の本文（5.6 / 8.4）。
 *
 * **仕様が名指しした項目には、どの節が求めているかを添えてある。** あとから読む人が
 * 「これは仕様に紐づいた条項か、一般的な雛形か」を見分けられるようにするため
 * （冒頭の但し書き）。
 */
const TERMS_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>利用規約 - Game Forge</title>
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
   公開した作品は、作品ページからいつでも取り下げられます。</p>
<p>ただし<strong>取り下げは、既にフォークされた作品には及びません。</strong>
   派生した作品は独立した作品として存続し、元の作品は「削除済みの作品から派生」と
   表示されます。</p>

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
<p>権利者の方からの削除申請は、<a href="${TAKEDOWN_PATH}">削除申請フォーム</a>で受け付けます。</p>

<h2>8. 免責</h2>
<p>本サービスは現状有姿で提供され、特定の目的への適合性、継続的な提供、
   データの保全について保証しません。<strong>本サービスはクローズドβであり、
   予告なく仕様の変更・機能の停止・サービスの終了を行うことがあります。</strong></p>
<p>本サービスの利用により利用者に生じた損害について、
   運営者の故意または重過失による場合を除き、責任を負いません。</p>

<h2>9. 規約の変更</h2>
<p>本規約は変更されることがあります。変更後の規約は本ページに掲示した時点で効力を生じます。
   重要な変更については、可能な範囲で事前に周知します。</p>

<h2>10. 準拠法および管轄</h2>
<p>本規約は日本法に準拠します。本サービスに関して紛争が生じた場合、
   運営者の所在地を管轄する裁判所を第一審の専属的合意管轄裁判所とします。</p>
${siteFooter()}
`;

/**
 * 削除申請フォーム（8.4 / #41 の acceptance 2）。
 *
 * **ログインを要求しない。** 権利者は本サービスの利用者とは限らない。
 *
 * **JavaScript を要求しない**（素の `<form>`。`src/publish.ts` と同じ形）。
 *
 * @param error 直前の申請が断られた理由（無ければ null）
 * @returns HTML
 */
function takedownPage(error: string | null): string {
  const message =
    error === null ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>削除申請 - Game Forge</title>
<h1>権利者の方へ（削除申請）</h1>
${message}
<p>本サービス上の作品が、あなたの権利を侵害していると思われる場合、
   このフォームからご連絡ください。<strong>ログインは不要です。</strong></p>
<p>お送りいただいた内容は記録され、運営者が確認します。
   <strong>申請をいただいた時点で作品が自動的に消えることはありません</strong>——
   内容を確認したうえで、削除・表示制限・申請を認めない、のいずれかを判断し、
   その結果を記録します。</p>

<form method="post" action="${TAKEDOWN_SUBMIT_PATH}">
  <p><label>対象の作品 URL または作品 ID<br>
    <input type="text" name="${TAKEDOWN_FIELDS.gameId}" required size="50">
  </label><br>
  <small>作品ページの URL（<code>/works/…</code>）に含まれる ID です。</small></p>

  <p><label>お名前または団体名（${MAX_CLAIMANT_LENGTH} 文字まで）<br>
    <input type="text" name="${TAKEDOWN_FIELDS.name}" required maxlength="${MAX_CLAIMANT_LENGTH}" size="40">
  </label></p>

  <p><label>ご連絡先（メールアドレス等。${MAX_CLAIMANT_LENGTH} 文字まで）<br>
    <input type="text" name="${TAKEDOWN_FIELDS.contact}" required maxlength="${MAX_CLAIMANT_LENGTH}" size="40">
  </label></p>

  <p><label>申請の内容（どの権利に基づき、何を求めるか。${MAX_BODY_LENGTH} 文字まで）<br>
    <textarea name="${TAKEDOWN_FIELDS.body}" required maxlength="${MAX_BODY_LENGTH}" rows="8" cols="60"></textarea>
  </label></p>

  <button type="submit">申請を送る</button>
</form>
${siteFooter()}
`;
}

/** 受け付けたあとの画面。 */
const TAKEDOWN_THANKS_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>削除申請を受け付けました - Game Forge</title>
<h1>削除申請を受け付けました</h1>
<p>ご連絡ありがとうございます。内容を確認し、記録したうえで対応します。</p>
<p><strong>確認には数日いただくことがあります。</strong>
   緊急を要する場合は、その旨を追記のうえ再度お送りください。</p>
${siteFooter()}
`;

/**
 * 規約と削除申請の経路。
 *
 * **受け口（POST）はここに置かない。** `src/takedown-routes.ts` が持つ——
 * このモジュールは画面（GET）だけを持ち、**D1 に触らない。**
 */
export const legalRoutes: readonly Route[] = [
  { method: 'GET', path: TERMS_PATH, handler: () => html(TERMS_HTML) },
  {
    method: 'GET',
    path: TAKEDOWN_PATH,
    handler: (request) => {
      // 断られたときは `?reason=` で戻ってくる（POST-redirect-GET）。
      const reason = new URL(request.url).searchParams.get('reason');
      return html(takedownPage(reason === null ? null : takedownMessageOf(reason)));
    },
  },
  { method: 'GET', path: TAKEDOWN_THANKS_PATH, handler: () => html(TAKEDOWN_THANKS_HTML) },
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
    'body-too-long': `申請の内容は ${MAX_BODY_LENGTH} 文字までです。`,
  };
  return Object.prototype.hasOwnProperty.call(messages, reason)
    ? messages[reason]!
    : '申請を受け付けられませんでした。内容をご確認ください。';
}
