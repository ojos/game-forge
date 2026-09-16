/**
 * 作者のプロフィール——自己紹介と外部リンク（#379 / M12-11 / 仕様 5.6・5.10）の、形の検査と保存。
 *
 * 画面（`/account` のプロフィールのタブ）と口は `src/account.ts`、作者ページでの描画は
 * `src/author-profile.ts` が持つ。**ここは D1 の 1 行と、利用者の入力の間に立つ部品だけを持つ。**
 * `src/account.ts` を import しない（あちらがここを import する。循環させない）。
 *
 * ## 入力側モデレーション（8.2）は通さない。8.3 の表を掛ける
 *
 * 5.10 は「自己紹介を 8.2 の対象にするかを M12-11 が決める」と書いた。**決定は「8.2 は通さず、
 * 8.3 の表（`inspectText`）を自己紹介とリンクの両方に掛ける」である**（題名の改名 #366 と
 * 作品の説明 #388 と同じ形）。
 *
 * 1. **8.2 はエッジで呼べない。** Bedrock Guardrails の適用はオーケストレータ Lambda で行い、
 *    エッジには Bedrock の資格情報が無い（8.2。#160 で Pages のシークレットから外した）。
 *    自己紹介のためにエッジへ長命のアクセスキーを戻すのは、8.2 が退けた取引そのものである
 * 2. **8.2 が守っているのは LLM 呼び出しの前である**（枠と費用。確定25）。自己紹介は LLM へ
 *    渡らず、止めて守れる費用が無い。**公開される自由文であることは作品の説明と同じ**で、
 *    説明が 8.3 で受けている以上、自己紹介だけを別の層で受ける理由が無い
 * 3. **呼べないときは遮断へ倒す（fail-closed）という 8.2 の規律を、プロフィールの保存に
 *    持ち込むと、AWS の障害で自己紹介が書けなくなる。** 8.3 の表はコードに置いた同期の
 *    純粋関数で、落ちる経路が無い（確定29）
 *
 * **落ちたときに、語も分類も応答に出さない**（改名・説明と同じ。当てては消しを繰り返せば
 * 表が 1 語ずつ復元できる）。**取りこぼしは 8.3 の冒頭のとおり避けられない**——残りは 8.4 の
 * 運用（運営が D1 を直す・BAN）が受ける。
 *
 * ## 自己紹介の形は、作品の説明と同じ規則にする（ただし上限は 500）
 *
 * **禁じる文字の組は、作品の説明（`src/games.ts` の `validateDescription`）と同じ**——表示名の
 * 組から改行（LF）だけを除いたもの。**`src/games.ts` を import しない。** あちらの検査は
 * 上限（1000）を関数の中に持っており、共有するには上限を引数へ出す編集が要る。**`src/games.ts`
 * はオーケストレータの束に入っている**（`scripts/bundle-orchestrator.sh`）ので、画面の都合の
 * 編集が束（CodeSha256）を変えると、配り直すまで main の配備が止まる（PR #401 で実測した形）。
 * **組が一致していることは `test/profile.test.ts` が表示名の検査と文字ごとに突き合わせる**
 * （説明の検査と同じ形。書き写した組は必ず腐る。shared-ai-rules 12 章）。
 *
 * ## 外部リンクは、構文解析してから `https:` に限る（5.6 の覆しの受け方）
 *
 * {@link normalizeProfileLink} を参照。**保存の前と表示の直前の 2 か所で、同じ関数を通す。**
 * 表示の直前にも通すのは、D1 を直接 UPDATE した値（運営の手作業）でも `javascript:` が
 * `href` に入らないようにするためである——**守る場所を「書く経路」だけに置くと、書く経路の
 * 外から入った値は守られない。**
 */
import { escapeHtml } from './html.js';
import { inspectText } from './output-moderation.js';
import { ACCOUNT_PROFILE_PATH, BIO_FIELD, PROFILE_LINK_FIELD } from './profile-paths.js';
import { NOT_WITHDRAWN_SQL } from './withdrawal-sql.js';

