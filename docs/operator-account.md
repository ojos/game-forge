# 運営アカウントの印

**コールドスタート用サンプル（#43）の所有者が運営であることを、作品ページで読めるように
します（#334）。** この文書は、その印を立てる・外す・確かめる手順と、**確かめられない
こと**を書きます。

- 位置づけ: **手順と限界。** 列の定義と「なぜ導出せず列で持つのか」は
  `migrations/0021_users_operator.sql`、表示は `src/work-page.ts` にあります。
  **ここへ複製しません。**
- 運用の形: **この列（`is_operator`）は、直接 UPDATE します。** BAN（`users.banned_at`）と同じ形で、
  前例があります（`docs/usage-report.md`「BAN と招待枠」）。**運営フラグの付け外しに管理 UI は持ちません**
  （仕様 2.4.3 が「画面に置かない」と決めています）。
  > **BAN は移ります**（#352 / 仕様 2.4）。**審査と BAN は M10-3 で管理画面へ移り、操作は
  > `admin_actions` に追記で残ります。** それまでは BAN も直接 UPDATE のままです。**移ったあとに
  > 端末から直接 UPDATE すると、履歴に残らないまま状態が変わります**——移行後は画面から行ってください。

---

## 1. 何が変わり、何が変わらないか

**`users.is_operator` が 1 の利用者の作品ページで、作者名の隣に「運営アカウント」の
バッジ（枠と地を持つ無彩色の印）が出ます**（文言の正本は `src/work-page.ts` の
`OPERATOR_MARK`、見た目は `public/assets/app.css` の `.gf-operator`。この文書の綴りは
写しです）。
0（既定値）の利用者では、作者の行は #334 の前と 1 バイトも変わりません。

| 場所 | 印が出るか |
|---|---|
| 作品ページ（`/works/<作品 id>`）の作者の行。**公開済みの作品だけ** | 出る |
| 未公開の作品ページ（作者のための状態画面。名前を出さない） | 出ない |
| 一覧・トップ・作者ページのカード（`src/work-card.ts`） | **出ない**（#334 の範囲外。出したくなったら別 issue） |
| 改造通知メール（`src/mail/fork-notice.ts`） | **出ない**（#334 の範囲外） |

**表示だけの列です。** 運営だからできることは 1 つも増えません——権限・日次枠・
推敲の回数・審査の免除のどれにも使いません。

**運営であることは名前で見分けません。** 表示名はログインのたびに Google の名前で
上書きされ、仕様 5.9（#341）以後は利用者が自由に変えられます——**誰でも「運営」と
名乗れます。** 見分ける材料はこの列だけです。

---

## 2. 前提（利用者の作業）

1. 運営用の Google アカウントを 1 つ用意し、表示名を「運営」相当にする
   （アドレスと表示名の決定は issue #334 のコメント。**アドレスをここへ書き写しません**
   ——プライマリアドレスは後から変えられる、と同じコメントが書いています）
2. 招待コードを 1 枚発行して、そのアカウントで登録する（クローズドβ）
3. 以下の手順でフラグを立てる

**フラグは作品より後に立ててかまいません。** 既に公開した作品にもそのまま効きます
（作品の行は触りません。印は表示のたびに `users` を結合して引きます）。

### 2.1 運営アカウントの公開の見え方（2026-09-23 時点）

**利用者が決めた綴りです。** 変えたら、ここを直してください。

| 項目 | 値 |
|---|---|
| ハンドル名 | **`gameforgejp`**（作者ページは `/@gameforgejp`）。**旧 `gameforge_jp` は 2026-12-22 ごろまで 302 で転送**し、その後は 404 |
| 表示名 | `Game Forge 運営` |
| 自己紹介 | 運営アカウントであること・並んでいるのが運営の作ったサンプルであること・遊ぶのは誰でも、改造は招待コードを持つ人ができること・連絡はフッタの窓口から |
| 外部リンク | note と OFUSE（投げ銭）。**X（`gameforge2026`）はアカウントが凍結中のため外しました**（2026-09-23） |

**`gameforge` / `game_forge` で始まる名前は、ほかの利用者が取れません**（#778。`src/handle.ts` の
`HAND_WRITTEN_RESERVED_PREFIXES`）。**ロゴの語 `forge` / `anvil` も完全一致で予約しています。**
**運営自身もこの規則の外に居ません**——画面から名乗り直すことはできず、変えるときは 3.6 の手順を使います。

