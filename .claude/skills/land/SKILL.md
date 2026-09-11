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
gh pr view N --json number,title,state,isDraft,mergeable,headRefName,baseRefName,body,closingIssuesReferences,commits
```

open でない、あるいは draft なら、止めて報告します。

### 2. CI とリモート最終ゲートの完了を待つ

**ターンを終えずに待ちます。** これまでは PR を作った時点でターンを終えていたため、利用者が指示するまで確認そのものが始まりませんでした。このスキルが解消したいのはその点です。

```bash
gh pr checks N --watch --interval 30
```

- `review-gate` は、opened のときは 120 秒の猶予を置いてから判定します。すぐに出なくても異常ではありません。
- `review-gate` が failure の場合は、Copilot のレビューが要求されていません。**そのジョブのエラー文に書かれている手順どおりに、1 回だけ手で要求します。** 2 回目は要求しません（「1 回だけ要求する」）。

### 3. Copilot のレビューが届くのを待つ

`review-gate` が緑でも、それは「要求された」ことを示すだけです。**レビュー本文が届くまで待ちます。** 待つときは Monitor の until ループか、Bash の `run_in_background` を使います（フォアグラウンドの sleep は使えません）。

```bash
until n="$(gh api 'repos/{owner}/{repo}/pulls/N/reviews' \
      --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | length')" \
    && [ "$n" -gt 0 ]; do
  sleep 30
done
```

API から読めなかった回は「まだ届いていない」として待ち続けます。**「届いた」と判定してはいけません。** 読めなかったことを到着と取り違えると、レビューを読まないまま次へ進んでしまいます。

- **15 分待っても届かなければ、マージせずに止めて報告します。** レビュアー不在で最終判断できない状態は、closer の「エスカレーション条件」にあたります。
- 指摘は review 本文と、行に付いたコメントの両方に出ます。

```bash
gh api 'repos/{owner}/{repo}/pulls/N/reviews' --jq '.[] | {user: .user.login, state, body}'
gh api --paginate 'repos/{owner}/{repo}/pulls/N/comments' --jq '.[] | {user: .user.login, path, line, body}'
```

人間が付けたコメントも同じ一覧に出ます。**それも指摘として扱います。**

### 4. 自分でも差分を読む

CI が緑でも、Copilot の指摘が 0 件でも、読まずにマージしません。

- `gh pr diff N` を読み、`pr-review.md` の順に確認します（受け入れ条件との対応、次に高リスクの観点）。
- **その差分がこの PR のものか確かめます。** 直前のブランチに居たまま `git checkout -b` すると、前の PR のコミットが相乗りします。この場合、レビューも CI も緑のまま通ってしまいます（`docs/handoff.md`）。`commits` の見出しと `gh pr diff N --name-only` が、PR の主題と合っているかを見ます。
- 本文に `Closes #NNN` があるか確かめます。書かれていないと、マージしても issue が open のまま残ります。

### 5. マージの前提を確かめる

**main へマージすると、そのまま本番へ配備されます**（`.github/workflows/verify.yml` の `deploy` ジョブ）。マージした後で順序を直す方法はありません。

- 差分がオーケストレータの束（`src/orchestrator/**` など、束に入るファイル）に及ぶ場合は、**Lambda の配備を先に済ませる必要があります**（`docs/orchestrator.md`）。
- 差分が `migrations/` に及ぶ場合は、**適用を先に済ませる必要があります。** 適用済みかどうかは、PR のブランチを checkout したツリーで `bash scripts/check-migrations-applied.sh --remote` を実行して確かめます。そのブランチが古い main から切られているなら、先に手元で main を取り込みます（確かめるためだけなので push はしません）。古いツリーで見ると、未適用を見落とします。
- PR 本文や issue に「マージ前に〜」と書かれている前提も確かめます。

どれも外部の状態を変える操作です。**済んでいなければ、ここで止めて利用者に伝えます。** このスキルの中では実行しません。

### 6. 指摘を判定する

指摘ごとに、`review-workflow.md` の条件に照らして次のどれにあたるかを決めます。

| 判定 | 扱い |
|---|---|
| 実在し、今回の差分の中にある | 7 で直す |
| スコープ外、または命名・可読性・好み | 直さない。技術負債として PR コメントに記録する |
| 事実誤認 | 却下する。**再現手順と実測結果を PR コメントに記録する。** 記録を伴わない却下は認めない |

判定の結果は、PR へ 1 件のコメントにまとめて返します（どの指摘を、どう扱ったか）。

### 7. 直す（1 巡だけ）

- **PR のブランチが checkout されている worktree で直します。** 他のセッションと共有しているプライマリの作業ツリーでは直しません。
- push の前に `bash scripts/loop-gate.sh` を通します。identity の検査もこのゲートに入っています。
- push したら、2 に戻って CI を待ちます。**Copilot には再要求しません。**
- **次のどれかにあたれば、マージせずに止めて報告します。**
  - 直すには仕様の判断が要る。または直すと PR の範囲を超える
  - 直したあとも CI が赤い
  - 2 巡目の指摘が出た（2 巡目以降の指摘は人間が却下する規則です。AI 同士を往復させません）

### 8. マージする

```bash
gh pr merge N --squash
```

- **確認が出るのは正常です。** `scripts/confirm-merge-hook.sh` がマージの直前に確認を挟みます。承認されればマージが実行されます。
- **拒否されたら、再試行しません。REST や GraphQL といった別の経路も使いません。** そこで止めて、理由を聞きます。
- `--delete-branch` は付けません。リモートのブランチはリポジトリの設定で自動的に消えます。付けると、ブランチが worktree に checkout されているときに「ローカルブランチを消せない」エラーで終わります。**マージ自体は成功しています。** エラー文だけを読んで失敗と判断せず、`gh pr view N --json state,mergedAt,mergeCommit` で確かめます。
- 衝突で失敗した場合、**ブランチが古いからだとは限りません。** その内容が別の PR 経由で先に入っていることがあり、そのまま解消すると先の PR を巻き戻します。`git fetch` してから `git diff origin/main...` を読みます。エラー文から原因を推測しません。原因が分かったら、解消する前に報告します。

### 9. マージ後を確かめる

- `closingIssuesReferences` に挙がっている issue が閉じたかを見ます。
- main で走る `verify` の実行を `gh run watch <run-id> --exit-status` で最後まで見届けます。`deploy` ジョブまで緑になったことを確かめます。

## 報告

最後に次をまとめます。closer の出力として求められている「判定根拠」にあたります。

- 判定: マージしたか、どこで止めたか
- 根拠: CI の結果、Copilot と人間の指摘の件数と、それぞれの扱い、自分で差分を読んで気づいたこと
- マージコミット、閉じた issue、配備の結果
- 止めた場合: 利用者に判断してほしいこと（1 つずつ、選択肢を添えて）