/**
 * 自己紹介の最大の長さ（**コードポイントで数える**）。
 *
 * **500 文字。** 自己紹介に入れたいのは、何を作っている人かの数行と、活動の場所の案内である
 * （リンクは別の欄に 3 本ある）。作品の説明（1000 文字）より短いのは、**作者ページの主役が
 * 並んでいる作品だから**である（M8 の「作品を主役にする」）——見出しの下に長い文章が来ると、
 * 狭い端末では作品のカードが画面の外へ押し出される。
 *
 * **数え方は作品の説明と同じ**（`\r\n` を `\n` へ畳んでから数え、改行は 1 文字）。
 * 履歴（`profile_changes`）は変更のたびに旧い値と新しい値の両方を持つ（3.6）。
 */
export const BIO_MAX_LENGTH = 500;

/** 外部リンクの最大の本数（5.6 の v1.57 注記 / 5.10）。 */
export const PROFILE_LINK_MAX_COUNT = 3;

/**
 * 外部リンク 1 本の最大の長さ（文字数）。
 *
 * **入力のコードポイントと、正規化した後の `href` の両方をこの値で見る。** `href` は
 * 日本語の経路をパーセント符号化し、国際化ドメイン名を punycode にするので、入力より
 * 長くなる。**保存して作者ページに出すのは `href` なので、上限もそちらに掛ける**
 * （入力の側で見るのは、解析の前に長すぎる入力を落とすため）。
 *
 * **500 文字。** 普通の SNS のプロフィールの URL は 100 文字に届かない。上限は利用者の
 * 文章量ではなく、D1 の 1 行と作者ページの 1 画面を守るために置く。
 */
export const PROFILE_LINK_MAX_LENGTH = 500;

/**
 * 自己紹介かリンクを変えてから、次の変更を受け付けるまでの秒数（3.6）。
 *
 * **表示名の `DISPLAY_NAME_CHANGE_INTERVAL_SECONDS` と同じ考え方・同じ値である。** 1 回の変更は
 * `users` の 1 行と、履歴と索引の 2 行を書く。**自己紹介とリンクで 1 つの時刻を共有する**
 * ——1 つのフォームで送るので、片方だけを連打する経路が無い。
 */
export const PROFILE_CHANGE_INTERVAL_SECONDS = 60;

/** プロフィールの変更の履歴を持つ表の名前（`migrations/` の user_profile）。 */
export const PROFILE_CHANGES_TABLE = 'profile_changes';

/**
 * 外部リンクに付ける `rel`（5.6 の v1.57 注記 / #379 の constraints）。
 *
 * - `nofollow` / `ugc` … **リンク元の信用を渡さない**（検索エンジンに、利用者が書いたリンクだと言う）
 * - `noopener` … 開いた先から `window.opener` で元の画面を書き換えさせない
 *
 * **`noreferrer` は足さない**（constraints が指定した 3 語に揃える）。`noopener` だけで
 * 開いた先からの操作は止まり、送られるのは作者ページの URL（公開の画面）だけである。
 */
export const PROFILE_LINK_REL = 'nofollow ugc noopener';

/**
 * 「運営は検証していない」旨の文言（5.6 の懸念を、機構ではなく表示で受ける）。
 *
 * **作者ページ（読む人）と `/account`（書く人）の両方に出す。** 文言を 1 か所に置くのは、
 * 片方だけが言い回しを変えて意味がずれることを防ぐためである。
 */
export const PROFILE_LINKS_UNVERIFIED_NOTICE =
  'これらのリンクは作者本人の申告によるものです。運営はリンク先が本人のものかを確認していません。';

/**
 * 自己紹介に含めてはいけない文字。**改行（LF）だけを除いた、表示名と同じ組である。**
 *
 * 作品の説明（#388）と同じ組である（冒頭）。CR は {@link validateBio} が先に LF へ畳む。
 */
