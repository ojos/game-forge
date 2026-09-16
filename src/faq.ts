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
 * **生成の待ち時間（#471 で足した「生成した作品はどうなりますか？」）も同じである。** 正本は生成画面の
 * `TYPICAL_WAIT_TEXT`（`src/generate-page.ts`）で、ここは import して差し込む。公開トップは #128 以来その写しを
 * 持っていた（循環参照で import できなかった）が、#471 でトップから外して FAQ へ移したので、写しは無くなった。
 *
 * 権利（5.6）と削除依頼（8.4）は、**規約と削除依頼の画面が正本である**。ここは要点だけを
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
import { READING_CLASS, escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { INVITE_RECOVERY_DAYS } from './invite-balance.js';
import { INVITE_QUOTA } from './invite-issuance.js';
import { TYPICAL_WAIT_TEXT } from './generate-page.js';
import { siteFooter } from './legal.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TERMS_PATH } from './legal-paths.js';
import { SIGNUP_PATH } from './paths.js';
import { DAILY_QUOTA_PER_USER } from './quota.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { CONTACT_EMAIL, CONTACT_MAILTO } from './service-contact.js';
import { HANDLE_RESERVATION_DAYS } from './handle.js';
import { WITHDRAWN_DISPLAY_NAME } from './withdrawal.js';

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
 * 質問の一覧。
 *
 * **先頭の 2 項目は #471 で新設した**（仕様 2.3.3 の #435 注記の表「外す文面の行き先」）——公開トップから外した
 * サイト説明の全文と、生成の待ち時間・下書き・公開の説明の行き先である。**初めて来た人がいちばん先に知りたいこと**
 * なので先頭に置く。**公開するまでの URL の見え方は重ねて書かず、既存の「自分の作品をフォークされたくないときは」へ
 * リンクする**（同じ注記の表）。
 *
 * **3 項目目は #513 で足した用語集（`glossary`）である。** フォークとリフォージの違いは、先頭の 2 項目で初めて
 * 出てくる語の説明なので、その直後に置く（先頭の 2 項目の順は `test/faq.test.ts` が見ている）。
 *
 * **4 項目目からは #373 の scope.in の順**（生成枠 / 招待 / 権利 / フォークされたくない /
 * 生成失敗時の枠 / 対応ブラウザ）で、そのあとに窓口の案内を足した。
 *
 * **作品の削除（`delete-work`）は #517 で足した。** 「フォークされたくない」の答えが取り下げを案内しているので、
 * その直後に置く（取り下げの次に来る操作である）。
 *
 * **退会（`withdraw`）は #518 で足した。** 作品の削除の直後に置く——「消す」の話が並び、
 * **作品を消すことと、アカウントごと消すことの違い**をその場で読み比べられる。削除の項目と
 * 窓口の項目からも `#withdraw` へ送る（#518 の scope.in）。
 */
export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    id: 'about',
    question: 'Game Forge はどんなサービスですか？',
    answer: `<p>プロンプト 1 行から、ブラウザで遊べる 2D ゲームが生まれるサービスです。
   気に入った作品は<strong>フォーク</strong>して、自分の 1 本として公開できます（<a href="#glossary">フォークとリフォージの違い</a>）。</p>
<p>現在は<strong>招待制のクローズドβ</strong>です。公開されている作品を遊ぶことと、作品の URL を共有することには、登録も招待も要りません。
   作品を作る・フォークするには招待コードが必要です（<a href="#invite">招待はどうすれば受けられますか？</a>）。</p>`,
  },
  {
    id: 'after-generation',
    question: '生成した作品はどうなりますか？',
    answer: `<p><strong>生成には${TYPICAL_WAIT_TEXT}。</strong>
   生成した作品は、まず<strong>下書き</strong>として保存されます。</p>
<p>作品ページで遊んで確かめてから、公開できます。
   公開するまでの URL の見え方は、<a href="#no-fork">自分の作品をフォークされたくないときは、どうすればよいですか？</a>をご覧ください。</p>`,
  },
  {
    id: 'glossary',
    question: '「フォーク」と「リフォージ」は何が違いますか？（用語集）',
    answer: `<p>どちらも、いまある作品のソースに指示文を足して、AI に作り直してもらう操作です。違うのは、<strong>何を対象にするか</strong>と、<strong>できたものがどう扱われるか</strong>です。</p>
<p><strong>フォーク</strong>: <strong>公開されている作品</strong>をもとに、<strong>新しい作品</strong>を作ります。
   元の作品はそのまま残り、できた作品はフォークした人の作品になります（まず下書きとして保存され、公開するまでほかの人には見えません）。
   できた作品のページには元の作品が「元ゲーム」として出て、元の作品のページの「このゲームからのフォーク」に数えられます。</p>
<p><strong>リフォージ</strong>: <strong>公開する前の自分の作品</strong>を作り直します。
   新しい作品は増えず、<strong>同じ作品が作り直したものに置き換わります</strong>。前の版は残り、作品ページからいつでも戻せます。
   フォークの数には数えません。公開したあとに手を加えたいときは、フォークしてください。</p>
<p>どちらも、新しく作るときと同じ<a href="#quota">1 日の生成枠</a>を共有します。</p>`,
  },
  {
    id: 'quota',
    question: '生成枠はいつ戻りますか？',
    answer: `<p><strong>生成枠は 1 人 1 日 ${DAILY_QUOTA_PER_USER} 回で、日本時間の 0 時に戻ります。</strong>
   残りの回数は生成の画面に表示されます。</p>
<p>枠は「できた作品の数」ではなく、<strong>生成のために AI を呼び出した回数</strong>で数えます。
   新しく作る・フォークする・リフォージする（<a href="#glossary">フォークとリフォージの違い</a>）のいずれも、同じ枠を使います。</p>
<p>これとは別に、<strong>サービス全体で 1 か月あたりの費用の上限</strong>があります。
   上限に達すると、個人の残りの回数にかかわらず、その月はサービス全体で生成が止まります。
   作品を遊ぶことと共有することは引き続きご利用いただけます。生成は翌月（日本時間）に再開します。</p>`,
  },
  {
    id: 'invite',
    question: '招待はどうすれば受けられますか？',
    answer: `<p>本サービスはクローズドβです。<strong>作品を作る・フォークするには招待コードが必要です。</strong>
   作品を遊ぶことと URL を共有することには、招待は要りません。</p>
<p>招待コードは、すでに参加している方から受け取ってください。参加している方の招待枠は
   1 人 ${INVITE_QUOTA} 本まで溜まり、使うと ${INVITE_RECOVERY_DAYS} 日ごとに 1 本ずつ戻ります。</p>
<p>招待コードをお持ちでない方は、<a href="${SIGNUP_PATH}">ログイン・登録の画面</a>から待機リストに登録できます。
   招待枠が空いたらご連絡します。</p>`,
  },
  {
    id: 'rights',
    question: '作った作品の権利は誰のものですか？',
    answer: `<p><strong>本サービスで生成した作品の権利は、生成した利用者に帰属します。</strong>
   本サービスは、作品を表示・配信・保存するために必要な範囲で、非独占かつ無償の利用許諾を受けます。</p>
<p>ただし、<strong>作品を公開すると、他の利用者がその作品をフォークし、フォークした作品を公開することを許諾したことになります。</strong>
   詳しくは<a href="${TERMS_PATH}">利用規約</a>の「生成物の権利」と「改変と再配布の許諾」をご覧ください。</p>`,
  },
  {
    id: 'no-fork',
    question: '自分の作品をフォークされたくないときは、どうすればよいですか？',
    answer: `<p><strong>公開しなければ、フォークされることはありません。</strong>
   フォークできるのは公開された作品だけです（<a href="#glossary">フォークとリフォージの違い</a>）。</p>
<p>公開の操作をするまで、作品を遊べる URL は作った本人にしか表示されません。
   作品ページの URL を知っている人がそのページを開いても、題名と「まだ公開されていません」という表示が出るだけで、遊ぶこともフォークすることもできません。</p>
<p>公開したままフォークだけを止める設定はありません。公開することが、フォークを許諾する意思表示を含むためです。</p>
<p>公開した作品は、作品ページの「公開を取り下げる」からいつでも取り下げられます。取り下げると、共有した URL からは遊べなくなります。
   <strong>ただし、取り下げる前に作られたフォーク作品は消えません。</strong>
   フォーク作品の側では、元の作品が「削除済みの作品から派生」と表示されます。</p>
<p>取り下げた作品は、さらに削除することもできます（<a href="#delete-work">作った作品を削除できますか？</a>）。</p>`,
  },
  {
    id: 'delete-work',
    question: '作った作品を削除できますか？',
    answer: `<p><strong>公開していない作品（下書き）と、公開を取り下げた作品は、作品ページから削除できます。</strong>
   作品ページの「この作品を削除する」を押すと、削除すると何が消えるかを確かめる画面が出ます。その画面でもう一度「この作品を削除する」を押すと、削除されます。</p>
<p><strong>削除すると元に戻せません。</strong>作品のソースコード・遊ぶためのファイル・紹介用の画像と、リフォージの前の版が消え、「あなたの作品」の一覧にも出なくなります。</p>
<p><strong>公開中の作品は、そのままでは削除できません。</strong>先に作品ページの「公開を取り下げる」で取り下げてから削除してください。
   生成中・リフォージ中の作品も、終わるまで削除できません。</p>
<p>削除しても、<strong>その作品をフォークして作られた作品は消えません</strong>。フォークした作品の側では、元の作品が「削除済みの作品から派生」と表示されます。
   また、その作品を作るために使った<a href="#quota">生成枠</a>は戻りません。</p>
<p>作品を削除しても、作品を作るときの指示文と生成の記録は残ります。通報や削除依頼への対応の記録がある作品は、対応を確かめられるように、記録と題名・説明の変更の履歴を残します（どちらも公開しません。<a href="${PRIVACY_PATH}">プライバシーポリシー</a>の「保存期間」）。</p>
<p>アカウントごと消したいときは<a href="#withdraw">退会できますか？</a>をご覧ください（退会すると、指示文も削除します）。</p>`,
  },
  {
    id: 'withdraw',
    question: '退会できますか？',
    answer: `<p><strong>できます。</strong>ログインしたうえで、登録情報の「アカウント」から「退会について確かめる」を開いてください。
   消えるもの・残るもの・戻せないことを確かめる画面が出ます。その画面で「退会する」を押すと退会します。</p>
<p><strong>退会すると元に戻せません。</strong>ログインできなくなり、<strong>あなたの作品はすべて取り下げられて削除されます</strong>。
   表示名は「${escapeHtml(WITHDRAWN_DISPLAY_NAME)}」になり、メールアドレス・自己紹介・外部リンク・アイコン・メール配信の設定と、作品を作るときの指示文も削除します。</p>
<p><strong>同じ Google アカウントでもう一度参加するには、新しい招待コードが必要です。</strong>退会前のアカウント・作品・招待枠には戻れません。</p>
<p><strong>生成中・リフォージ中の作品があるあいだは退会できません。</strong>終わってからお試しください。</p>
<p>退会しても、<strong>あなたの作品をフォークして作られた作品は消えません</strong>。生成の記録（回数・費用・日時）や、いいね・通報・招待の記録も残ります
   （匿名化した行に紐づくだけになります）。ハンドル名は退会から ${HANDLE_RESERVATION_DAYS} 日のあいだ、ほかの方が使えません。
   詳しくは<a href="${PRIVACY_PATH}">プライバシーポリシー</a>の「保存期間」と<a href="${TERMS_PATH}">利用規約</a>の「退会」をご覧ください。</p>`,
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
<p>ご自身の情報の開示・削除などのご請求も同じ窓口で受け付けます（<a href="${PRIVACY_PATH}">プライバシーポリシー</a>）。アカウントを消したいだけであれば、ご自身で<a href="#withdraw">退会</a>できます。</p>
<p>本サービス上の作品があなたの権利を侵害している場合は、<a href="${TAKEDOWN_PATH}">削除依頼フォーム</a>をお使いください（ログインは不要です）。
   不適切な作品を見つけたときは、ログインしたうえで、その作品ページの「この作品を通報する」からお知らせください。</p>`,
  },
];

/**
 * よくある質問の本文を組み立てる。
 *
 * **質問の一覧を先頭に置く**——390px の幅で 9 件を順に読ませると、知りたい答えまで
 * スクロールが長い。一覧から `#id` で飛べるようにする（JavaScript を使わない）。
 *
 * ## 見た目（仕様 2.5.3 / 2.5.4 / #471）
 *
 * - **質問の一覧はブロック（`.gf-block`）**で、器の幅いっぱいに面を置く。一覧のリンクは段落と箇条の中のリンクなので
 *   下線を常に出す（2.5.5「文章の中」）
 * - **質問と質問の間の罫線は器の端まで**（`.gf-faq-item` の上の線）。**答えの本文は 42rem のまま**（長い文を読ませる
 *   画面。行長を絞るのは段落の中身で、罫線ではない。2.5.3）
 * - **器は読み物の器**（`READING_CLASS`。42rem の幅で中央に置き、一覧のブロックと罫線もその端まで。仕様 2.5.3 / #564）
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
  return `<div class="gf-legal ${READING_CLASS}">
<h1>よくある質問</h1>
<div class="gf-block gf-faq-index">
<p class="gf-faq-index-title">質問の一覧</p>
<ul>
${index}
</ul>
</div>

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
  return `${siteHead({ title: FAQ_TITLE, viewer, reading: true })}
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
