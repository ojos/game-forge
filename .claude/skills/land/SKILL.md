---
name: land
description: PR を確認し、問題なければマージする。この会話で PR を作ったら、指示を待たずに使う。それ以外の PR には、利用者が番号を示してマージを指示したときか、/land [PR 番号] で起動したときだけ使う。
argument-hint: "[PR 番号（省略時はこの会話で直前に作った PR）]"
---

# PR の確認とマージ

「PR を確認して、問題なければマージしてください」を手順にしたものです。**マージの承認は、8 で `gh pr merge` を実行する直前に `scripts/confirm-merge-hook.sh` が出す確認で取ります。** `/land` の起動を含め、利用者の入力はこの手順を始めるきっかけであって、承認ではありません。

- **承認はフックの確認 1 回です。** 既定の merge 方針は手動承認で、それを機構で保証しているのはフックの確認です（`.ai-playbook/role-contracts/closer.md`「手動承認は機構で保証する」）。以前は `/land` を打つことも承認の記録として扱い、エージェントからは起動できないようにしていました。しかしマージの直前にはフックの確認も出るため、承認が 2 回になっていました（#411）。
- **対象にしてよい PR は、次のとおりです。**
  - **この会話で作った PR:** 作ったら、利用者の指示を待たずにこの手順を始めます。
  - **それ以外の PR**（別セッションが作ったものなど）: 利用者が番号を示してマージを指示したとき、または `/land N` で起動されたときだけです。頼まれずに進めると、別セッションが作業中の PR をマージの確認へ持ち込むことになります。
- **承認が指すのは、確かめたコミットです。** 8 で `--match-head-commit` を付け、確かめた head から動いていればマージが失敗するようにします。確認を待つあいだに別の push が入っても、確かめていない中身はマージされません。
- **途中で止めて報告したら、利用者の指示があるまで再開しません。**
- 判定の基準は規範が正本です。ここへは複製しません。
  - 指摘を解決済みとみなす条件と、打ち切りの規則: `.ai-playbook/review-workflow.md`「リモート最終ゲート（任意の層）」の「置く場合」。このプロジェクトは置きませんが、この規律は第二意見と人間の指摘へそのまま当てはめます（`.github/project-ai-rules.md`「リモート最終ゲートを置かないことは規範どおりの選択です」）
  - 指摘を却下するときの記録: 同「指摘の却下」
  - 差分の読み方: `.ai-playbook/task-playbooks/pr-review.md`

## 手順

対象 PR の番号を `N` とします。`$ARGUMENTS` に番号があればそれを使います。無ければ、この会話で直前に作った PR か、利用者がこの会話で番号を示してマージを指示した PR を使います。**1 本に決まらなければ、推測せず利用者に聞きます。**

### 1. 状態を読む

```bash
gh pr view N --json number,title,state,isDraft,mergeable,headRefName,headRefOid,baseRefName,body,closingIssuesReferences,commits
```

次のどれかにあたれば、止めて報告します。

- open でない、あるいは draft である
- **利用者の指示なしに始めたのに、作業ディレクトリで checkout しているブランチ（`git branch --show-current`）が `headRefName` と一致しない。** 「この会話で作った PR だけ」を、文章だけでなく確かめられる形にしたものです。別セッションは自分の worktree で作業するため、その PR のブランチはここに checkout されていません。番号を示した指示や `/land N` で始めた場合は、この条件を見ません
- `baseRefName` が `main` でない。**この手順は、main へのマージとその配備を前提にしています。** 別のブランチ向けの PR に使うと、9 で無関係な main の実行を見届け、配備が済んだと誤って報告することになります。

### 2. CI と第二意見の確認側の完了を待つ

**リモート最終ゲートはありません**（#807 で Copilot code review を撤退しました。`.github/project-ai-rules.md`「リモート最終ゲート」）。PR の上で機構が確かめるのは、CI（`verify`・`identity-guard`）と、第二意見の記録（`second-opinion-gate`）です。

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