const BIO_FORBIDDEN_CHARACTER = /(?!\n)[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * 文字の向きを変える書式文字（Unicode の `Bidi_Control`）。
 *
 * **自己紹介は作者名の直下に出る**（作者ページ）。表示名が弾く理由（5.9「名前の側から印の
 * 見え方を動かせてはいけない」）がそのまま当てはまる。
 */
const DIRECTION_CHARACTER = /\p{Bidi_Control}/u;

/** 形の検査で断る理由（自己紹介）。 */
export type BioRejection = 'bio-too-long' | 'bio-forbidden-character';

/** 形の検査で断る理由（外部リンク）。 */
export type ProfileLinkRejection = 'link-invalid' | 'link-not-https' | 'link-credentials' | 'link-too-long';

/**
 * 保存を受け付けなかった理由（`/account?reason=` に載る綴り）。
 *
 * - `too-many-links` … 空でないリンクが {@link PROFILE_LINK_MAX_COUNT} 本を超えた
 *   （画面の入力欄は 3 つなので、手で組んだ要求だけがここへ来る）
 * - `profile-denied-term` … 8.3 の表に当たった。**語も分類も、どの欄かも添えない**
 * - `profile-too-soon` … 前回の変更から {@link PROFILE_CHANGE_INTERVAL_SECONDS} 秒経っていない
 * - `profile-too-large` … 本文が大きすぎて読まなかった（どの欄が長いかは分からない）
 * - `profile-failed` … D1 の失敗など
 */
export type ProfileRejection =
  | BioRejection
  | ProfileLinkRejection
  | 'too-many-links'
  | 'profile-denied-term'
  | 'profile-too-soon'
  | 'profile-too-large'
  | 'profile-failed';

/** 保存する形へ落としたプロフィール。 */
export interface Profile {
  /** 自己紹介（正規化後。空文字なら書いていない）。 */
  readonly bio: string;
  /** 外部リンク（{@link normalizeProfileLink} を通った `href`。0〜3 本）。 */
  readonly links: readonly string[];
}

/** 形の検査の結果。 */
export type ProfileValidation =
  | { readonly ok: true; readonly profile: Profile }
  | { readonly ok: false; readonly reason: ProfileRejection };

/**
 * 自己紹介を検査し、保存する形へ落とす。
 *
 * **規則は作品の説明（`validateDescription`）と同じで、上限だけが違う**（冒頭）。
 *
 * 1. `\r\n` と `\r` を `\n` へ畳む（ブラウザは `<textarea>` の改行を `\r\n` で送る）
 * 2. **禁じた文字を含めば断る。`trim` の前に見る**——`trim` は U+2028 / U+2029 とタブも除くので、
 *    後に見ると端に置いた禁じた文字が黙って消えて通る（PR #401 の Copilot レビュー）
 * 3. 前後の空白（改行を含む）を除く（空白だけなら空文字＝書いていない）
 * 4. **{@link BIO_MAX_LENGTH} を超えれば断る。黙って切らない**——文章の末尾を落として公開すると、
 *    作者が見ている文章と作者ページの文章が食い違う
 *
 * **HTML に効く文字（`<` `"` など）は通す。** 防ぐのは出力側のエスケープである
 * （5.9「保存時の制約は XSS を防がない」）。
 *
 * @param raw 入力された自己紹介（正規化前）
 * @returns 保存する値、または断る理由
 */
export function validateBio(
  raw: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: BioRejection } {
  const unified = raw.replace(/\r\n?/gu, '\n');
  if (BIO_FORBIDDEN_CHARACTER.test(unified) || DIRECTION_CHARACTER.test(unified)) {
    return { ok: false, reason: 'bio-forbidden-character' };
  }
  const value = unified.trim();
  // スプレッドはコードポイントごとに分ける（サロゲート対を 1 つに数える）。
  if ([...value].length > BIO_MAX_LENGTH) {
    return { ok: false, reason: 'bio-too-long' };
  }
  return { ok: true, value };
}

/**
 * 外部リンク 1 本を検査し、表示と保存に使う `href` へ落とす（5.6 / 5.10）。
 *
 * # 接頭辞の一致で判定しない（5.10）
 *
 * **`new URL` で構文解析してから `protocol` を見る。** `startsWith('https://')` は
 * `https://` の後ろに何が続くかを見ないうえ、ブラウザが解析する形（前後の空白・大文字の
 * スキーム・タブや改行の除去）と食い違う。**判定と表示に使うのは、解析した結果の
 * `URL#href` だけである**——入力の文字列そのものを `href` へ入れない。
 *
 * # 断るもの
 *
 * - **`https:` 以外のスキーム**（`javascript:` / `data:` / `http:` / `mailto:` …）。
 *   `http:` も断る——作者ページは `https:` で配っており、平文のリンクへ送る理由が無い
 * - **解析できない文字列**（相対 URL・空白だけの綴りなど）
 * - **ユーザー情報（`user:pass@`）を含む URL。** `https://example.com@evil.example/` は
 *   **見た目の先頭と実際の行き先が違う**——なりすましの踏み台の典型である
 * - **制御文字・行区切り・向きを変える書式文字を含む入力。** URL の解析はタブや改行を黙って
 *   除くので、**利用者が見ている綴りと保存される行き先が食い違う**（自己紹介と同じ理由で、
 *   置き換えずに断る）。**`trim` の前に、入力そのものへ掛ける**（{@link validateBio} と同じ規律。
 *   PR #418 の Copilot レビュー）——`String#trim` はタブ・改行・U+2028 / U+2029 も除くので、
 *   後に見ると先頭や末尾に置かれた禁じた文字が黙って消えて通る。前後の普通の空白（U+0020）は
 *   禁じた文字ではないので、除いて通す
 * - **{@link PROFILE_LINK_MAX_LENGTH} を超えるもの**（前後の空白を除いた入力と `href` の両方で見る）
 *
 * # 国際化ドメイン名は punycode のまま出す
 *
 * `URL#href` は国際化ドメイン名を `xn--` の形にする。**表示にもそれを使う**——見た目の似た
 * 別の文字で綴ったドメイン（ホモグラフ）を、画面の上で本物と見分けられるようにするため。
 *
 * @param raw 入力された URL（**前後の空白を除く前**の、フォームから受け取ったままの値）
 * @returns 表示と保存に使う `href`、または断る理由
 */
export function normalizeProfileLink(
  raw: string,
): { readonly ok: true; readonly href: string } | { readonly ok: false; readonly reason: ProfileLinkRejection } {
  // **禁じた文字は `trim` の前に見る**（上の「断るもの」）。
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(raw) || DIRECTION_CHARACTER.test(raw)) {
    return { ok: false, reason: 'link-invalid' };
  }
  const value = raw.trim();
  if ([...value].length > PROFILE_LINK_MAX_LENGTH) {
    return { ok: false, reason: 'link-too-long' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'link-invalid' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'link-not-https' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'link-credentials' };
  }
  if (url.hostname === '') {
    return { ok: false, reason: 'link-invalid' };
  }
  if (url.href.length > PROFILE_LINK_MAX_LENGTH) {
    return { ok: false, reason: 'link-too-long' };
  }
  return { ok: true, href: url.href };
}

