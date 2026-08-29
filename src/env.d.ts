/**
 * `.dev.vars`（本番では `wrangler secret`）が供給する秘密の型。
 *
 * `worker-configuration.d.ts` へ書かない。あれは `wrangler types` の生成物で、
 * **手元に `.dev.vars` があるかどうかで中身が変わる**（wrangler は `.dev.vars` の
 * キーも `Env` へ書き出す）。あちらへ手で足すと、次の生成で消えるうえ、
 * `scripts/check-worker-types.sh` の照合（生成物と `wrangler.toml` の一致）が
 * 壊れる。`test/cloudflare-test-env.d.ts` と同じく、宣言のマージでこちら側から足す。
 *
 * `.dev.vars` を置いた環境では同じキーが生成物側にも `string` として現れるが、
 * ここでも `string` として宣言しているため、宣言のマージで矛盾しない。
 *
 * **値は実行時に `undefined` になりうる。** `.dev.vars` を置いていない環境では
 * キー自体が存在しない。型が `string` であることを根拠に素通しせず、認証の入口で
 * 未設定を検査すること（`src/auth/google.ts` の `missingSecrets`）。
 */
/** `.dev.vars` / `wrangler secret` が供給する、このアプリの秘密。 */
interface AppSecrets {
  /** 署名付きセッション cookie の HMAC 鍵（8.1 / 確定9）。32 文字以上。 */
  SESSION_SECRET: string;
  /**
   * Bedrock を呼ぶ AWS 資格情報（確定19 / 4.1 / #83）。
   *
   * **`BEDROCK_` 接頭辞を付けている。** このリポジトリは Terraform 用に
   * `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` を開発機の環境変数として使うため、同じ名前を
   * アプリの秘密にも使うと、どちらの資格情報で何を叩いているのか読めなくなる
   * （`.dev.vars.example`）。
   *
   * **どのモデルで生成するかはここに無い。** `GENERATION_MODEL` は秘密ではなく構成で、
   * `wrangler.toml` の `[vars]` が宣言する（`src/generation-models.ts`）。
   */
  BEDROCK_AWS_REGION: string;
  BEDROCK_AWS_ACCESS_KEY_ID: string;
  BEDROCK_AWS_SECRET_ACCESS_KEY: string;
  /**
   * SSO の一時資格情報を使うときだけ入る（本番の長命キーでは登録しない）。
   *
   * **`string` として宣言する。** 生成物側（`wrangler types`）は `.dev.vars` に
   * キーがあれば `string` として出すため、こちらを省略可能（`?`）にすると宣言の
   * マージが矛盾する。**空・未設定は `src/bedrock.ts` が実行時に判定する。**
   */
  BEDROCK_AWS_SESSION_TOKEN: string;
  /**
   * ビルド関数（Lambda）を呼ぶ AWS 資格情報（確定24 / 3.3-5 / #19）。
   *
   * **Bedrock 用と別の名前にしてある。** 用途が違うだけでなく、必要な権限も違う
   * （`bedrock:InvokeModel` と `lambda:InvokeFunction`）。最小権限を保つなら
   * principal ごと分かれる（`.dev.vars.example` / `docs/build-invocation.md`）。
   *
   * **呼ぶ相手（`BUILD_FUNCTION_NAME`）はここに無い。** 秘密ではなく構成なので、
   * `wrangler.toml` の `[vars]` が宣言し、生成物（`worker-configuration.d.ts`）側に
   * 現れる。
   */
  BUILD_AWS_REGION: string;
  BUILD_AWS_ACCESS_KEY_ID: string;
  BUILD_AWS_SECRET_ACCESS_KEY: string;
  /** SSO の一時資格情報を使うときだけ入る（`BEDROCK_AWS_SESSION_TOKEN` と同じ扱い）。 */
  BUILD_AWS_SESSION_TOKEN: string;
  /** Google OAuth のクライアント ID。ID トークンの `aud` の照合にも使う。 */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth のクライアントシークレット。トークンエンドポイントへのみ送る。 */
  GOOGLE_CLIENT_SECRET: string;
  /**
   * メール送信（Resend）の API キー（確定14 / 4.6 / #148 / #153）。
   *
   * **未設定の環境では送らない**（例外にしない。`src/mail/resend.ts`）。ローカルにも
   * テストにも値は無く、通知の経路は「送信の手前」で止まる。
   */
  RESEND_API_KEY: string;
  /**
   * 差出人（`name <local@domain>` の形も可）。**送信ドメインは ojos.jp 系である**（7.2）。
   *
   * **構成に見えるが `[vars]` へ置かない。** 実在のメールアドレスを追跡ファイルへ書くと、
   * 宛先と同じ理由（下記 `OPERATOR_EMAIL`）でリポジトリに住所が残る。
   */
  MAIL_FROM: string;
  /**
   * 運用者の宛先（4.3 の 80% 警告。#148）。
   *
   * **コードにも仕様書にも書かない。** 誰が運用しているかは実装の一部ではなく、
   * 環境ごとに変わる設定である。**利用者向けの通知はここを使わない**——生成の完了
   * （#153）の宛先は `users.email` から引く。
   */
  OPERATOR_EMAIL: string;
}

declare global {
  // 生成物が `Env`（Worker 側）と `Cloudflare.Env`（`cloudflare:test` 側）の 2 つを
  // 別々に宣言しているため、両方へ足す。片方だけにすると、テストが受け取る env を
  // ハンドラへ渡せない（型が食い違う）。メンバの定義は 1 か所（`AppSecrets`）に
  // 置き、書き写しを作らない。
  interface Env extends AppSecrets {}
  namespace Cloudflare {
    interface Env extends AppSecrets {}
  }
}

export {};