check run だけを数えれば足りるのは、このリポジトリの事情によります。PR で起動する `verify`・`identity-guard`・`second-opinion-gate` はパスで絞っていないため、PR のどのコミットにも check run が付きます。commit status は `second-opinion-gate` と、`docs/handoff.md` を触る PR の `writeback-serial`、`terraform/` を触る PR の `acceptance-remote-pr` だけで、どれも check run と一緒に Actions が出しています。外部の CI はありません。それでも付かないのは、`[skip ci]` などで CI を飛ばしたコミットです。**CI を通っていないコミットを黙って通さず、止まるのが正しい動きです。**

```bash
gh pr checks N --watch --interval 30
```

- **`terraform/` を触る PR では、`acceptance-remote-pr` が failure のまま `--watch` が終わることがあります。** apply の後の外部層の記録が無いと failure になるのが正しい状態で、ここでは止めずに 5 で読みます（#845）。
- `second-opinion-gate` は、push のたびに 300 秒の猶予を置いてから判定します（記録は push の後に手元から投稿されるため）。すぐに出なくても異常ではありません。
- **Dependabot の PR は、記録を投稿しません。** ゲートが待たずに success を付けます（説明文が `Dependabot PR: second-opinion record not required`。#838）。ただし人がコミットを足していれば、いつもどおり記録が要ります。どちらの場合も、4 で差分は読みます。
- 失敗の形は 2 つあり、**扱いが違います。**
  - **status の `second-opinion-gate` が failure**（説明文が `no second-opinion record for this head`）: その head に紐づく第二意見の記録がありません。**この会話で作った PR なら、PR のブランチを checkout した worktree で `bash scripts/loop-gate.sh` を通し、`bash scripts/second-opinion-record.sh post` で投稿します。** 記録だけを作って投稿しません（回していないレビューを回したことにする形です）。別セッションの PR なら、止めて報告します。
  - **ジョブの `record` だけが失敗し、status の `second-opinion-gate` が failure でない**: 記録の有無を API から読めなかっただけです（このとき status は付きません）。**投稿し直しません。** 20 分ごとの掃き寄せが判定し直すのを待ち、付かなければ止めて報告します。

### 3. 第二意見の記録と、人間のコメントを読む

`second-opinion-gate` が緑でも、それは「記録がある」ことを示すだけです。**記録の中身を読みます。** ただし、説明文が `Dependabot PR: second-opinion record not required` の緑は「記録を求めていない」ことを示します（#838）。読む記録は無いので、人間のコメントだけを読み、4 へ進みます。 記録は PR のコメントとして、先頭に `<!-- second-opinion sha=<head の SHA> -->` の印を持って投稿されています。

```bash
gh api --paginate 'repos/{owner}/{repo}/issues/N/comments' --jq '.[] | {user: .user.login, created_at, body}'
gh api --paginate 'repos/{owner}/{repo}/pulls/N/reviews' --jq '.[] | {user: .user.login, state, body}'
gh api --paginate 'repos/{owner}/{repo}/pulls/N/comments' --jq '.[] | {user: .user.login, path, line, body}'
```

- **いまの head の SHA を持つ記録を読みます。** 古い head の記録は、直す前の差分に対するものです。
- **`--paginate` を外しません。** 外すと先頭の 30 件しか見ないため、コメントが多い PR では、いまの head の記録を見落とします。
- 記録に指摘があれば、6 で判定します。`loop-gate.sh` が `GATE_PASS` を返していても、報告対象外として出た指摘（範囲外など）が残っていることがあります。
- 人間が付けたコメントやレビューも同じ一覧に出ます。**それも指摘として扱います。**

### 4. 自分でも差分を読む

**判断の要る指摘の受け皿は、この手順です**（`.github/project-ai-rules.md`「リモート最終ゲート」）。リモート最終ゲートを置いていないので、PR 本文や issue の acceptance と差分の突き合わせは、機構ではなくここで行います。CI が緑でも、第二意見の指摘が 0 件でも、読まずにマージしません。