/**
 * 8.3 の表に当たる語を含むか（自己紹介とリンク）。
 *
 * **リンクは 3 つの綴りで見る**——入力のまま（国際化ドメイン名や日本語の経路が読める形）、
 * `href`（利用者の画面に出る形）、`href` のパーセント符号を戻した形（`%E3%81%82` のように
 * 符号化して表をすり抜ける綴りを拾う）。**punycode で入力されたドメイン名は戻さない**
 * （`xn--` の綴りを Unicode へ戻す関数をエッジに持たない）。これは 8.3 の「綴りの崩しは
 * 拾わない」の範囲である。
 *
 * @param profile 形の検査を通ったプロフィール
 * @param rawLinks 入力されたリンク（空でない欄の、受け取ったままの値。`profile.links` と同じ順）
 * @returns 表に当たれば true
 */
function containsDeniedTerm(profile: Profile, rawLinks: readonly string[]): boolean {
  const texts: string[] = [];
  if (profile.bio !== '') {
    texts.push(profile.bio);
  }
  for (const raw of rawLinks) {
    texts.push(raw);
  }
  for (const href of profile.links) {
    texts.push(href);
    try {
      texts.push(decodeURI(href));
    } catch {
      // 壊れたパーセント符号は `href` のまま見る（上で入れてある）。
    }
  }
  return texts.some((text) => !inspectText(text).ok);
}

