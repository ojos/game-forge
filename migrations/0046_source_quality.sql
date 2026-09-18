-- 生成物の質の指標と、どの版のプロンプトが作ったか（#605）。
--
-- **これ自体は質を上げない。** #597 は基準線を取ったのに前後比較をしていないので、
-- 「生成物の質が上がった」と言えないまま終わっている。**この表は、以後のプロンプト変更の効果を
-- 費用ゼロで測れるようにするためにある**——ソースは既に R2 にあり、利用者が普通に生成するたびに
-- 評価データが貯まる。
--
-- ## ソースの R2 キーで引く（`games` の列にしない）
--
-- **`source_input_keys`（0040）と同じ理由である。** 複製しないので要点だけ書く——R2 のソースは
-- 内容のハッシュで名付けられて作品をまたいで共有され（確定26）、推敲と「版に戻す」は
-- `games.source_key` を差し替える。ソースに紐づけておけば、戻したときに何も書かなくてよい。
-- 行が無いこと（まだ測っていない）と、値が 0 であること（測ったが 0 だった）も区別できる。
--
-- ## 外部キーを張らず、掃除でも消さない
--
-- これも 0040 と同じである（`games` とも `game_revisions` とも 1 対 1 でない）。
--
-- ## 書く場所（`src/source-quality-metrics.ts`）
--
-- - **完成を確定させた直後に、エッジが R2 のソースを読んで測る**（完成のコールバックと同期実行の 2 か所）。
--   **オーケストレータの束を変えない**ために、コールバックの中ではなく経路表を包む側に置く
--   （`src/source-quality-routes.ts`。0040 の `src/source-input-keys-routes.ts` と同じ形）。
-- - 書き込みは 0040 と同じく `insert ... on conflict ... where excluded.rule_version > rule_version` の 1 文。
-- - 既存の作品は `scripts/source-quality-backfill.mjs` が埋め戻す。**#597 の基準線は使い捨ての Go の
--   道具で測った値なので、埋め戻して測り直さないと違う物差しで前後を比べることになる。**

CREATE TABLE source_quality_metrics (
  -- R2 のキー。`games.source_key` / `game_revisions.source_key` と同じ綴り。
  source_key TEXT PRIMARY KEY,
  -- 勝ち・クリアを表す語を画面へ出しているか（0 / 1）。**終端の状態があることの代理である。**
  has_win_text INTEGER NOT NULL CHECK (has_win_text IN (0, 1)),
  -- 負け・ゲームオーバーを表す語を画面へ出しているか（0 / 1）。
  has_lose_text INTEGER NOT NULL CHECK (has_lose_text IN (0, 1)),
  -- `color.RGBA{...}` の種類数。見た目の豊かさの粗い代理。
  color_count INTEGER NOT NULL,
  -- `ebiten.NewImage` の呼び出し回数。**スプライトを使っているかの代理である。**
  sprite_count INTEGER NOT NULL,
  -- `iota` を含む `const (...)` の組で宣言された名前の数（最大の組）。0 は「そういう組が無い」。
  state_count INTEGER NOT NULL,
  -- 抽出の規則の版（`src/source-quality.ts` の `SOURCE_QUALITY_RULE_VERSION`）。
  rule_version INTEGER NOT NULL,
  -- 測った時刻（UNIX 秒）。
  extracted_at INTEGER NOT NULL
);

-- **索引を足さない。** 引き方は `source_key` の等値と全件走査の 2 通りで、前者は主キーが担い、
-- 後者は索引が効かない（0040 と同じ方針）。

-- どの版のシステムプロンプトが作ったか（`src/prompt-version.ts` の `PROMPT_VERSION`）。
--
-- **既存の行には入らないので NULL を許す。** 0 を既定にすると「版 0 で作った」と読めてしまい、
-- 記録を始める前の行と区別できなくなる。
--
-- **版を決めるのは生成した側で、行を書くのはエッジである**（#649 で訂正）。本番では Lambda が
-- 生成し、エッジが `ledger` コールバックを受けてこの行を書く。Lambda は自分の束に焼き込まれた
-- プロンプトを使うので、**配り直しの前後でエッジと本文が違う。** したがって Lambda が版を
-- `ledger` の本文で運び、エッジはそれを書く。**運ばれてこなければ NULL**（エッジの版で埋めない）。
--
-- **#649 より前の行は、エッジの版であって実際の版ではない。** 当初ここには「書くのは
-- オーケストレータ側である」と書いてあったが、実際はエッジが自分の版を書いていた。
ALTER TABLE generations ADD COLUMN prompt_version INTEGER;
