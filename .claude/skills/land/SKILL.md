---
name: land
description: PR を確認し、問題なければマージする。利用者が /land [PR 番号] で起動したときだけ使う。
disable-model-invocation: true
argument-hint: "[PR 番号（省略時はこの会話で直前に扱った PR）]"
---

# PR の確認とマージ

「PR を確認して、問題なければマージしてください」を 1 語にしたものです。**利用者が `/land` を打ったことを、対象 PR へのマージ承認の記録として扱います。**

- **エージェントからは起動できません**（`disable-model-invocation: true`）。起動できると、エージェントが自分で承認を作れてしまい、記録の意味が無くなります。既定の merge 方針は手動承認です（`.ai-playbook/role-contracts/closer.md`）。
- **承認の範囲は、起動した時点の PR です。** 途中で止めて報告し、そのあと利用者が「続けて」と言った場合、それは新しい指示として扱います。
- 判定の基準は規範が正本です。ここへは複製しません。
  - 指摘を解決済みとみなす条件と、打ち切りの規則: `.ai-playbook/review-workflow.md`「リモート最終ゲート」
  - 指摘を却下するときの記録: 同「指摘の却下」
  - 差分の読み方: `.ai-playbook/task-playbooks/pr-review.md`

## 手順

対象 PR の番号を `N` とします。`$ARGUMENTS` に番号があればそれを使います。無ければ、この会話で直前に作った PR か、直前に話題にした PR を使います。**1 本に決まらなければ、推測せず利用者に聞きます。**

### 1. 状態を読む

```bash
gh pr view N --json number,title,state,isDraft,mergeable,headRefName,headRefOid,baseRefName,body,closingIssuesReferences,commits
```

次のどれかにあたれば、止めて報告します。

- open でない、あるいは draft である
- `baseRefName` が `main` でない。**この手順は、main へのマージとその配備を前提にしています。** 別のブランチ向けの PR に使うと、9 で無関係な main の実行を見届け、配備が済んだと誤って報告することになります。

### 2. CI とリモート最終ゲートの完了を待つ

**利用者の入力を、再開のきっかけにしません。** これまでは PR を作った時点でターンを終えていたため、利用者が指示するまで確認そのものが始まりませんでした。このスキルが解消したいのはその点です。待つときは、終わると通知が来て自動で再開する形（Bash の `run_in_background`）を使います。

**先に、確かめたいコミットにチェックが付いたことを確かめます。** push の直後に `gh pr checks` を叩くと、**前のコミットの結果が返ることがあります。** 実測では、push の直後に前の head の全緑が終了コード 0 で返り、その 3 秒後に新しいコミットの pending へ変わりました。`--watch` は前者を見て即座に抜けるので、7 で直して戻ってきたときに偽の緑で通り抜けます。

`sha` には、最初に来たときは 1 で読んだ `headRefOid` を、7 から戻ってきたときは push したコミット（`git rev-parse HEAD`）を入れます。`headRefName`（ブランチ名）と取り違えると、比較が必ず外れて時間切れになります。

```bash
for _ in $(seq 60); do  # 5 秒 × 60 回 = 5 分
  head="$(gh pr view N --json headRefOid --jq .headRefOid)" || head=""
  runs="$(gh api "repos/{owner}/{repo}/commits/$sha/check-runs" --jq .total_count)" || runs=0
  [ "$head" = "$sha" ] && [ "${runs:-0}" -gt 0 ] && { echo CHECKS_ATTACHED; exit 0; }
  sleep 5
done
echo CHECKS_NOT_ATTACHED; exit 1
```

`CHECKS_ATTACHED` が出てから watch します。`CHECKS_NOT_ATTACHED` なら、止めて報告します。

check run だけを数えれば足りるのは、このリポジトリの事情によります。PR で起動する `verify`・`identity-guard`・`review-gate` はパスで絞っていないため、PR のどのコミットにも check run が付きます。commit status は `review-gate` だけで、これも check run と一緒に Actions が出しています。外部の CI はありません。それでも付かないのは、`[skip ci]` などで CI を飛ばしたコミットです。**CI を通っていないコミットを黙って通さず、止まるのが正しい動きです。**

```bash
gh pr checks N --watch --interval 30
```

- `review-gate` は、opened のときは 120 秒の猶予を置いてから判定します。すぐに出なくても異常ではありません。
- 失敗の形は 2 つあり、**扱いが違います。**
  - **status の `review-gate` が failure**（説明文が `Copilot code review was never requested`）: Copilot のレビューが要求されていません。**ジョブのエラー文に書かれている手順どおりに、1 回だけ手で要求します。**
  - **ジョブの `check` だけが失敗し、status の `review-gate` が failure でない**: レビューの有無を API から読めなかっただけです（`review-gate.yml` はこのとき status を付けません）。**要求しません。** 要求済みのレビューを二重に要求すると、「1 回だけ要求する」が壊れます。3 のループで待ち、届かなければ止めて報告します。

### 3. Copilot のレビューが届くのを待つ

