/**
 * 待機リストの登録と登録数の取得（8.1 / 2.2-4 / 10.2）。
 *
 * 未招待ユーザーが「改造する」を押したときの受け皿である（2.2-4）。招待制で母数を
 * 絞る以上、弾いた人をそのまま返すと、8.1 が招待制と引き換えに手放した「踏んで即改造」の
 * 転換をまるごと失う。ここはその代替の導線であり、10.2 の補助指標
 * （「改造する」を押した未招待ユーザー数と、そこからの登録率）の分子でもある。
 *
 * このモジュールが持つのは**保存と件数だけ**である。登録画面と
 * 「招待コード検証 → OAuth」のフロー結線は #14 の T7 が持つ。分けているのは、
 * 保存が #12（OAuth）/ #13（招待）のどちらにも依存せず、単独で検証できるためで、
 * M1 の並列作業の前提でもある。
 *
 * **一覧・列挙の経路は置かない。** メールアドレスの束は個人情報で、認証機構が
 * まだ無い段階で読み出せる経路を開ける理由がない。外へ出すのは件数だけとする。
 *
 * **投稿量の制限はここに置いていない。** 誰でも叩ける POST であり、他人のアドレスの
 * 登録も、架空のアドレスでの水増しも防げない（後者は D1 の書き込み枠（3.6）を
 * 削る）。1 リクエストで書くのが 1 行以下であることは下記で保証しているが、
 * 回数そのものを絞るのはアプリ層の仕事ではなく、エッジのレート制限や
 * Turnstile のような手前の層で受ける。7.3 が費用 DoS の防御を二層（招待制と
 * 月次上限）で組み立てているのと同じ考え方で、ここへ独自の計数を持ち込むと、
 * その計数のために毎リクエスト書き込む本末転倒になる。
 */
import type { Route, RouteHandler } from './routes.js';
import { json } from './routes.js';

/**
 * 登録経路。10.2 が導線ごとの登録率を補助指標に挙げているため、区別できる形で持つ。
 *
 * **集合を閉じて未知の値を弾く。** 自由文字列のまま受けると、表記ゆれ（`fork` /
 * `fork_cta` / `forkCta`）が同じ導線を別の行に見せ、集計が「同じものを別々に数えた
 * 結果」になる。列挙にしておけば、導線を増やすときに必ずこの表を通る。
 *
 * - `fork-cta`: 作品ページの「改造する」を未招待ユーザーが押した（2.2-4）。10.2 が名指しする導線
 * - `signup`: 登録画面で招待コードを持っていなかった（8.1 の登録フローからの離脱）
 * - `landing`: トップページからの直接登録
 */
export const WAITLIST_SOURCES = ['fork-cta', 'signup', 'landing'] as const;

/** `WAITLIST_SOURCES` のいずれか。 */
export type WaitlistSource = (typeof WAITLIST_SOURCES)[number];

/**
 * メールアドレスの最大長。
 *
 * RFC 5321 が経路（forward-path）に定める上限 256 オクテットから、囲みの `<` `>` を
 * 除いた 254 文字。「明らかに長すぎる」を弾くための線であり、これ以上厳しくしない。
 */
export const MAX_EMAIL_LENGTH = 254;

/**
 * 受け付けるリクエスト本文の最大バイト数。
 *
 * 本文は 254 文字のアドレスと導線名だけであり、1 KiB あれば JSON の空白込みでも余る。
 * 上限を置かないと、本文を読み切るまでメモリを積む形になる。
 */
const MAX_BODY_BYTES = 1024;

/**
 * 外へ出す件数の丸め幅（下記 `coarsenWaitlistCount` の理由）。
 */
export const WAITLIST_COUNT_STEP = 10;

/** 保存する 1 件分の登録内容。 */
export interface WaitlistRegistration {
  /** 正規化済みのメールアドレス（小文字・前後の空白なし）。 */
  readonly email: string;
  /** 導線。判別できない場合は null（列は NULL を許す）。 */
  readonly source: WaitlistSource | null;
}