> **仕様 5.10 の #778 実装注記と、版の履歴の v1.134 の行は、`gameforge_jp` を持ち X の `gameforge2026` を
> 公開していると書いたままです**（2026-09-22 の記述）。**書き換えません**——仕様は「過去の記述は書き換えない。
> `## 版の履歴` の各行は、書かれた時点の語のまま残す」と定めています（`docs/product-spec.md` 10663 行）。
> **いまの綴りはこの表が持ちます。** 注記が支えている判断（接頭辞で弾く理由）は、綴りが変わっても動きません。

---

## 3. 手順

**本番への書き込みは利用者の端末で行います**（`docs/handoff.md` 3 章。実行環境は本番への
書き込みを止めます）。

### 3.1 0021 を本番へ当てる（1 度だけ）

**origin/main を checkout した（本番へ配備済みのマイグレーションをすべて含む）作業ツリー
から打ってください。** `migrations apply` も `check-migrations-applied.sh` も、**叩いた
作業ツリーの `migrations/` を期待値にして**本番の台帳と比べます。古いブランチや作業中の
worktree から打つと、そのツリーに無いマイグレーションは比べる対象に入らず、**未適用が
あっても `MIGRATIONS_APPLIED` と出ます**（2026-09-11 に実際にこれで誤報しました）。

```bash
git fetch origin
git checkout --detach origin/main        # 本番へ配備済みのものをすべて含むツリーにする
ls migrations/0021_users_operator.sql    # 0021 がこのツリーにあることを先に確かめる
npx wrangler d1 migrations apply DB --remote --env production
bash scripts/check-migrations-applied.sh --remote   # MIGRATIONS_APPLIED を確かめる
```

**0021 を当てる前に Worker を配ってはいけません。** 作品ページの問い合わせが
`is_operator` を選ぶので、列が無いと**すべての作品ページが落ちます。** 配備の手前には
`.github/workflows/verify.yml` の「未適用のマイグレーションが無いこと」の関門があり、
当てていなければそこで止まります。

### 3.2 運営アカウントの `users.id` を控える

```bash
npx wrangler d1 execute DB --remote --env production \
  --command "select id, display_name, is_operator, created_at from users where email = '<運営アカウントのアドレス>'"
```

**1 行だけ返ることを確かめます。** 0 行なら登録が済んでいません。

### 3.3 フラグを立てる

```bash
npx wrangler d1 execute DB --remote --env production \
  --command "update users set is_operator = 1 where id = '<3.2 で控えた id>'"
```

**`id` で指します。** `display_name` や `email` で指さないでください——どちらも変わる値で
あり、`display_name` は重複も許されます（5.9）。**名前で指した UPDATE は、同じ名前を
名乗った利用者にも印を立てます。**

値は `0` と `1` しか入りません（0021 の CHECK が、それ以外を書いた瞬間に断ります）。

### 3.4 確かめる

```bash
npx wrangler d1 execute DB --remote --env production \
  --command "select id, display_name from users where is_operator = 1"
```

**運営アカウントの 1 行だけが返ること。** 2 行以上なら、立てるべきでない行に立っています。

続けて、運営アカウントの**公開済みの**作品を 1 つ、未ログインのブラウザで開きます
（`https://app.game-forge.ojos.jp/works/<作品 id>`）。作者名の隣に枠で囲まれた
「運営アカウント」のバッジが出ていれば済みです。**利用者の作品を 1 つ開き、そちらには出ていないことも見ます。**

### 3.5 外す

```bash
npx wrangler d1 execute DB --remote --env production \
  --command "update users set is_operator = 0 where id = '<id>'"
```

外すと、その作者のすべての作品ページから印が消えます（作品の行は触りません）。

### 3.6 ハンドル名を変える（画面からは通りません）

**運営のハンドル名は、設定の画面からは変えられません。** 理由が 2 つあり、**どちらも意図した形です。**

1. **改名は 30 日に 1 回まで**（5.10。`HANDLE_RENAME_INTERVAL_DAYS`）
2. **`gameforge` で始まる名前は予約されている**（#778）。**`is_operator` を見て通す例外は作っていません**
   ——表示だけの列がハンドル名の可否まで決めることになるためです（1 章）。印の付け外しと同じく、D1 を直接書きます

**この手順は、30 日の間隔を意図して外します。** 画面の間隔は利用者の連打（履歴と索引を何度も書く）を
止めるためのもので、運営が年に数回打つ手順には当たりません。**ただし `claimed_at` は今の時刻になる**ので、
**画面からの改名は、この書き込みから改めて 30 日後になります。**

#### 3 つの要求は、まとめて巻き戻りません

**`src/handle.ts` の `changeHandle` は 1 つの `D1.batch`** で、途中で落ちれば全部が巻き戻ります。**端末から打つ
`wrangler d1 execute` は 1 文ずつ別の要求**なので、その保証がありません。そこで**順を「途中で止まっても
半端が残らない」形にしてあります**——**手放す → 取る → 履歴**の順です。

