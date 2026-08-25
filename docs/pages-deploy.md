# Cloudflare Pages への配備手順

- 位置づけ: 確定22（アプリと API は Pages Functions）を実際に配備するための手順書。
- 対象: `game-forge.ojos.jp`（アプリ）と `sandbox.game-forge.ojos.jp`（UGC）。
- **この文書は手順であって、実行の記録ではない。** 実際の配備は外部状態の変更なので、
  行った時点で `terraform/` か本文書に結果を残すこと。

## なぜ Workers ではなく Pages か

`game-forge.ojos.jp` のゾーンは確定17 に従って **AWS Route53 へ NS 委譲済み**で、
Cloudflare 上にありません。

- **Workers のカスタムドメインは、ゾーンが Cloudflare 上にあることを要求します。** 使えません。
- **Pages のカスタムドメインは、サブドメインであれば外部 DNS のまま CNAME 1 本で足ります。**

ゾーンを Cloudflare へ戻す案は採りません。確定17 の委譲と 9.2 の AWS アカウント設計を
巻き戻すことになり、DNS を Terraform で宣言的に管理する目的（さくらに DNS の API が
無いことへの対処）を捨てることになるためです。

## 構成

```
functions/[[path]].ts   Pages Functions の入口。src/index.ts の default export を呼ぶだけ
public/                 出力ディレクトリ。空（.gitkeep のみ）
wrangler.toml           pages_build_output_dir とバインディングの宣言
```

**`public/` に静的ファイルを置かないこと。** Pages は静的ファイルを Functions より先に
解決するため、`index.html` を置くと `/` の経路が隠れます（実測で確認）。画面はすべて
Worker が生成します。

## 配備

### 1. プロジェクトを作る（初回のみ）

```bash
npx wrangler pages project create game-forge --production-branch main
```

### 2. バインディングを設定する

D1 と R2 は Pages プロジェクト側にも設定が要ります。**ローカルの `wrangler.toml` にある
`database_id` は placeholder** なので、本番の D1 を作ってから実際の ID を入れます。

```bash
npx wrangler d1 create game-forge
npx wrangler r2 bucket create game-forge
```

### 3. シークレットを入れる

`.dev.vars` に置いているものと同じ名前で、Pages のシークレットとして登録します。

```bash
npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put GOOGLE_CLIENT_ID
npx wrangler pages secret put GOOGLE_CLIENT_SECRET
npx wrangler pages secret put BEDROCK_AWS_REGION
npx wrangler pages secret put BEDROCK_AWS_ACCESS_KEY_ID
npx wrangler pages secret put BEDROCK_AWS_SECRET_ACCESS_KEY
```

LLM は **Amazon Bedrock** を叩きます（確定19 / 仕様書 4.1）。認証は AWS 資格情報による
SigV4 署名です。

**`BEDROCK_AWS_SESSION_TOKEN` は本番では登録しません。** 一時資格情報はローカル開発で
SSO を使うときだけのもので、本番には長命キーを置きます（Workers は AWS の外で動くため
IAM ロールを引き受けられません。仕様書 4.1）。**鍵のローテーション手順は #82 が持ちます。**

**`compatibility_flags = ["nodejs_compat"]` が必要です**（#79 の実測）。これが無いと
`assert` / `stream` が解決できずビルドが落ちます。

### 4. デプロイ

```bash
npx wrangler pages deploy
```

## カスタムドメイン（外部 DNS のまま張る）

**Cloudflare 側と Route53 側の両方に作業があります。** 片方だけでは張れません。

1. Cloudflare のダッシュボードで、Pages プロジェクト → **Custom domains** →
   `game-forge.ojos.jp` を追加する。
2. Route53 のホストゾーン `ojos.jp` に **CNAME を 1 本**作る。
   - 名前: `game-forge`
   - 値: `<project>.pages.dev`
3. サンドボックス用ホストも同じ手順で追加する。
   - 名前: `sandbox.game-forge`
   - 値: 同じ `<project>.pages.dev`

**Route53 のレコードは Terraform で宣言すること**（確定17 が Route53 へ委譲した目的が
そもそもこれです）。ダッシュボードから手で作らないこと。

### サンドボックス用ホストを同じプロジェクトに載せてよい理由

7.2 が要求するのは**別オリジンであること**で、別プロジェクトであることではありません。
`src/index.ts` が `Host` ヘッダで出し分け、サンドボックス側には CSP `sandbox` ヘッダを
付け、cookie を一切設定しません。この構造はローカルでも
`npm run check:origins` が毎回検証しています。

**`game-forge.ojos.jp` と `sandbox.game-forge.ojos.jp` は同一サイト**（eTLD+1 が
どちらも `ojos.jp`）である点に注意してください。だからこそセッション cookie に
`__Host-` 接頭辞が必須です（7.2 必須要件 2）。

## 確認

配備後に最低限これを見ます。

```bash
curl -sI https://game-forge.ojos.jp/ | head -1
curl -s https://game-forge.ojos.jp/signup | head -3
curl -sI https://sandbox.game-forge.ojos.jp/ | grep -i content-security-policy
```

サンドボックス側に `sandbox allow-scripts` が付き、`allow-same-origin` が**付いていない**
ことを必ず確認してください（7.2 必須要件 1）。

## まだ決まっていないこと

- **本番の D1 / R2 を Terraform で宣言するか**、`wrangler` で作るか。現状 `terraform/` は
  GitHub と AWS だけを見ています。
- **Pages プロジェクトそのものを Terraform で宣言するか。** shared-ai-rules 4 章は
  「UI やアドホックな CLI での直接作成・変更を、恒久的な状態変更の手段にしない」と
  定めており、上の手順のうちダッシュボード操作は本来その対象です。