/**
 * フォームから受け取った自己紹介とリンクを検査し、保存する形へ落とす。
 *
 * **検査の順序**: 自己紹介の形 → リンクの本数 → リンクごとの形 → 8.3 の表。**8.3 を最後に
 * 置く**——形で断れるものを表に掛けない（表の突き合わせは正規化を伴い、形の検査より重い）。
 *
 * **空のリンク欄は無視する**（3 つの欄のうち 1 つだけ埋める人が普通である）。並びは入力の
 * 順を保つ。**重複は断らない**（害が無く、断ると理由の文言が 1 つ増えるだけである）。
 *
 * **`trim` を使うのは「空の欄か」の判定だけである。** {@link normalizeProfileLink} と 8.3 の
 * 突き合わせには、**受け取ったままの文字列**を渡す——ここで先に `trim` すると、端に置かれた
 * タブや改行や U+2028 が黙って消え、あちらの「置き換えずに断る」が効かなくなる
 * （PR #418 の Copilot レビュー）。
 *
 * @param rawBio 入力された自己紹介
 * @param rawLinks 入力されたリンク（欄の数だけ。空の欄を含んでよい）
 * @returns 保存する形、または断る理由
 */
export function validateProfile(rawBio: string, rawLinks: readonly string[]): ProfileValidation {
  const bio = validateBio(rawBio);
  if (!bio.ok) {
    return { ok: false, reason: bio.reason };
  }
  const filled = rawLinks.filter((raw) => raw.trim() !== '');
  if (filled.length > PROFILE_LINK_MAX_COUNT) {
    return { ok: false, reason: 'too-many-links' };
  }
  const links: string[] = [];
  for (const raw of filled) {
    const normalized = normalizeProfileLink(raw);
    if (!normalized.ok) {
      return { ok: false, reason: normalized.reason };
    }
    links.push(normalized.href);
  }
  const profile: Profile = { bio: bio.value, links };
  if (containsDeniedTerm(profile, filled)) {
    return { ok: false, reason: 'profile-denied-term' };
  }
  return { ok: true, profile };
}

/**
 * 保存するリンクの列を、`users.profile_links` の綴りへ落とす。
 *
 * **綴りを 1 つに決める**（`JSON.stringify` の出力）。変更の判定（`profile_links <> ?`）が
 * 文字列の比較なので、同じリンクの列が 2 つの綴りを持つと「変わっていないのに履歴が積まれる」。
 *
 * @param links {@link normalizeProfileLink} を通った `href` の列
 * @returns JSON の文字列
 */
export function encodeProfileLinks(links: readonly string[]): string {
  return JSON.stringify(links);
}

/**
 * `users.profile_links` を読み、**表示してよいリンクだけ**を返す。
 *
 * **保存の前に検査した値でも、ここでもう一度 {@link normalizeProfileLink} を通す**（冒頭）。
 * D1 を直接 UPDATE した値・壊れた JSON・文字列でない要素は、黙って落とす（画面を 500 に
 * しない。落としたリンクは出ないだけで、他のリンクと自己紹介は出る）。**正規化で綴りが
 * 変わる値も落とす**——`href` と入力が一致しない値は、保存の経路を通っていない。
 *
 * @param stored `users.profile_links`（NULL や列の無い行から来る値も受ける）
 * @returns 表示してよい `href` の列（最大 {@link PROFILE_LINK_MAX_COUNT} 本）
 */
export function parseStoredProfileLinks(stored: unknown): string[] {
  if (typeof stored !== 'string') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const links: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = normalizeProfileLink(item);
    if (normalized.ok && normalized.href === item) {
      links.push(item);
    }
  }
  return links.slice(0, PROFILE_LINK_MAX_COUNT);
}

/** プロフィールの書き込みの結果。 */
export type ProfileChange =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'profile-too-soon' | 'profile-failed' };