**`changeHandle` が履歴を先に積むのは、旧い名前を手放す前の行からしか読めないからです。** この手順では
旧い名前を自分で打つので、**履歴を最後に回せます。** 途中で落ちたときに「起きていない改名の記録」が
残らないのは、この順のおかげです。

**値は実行時に DB から読みます**——控えた値を貼り込むと、打つまでの間に利用者の操作で古くなります
（`docs/handoff.md` 3 章の #380）。置き換えるのは `<新しいハンドル名>` と `<いまのハンドル名>` だけです。

#### 手順

**先に、現状と空き具合を読み取ります**（後からは「何が在ったか」を確かめられません）。

```bash
npx wrangler d1 execute DB --remote --env production --json \
  --command "select h.handle, h.user_id, h.claimed_at, h.released_at from handles h join users u on u.id = h.user_id where u.is_operator = 1 order by h.claimed_at"
npx wrangler d1 execute DB --remote --env production --json \
  --command "select * from handles where handle = '<新しいハンドル名>'"
```

**いまのハンドル名が 1 行（`released_at` が null）で、新しい名前が 0 行**であること。**新しい名前に行が
あれば、そこで止めます**（ほかの人が持っています）。

```bash
# 1. いまの名前を手放す（90 日の予約へ移り、旧 URL は転送になる）
npx wrangler d1 execute DB --remote --env production \
  --command "update handles set released_at = cast(strftime('%s','now') as integer) where handle = '<いまのハンドル名>' and released_at is null and user_id in (select id from users where is_operator = 1 and withdrawal_started_at is null)"

# 2. 新しい名前を取る（手放した後でないと部分索引で落ちる）
npx wrangler d1 execute DB --remote --env production \
  --command "insert into handles (handle, user_id, claimed_at) select '<新しいハンドル名>', h.user_id, cast(strftime('%s','now') as integer) from handles h where h.handle = '<いまのハンドル名>' and h.released_at is not null and h.user_id in (select id from users where is_operator = 1 and withdrawal_started_at is null)"

# 3. 履歴を積む（新しい名前が現役になっていることを条件にする）
npx wrangler d1 execute DB --remote --env production \
  --command "insert into handle_changes (id, user_id, old_handle, new_handle, changed_at) select lower(hex(randomblob(16))), h.user_id, '<いまのハンドル名>', '<新しいハンドル名>', cast(strftime('%s','now') as integer) from handles h where h.handle = '<新しいハンドル名>' and h.released_at is null and h.user_id in (select id from users where is_operator = 1 and withdrawal_started_at is null)"
```

#### 落ちたときの戻し方（落ちた番号で変わります）

| 落ちた文 | 起きていること | やること |
|---|---|---|
| **1** | 何も書かれていない | そのまま止める。0 行なら、いまの名前が既に手放されている（読み取りへ戻る） |
| **2**（`UNIQUE constraint failed: handles.handle`） | **ほかの誰かがその名前を先に取った。** 運営は現役の名前を持たない状態 | **下の取り消しで 1 を戻し、止める**（別の名前を選び直す） |
| **2**（`UNIQUE constraint failed: handles.user_id`） | **1 が当たっていない**（別の経路で改名が起きた等）。運営は現役の名前を持っている | **取り消さずに止め、読み取りからやり直す**——戻すと現役の行が 2 つになる |
| **3** | **行は正しい。** 履歴だけが欠けている | **`handle_changes` を読んでから、3 だけを打ち直す**——条件は新しい行を見るだけなので、**当たった後にもう一度打つと履歴が 2 行になります** |

```bash
# 2 が handles.handle で落ちたときだけ（履歴はまだ書いていないので、これで元に戻ります）
npx wrangler d1 execute DB --remote --env production \
  --command "update handles set released_at = null where handle = '<いまのハンドル名>' and released_at is not null and user_id in (select id from users where is_operator = 1) and not exists (select 1 from handles h2 where h2.user_id in (select id from users where is_operator = 1) and h2.released_at is null)"
```

**取り消しの文にも条件を置いてあります**——**運営が現役の名前を持っていないときにしか当たりません。**
持っている状態で戻すと、部分索引（`handles_user_current_idx`）が弾くか、弾かれずに 2 つ目の現役の行を
作ることになります。

#### 確かめます