- `gh pr diff N` を読み、`pr-review.md` の順に確認します（受け入れ条件との対応、次に高リスクの観点）。
- **その差分がこの PR のものか確かめます。** 直前のブランチに居たまま `git checkout -b` すると、前の PR のコミットが相乗りします。この場合、レビューも CI も緑のまま通ってしまいます（`docs/handoff.md`）。`commits` の見出しと `gh pr diff N --name-only`（変更したファイルの一覧）が、PR の主題と合っているかを見ます。
- 本文とコミットメッセージ（`commits` の `messageHeadline` / `messageBody`）の**両方**に `Closes #NNN` があるか確かめます。本文に無ければ、マージしても issue が open のまま残ります。コミットメッセージ側は、PR 本文の `Closes` を GitHub が認識しないことがあるための保険です（`.ai-playbook/shared-ai-rules.md`「6. コミットメッセージ規約」の「Closes の保険」。このリポジトリでは #839 / #841 / #842 で `closingIssuesReferences` が空になりました。`docs/handoff.md` 3 章）。**コミットメッセージ側に無ければ、8 で squash の本文に `Closes #NNN` を足してマージします。** 保険のためだけにコミットを積み直して CI をやり直すことはしません。

  ```bash
  gh pr view N --json body,commits --jq '"[body]", .body, (.commits[] | "[commit \(.oid[0:7])]", .messageHeadline, .messageBody)' \
    | grep -n -i -E '^\[|(close[sd]?|fix(e[sd])?|resolve[sd]?) #[0-9]+'
  ```

### 5. マージの前提を確かめる

**main へマージすると、そのまま本番へ配備されます**（`.github/workflows/verify.yml` の `deploy` ジョブ）。マージした後で順序を直す方法はありません。

- オーケストレータの束が変わる場合は、**Lambda の配備を先に済ませる必要があります**（`docs/orchestrator.md`）。**変わるかどうかを、ファイル名で判断しません。** 束には `src/orchestrator/**` のほかに `src/bedrock.ts` や `src/generate.ts` も入るため、名前で見ると見落とします。#258 が実際にこれで抜けました。束そのものを作って比べます。PR のブランチを checkout したきれいな作業ツリーで、次を実行します。

  ```bash
  git fetch origin main
  bash scripts/orchestrator-bundle-changed.sh "$(git merge-base origin/main HEAD)"
  ```

  最終行が `ORCHESTRATOR_BUNDLE_CHANGED` なら、配備が必要です。スクリプトが失敗した場合（作業ツリーが汚れている等）は、「変わっていない」とは扱いません。
- チャットの関数の束も、同じツリーで確かめます（#903 / #925）。別の zip・別の関数なので、オーケストレータの結果からは分かりません。

  ```bash
  bash scripts/chat-bundle-changed.sh "$(git merge-base origin/main HEAD)"
  ```

  最終行が `CHAT_BUNDLE_CHANGED` なら、**マージの前に、利用者の端末で `bash scripts/deploy-chat.sh` を実行してもらう必要があります**（実体の `node_modules` を持つ、PR の head のツリーから）。スクリプトが失敗した場合は、オーケストレータと同じく「変わっていない」とは扱いません。main の deploy の関門（`.github/workflows/verify.yml`）も止めますが、それはマージの後です。ここで先に気づけば、main の deploy を止めずに済みます。
- 差分が `migrations/` に及ぶ場合は、**適用を先に済ませる必要があります。** 適用済みかどうかは、PR のブランチを checkout したツリーで `bash scripts/check-migrations-applied.sh --remote` を実行して確かめます。そのブランチが古い main から切られているなら、先に手元で main を取り込みます（確かめるためだけなので push はしません）。古いツリーで見ると、未適用を見落とします。
- 差分が `terraform/` に及ぶ場合は、**apply と、その後の外部層の記録が先に要ります**（#845）。apply はマージの前に、プライマリを PR の head へ `--detach` で置いて利用者が当てます（`docs/handoff.md` 3 章）。済んだかどうかは commit status の `acceptance-remote-pr` で読みます。**見るのは確かめる head の status です**（`gh api "repos/{owner}/{repo}/commits/$sha/statuses" --jq '[.[] | select(.context == "acceptance-remote-pr")][0] | {state, description}'`）。
  - success: その head で回した最新の記録が全件 PASS です。前提は済んでいます。
  - failure: 説明文で読み分けます（`docs/acceptance-remote-schedule.md`「status の読み方」）。記録が無い・古い head のもの・前提の不成立なら、**apply と `bash scripts/acceptance-remote-scheduled.sh --pr N` の手順を渡して止めます。** 乖離（`found drift`）なら、PR のコメントの `DRIFT` の行を添えて止めます。**required check ではないので、マージそのものは通ってしまいます。** 止めるのはこの手順です。
  - 無い: `terraform/` を触る PR なのに無いときは、GitHub API から読めなかったか、まだ判定されていません。`gh workflow run acceptance-remote-pr.yml -f pr=N` で流してから読み直します。付かなければ止めて報告します。
  - 記録を付けたのが apply の前か後かは、機構では分かりません（記録は head で結ぶだけです）。利用者に apply の後に回したかを確かめます。