/**
 * リクエストを受け付けられなかった理由。
 *
 * **ここに「登録済み」は無い。** 重複は成功として扱うため、失敗の理由に現れてはならない
 * （下記 `registerWaitlist` の理由）。
 */
export type WaitlistRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'malformed-json'
  | 'invalid-email'
  | 'unknown-source';

/** リクエスト本文の解析結果。 */
export type WaitlistParseResult =
  | { readonly ok: true; readonly registration: WaitlistRegistration }
  | { readonly ok: false; readonly reason: WaitlistRejection };

/**
 * メールアドレスを正規化する。
 *
 * **小文字へ揃える。** ドメイン部は元から大小を区別せず、ローカル部を区別する
 * メール事業者は実運用でほぼ無い。揃えずに保存すると `A@example.com` と
 * `a@example.com` が `waitlist.email` の UNIQUE 制約をすり抜けて 2 行になり、
 * 同じ人が 2 人分として数えられる。10.2 の登録率の分子が壊れるのはこの経路である。
 *
 * 検証は**最小限に留める**。厳密な文法（RFC 5322）を正規表現で書くと、正当な
 * アドレスを弾く側の誤りが出る。ここで落とすのは「明らかに送れないもの」だけとし、
 * 到達性の確認は将来の確認メールに委ねる。
 *
 * @param input 入力された文字列
 * @returns 正規化したアドレス、または明らかに不正なら null
 */
export function normalizeEmail(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) {
    return null;
  }

  // 制御文字を弾く。CR / LF を通すと、将来このアドレスをメールヘッダへ載せたときに
  // ヘッダ挿入になる（2.2-6 は改造されたことを作者へメールで知らせる）。
  // 保存の時点で入り口を閉じておくほうが、送信側の実装ごとに気をつけるより確実である。
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
  }

  // 区切りは**最後の** `@` とする。ローカル部を引用符で囲む形（`"a@b"@example.com`）は
  // 正当なアドレスであり、`@` の個数で弾くとこれを落とす。前後がどちらも空でないこと
  // だけを見る。
  const separator = normalized.lastIndexOf('@');
  if (separator <= 0 || separator === normalized.length - 1) {
    return null;
  }
  return normalized;
}

/**
 * 文字列が既知の導線かどうかを判定する。
 *
 * @param value 判定する文字列
 * @returns 既知の導線なら true
 */
export function isWaitlistSource(value: string): value is WaitlistSource {
  return (WAITLIST_SOURCES as readonly string[]).includes(value);
}

/**
 * リクエスト本文を解析して、保存する内容を取り出す。
 *
 * **この関数は例外を投げない。** 壊れた JSON、`Content-Type` 違い、巨大な本文は
 * すべて理由付きの失敗として返す。投げると経路の外側（`src/index.ts` の catch）で
 * 500 になり、利用者の入力の誤りがサーバの障害として記録される。
 *
 * @param request 受信したリクエスト
 * @returns 解析結果
 */
export async function parseWaitlistRequest(request: Request): Promise<WaitlistParseResult> {
  // メディアタイプだけを見る。`application/json; charset=utf-8` のようにパラメータが
  // 付く形は正当なので、完全一致で判定すると正しいリクエストを弾く。
  //
  // JSON に限ることは、他サイトのフォームから勝手に登録される経路も同時に塞ぐ。
  // `application/x-www-form-urlencoded` は単純リクエストとしてプリフライトなしに
  // 送れるが、`application/json` は必ずプリフライトを伴い、こちらが CORS の許可を
  // 返さない以上ブラウザは本体を送らない。T7 の登録フォームは同一オリジンの
  // fetch から叩くため、この制限で困らない。
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const body = await readLimitedText(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  // JSON として妥当でも、オブジェクトとは限らない（`"文字列"` や `null` も妥当な JSON）。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed-json' };
  }

  const { email, source } = parsed as Record<string, unknown>;
  if (typeof email !== 'string') {
    return { ok: false, reason: 'invalid-email' };
  }
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail === null) {
    return { ok: false, reason: 'invalid-email' };
  }

  // 導線は任意とする。未指定を 400 で弾くと、UI 側の付け忘れ 1 つで**登録そのもの**を
  // 落とすことになる。失うのが「登録」か「導線の内訳」かの取引であり、後者を選ぶ。
  if (source === undefined || source === null || source === '') {
    return { ok: true, registration: { email: normalizedEmail, source: null } };
  }
  if (typeof source !== 'string' || !isWaitlistSource(source)) {
    return { ok: false, reason: 'unknown-source' };
  }
  return { ok: true, registration: { email: normalizedEmail, source } };
}