```bash
npx wrangler d1 execute DB --remote --env production --json \
  --command "select h.handle, h.claimed_at, h.released_at from handles h join users u on u.id = h.user_id where u.is_operator = 1 order by h.claimed_at"
npx wrangler d1 execute DB --remote --env production --json \
  --command "select old_handle, new_handle, changed_at from handle_changes where user_id in (select id from users where is_operator = 1) order by changed_at"
curl -sI "https://app.game-forge.ojos.jp/@<新しいハンドル名>" | head -1
curl -sI "https://app.game-forge.ojos.jp/@<いまのハンドル名>" | grep -iE "^HTTP/|^location"
```

**新しい名前が現役（`released_at` が null）、旧い名前に時刻が入り、履歴が 1 行だけ増え、`/@新` が 200、
`/@旧` が 302 で `/@新` を指すこと。** 旧い名前の転送は 90 日で切れ、その後は 404 になります。

**この手順は 2026-09-23 に実際に通しました**（`gameforge_jp` → `gameforgejp`）。**打つ前に、使い捨ての
ローカル D1（`--local --persist-to`）で同じ文を流し、`changeHandle` と同じ行（履歴 1 行・旧い行の予約・
新しい行の現役）になることを確かめています。** **当日は履歴を先に積む順で打ちました**——上の順（履歴を
最後）は、PR #782 の Copilot の指摘（途中で落ちると、起きていない改名の記録が残る）を受けて直したものです。

---

## 4. 限界——機械照合は置けません

**この印には、本番で立っていることを確かめる検査がありません。** フラグは D1 の行データで
あり、宣言（コード・マイグレーション・terraform）のどこにも値が無いためです。

- **テストが見ているのは、テスト用 D1 の列の形と画面の分岐です**
  （`test/schema-operator.test.ts` / `test/work-page.test.ts`）。本番の行に 1 が立って
  いることは見ていません
- **本番でフラグが失われても、`scripts/verify.sh` も CI も `scripts/acceptance-remote.sh`
  も緑のまま通ります。** 印が消えたことに気づく経路は、**人が作品ページを開くこと**
  だけです
- 運営アカウントの `id` をコードや検査へ書き写して照合する形は採りません。本番の行の値を
  写すと、写しは必ず腐ります（shared-ai-rules 12 章）

**フラグが失われうる出来事と、そのあとにすること:**

| 出来事 | 何が起きるか | すること |
|---|---|---|
| D1 を過去の時点へ戻した（Time Travel） | 戻した時点の値になる | 3.4 をやり直す |
| 運営アカウントを別の Google アカウントで作り直した | `google_sub` が違えば**別の利用者**になり、新しい行は 0 で始まる。作品の所有も古い行に残る（`games.author_id` の付け替えが要る。issue #334 のコメント） | 3.2 から。所有の付け替えは別の作業 |
| `users` を手作業で UPDATE した | 誤って 0 に戻しうる | 3.4 をやり直す |

**ログインでは落ちません。** 既存の利用者のログインが書くのは `email` と `display_name`
だけです（`src/auth/google.ts` の `refreshExistingUser`）。**ただし、これも検査では
押さえていません**——ログインの UPDATE がこの列を書くように変わっても、落ちる
テストはありません。

---

## 5. 見た目の限界

**見分けは文字ではなく見た目で付けています。** 表示名は利用者が自由に決められ、語の
制限もありません（5.9）。名前に「運営アカウント」と書けば、**文字の並びとしては**運営と
同じものを画面に出せます。そこで印を**枠と地を持つバッジ**にしてあります
（`public/assets/app.css` の `.gf-operator`。無彩色のトークンだけで描く）。

**利用者はこの見た目を持ち込めません。** 名前は `<strong>` の中へ `escapeHtml` を通して
出るので、名前に書いた HTML はタグとして解釈されず、`class` も付きません。
`test/work-page.test.ts` の「名前に class 属性つきの HTML を入れても、バッジの要素に
ならない」が、`gf-operator` のクラスを持つ要素を名前に入れた場合（引用符の有無・種類、
`</strong>` で閉じようとする形を含む）を確かめ、「バッジは枠と地を持ち、無彩色の
トークンだけで描く」が app.css の宣言を確かめています。

**残る限界:**

- **見た目は CSS が読み込まれてはじめて付きます。** CSS を切った閲覧（リーダーモード・
  テキストだけのクローラなど）では、印は名前の隣の素の文字列になり、名前で真似できます
- 見分けられるのは**作品ページだけ**です。カード（一覧・トップ・作者ページ）には作者名は
  出ても印は出ません（1 章）

---

## 関連

- 列の定義と、なぜ導出せず列で持つのか: `migrations/0021_users_operator.sql`
- 表示: `src/work-page.ts`（`operatorMark` / `OPERATOR_MARK`）
- BAN（同じ運用の前例）: [usage-report.md](usage-report.md)
- 表示名の変更（誰でも「運営」と名乗れるようになる）: 仕様 5.9 / #341