`review-gate` が緑でも、それは「要求された」ことを示すだけです。**レビュー本文が届くまで待ちます。** 次のループを Bash の `run_in_background` で回します（フォアグラウンドの sleep は使えません）。

```bash
for _ in $(seq 30); do  # 30 秒 × 30 回 = 15 分
  n="$(gh api --paginate 'repos/{owner}/{repo}/pulls/N/reviews' \
      --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | .id' | wc -l)" || n=0
  [ "$n" -gt 0 ] && { echo COPILOT_REVIEW_POSTED; exit 0; }
  sleep 30
done
echo COPILOT_REVIEW_TIMEOUT; exit 1
```

- **`--paginate` を外しません。** 外すと先頭の 30 件しか見ないため、レビューが多い PR では、届いているのに待ち続けます。`--paginate` と `--jq` を組み合わせると、jq はページごとに適用されます。そのため `length` で数えず、1 件 1 行で出して `wc -l` で数えます。
- API から読めなかった回は 0 件として扱い、そのまま待ち続けます。**「届いた」と判定してはいけません。** 読めなかったことを到着と取り違えると、レビューを読まないまま次へ進んでしまいます。
- **`|| n=0` を外しません。** `set -e -o pipefail` のシェルで回すと、API が 1 回失敗しただけで、合図の行を何も出さずに終了します（実測）。どちらの合図も出ないまま止まると、届いたのか、時間切れなのかが分かりません。
- **`COPILOT_REVIEW_TIMEOUT` が出たら、マージせずに止めて報告します。** レビュアー不在で最終判断できない状態は、closer の「エスカレーション条件」にあたります。
- 指摘は review 本文と、行に付いたコメントの両方に出ます。

```bash
gh api --paginate 'repos/{owner}/{repo}/pulls/N/reviews' --jq '.[] | {user: .user.login, state, body}'
gh api --paginate 'repos/{owner}/{repo}/pulls/N/comments' --jq '.[] | {user: .user.login, path, line, body}'
```

- 人間が付けたコメントも同じ一覧に出ます。**それも指摘として扱います。**
- Copilot は、確度の低い指摘を review 本文の「Suppressed comments」に折りたたんで出します。**これも読みます。** 行コメントと同じくらい実在することがあります。

### 4. 自分でも差分を読む

CI が緑でも、Copilot の指摘が 0 件でも、読まずにマージしません。

- `gh pr diff N` を読み、`pr-review.md` の順に確認します（受け入れ条件との対応、次に高リスクの観点）。
- **その差分がこの PR のものか確かめます。** 直前のブランチに居たまま `git checkout -b` すると、前の PR のコミットが相乗りします。この場合、レビューも CI も緑のまま通ってしまいます（`docs/handoff.md`）。`commits` の見出しと `gh pr diff N --name-only`（変更したファイルの一覧）が、PR の主題と合っているかを見ます。
- 本文に `Closes #NNN` があるか確かめます。書かれていないと、マージしても issue が open のまま残ります。

### 5. マージの前提を確かめる

**main へマージすると、そのまま本番へ配備されます**（`.github/workflows/verify.yml` の `deploy` ジョブ）。マージした後で順序を直す方法はありません。

- オーケストレータの束が変わる場合は、**Lambda の配備を先に済ませる必要があります**（`docs/orchestrator.md`）。**変わるかどうかを、ファイル名で判断しません。** 束には `src/orchestrator/**` のほかに `src/bedrock.ts` や `src/generate.ts` も入るため、名前で見ると見落とします。#258 が実際にこれで抜けました。束そのものを作って比べます。PR のブランチを checkout したきれいな作業ツリーで、次を実行します。

  ```bash
  git fetch origin main
  bash scripts/orchestrator-bundle-changed.sh "$(git merge-base origin/main HEAD)"
  ```

  最終行が `ORCHESTRATOR_BUNDLE_CHANGED` なら、配備が必要です。スクリプトが失敗した場合（作業ツリーが汚れている等）は、「変わっていない」とは扱いません。
- 差分が `migrations/` に及ぶ場合は、**適用を先に済ませる必要があります。** 適用済みかどうかは、PR のブランチを checkout したツリーで `bash scripts/check-migrations-applied.sh --remote` を実行して確かめます。そのブランチが古い main から切られているなら、先に手元で main を取り込みます（確かめるためだけなので push はしません）。古いツリーで見ると、未適用を見落とします。
- PR 本文や issue に「マージ前に〜」と書かれている前提も確かめます。

どれも外部の状態を変える操作です。**済んでいなければ、ここで止めて利用者に伝えます。** このスキルの中では実行しません。

### 6. 指摘を判定する

判定の基準は、`review-workflow.md` の「リモート最終ゲート」と「指摘の却下」に従います。そのうえで、指摘ごとに次の順に判断します。