/**
 * 待機リストへ登録する。**同じアドレスを何度登録しても成功し、行は増えない。**
 *
 * 重複を「既に登録済みです」と区別できる形で返さないこと。区別できる応答は、任意の
 * アドレスが登録済みかどうかを外部から確かめられる列挙のオラクルになる。呼び出し側が
 * 応答を分けられないよう、この関数自体が新規と既存を区別せずに返す。
 *
 * `on conflict(email) do nothing` を使い、**1 回の登録で書くのは 1 行以下**にする。
 * D1 は書き込みの無料枠が読み取りより桁で小さい（3.6）ため、先に `select` して
 * 存在を確かめてから `insert` する形にしない（往復が増えるうえ、同時実行では
 * その隙間で二重に書かれる）。
 *
 * `insert or ignore` を使わないのは、あれが UNIQUE 以外の制約違反（NOT NULL 等）まで
 * 黙って捨てるためである。ここで無視してよいのは email の重複だけであり、それ以外は
 * 実装の誤りとして表面化させる。
 *
 * 重複時に `source` を上書きしないのは、最初にどの導線から来たかが 10.2 の見たい
 * 情報だからである。後から押した導線で上書きすると、初回接触の分布が消える。
 *
 * @param db D1 バインディング
 * @param registration 保存する内容（`parseWaitlistRequest` が検証済みのもの）
 * @param nowSeconds 登録時刻（UNIX 秒）。既定は実時刻。テストから固定できるようにする
 */
export async function registerWaitlist(
  db: D1Database,
  registration: WaitlistRegistration,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db
    .prepare(
      'insert into waitlist (id, email, source, created_at) values (?, ?, ?, ?) on conflict(email) do nothing',
    )
    .bind(crypto.randomUUID(), registration.email, registration.source, nowSeconds)
    .run();
}

/**
 * 待機リストの登録数を返す（正確な値）。
 *
 * 10.2 の「待機リスト登録率」の分子はこの値で数える。**外へそのまま返さないこと**
 * （下記 `coarsenWaitlistCount` の理由）。
 *
 * `count(*)` は全行を読むが、待機リストは月数百件規模であり、読み取りの単価は
 * 書き込みの 1/1000（3.6）なので、集計用のカウンタ行を別に持って**毎回書く**ほうが
 * 高くつく。
 *
 * @param db D1 バインディング
 * @returns 登録数
 */