/**
 * 自己紹介とリンクを書き込む。**変更の履歴を同じ `D1.batch` で 1 行積む。**
 *
 * # 形は作品の説明（`describeGame`）と表示名（`changeDisplayName`）を写してある
 *
 * - **間隔の判定を WHERE に置く**（断った要求は 1 行も書かない。先に SELECT で時刻を読んでから
 *   決めると、読みと書きの間にもう 1 本入った要求と 2 行書く）
 * - **履歴を先に積み、UPDATE を後に置く**（旧い値は UPDATE の前の行からしか取れない）
 * - **2 文の WHERE を同じ綴りにする**——間隔で断った要求では履歴も 0 行、履歴の insert が
 *   落ちれば batch ごと巻き戻ってプロフィールも変わらない
 * - **何も変わらない入れ直しは書かない**（`bio <> ? or profile_links <> ?` を条件に含める）。
 *   表示名と違い、同じ値を入れ直すことに意味が無い（Google への追随のような状態を持たない）
 * - **0 行だったときだけ、理由を引きに行く**（同じ値なら成功・違えば間隔）
 *
 * **BAN の検査はここに無い。** 呼び出し側が `resolveSessionUser` を通した後にしか呼ばない。
 *
 * @param db D1 バインディング
 * @param userId 利用者の id
 * @param profile 検査済みのプロフィール（{@link validateProfile}）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 書いたか（変わったか）、断ったか
 */
export async function changeProfile(
  db: D1Database,
  userId: string,
  profile: Profile,
  nowSeconds: number,
): Promise<ProfileChange> {
  const links = encodeProfileLinks(profile.links);
  // **条件の綴りを 1 つにする**（履歴の文と UPDATE が同じ行を見る）。
  // **退会した行は書き換えない**（#518 の PR #589 の Copilot の指摘。`src/withdrawal-sql.ts`）。
  // 履歴の INSERT と UPDATE が同じ綴りを見るので、ここへ 1 語足せば両方に効く。
  const conditions =
    `id = ? and ${NOT_WITHDRAWN_SQL} and (bio <> ? or profile_links <> ?)` +
    ' and (profile_set_at is null or profile_set_at <= ?)';
  const bindings = [userId, profile.bio, links, nowSeconds - PROFILE_CHANGE_INTERVAL_SECONDS] as const;

  const results = await db.batch([
    db
      .prepare(
        `insert into ${PROFILE_CHANGES_TABLE}
                (id, user_id, old_bio, new_bio, old_links, new_links, changed_at)
         select ?, id, bio, ?, profile_links, ?, ?
           from users
          where ${conditions}`,
      )
      .bind(crypto.randomUUID(), profile.bio, links, nowSeconds, ...bindings),
    db
      .prepare(
        `update users set bio = ?, profile_links = ?, profile_set_at = ? where ${conditions}`,
      )
      .bind(profile.bio, links, nowSeconds, ...bindings),
  ]);

  // **添字で読む**（`noUncheckedIndexedAccess`）。
  const historyRows = results[0]?.meta.changes ?? 0;
  const updatedRows = results[1]?.meta.changes ?? 0;
  if (updatedRows > 0) {
    if (historyRows === 0) {
      // **構造上ありえない**（同じ条件・同じ batch）。出るとすれば D1 の batch の意味が変わったとき。
      console.error('[profile] 履歴の無いプロフィールの変更が入りました（batch の意味が変わっています）');
    }
    return { ok: true, changed: true };
  }

  const row = await db
    .prepare('select bio, profile_links from users where id = ?')
    .bind(userId)
    .first<{ bio: string; profile_links: string }>();
  if (row === null) {
    // 解決の直後に行が消えた（手動の削除など）。
    return { ok: false, reason: 'profile-failed' };
  }
  if (row.bio === profile.bio && row.profile_links === links) {
    // **同じ値の入れ直しは失敗にしない**（二度押し）。間隔の内側でもこちらを先に見る。
    return { ok: true, changed: false };
  }
  return { ok: false, reason: 'profile-too-soon' };
}

/**
 * 断った理由ごとの文言（`src/account.ts` の文言の表へ連結する）。
 *
 * **8.3 に当たったときは、どの欄の何が当たったかを言わない**（冒頭）。
 */