- PR 本文や issue に「マージ前に〜」と書かれている前提も確かめます。

どれも外部の状態を変える操作です。**済んでいなければ、ここで止めて利用者に伝えます。** このスキルの中では実行しません。

### 6. 指摘を判定する

判定の基準は、`review-workflow.md` の「リモート最終ゲート（任意の層）」の「置く場合」と「指摘の却下」に従います（置かないこのプロジェクトでも、指摘の扱いはそのまま使います）。そのうえで、指摘ごとに次の順に判断します。

1. **実在するかを、実測で確かめます。** 読んだ印象だけで決めません。
2. **実在しない（事実誤認）なら**、「指摘の却下」の手順で却下し、再現手順と実測結果を残します。**ただし、却下するかどうかと、示された対処を採るかどうかは別に判断します。** 前提が誤っていても、提案された対処そのものに価値があれば採ります（同節）。
3. **実在するなら、7 で直します。** 規範は「CI がすべて通っていれば解決済みとしてマージしてよい」としていますが、これは「マージしてよい」という許可であって、「直さなくてよい」と決める規則ではありません。**CI が緑であることだけを理由に、実在する指摘を残したままマージしません。** 直さずに通すのは、スコープ外、または命名・可読性・好みの提案にあたる場合だけです。その場合は、どちらにあたるかと、技術負債として記録したことを書きます。

判定の結果は、PR へ 1 件のコメントにまとめて返します（どの指摘を、どう扱ったか）。

### 7. 直す（1 巡だけ）

- **PR のブランチが checkout されている worktree で直します。** 他のセッションと共有しているプライマリの作業ツリーでは直しません。
- push の前に `bash scripts/loop-gate.sh` を通します。identity の検査もこのゲートに入っています。
- push したら、`bash scripts/second-opinion-record.sh post` で新しい head の記録を投稿し、2 に戻って CI を待ちます。
- **次のどれかにあたれば、マージせずに止めて報告します。**
  - 直すには仕様の判断が要る。または直すと PR の範囲を超える
  - 直したあとも CI が赤い
  - 直したあとに、新しい指摘（2 巡目）が出た。**扱いを決めるのは人間です。** 規範では、2 巡目以降の軽微な指摘は人間が却下し、AI 同士を往復させません。重大な指摘であれば、人間が扱いを決めます。どちらの場合も、このスキルの中では判定しません

### 8. マージする

**先に、squash の本文に CI を飛ばす指示が入っていないか確かめます。** このリポジトリの squash の本文は、PR のコミットメッセージを連ねたものです（`squash_merge_commit_message: COMMIT_MESSAGES`）。どれか 1 つのメッセージに CI を飛ばす指示があれば、**main の `verify` も `deploy` も起動しません。** GitHub は、メッセージの見出しでなく本文にあっても、この指示に従います。PR #343 で実際に踏みました。説明のために書いた一文がこれに当たり、PR 側の CI が 1 本も起動しませんでした。

**検査は、設定によらず PR 本文と全コミットメッセージの両方に掛けます**（ai-playbook v0.5.0 の雛形 `claude-skill-land.md` の手順 8 と同じ。#901）。今の設定では PR 本文は squash の本文に入りませんが、設定を前提に検査先を片方へ絞ると、設定が変わった日にその経路だけが古くなります。設定を読んでから検査先を切り替える形も採りません。判定を 2 経路に分けるほど、どちらかだけが古くなる余地が増えるためです。

```bash
gh pr view N --json body,commits --jq '.body, (.commits[] | .messageHeadline, .messageBody)' \
  | grep -n -i -E '\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks: *true'
```