export async function countWaitlist(db: D1Database): Promise<number> {
  const row = await db.prepare('select count(*) as total from waitlist').first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * 外へ返す件数を丸める。
 *
 * **正確な件数を返すと、応答本文を新規・既存で同じにしても列挙できる。** 攻撃者は
 * 使い捨てのアドレスを登録して件数 N を得たあと、対象のアドレスを送る。N のままなら
 * 登録済み、N+1 なら未登録と読める。応答の文面ではなく、件数の差分が同じことを漏らす。
 *
 * 丸めればこの差分は 10 件に 1 回しか動かず、どの登録で動くかを攻撃者は選べない。
 * 完全には塞がらない（境界を探る目的で 10 件ほど登録すれば 1 ビットは得られる）が、
 * 1 件のアドレスを調べる費用が 2 リクエストから「境界探索 + 実際に行を書く」へ上がる。
 * 完全に塞ぐには件数を出さないか、レート制限が要る。件数を出すのは 2.2-4 の希少性の
 * 提示に使うためで、そこで要るのは桁であって 1 件単位の精度ではない。
 *
 * 10 件に満たないうちは 0 を返す。希少性の提示は件数が小さいうちは効かないため、
 * 表示側は 0 のときに件数を出さない選択ができる。
 *
 * @param exactCount `countWaitlist` が返した正確な件数
 * @returns 丸め幅で切り捨てた件数（実際の件数以下であることを保証する）
 */
export function coarsenWaitlistCount(exactCount: number): number {
  return Math.floor(exactCount / WAITLIST_COUNT_STEP) * WAITLIST_COUNT_STEP;
}

/**
 * 待機リストへの登録を受け付ける。
 *
 * 成功時は新規でも既存でも**同じ 200 と同じ本文の形**を返す。新規のときだけ 201 を
 * 返すような設計にすると、ステータスコードがそのまま列挙のオラクルになる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
const handleWaitlistRegistration: RouteHandler = async (request, env) => {
  const parsed = await parseWaitlistRequest(request);
  if (!parsed.ok) {
    return json({ error: parsed.reason }, 400);
  }

  try {
    await registerWaitlist(env.DB, parsed.registration);
    const waitingCount = coarsenWaitlistCount(await countWaitlist(env.DB));
    return json({ registered: true, waitingCount });
  } catch (error) {
    // 例外の中身は返さない。SQL のエラーメッセージには保存しようとした値が入りうる。
    console.error('[waitlist] 待機リストへの登録に失敗しました', error);
    return json({ error: 'internal error' }, 500);
  }
};

/**
 * 待機リストの経路。
 *
 * `src/app.ts` の `appRoutes` へ連結する。**件数だけを返す GET は置いていない。**
 * 表示側（T7）は同じ Worker 内で `countWaitlist` を直接呼べるため、公開経路にする
 * 必要がない。置けば認証なしで叩ける読み取りが 1 つ増え、D1 の読み取りを外から
 * いくらでも起こせる面（3.6）が広がるだけになる。
 *
 * パスを `/api/waitlist` にしないのは、9.3 が「API を `/api/*` に置くなら
 * Pages Functions を使う。ここは M2-1 の実装時に確定する」としているためである。
 * M1 でこの綴りを使うと、その判断を先取りしたことになる。
 */
export const waitlistRoutes: readonly Route[] = [
  { method: 'POST', path: '/waitlist', handler: handleWaitlistRegistration },
];

/** 本文の読み出し結果。 */
type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'body-too-large' | 'unreadable-body' };

/**
 * リクエスト本文を、上限を超えたら打ち切りながら読む。
 *
 * `request.text()` を使わないのは、上限を超えたかどうかが**読み切ったあと**にしか
 * 分からないためである。`Content-Length` を先に見る形も、ヘッダは省略できる
 * （chunked）うえ実際の本文と一致する保証がない。読みながら数えるのが、
 * 上限を実際に効かせられる唯一の形になる。
 *
 * @param request 受信したリクエスト
 * @param limit 受け付ける最大バイト数
 * @returns 本文の文字列、または打ち切り・読み出し失敗の理由
 */
async function readLimitedText(request: Request, limit: number): Promise<BodyReadResult> {
  const body: ReadableStream<Uint8Array> | null = request.body;
  if (body === null) {
    // 本文なしの POST。JSON として不正なので、この後の解析で落ちる。
    return { ok: true, text: '' };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        // 残りを受け取らずに切る。読み捨てても上限を超えた分の転送は続くため、
        // ここで止めないと上限を置いた意味が薄れる。
        await reader.cancel();
        return { ok: false, reason: 'body-too-large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    // 通信の切断など。利用者の入力の問題ではないが、こちらから見えるのは
    // 「本文が読めなかった」ことだけなので、400 として扱う。
    console.error('[waitlist] リクエスト本文の読み出しに失敗しました', error);
    return { ok: false, reason: 'unreadable-body' };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // 不正なバイト列は置換文字になる（投げない）。JSON として壊れていれば解析側で落ちる。
  return { ok: true, text: new TextDecoder().decode(merged) };
}
