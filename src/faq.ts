/**
 * よくある質問（`/faq`。2.3.1 v1.57 / M12-5 / #373）。
 *
 * ## 仕様と食い違わせない（#373 の constraints）
 *
 * **数は本文へ書き写さず、正本の定数から差し込む。** 生成枠（4.3 / 4.4）は `src/quota.ts`、
 * 自動の作り直し（5.2-7）は `src/build-retry.ts`、招待枠（8.1）は `src/invite-issuance.ts`
 * が持つ。**書き写すと、枠を変えた日にこの画面だけが古い数を案内し続ける**——しかも
 * 利用者はそれを見て「押しても動かない」と感じる（4.4 / 2.2）。
 *
 * 権利（5.6）と削除申請（8.4）は、**規約と削除申請の画面が正本である**。ここは要点だけを
 * 書き、行き先へリンクする。
 *
 * ## 実装済みのものだけを書く
 *
 * **招待枠の時限回復（v1.55 / #355）は #396 で実装した**ので、溜まる上限と戻る速さを
 * 書く（どちらも定数から。`INVITE_QUOTA` / `INVITE_RECOVERY_DAYS`）。#396 より前は未実装で、
 * 「戻る」とも「戻らない」とも書かずに「1 人 N 本まで」だけを書いていた。
 *
 * **対応ブラウザは、確かめている範囲だけを書く。** 実ブラウザの検査
 * （`scripts/check-sandbox-browser.sh` / `scripts/check-page-width.sh`）が回しているのは
 * Chromium 系だけで、それ以外は確かめていない。
 *
 * ## D1 を読まない
 *
 * 静的な画面である（#373 の constraints）。
 */