**PR 本文だけに当たった場合**、今の設定（`COMMIT_MESSAGES`）では、その指示は main に届きません。そのまま `--body-file` を使わずにマージしてかまいません。ただし下で `--body-file` の本文を作るときは、PR 本文を写さないこと（コミットメッセージを連ねて作る）を確かめます。写すと、その指示が main に届きます。

**次に、判定根拠を出力してから、マージのコマンドを実行します。** 確認が出た時点で、利用者がそれを読んで承認するかどうかを決められるようにするためです。先にコマンドを実行すると、確認に出るのはコマンドだけです。何を確かめたのかが分からないまま、承認を求めることになります。出力する中身は、「報告」の根拠の項目（CI の結果、指摘の件数と扱い、自分で差分を読んで気づいたこと）、5 で確かめた前提、マージする head の SHA です。

`sha` には、2 で最後に確かめたコミットを入れます（7 から戻ってきたときは、push したコミット）。何も出なければ（終了コード 1）、そのままマージします。

```bash
gh pr merge N --squash --match-head-commit "$sha"
```

該当する行が出たら、その指示を除いた本文をファイルに書き、`gh pr merge N --squash --match-head-commit "$sha" --body-file <そのファイル>` で本文を差し替えてマージします。

4 でコミットメッセージ側に `Closes #NNN` が無かった場合も、同じく `--body-file` で本文を差し替えます。本文は、既定の squash の本文と同じくコミットメッセージを連ねたもの（`gh pr view N --json commits --jq '.commits[] | .messageHeadline + "\n\n" + .messageBody'`）に、`Closes #NNN` の行を足して作ります（CI を飛ばす指示があれば、それも除きます。`Closes` はバッククォートで囲みません）。`--body-file` で渡した本文がマージコミットのメッセージになるため、そこから issue が閉じます。**このリポジトリでは PR 本文は squash の本文に入らない**（`COMMIT_MESSAGES`）ので、本文の `Closes` を GitHub が認識しなければ、ここで足さない限りどこからも閉じません。

- **確認が、この手順での承認です。** `scripts/confirm-merge-hook.sh` がマージの直前に確認を挟みます。承認されればマージが実行されます。
- **head が動いていたためにマージが失敗したら、新しい SHA で打ち直しません。** 確かめていないコミットが入ったということなので、止めて報告します。
- **拒否されたら、再試行しません。REST や GraphQL といった別の経路も使いません。** そこで止めて、理由を聞きます。
- `--delete-branch` は付けません。リモートのブランチはリポジトリの設定で自動的に消えます。付けると、ブランチが worktree に checkout されているときに「ローカルブランチを消せない」エラーで終わります。**マージ自体は成功しています。** エラー文だけを読んで失敗と判断せず、`gh pr view N --json state,mergedAt,mergeCommit` で確かめます。
- 衝突で失敗した場合、**ブランチが古いからだとは限りません。** その内容が別の PR 経由で先に入っていることがあり、そのまま解消すると先の PR を巻き戻します。`git fetch` してから `git diff origin/main...` を読みます。エラー文から原因を推測しません。原因が分かったら、解消する前に報告します。

### 9. マージ後を確かめる

- `closingIssuesReferences` に挙がっている issue と、本文・コミットメッセージの `Closes #NNN` に書かれた issue（4 で読んだもの）の**両方**が閉じたかを見ます。GitHub が `Closes` を認識しなかったときは `closingIssuesReferences` が空になるため、それだけを見ると、閉じていない issue を確かめないまま通り抜けます（#839 / #841 / #842）。閉じていなければ、マージコミットを示すコメントを付けて手で閉じ（`gh issue close NNN --comment "<マージコミットの SHA>（PR #N）で解決しました。Closes が認識されなかったため手で閉じます。"`）、報告に書きます。

  ```bash
  gh pr view N --json closingIssuesReferences --jq '[.closingIssuesReferences[].number]'
  gh issue view NNN --json state,stateReason --jq '{state, stateReason}'
  ```
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
- 根拠: CI の結果、第二意見と人間の指摘の件数と、それぞれの扱い、自分で差分を読んで気づいたこと
- マージコミット、閉じた issue、配備の結果
- 止めた場合: 利用者に判断してほしいこと（1 つずつ、選択肢を添えて）