1. **実在するかを、実測で確かめます。** 読んだ印象だけで決めません。
2. **実在しない（事実誤認）なら**、「指摘の却下」の手順で却下し、再現手順と実測結果を残します。**ただし、却下するかどうかと、示された対処を採るかどうかは別に判断します。** 前提が誤っていても、提案された対処そのものに価値があれば採ります（同節）。
3. **実在するなら、7 で直します。** 規範は「CI がすべて通っていれば解決済みとしてマージしてよい」としていますが、これは「マージしてよい」という許可であって、「直さなくてよい」と決める規則ではありません。**CI が緑であることだけを理由に、実在する指摘を残したままマージしません。** 直さずに通すのは、スコープ外、または命名・可読性・好みの提案にあたる場合だけです。その場合は、どちらにあたるかと、技術負債として記録したことを書きます。

判定の結果は、PR へ 1 件のコメントにまとめて返します（どの指摘を、どう扱ったか）。

### 7. 直す（1 巡だけ）

- **PR のブランチが checkout されている worktree で直します。** 他のセッションと共有しているプライマリの作業ツリーでは直しません。
- push の前に `bash scripts/loop-gate.sh` を通します。identity の検査もこのゲートに入っています。
- push したら、2 に戻って CI を待ちます。**Copilot には再要求しません。**
- **次のどれかにあたれば、マージせずに止めて報告します。**
  - 直すには仕様の判断が要る。または直すと PR の範囲を超える
  - 直したあとも CI が赤い
  - 直したあとに、新しい指摘（2 巡目）が出た。**扱いを決めるのは人間です。** 規範では、2 巡目以降の軽微な指摘は人間が却下し、AI 同士を往復させません。重大な指摘であれば、人間が扱いを決めます。どちらの場合も、このスキルの中では判定しません

### 8. マージする

**先に、squash の本文に CI を飛ばす指示が入っていないか確かめます。** このリポジトリの squash の本文は、PR のコミットメッセージを連ねたものです（`squash_merge_commit_message: COMMIT_MESSAGES`）。どれか 1 つのメッセージに CI を飛ばす指示があれば、**main の `verify` も `deploy` も起動しません。** GitHub は、メッセージの見出しでなく本文にあっても、この指示に従います。PR #343 で実際に踏みました。説明のために書いた一文がこれに当たり、PR 側の CI が 1 本も起動しませんでした。

```bash
gh pr view N --json commits --jq '.commits[] | .messageHeadline, .messageBody' \
  | grep -n -i -E '\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks: *true'
```

何も出なければ（終了コード 1）、そのままマージします。

```bash
gh pr merge N --squash
```

該当する行が出たら、その指示を除いた本文をファイルに書き、`gh pr merge N --squash --body-file <そのファイル>` で本文を差し替えてマージします。

- **確認が出るのは正常です。** `scripts/confirm-merge-hook.sh` がマージの直前に確認を挟みます。承認されればマージが実行されます。
- **拒否されたら、再試行しません。REST や GraphQL といった別の経路も使いません。** そこで止めて、理由を聞きます。
- `--delete-branch` は付けません。リモートのブランチはリポジトリの設定で自動的に消えます。付けると、ブランチが worktree に checkout されているときに「ローカルブランチを消せない」エラーで終わります。**マージ自体は成功しています。** エラー文だけを読んで失敗と判断せず、`gh pr view N --json state,mergedAt,mergeCommit` で確かめます。
- 衝突で失敗した場合、**ブランチが古いからだとは限りません。** その内容が別の PR 経由で先に入っていることがあり、そのまま解消すると先の PR を巻き戻します。`git fetch` してから `git diff origin/main...` を読みます。エラー文から原因を推測しません。原因が分かったら、解消する前に報告します。

### 9. マージ後を確かめる

- `closingIssuesReferences` に挙がっている issue が閉じたかを見ます。
- main で走る `verify` の実行を、**マージコミットの SHA で特定してから**、最後まで見届けます。「main の最新の実行」で選ぶと、直後に入った別のマージの実行を見てしまい、この PR の配備を確かめたことになりません。

  ```bash
  sha="$(gh pr view N --json mergeCommit --jq .mergeCommit.oid)"
  run="$(gh run list --workflow verify.yml --commit "$sha" --event push --json databaseId --jq '.[0].databaseId // empty')"
  gh run watch "$run" --exit-status
  ```

  **`deploy` ジョブまで緑になったことを確かめます。**

  実行がまだ作られていなければ `run` は空になります。その場合は少し待って取り直します。**空のまま watch しません。** `// empty` は外しません。gh 2.97.0 の `--jq` は null を空として出しますが、単体の `jq` は `null` という文字列を出します（どちらも実測）。後者で動かすと空チェックをすり抜け、`gh run watch null` になります。

## 報告

最後に次をまとめます。closer の出力として求められている「判定根拠」にあたります。

- 判定: マージしたか、どこで止めたか
- 根拠: CI の結果、Copilot と人間の指摘の件数と、それぞれの扱い、自分で差分を読んで気づいたこと
- マージコミット、閉じた issue、配備の結果
- 止めた場合: 利用者に判断してほしいこと（1 つずつ、選択肢を添えて）