import { MAX_GENERATION_ATTEMPTS } from './build-retry.js';
import type { SiteViewer } from './html.js';
import { escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { INVITE_RECOVERY_DAYS } from './invite-balance.js';
import { INVITE_QUOTA } from './invite-issuance.js';
import { siteFooter } from './legal.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TERMS_PATH } from './legal-paths.js';
import { SIGNUP_PATH } from './paths.js';
import { DAILY_QUOTA_PER_USER, REVISIONS_PER_GAME } from './quota.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { CONTACT_EMAIL, CONTACT_MAILTO } from './service-contact.js';

/** 画面の `<title>`（パンくずの末尾にもこの名前が出る）。 */
export const FAQ_TITLE = 'よくある質問 - Game Forge';

/** 質問 1 件。 */
export interface FaqEntry {
  /** 画面の中で質問を指す id（`#` で直接開けるようにする）。 */
  readonly id: string;
  /** 質問（素の文字列。見出しになる）。 */
  readonly question: string;
  /** 答え（HTML。**利用者の入力を含まない固定文である**）。 */
  readonly answer: string;
}

/**
 * 質問の一覧。**並びは #373 の scope.in の順**（生成枠 / 招待 / 権利 / 改造されたくない /
 * 生成失敗時の枠 / 対応ブラウザ）で、そのあとに窓口の案内を足した。
 */
export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    id: 'quota',
    question: '生成枠はいつ戻りますか？',
    answer: `<p><strong>生成枠は 1 人 1 日 ${DAILY_QUOTA_PER_USER} 回で、日本時間の 0 時に戻ります。</strong>
   残りの回数は生成の画面に表示されます。</p>
<p>枠は「できた作品の数」ではなく、<strong>生成のために AI を呼び出した回数</strong>で数えます。
   新しく作る・改造する・推敲する（作り直す）のいずれも、同じ枠を使います。
   推敲は 1 作品につき ${REVISIONS_PER_GAME} 回までです。</p>
<p>これとは別に、<strong>サービス全体で 1 か月あたりの費用の上限</strong>があります。
   上限に達すると、個人の残りの回数にかかわらず、その月はサービス全体で生成が止まります。
   作品を遊ぶことと共有することは引き続きご利用いただけます。生成は翌月（日本時間）に再開します。</p>`,
  },
  {
    id: 'invite',
    question: '招待はどうすれば受けられますか？',
    answer: `<p>本サービスはクローズドβです。<strong>作品を作る・改造するには招待コードが必要です。</strong>
   作品を遊ぶことと URL を共有することには、招待は要りません。</p>
<p>招待コードは、すでに参加している方から受け取ってください。参加している方の招待枠は
   1 人 ${INVITE_QUOTA} 本まで溜まり、使うと ${INVITE_RECOVERY_DAYS} 日ごとに 1 本ずつ戻ります。</p>
<p>招待コードをお持ちでない方は、<a href="${SIGNUP_PATH}">登録の画面</a>から待機リストに登録できます。
   招待枠が空いたらご連絡します。</p>`,
  },
  {
    id: 'rights',
    question: '作った作品の権利は誰のものですか？',
    answer: `<p><strong>本サービスで生成した作品の権利は、生成した利用者に帰属します。</strong>
   本サービスは、作品を表示・配信・保存するために必要な範囲で、非独占かつ無償の利用許諾を受けます。</p>
<p>ただし、<strong>作品を公開すると、他の利用者がその作品を改造し、改造した作品を公開することを許諾したことになります。</strong>
   詳しくは<a href="${TERMS_PATH}">利用規約</a>の「生成物の権利」と「改変と再配布の許諾」をご覧ください。</p>`,
  },
  {
    id: 'no-fork',
    question: '自分の作品を改造されたくないときは、どうすればよいですか？',
    answer: `<p><strong>公開しなければ、改造されることはありません。</strong>
   改造できるのは公開された作品だけです。</p>
<p>公開の操作をするまで、作品を遊べる URL は作った本人にしか表示されません。
   作品ページの URL を知っている人がそのページを開いても、題名と「まだ公開されていません」という表示が出るだけで、遊ぶことも改造することもできません。</p>
<p>公開したまま改造だけを止める設定はありません。公開することが、改造を許諾する意思表示を含むためです。</p>
<p>公開した作品は、作品ページの「公開を取り下げる」からいつでも取り下げられます。取り下げると、共有した URL からは遊べなくなります。
   <strong>ただし、取り下げる前に作られた改造作品は消えません。</strong>
   改造作品の側では、元の作品が「削除済みの作品から派生」と表示されます。</p>`,
  },
  {
    id: 'failed-generation',
    question: '生成に失敗したとき、生成枠は戻りますか？',
    answer: `<p><strong>戻りません。</strong>枠は AI を呼び出した回数で数えるため、
   呼び出したあとで失敗しても、その回数ぶんは消費されます（呼び出した時点で費用が発生しているためです）。</p>
<p>作られたプログラムがビルドに失敗したときは、自動で作り直すことがあります。
   その場合、1 回の依頼で最大 ${MAX_GENERATION_ATTEMPTS} 回分の枠を使います。</p>
<p>指示文が入力の検査で止められたときは、AI を呼び出す前に止まるため、枠は減りません。</p>`,
  },
  {
    id: 'browser',
    question: '対応しているブラウザを教えてください。',
    answer: `<p><strong>動作を確かめているのは、Chromium 系のブラウザ（Google Chrome など）です。</strong>
   それ以外のブラウザでも動くことがありますが、動作は確かめていません。</p>
<p>作品を遊ぶには、JavaScript と WebAssembly が有効になっている必要があります。</p>`,
  },
  {
    id: 'contact',
    question: '不具合の報告や、ここにない質問はどこへ送ればよいですか？',
    answer: `<p><a href="${CONTACT_MAILTO}">${CONTACT_EMAIL}</a> までメールでお送りください。</p>
<p>ご自身の情報の開示・削除などのご請求も同じ窓口で受け付けます（<a href="${PRIVACY_PATH}">プライバシーポリシー</a>）。</p>
<p>本サービス上の作品があなたの権利を侵害している場合は、<a href="${TAKEDOWN_PATH}">削除申請フォーム</a>をお使いください（ログインは不要です）。
   不適切な作品を見つけたときは、ログインしたうえで、その作品ページの「この作品を通報する」からお知らせください。</p>`,
  },
];

/**
 * よくある質問の本文を組み立てる。
 *
 * **質問の一覧を先頭に置く**——390px の幅で 7 件を順に読ませると、知りたい答えまで
 * スクロールが長い。一覧から `#id` で飛べるようにする（JavaScript を使わない）。
 *
 * @param entries 質問の一覧
 * @returns HTML（外枠を含まない）
 */
export function faqBody(entries: readonly FaqEntry[]): string {
  const index = entries
    .map((entry) => `  <li><a href="#${entry.id}">${escapeHtml(entry.question)}</a></li>`)
    .join('\n');
  const items = entries
    .map(
      (entry) => `<section class="gf-faq-item" id="${entry.id}">
<h2>${escapeHtml(entry.question)}</h2>
${entry.answer}
</section>`,
    )
    .join('\n\n');
  return `<div class="gf-legal">
<h1>よくある質問</h1>
<ul class="gf-faq-index">
${index}
</ul>

${items}
</div>`;
}

/**
 * よくある質問の画面を組み立てる。
 *
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
function faqPage(viewer: SiteViewer): string {
  return `${siteHead({ title: FAQ_TITLE, viewer })}
${faqBody(FAQ_ENTRIES)}
${siteFooter()}
`;
}

/** よくある質問の経路。**ログインを要求しない**（2.3.1）。 */
export const faqRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: FAQ_PATH,
    handler: async (request, env) => html(faqPage(await resolveSiteViewer(request, env))),
  },
];
