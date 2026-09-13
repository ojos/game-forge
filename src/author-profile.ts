/**
 * 作者ページ（`/users/<user_id>`）に出す、自己紹介と外部リンク（#379 / M12-11 / 仕様 5.6・5.10）。
 *
 * **`src/users-page.ts` から描画の本体を出してある。** 作者ページのモジュールは作品の一覧の
 * SQL とカードの写しを持ち、並行する別の issue（#376）も同じファイルを触る。**プロフィールの
 * 描画をこちらに閉じれば、あちらに足すのは「列を読む」「呼ぶ」の数行で済む。**
 *
 * ## 出し方の規律
 *
 * - **自己紹介は `escapeHtml` を通してから改行を `<br>` にする**（順序に意味がある。作品の
 *   説明の `descriptionSection`（`src/work-page.ts`）と同じ）。空行で段落を分ける
 * - **リンクは表示の直前にもう一度検査する**（`parseStoredProfileLinks`。D1 を直接書き換えた値でも
 *   `javascript:` を `href` に入れない）。`href` も文字も `escapeHtml` を通す（引用符で属性を
 *   閉じさせない。5.10）
 * - **リンクの文字は `href` そのものを出す**（国際化ドメイン名は punycode のまま。見た目の似た
 *   ドメインを画面の上で見分けられるようにする。`src/profile.ts` の `normalizeProfileLink`）
 * - **`rel="nofollow ugc noopener"` と `target="_blank"` を付ける**（5.6 の v1.57 注記）
 * - **リンクを 1 本でも出すときは、「運営は検証していない」旨を必ず添える**（5.6 の懸念を、
 *   機構ではなく表示で受ける）。リンクが無ければ出さない（関係の無い但し書きを全作者に並べない）
 * - **どちらも無ければ何も出さない**（「自己紹介はありません」を全作者に並べない。
 *   `src/work-page.ts` の説明と同じ判断）
 *
 * **運営の印（`.gf-operator`）は出さない**（作者ページの冒頭。#334 の範囲を広げない）。
 */
import { escapeHtml } from './html.js';
import {
  PROFILE_LINKS_UNVERIFIED_NOTICE,
  PROFILE_LINK_REL,
  parseStoredProfileLinks,
} from './profile.js';

/** 作者ページに出すプロフィールの材料（`users` の行から読んだまま）。 */
export interface AuthorProfileView {
  /** `users.bio`（利用者の入力。**エスケープして出す**）。 */
  readonly bio: string | null;
  /** `users.profile_links`（JSON の文字列。**表示の直前に検査し直す**）。 */
  readonly links: string | null;
}

/**
 * 自己紹介を段落へ組む。
 *
 * @param bio 自己紹介
 * @returns HTML（空なら空文字）
 */
function bioParagraphs(bio: string): string {
  return bio
    .replace(/\r\n?/gu, '\n')
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/gu, '<br>\n')}</p>`)
    .join('\n');
}

/**
 * 作者ページのプロフィールの節を組み立てる。
 *
 * @param view `users` の行から読んだ自己紹介とリンク（無ければ undefined）
 * @returns HTML（出すものが無ければ空文字）
 */
export function renderAuthorProfile(view: AuthorProfileView | undefined): string {
  if (view === undefined) {
    return '';
  }
  const bio = typeof view.bio === 'string' ? bioParagraphs(view.bio) : '';
  const links = parseStoredProfileLinks(view.links);

  const parts: string[] = [];
  if (bio !== '') {
    parts.push(`<div class="gf-author-bio">\n${bio}\n</div>`);
  }
  if (links.length > 0) {
    const items = links
      .map((href) => {
        const escaped = escapeHtml(href);
        return `  <li><a href="${escaped}" rel="${PROFILE_LINK_REL}" target="_blank">${escaped}</a></li>`;
      })
      .join('\n');
    parts.push(`<ul class="gf-author-links" aria-label="外部リンク">
${items}
</ul>
<p class="gf-author-links-note">${escapeHtml(PROFILE_LINKS_UNVERIFIED_NOTICE)}</p>`);
  }
  if (parts.length === 0) {
    return '';
  }
  return `<section class="gf-author-profile" aria-label="プロフィール">
${parts.join('\n')}
</section>`;
}
