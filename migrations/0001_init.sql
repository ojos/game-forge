-- 仕様書 5.1 の主要テーブルと、待機リスト（8.1 / 2.2-4）を作成する。
--
-- 冪等性は `CREATE TABLE IF NOT EXISTS` ではなく、マイグレーション台帳
-- （`d1_migrations`）が担保する。`IF NOT EXISTS` を書くと、途中まで適用されて
-- 中断したマイグレーションを再実行したときに「成功」として通ってしまい、
-- 欠けたままの状態が緑になる。台帳側で一度だけ実行されることを保証する。
--
-- 時刻はすべて **UNIX 秒の INTEGER** で持つ。文字列の日時にすると比較のたびに
-- 変換が要り、境界の扱いが実装ごとにぶれる。アプリ側の失効判定
-- （招待コード・セッション）も UNIX 秒で揃えている。
--
-- インデックスは、必要とする問い合わせが決まっているものだけを張る。D1 は
-- 読み取りも従量である以上（3.6）「将来使うかもしれない」で足すと、書き込み
-- コストだけが確実に増える。追加は、それを要する問い合わせが来た時点で行う。

-- 参加者。ログイン手段は Google OAuth のみ（8.1）。
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Google のアカウント識別子。email は変わりうるため、同一性の判定はこちらで行う。
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- 任意入力・未検証のプロフィール項目（5.6）。X API に依存しないため検証しない。
  x_handle TEXT,
  -- 誰が招待したか。コミュニティの初期構造をそのまま資産にする（8.1）。
  -- 最初の参加者は招待者を持たないため NULL を許す。
  invited_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  -- BAN は google_sub 単位で行う（7.3）。行を消さないのは、消すと invited_by の
  -- 連鎖と生成履歴が同時に失われ、BAN の波及先を追えなくなるため。
  banned_at INTEGER
);

-- 招待コード。7.3 が「費用 DoS に対する一次の防波堤」と位置づける。
CREATE TABLE invites (
  -- コードそのものを主キーにする。正規形（区切りなし・大文字）だけを保存する。
  -- 表示用の揺れを保存すると、同じコードが複数行に見えて二重使用の判定が破れる。
  code TEXT PRIMARY KEY,
  issued_by TEXT NOT NULL REFERENCES users(id),
  -- 未使用なら NULL。二重使用の防止は、この列が NULL であることを条件にした
  -- 単一の UPDATE で行う（先に SELECT して確認する形にしない）。
  used_by TEXT REFERENCES users(id),
  used_at INTEGER,
  -- NULL は無期限。
  expires_at INTEGER
);

-- 招待枠の残数管理（#13）は「発行者ごとの発行済み件数」を数える。
CREATE INDEX invites_issued_by_idx ON invites(issued_by);

-- 作品。
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  -- フォーク元。系統の親（5.3 / 5.5）。オリジナルは NULL。
  parent_id TEXT REFERENCES games(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'removed')),
  title TEXT NOT NULL,
  -- ビルドに使った Go の版。3.5 の `wasm_exec.js` の出し分けに要る。
  go_version TEXT NOT NULL,
  -- R2 のキー。source は 5.3 が「これがなければフォークは再現できない」とする永続物。
  -- tombstone 化（M5-4）で実体を落とす場合に NULL になりうるため NOT NULL にしない。
  source_key TEXT,
  wasm_key TEXT,
  -- 一覧を軽くするための非正規化列（5.1）。
  fork_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

-- 系統の近傍表示（5.5）が「この作品からの改造 N 件」を引く。5.1 が明示的に要求する。
CREATE INDEX games_parent_id_idx ON games(parent_id);

-- 生成の費用台帳（4.3 / M3-1）。成否によらず全件を記録する。
CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  -- 生成が失敗した場合は作品行が作られないため NULL を許す。
  game_id TEXT REFERENCES games(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  -- usage の 4 種（4.1.1 / 4.5）。prompt caching の効きを見るために別々に持つ。
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL,
  -- 円換算した費用。換算の精度と丸めの規約は M3-1 が確定する。
  cost_jpy REAL NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  created_at INTEGER NOT NULL
);

-- 通報（8.4 / M6-4）。閾値到達で自動非表示にはせず、審査キューへ入れる。
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 待機リスト（8.1 / 2.2-4）。
--
-- 5.1 の 5 テーブルには含まれないが、未招待ユーザーの導線の保存先として #14 が
-- 要求する。マイグレーションを 1 本に集約するため、#11 が所有する
-- （2 本に分けると連番と適用順が並行作業と絡む）。
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  -- 重複登録を弾く。同じ人が何度押しても登録数が増えないようにする
  -- （10.2 の「待機リスト登録率」の分子が壊れる）。
  email TEXT NOT NULL UNIQUE,
  -- どの導線から来たか。10.2 が「改造するを押した未招待ユーザー数と、そこからの
  -- 登録率」を補助指標に挙げているため、経路を区別できる形で持つ。
  source TEXT,
  created_at INTEGER NOT NULL
);