export const PROFILE_REASON_MESSAGES: Readonly<Record<ProfileRejection, string>> = {
  'bio-too-long': `自己紹介は ${BIO_MAX_LENGTH} 文字までです。`,
  'bio-forbidden-character':
    '自己紹介に、改行以外の制御文字（タブなど）や、文字の向きを変える目に見えない記号は使えません。',
  'link-invalid': '外部リンクに、URL として読めないものがあります。https:// から始まる URL を入力してください。',
  'link-not-https': '外部リンクには https:// から始まる URL だけを使えます。',
  'link-credentials': '外部リンクに、ユーザー名やパスワード（@ の前の部分）を含む URL は使えません。',
  'link-too-long': `外部リンクは 1 本あたり ${PROFILE_LINK_MAX_LENGTH} 文字までです（日本語などの文字は、符号化した後の長さで数えます）。`,
  'too-many-links': `外部リンクは ${PROFILE_LINK_MAX_COUNT} 本までです。`,
  'profile-denied-term': '自己紹介または外部リンクに、使えない語が含まれています。',
  'profile-too-soon': `自己紹介と外部リンクの変更は ${PROFILE_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。少し待ってからもう一度お試しください。`,
  'profile-too-large': `送られた内容が大きすぎます。自己紹介は ${BIO_MAX_LENGTH} 文字、外部リンクは 1 本 ${PROFILE_LINK_MAX_LENGTH} 文字までです。`,
  'profile-failed': '自己紹介と外部リンクを保存できませんでした。時間をおいてもう一度お試しください。',
};

/** プロフィールのフォームに入れる値。 */
export interface ProfileFormView {
  /** 自己紹介（保存されている値、または断られた要求で送られた値）。**エスケープして出す。** */
  readonly bio: string;
  /** リンクの欄に入れる値（保存されている `href`、または送られた値）。**エスケープして出す。** */
  readonly links: readonly string[];
}

/**
 * 自己紹介と外部リンクのフォームを組み立てる（`/account` のプロフィールのタブ）。
 *
 * **面のブロックは呼ぶ側（`src/account.ts` の `renderAccountPage`）が包む**（#473）。見出しの id はブロックの `aria-labelledby` が指す。
 * **保存のボタンは副**（登録情報のタブは主を置かない。仕様 2.5.5 / #473）。
 *
 * **`maxlength` を付けない**（表示名と同じ理由。HTML の `maxlength` は UTF-16 の長さで数え、
 * こちらの規則と食い違う）。**`type="url"` にしない**——ブラウザの検査は `javascript:` も
 * 「正しい URL」として通すので守りにならず、しかも `app.css` の入力欄の既定が `type="text"`
 * だけに効く。`inputmode="url"` で端末のキーボードだけを URL 向けにする。
 *
 * @param view フォームに入れる値
 * @returns HTML
 */
export function renderProfileForm(view: ProfileFormView): string {
  const inputs: string[] = [];
  for (let index = 0; index < PROFILE_LINK_MAX_COUNT; index += 1) {
    const id = `profile-link-${index + 1}`;
    const value = view.links[index] ?? '';
    inputs.push(`  <label for="${id}">リンク ${index + 1}</label>
  <input id="${id}" name="${PROFILE_LINK_FIELD}" type="text" inputmode="url" autocomplete="url"
         placeholder="https://" value="${escapeHtml(value)}">`);
  }
  return `<h2 id="account-profile-heading">自己紹介と外部リンク</h2>
<form class="gf-profile-form" method="post" action="${ACCOUNT_PROFILE_PATH}">
  <label for="profile-bio">自己紹介</label>
  <textarea id="profile-bio" name="${BIO_FIELD}">${escapeHtml(view.bio)}</textarea>
  <p>${BIO_MAX_LENGTH} 文字まで。改行できます。空にすると作者ページに出なくなります。</p>
  <fieldset class="gf-profile-links">
  <legend>外部リンク（${PROFILE_LINK_MAX_COUNT} 本まで）</legend>
${inputs.join('\n')}
  </fieldset>
  <p>https:// から始まる URL だけを使えます。作者ページにリンクとして表示され、「${PROFILE_LINKS_UNVERIFIED_NOTICE}」と添えられます。</p>
  <button type="submit" class="gf-button gf-button-secondary">自己紹介と外部リンクを保存する</button>
</form>
<p>自己紹介と外部リンクは作者ページに出て、ログインしていない人にも見えます。変更の履歴は、通報への対応のために運営者が確かめられる形で残ります（公開しません）。</p>`;
}
