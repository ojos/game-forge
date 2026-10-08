---
name: land
description: PR を確認し、問題なければマージする。この会話で PR を作ったら、指示を待たずに使う。それ以外の PR には、利用者が番号を示してマージを指示したときか、/land [PR 番号] で起動したときだけ使う。
argument-hint: "[PR 番号（省略時はこの会話で直前に作った PR）]"
---

# PR の確認とマージ

「PR を確認して、問題なければマージしてください」を手順にしたものです。**マージの承認は、8 で `gh pr merge` を実行する直前に、マージ実行の前に確認を挟む機構（`.ai-playbook/role-contracts/closer.md`「手動承認は機構で保証する」）が出す確認で取ります。** `/land` の起動を含め、利用者の入力はこの手順を始めるきっかけであって、承認ではありません。

- **承認は、マージ直前の確認 1 回です。** 既定の merge 方針は手動承認で、それを機構で保証しているのがこの確認です。`/land` の起動自体を承認の記録として扱うと、マージ直前にも確認が出るため、承認が二重になります。承認は 1 回に保ちます。
- **対象にしてよい PR は、次のとおりです。**
  - **この会話で作った PR:** 作ったら、利用者の指示を待たずにこの手順を始めます。
  - **それ以外の PR**（別セッションが作ったものなど）: 利用者が番号を示してマージを指示したとき、または `/land N` で起動されたときだけです。頼まれずに進めると、別セッションが作業中の PR をマージの確認へ持ち込むことになります。
- **承認が指すのは、確かめたコミットです。** 8 で `--match-head-commit` を付け、確かめた head から動いていればマージが失敗するようにします。確認を待つあいだに別の push が入っても、確かめていない中身はマージされません。
- **途中で止めて報告したら、利用者の指示があるまで再開しません。**
- **`run_in_background` で待ちを起こしたら、実在を確かめてから離れます。** 「起動した」という報告だけでは、実際にプロセスが動いているとは限りません。この手順の運用では、報告だけを信じて次の作業へ進んだ結果、待ちが実際には動いておらず手順が止まったことが 2 度ありました（サブエージェントへ検証を委譲したときと、親セッションで `nohup` を使って待ちを起こしたとき、それぞれ 1 回ずつ）。起動した直後に `pgrep -f <起動コマンドに含まれる目印文字列>` などでプロセスの実在を確認し、見つからなければ起動からやり直します。**ただしパターン照合だけでは、動いているものを「動いていない」と誤判定しえます。** プロセスのコマンドラインには、起動した作業ディレクトリが現れないことがあります（シェルが `cd` してから相対パスで起動した場合など）。複数の作業ツリーで同じスクリプトを走らせているときは、`readlink /proc/<pid>/cwd` で作業ディレクトリを見て、どれが自分のものかを特定します。**この誤判定も実際に踏みました。** 動いている待ちを「無い」と判断し、同じ検証をもう一度起こしかけています。**逆向きの誤判定にも注意します。** `pgrep -f` は自分自身のコマンド行にも一致するため、`until ! pgrep -f "scripts/verify.sh"; do …` や `pgrep … || bash scripts/loop-gate.sh` のように、パターンと同じ文字列が確認と同じ行に現れると、待ちが無いのに「有る」と判定します。前者の待ちは永久に抜けられず、後者の起動は黙って飛ばされます。避け方は 2 つを組み合わせます。1 つは、パターンの 1 文字を角括弧で囲むことです（例 `pgrep -f '[s]cripts/verify\.sh'`）。これでパターン自身の文字列には一致しなくなります。もう 1 つは、確認を行うコマンド行に対象の名前をそのまま書かないことです。角括弧はパターン自身の一致を防ぐだけで、同じ行に `bash scripts/loop-gate.sh` のような起動を並べれば、`bash -c` で包んでも、その文字列に一致します。確認と起動は別の呼び出し（別のコマンドの実行）に分け、確認の呼び出しには角括弧のパターンだけを書きます。実在を確認できてから、通知が来て自動で再開する形で離れます。2・3 で run_in_background を使う場面でも同様です。
- 判定の基準は規範が正本です。ここへは複製しません。
  - 指摘を解決済みとみなす条件: `.ai-playbook/review-workflow.md`「リモート最終ゲート」
  - 指摘を却下するときの記録: 同「指摘の却下」
  - 2 巡目以降の往復を打ち切る基準: `.ai-playbook/role-contracts/closer.md`「レビュー往復の打ち切り」
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
- `baseRefName` が `main` でない。**この手順は、main への直接マージを前提にしています。** 別のブランチ向けの PR に使うと、9 で無関係な main の実行を見届けることになります。main へのマージで配備が走るかどうかはプロジェクトによって異なります（9 を参照）。

### 2. CI の完了を待つ（置く場合はリモート最終ゲートも）

**利用者の入力を、再開のきっかけにしません。** これまでは PR を作った時点でターンを終えていたため、利用者が指示するまで確認そのものが始まりませんでした。このスキルが解消したいのはその点です。待つときは、終わると通知が来て自動で再開する形（Bash の `run_in_background`）を使います。起動したら、実在を確かめてから離れます（上記「`run_in_background` で待ちを起こしたら、実在を確かめてから離れます」）。

**CI の確認には、Checks の権限を使わない API だけを使います。** `gh pr checks` と `commits/<sha>/check-runs` は Checks の権限を要りますが、fine-grained PAT にはその権限がなく、非公開リポジトリでは 403 になります（公開リポジトリでは読めます）。そのため、Actions の権限で読める `actions/runs` と、Commit statuses の権限で読める `commits/<sha>/status` で判定します。保存済みの認証（`gh auth login`）でも、公開リポジトリでも同じ手順で動きます。

**先に、確かめたいコミットに CI の実行が付いたことを確かめます。** push の直後は、前のコミットの結果が見えることがあります（実測では、`gh pr checks` が前の head の全緑を返し、3 秒後に新しいコミットの pending へ変わりました）。前のコミットの緑で通り抜けると、7 で直して戻ってきたときに偽の緑になります。そこで、実行は `head_sha` で対象のコミットに固定して読みます。

**絞り込みの条件は 2 つです。** `event=pull_request` と、実行の `pull_requests[].number` が `N` であること。同じ SHA を持つ別の PR の実行を拾わないためです。**ただし `pull_requests` が空になる実行があります。** 実測では、フォークからの PR（`isCrossRepository` が true）と、ブランチを消したあとの PR で空でした。この手順は open の PR を対象にするので後者には当たりませんが、前者は当たります。フォークからの PR では、`pull_requests` が空の実行のうち、**実行の `head_repository.full_name` と `head_branch` がこの PR の head と一致するもの**だけを対象に含めます。PR 番号の代わりに、head のリポジトリとブランチで照合するということです（同じフォークの同じブランチから、ベースの違う別の PR も出している場合だけは区別できません。`pull_requests` が空の実行には、どの PR のものかを示す情報が無いためです）。

**この段のコードブロック（実行が付いたことの確認・完了の待ちと判定・commit status の確認）は、上から順に、1 回の Bash 呼び出しへつなげて実行します。** 前のブロックで決めた変数（`url`、`sel` など）を後のブロックが使うためです。別々の呼び出しに分けると、変数が引き継がれず、待ちが成り立ちません。

`sha` には、最初に来たときは 1 で読んだ `headRefOid` を、7 から戻ってきたときは push したコミット（`git rev-parse HEAD`）を入れます。`headRefName`（ブランチ名）と取り違えると、比較が必ず外れて時間切れになります。

```bash
cross="$(gh pr view N --json isCrossRepository --jq .isCrossRepository)"
# head のリポジトリとブランチ（jq の文字列リテラルとして埋め込むため @json で引用する）
repo="$(gh pr view N --json headRepositoryOwner,headRepository --jq '"\(.headRepositoryOwner.login)/\(.headRepository.name)" | @json')"
branch="$(gh pr view N --json headRefName --jq '.headRefName | @json')"
# 対象の実行: この PR の番号を持つもの。フォークからの PR だけ、pull_requests が空で head が一致するものも含める
sel=".workflow_runs[] | select(any(.pull_requests[]; .number == N) or ($cross and (.pull_requests | length == 0) and .head_repository.full_name == $repo and .head_branch == $branch))"
url="repos/{owner}/{repo}/actions/runs?head_sha=$sha&event=pull_request&per_page=100"
attached=0
for _ in $(seq 60); do  # 5 秒 × 60 回 = 5 分
  head="$(gh pr view N --json headRefOid --jq .headRefOid)" || head=""
  runs="$(gh api --paginate "$url" --jq "$sel | .id" | wc -l)" || runs=0  # 全ページを数える
  [ "$head" = "$sha" ] && [ "${runs:-0}" -gt 0 ] && { attached=1; break; }
  sleep 5
done
[ "$attached" = 1 ] || { echo CHECKS_NOT_ATTACHED; exit 1; }
echo CHECKS_ATTACHED
```

`CHECKS_ATTACHED` が出たら、続けて実行の完了を待ちます。`CHECKS_NOT_ATTACHED` なら、そこで終わるので、止めて報告します。

**`CHECKS_NOT_ATTACHED` は「CI が落ちた」ではありません。「実行が作られていない」です。** 両者を取り違えると、走ってもいない CI を「まだ終わっていない」と思って待ち続けることになります。

**契機のイベントが届かず、実行が 1 件も作られないことがあります。** ある利用プロジェクトでは、force push で SHA を置き換えた PR に対して、`synchronize` も `reopened` も実行を作らない状態が数時間続きました。同じ時間帯に、**新しく作った別の PR の `opened` は正常に実行を作っています。** つまりイベント全体が止まっていたのではなく、**その PR（その SHA）に対してだけ実行が作られない**状態でした。原因は、公開されている情報の範囲では特定できていません。

**確かめる順序を決めておきます。** `CHECKS_NOT_ATTACHED` が出たら、次の順に切り分けます。

1. **ワークフローが無効化されていないか**（`gh api repos/{owner}/{repo}/actions/workflows` の `state`）
2. **Actions の利用枠・予算に当たっていないか**（枠が残っていても、予算の停止設定に当たると止まります）
3. **実行基盤そのものが動くか。** `workflow_dispatch` を持つワークフローを手で起こして確かめます。**これが走るなら、実行基盤ではなく契機の側の問題です**
4. **同じ時間帯に別の PR で実行が作られるか。** 作られるなら、その PR に固有の事象です

**回避するには、新しいコミットを積んで別の SHA にします。** `reopened` や force push では回復しないことがあります。**捨てコミットを作らず、意味のある変更を 1 つ入れてください。**

**あわせて、CI のワークフローに `workflow_dispatch` を持たせておくことを勧めます。** 手動の口が無いと、契機が届かないときに打つ手がありません。

**実行だけを数えれば足りるかどうかは、プロジェクトの CI 構成によります。** パスフィルタで絞ったワークフローがあると、差分の内容によっては対象コミットに実行が 1 件も付きません。また、Actions の実行を出さない外部 CI を使っている場合は、それだけを見ても待ち条件を満たせません。この段では「対象コミットに 1 件以上の実行が付くこと」を待ち条件としていますが、これで足りるかはプロジェクト層で確認し、足りなければ確認方法を補ってください。想定するワークフローを YAML から推定することは、この手順では行いません。

付いた実行が完了するまで待ち、`conclusion` で成否を判定します。**待ちには `gh run watch` を使わず、上と同じ `actions/runs` を読み直します。** `gh run watch` は実行中のジョブを表示するときに annotations（Checks の API）を読むことがあり、Checks の権限を持たないトークンでの動きを確かめられていないためです。読み直すたびに一覧を取るので、待っているあいだに増えた実行も対象に入ります。

判定の対象は、次の 2 点で絞ります。

- **完了を 2 回続けて見るまで待ちます。** ワークフローごとに実行が作られる時刻はずれるため、先に作られた実行が完了した時点では、後の実行がまだ一覧に無いことがあります。30 秒あけて読んだ一覧が前の回と同じで、すべて完了していれば抜けます。この間隔を超えて遅れる実行までは拾えません。
- **ワークフローごとに、最新の実行 1 件だけを見ます。** `reopened` などで同じ SHA に実行が重なると、古い失敗が一覧に残るためです。一覧は全ページを読みます（`--paginate`）。
- **commit status を出すワークフロー（`second-opinion-gate`、`review-gate`）は、実行の成否では判定しません。** 下の commit status で判定します。たとえば `second-opinion-gate` は、記録が無いうちに起動した実行が失敗のまま残り、記録を投稿したあとの緑は、別の契機（掃き寄せ）が付ける status として出ます。実行の成否で判定すると、投稿しても緑になりません。除くワークフローの名前（`gates`）は、プロジェクトの構成に合わせて直してください。

```bash
gates='second-opinion-gate|review-gate'
latest() (  # 対象の実行を、ワークフローごとに最新の 1 件だけ出す（全ページ）
  set -o pipefail
  gh api --paginate "$url" --jq "$sel | [.workflow_id, .run_number, .status, (.conclusion // \"-\"), .name] | @tsv" \
    | sort -t "$(printf '\t')" -k1,1 -k2,2nr | awk -F '\t' '!seen[$1]++'
)
listed=0; prev=""
for _ in $(seq 120); do  # 30 秒 × 120 回 = 60 分
  if all="$(latest)"; then listed=1; else listed=0; all=""; fi
  runs="$(printf '%s\n' "$all" | awk -F '\t' -v g="^($gates)\$" 'NF && $5 !~ g')"
  # 読めていて、ゲート以外に未完了が 1 件も無く、一覧が前の回と同じなら抜ける。
  # 2 回続けて同じ一覧を見るのは、後から作られる実行を取りこぼさないため
  # （awk に最後まで読ませ、終了コードで判定する。空行は数えない）。
  if [ "$listed" = 1 ] && [ -n "$all" ] && printf '%s\n' "$all" | awk -F '\t' 'NF && $3 != "completed" { p = 1 } END { exit p }'; then
    [ "$all" = "$prev" ] && break
    prev="$all"
  else
    prev=""
  fi
  sleep 30
done
echo "-- 実行（判定の対象）"; printf '%s\n' "$runs"
echo "-- ゲートの実行（参考。成否は commit status で判定する）"; printf '%s\n' "$all" | awk -F '\t' -v g="^($gates)\$" 'NF && $5 ~ g'
printf '%s\n' "$runs" | awk -F '\t' -v listed="$listed" '
  NF { n++; if ($3 != "completed" || $4 !~ /^(success|skipped|neutral)$/) bad = 1 }
  END { if (listed != 1) print "RUNS_UNKNOWN"; else if (n == 0) print "RUNS_NONE"; else print bad ? "RUNS_NOT_GREEN" : "RUNS_GREEN" }'
```

判定の出力は 4 通りです。

- `RUNS_GREEN`: ゲート以外の実行がすべて通っています。
- `RUNS_NOT_GREEN`: 「実行（判定の対象）」の一覧（4 列目が `conclusion`）を読み、失敗した実行（`failure`、`cancelled`、`timed_out` など）を止めて報告します。60 分で終わらなかった場合もここに入ります。その場合は失敗でなく時間切れなので、3 列目（`status`）を見て、止めて報告します。
- `RUNS_NONE`: ゲート以外の実行がありません（付いていたのはゲートの実行だけ）。CI の成否は、下の commit status だけで判定します。
- `RUNS_UNKNOWN`: 一覧を読めませんでした。「通った」とも「落ちた」とも扱わず、止めて報告します。

「ゲートの実行」の一覧は、判定には使いませんが、status が付かない理由を切り分けるときに読みます（下の「置いている場合」の、ジョブだけが失敗する形）。

`second-opinion-gate` や `review-gate` のように **commit status で出るもの**は、実行ではなく Commit statuses の権限で読みます。`pending` のあいだは待ち、`success` で通過、`failure` と `error` は失敗です。このエンドポイント（combined status）は、**context ごとに最新の 1 件だけ**を返します。同じ context に status が積み重なっても（例: 記録を投稿して `failure` から `success` へ変わった）、過去の結果は並びません（実測で確認済み）。

```bash
for _ in $(seq 60); do  # 30 秒 × 60 回 = 30 分。ゲートの status が付き、pending でなくなるまで待つ
  st="$(gh api "repos/{owner}/{repo}/commits/$sha/status" --jq '.statuses[] | [.context, .state, .description] | @tsv')" || st=""
  printf '%s\n' "$st" | awk -F '\t' -v g="^($gates)\$" '$1 ~ g { n++; if ($2 == "pending") p = 1 } END { exit (n > 0 && !p) ? 0 : 1 }' && break
  sleep 30
done
printf '%s\n' "$st"
```

ゲートの status が 30 分たっても付かない、または `pending` のままなら、最後に出した一覧をもとに止めて報告します（下の「`second-opinion-gate` の確認」と、置いている場合の失敗の形に従います）。

**`second-opinion-gate` の確認（リモート最終ゲートの有無にかかわらず行います）**:

- `second-opinion-gate` の status を、上の `commits/<sha>/status` で確認します。**`failure`**（説明文が `no second-opinion record for this head`）なら、push 後に記録を投稿していません。`bash scripts/second-opinion-record.sh post` を実行してから、もう一度、上の実行の完了の待ちと commit status の確認をやり直します。ローカルに記録が残っていない場合（別セッションが push した等）は、このブランチで第二意見を回し直す必要があるため、止めて報告します。
- status が付かない（確かめられなかった）場合は、「記録が無い」と同じに扱いません。しばらく待ってから読み直します。

**ここから先は、このプロジェクトがリモート最終ゲートを置いているかどうかで分かれます（`.github/project-ai-rules.md`「リモート最終ゲート」）。**

**置いている場合**:

- `review-gate` は、opened のときは 120 秒の猶予を置いてから判定します。すぐに出なくても異常ではありません。
- 失敗の形は 2 つあり、**扱いが違います。**
  - **status の `review-gate` が failure**（説明文が `Copilot code review was never requested`）: Copilot のレビューが要求されていません。**ジョブのエラー文に書かれている手順どおりに、1 回だけ手で要求します。**
  - **ジョブの `check` だけが失敗し、status の `review-gate` が failure でない**（上の「ゲートの実行」の一覧で、`review-gate` の実行が `failure` になっている）: レビューの有無を API から読めなかっただけです（`review-gate.yml` はこのとき status を付けません）。**要求しません。** 要求済みのレビューを二重に要求すると、「1 回だけ要求する」が壊れます。3 のループで待ち、届かなければ止めて報告します。
- 待てたら 3 へ進みます。

**置いていない場合**: **3 は行いません。4 へ進みます。**

### 3. （リモート最終ゲートを置く場合のみ）Copilot のレビューが届くのを待つ

**このプロジェクトがリモート最終ゲートを置いていない場合、この手順は行いません。** `second-opinion-gate` の確認（2）は、置いているかどうかにかかわらず行います。

`review-gate` が緑でも、それは「要求された」ことを示すだけです。**レビュー本文が届くまで待ちます。** 次のループを Bash の `run_in_background` で回します（フォアグラウンドの sleep は使えません）。ここでも、起動したら実在を確かめてから離れます（上記）。

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
- **その差分がこの PR のものか確かめます。** 直前のブランチに居たまま `git checkout -b` すると、前の PR のコミットが相乗りします。この場合、レビューも CI も緑のまま通ってしまいます。`commits` の見出しと `gh pr diff N --name-only`（変更したファイルの一覧）が、PR の主題と合っているかを見ます。
- 本文とコミットメッセージ（`commits` の `messageHeadline` / `messageBody`）の**両方**に `Closes #NNN` があるか確かめます。本文に無ければ、マージしても issue が open のまま残ります。コミットメッセージ側は、PR 本文の `Closes` を GitHub が認識しないことがあるための保険です（`.ai-playbook/shared-ai-rules.md`「6. コミットメッセージ規約」）。**コミットメッセージ側に無ければ、8 で squash の本文に `Closes #NNN` を足してマージします。** 保険のためだけにコミットを積み直して CI をやり直すことはしません。

### 5. マージの前提を確かめる

**main へのマージが、そのまま配備や他の外部状態の変更につながる場合があります。** マージした後で順序を直す方法はありません。

- **プロジェクト固有の前提条件（配備の順序、マイグレーションの適用順序など）は、この雛形では決め打ちません。** ある種の変更（例: 特定のディレクトリ配下に限らない広い範囲の差分）は、ファイル名だけでは前提条件に該当するかどうかを判断できないことがあります。該当するかどうかの判定方法と、確認に使う具体的なコマンドは、プロジェクト層（例: `.github/project-ai-rules.md`）で定義してください。定義されていない場合は、この段は確認済みとして扱わず、判断できないことを報告します。
- PR 本文や issue に「マージ前に〜」と書かれている前提も確かめます。
- **他のセッションがマージ・リリースの最中でないか**を、台帳で確かめます（`scripts/session-ledger.sh` を置いている場合。`.ai-playbook/shared-ai-rules.md`「16. セッション間の協調」）。`bash scripts/session-ledger.sh check merge` の 1 行目が `LEDGER_DENY` なら、他のセッションが登録しています。**マージせずに止めて**、出力に示された相手の識別子と調整の手順を報告します。相手が解放する、または登録が失効するまで待ちます。登録を消して通すことも、拒否を迂回することもしません。`LEDGER_SKIP`（台帳を読み書きできなかった）は、警告を出して進めます。相手から得た「進めてよい」という返事は、マージの承認の代わりになりません。承認は、8 のマージ直前の確認で取ります。

どれも外部の状態を変える操作です。**済んでいなければ、ここで止めて利用者に伝えます。** このスキルの中では実行しません。

### 6. 指摘を判定する

判定の基準は、`review-workflow.md` の「リモート最終ゲート」と「指摘の却下」に従います。**条件そのものはここへ書き写しません。** 書き写すと、言い換えの形で規範側の条件と食い違ったまま気づかれない状態になります（規範を更新しても、この雛形は追随しません）。そのうえで、指摘ごとに次の順で進めます。

1. **実在するかを、実測で確かめます。** 読んだ印象だけで決めません。
2. **実在しない（事実誤認）なら**、「指摘の却下」の手順で却下し、再現手順と実測結果を残します。**ただし、却下するかどうかと、示された対処を採るかどうかは別に判断します。** 前提が誤っていても、提案された対処そのものに価値があれば採ります（同節）。
3. **実在するなら、「リモート最終ゲート」の条件に照らして、直すか・直さずに記録して進めるかを判断します。** どの条件に当たるかという判定そのものが規範の適用であり、ここでは行いません。**同節は、重大な指摘を打ち切りの条件の対象外としています。** CI が緑であることだけを根拠に、直さずに進めないでください（どの指摘が重大か、どう扱うかは同節に従います）。直す場合は 7 へ進みます。直さない場合は、同節のどの条件に基づく判断かを記録に残します。

判定の結果は、PR へ 1 件のコメントにまとめて返します（どの指摘を、どう扱ったか）。

### 7. 直す（1 巡だけ）

- **PR のブランチが checkout されている worktree で直します。** 他のセッションと共有しているプライマリの作業ツリーでは直しません。
- push の前にローカル事前ゲート（`.ai-playbook/loop-workflow.md`「ローカル事前ゲート（push 前）」）を通します。実行体（受け入れ検証・第二意見・identity の検査をまとめて通す入口）はプロジェクト層が用意します。
- **リモート最終ゲートの有無にかかわらず、push が終わった直後（2 に戻る前）に、push のたびに `bash scripts/second-opinion-record.sh post` を実行します。** 記録は head SHA に紐づくため、直すたびに打ち直さないと、2 の `second-opinion-gate` がこの新しい head を「記録が無い」と判定します。
- 上の `post` を終えたら、2 に戻って CI を待ちます。**Copilot には再要求しません。**
- **次のどれかにあたれば、マージせずに止めて報告します。**
  - 直すには仕様の判断が要る。または直すと PR の範囲を超える
  - 直したあとも CI が赤い
  - 直したあとに、新しい指摘（2 巡目）が出た。**扱いを決めるのは人間です。** 基準は `.ai-playbook/role-contracts/closer.md`「レビュー往復の打ち切り」に従います。このスキルの中では判定しません

### 8. マージする

**先に、squash の本文に CI を飛ばす指示が入っていないか確かめます。** squash マージの本文の組み立て方（PR の説明文だけを使うか、各コミットのメッセージを連ねるか）はリポジトリの設定（`squash_merge_commit_message`）によって変わり、**この雛形はどちらの設定かを前提にしません。** PR 本文だけを検査し、コミット側の設定を前提にコミットメッセージ側を省くと、`PR_BODY` 設定のプロジェクトでの見落としを防げても `COMMIT_MESSAGES` 設定のプロジェクトでの見落としを防げず、逆も同様です。設定を読んでから検査対象を切り替える方法もありますが、判定を 2 経路に分けるほど、どちらかの経路だけが古くなる余地が増えます。**そのため、設定によらず両方（PR 本文と全コミットメッセージ）を検査します。** どちらの組み立て方であっても、いずれか 1 か所に CI を飛ばす指示があれば、**main 側の CI が起動しないことがあります。** GitHub は、メッセージの見出しでなく本文にあっても、この指示に従います。

```bash
gh pr view N --json body,commits --jq '.body, (.commits[] | .messageHeadline, .messageBody)' \
  | grep -n -i -E '\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks: *true'
```

**次に、判定根拠を出力してから、マージのコマンドを実行します。** 確認が出た時点で、利用者がそれを読んで承認するかどうかを決められるようにするためです。先にコマンドを実行すると、確認に出るのはコマンドだけです。何を確かめたのかが分からないまま、承認を求めることになります。出力する中身は、「報告」の根拠の項目（CI の結果、指摘の件数と扱い、自分で差分を読んで気づいたこと）、5 で確かめた前提、マージする head の SHA です。

`sha` には、2 で最後に確かめたコミットを入れます（7 から戻ってきたときは、push したコミット）。何も出なければ（終了コード 1）、そのままマージします。

```bash
gh pr merge N --squash --match-head-commit "$sha"
```

該当する行が出たら、その指示を除いた本文をファイルに書き、`gh pr merge N --squash --match-head-commit "$sha" --body-file <そのファイル>` で本文を差し替えてマージします。

4 でコミットメッセージ側に `Closes #NNN` が無かった場合も、同じく `--body-file` で本文を差し替えます。本文には `Closes #NNN` の行を足します（CI を飛ばす指示があれば、それも除きます）。squash の本文をどう組み立てる設定であっても、`--body-file` で渡した本文がマージコミットのメッセージになるため、そこから issue が閉じます。

- **確認が、この手順での承認です。** マージ実行の前に確認を挟む機構（`.ai-playbook/role-contracts/closer.md`「手動承認は機構で保証する」）がマージの直前に確認を挟みます。承認されればマージが実行されます。
- **head が動いていたためにマージが失敗したら、新しい SHA で打ち直しません。** 確かめていないコミットが入ったということなので、止めて報告します。
- **拒否されたら、再試行しません。REST や GraphQL といった別の経路も使いません。** そこで止めて、理由を聞きます。
- `--delete-branch` は付けません。リモートのブランチをリポジトリの設定で自動的に消している場合、付けると、ブランチが worktree に checkout されているときに「ローカルブランチを消せない」エラーで終わることがあります。**マージ自体は成功しています。** エラー文だけを読んで失敗と判断せず、`gh pr view N --json state,mergedAt,mergeCommit` で確かめます。
- 衝突で失敗した場合、**ブランチが古いからだとは限りません。** その内容が別の PR 経由で先に入っていることがあり、そのまま解消すると先の PR を巻き戻します。`git fetch` してから `git diff origin/main...` を読みます。エラー文から原因を推測しません。原因が分かったら、解消する前に報告します。

### 9. マージ後を確かめる

- `closingIssuesReferences` に挙がっている issue と、本文・コミットメッセージの `Closes #NNN` に書かれた issue の**両方**が閉じたかを見ます。GitHub が `Closes` を認識しなかったときは `closingIssuesReferences` が空になるため、それだけを見ると、閉じていない issue を確かめないまま通り抜けます。閉じていなければ、マージコミットを示すコメントを付けて手で閉じ、報告に書きます。
- main で走る CI の実行を、**マージコミットの SHA で特定してから**、最後まで見届けます。「main の最新の実行」で選ぶと、直後に入った別のマージの実行を見てしまい、この PR の反映を確かめたことになりません。対象の workflow ファイル名はプロジェクト層で定義します（例: `ci.yml`）。

  ```bash
  sha="$(gh pr view N --json mergeCommit --jq .mergeCommit.oid)"
  for _ in $(seq 120); do  # 30 秒 × 120 回 = 60 分
    # 実行がまだ作られていなければ空になるので、毎回取り直す
    run="$(gh run list --workflow <ワークフローファイル名> --commit "$sha" --event push --json databaseId --jq '.[0].databaseId // empty')" || run=""
    st=""
    [ -n "$run" ] && { st="$(gh api "repos/{owner}/{repo}/actions/runs/$run" --jq '"\(.status) \(.conclusion)"')" || st=""; }
    case "$st" in "completed "*) break ;; esac
    sleep 30
  done
  case "$st" in
    "completed success") echo MAIN_CI_GREEN ;;
    *) echo "MAIN_CI_NOT_GREEN: ${st:-unknown}"; exit 1 ;;  # 失敗・時間切れ・読めなかった
  esac
  ```

  待ちには、2 と同じ理由で `gh run watch` を使いません。

  **本番配備など、マージ後に外部状態を変えるジョブがある場合は、そのジョブが緑になったことまで確かめます。** ジョブ名や、緑と見なす条件はプロジェクト層で定義してください。そうしたジョブが無い構成では、この確認は不要です。

  実行がまだ作られていなければ `run` は空になります。上のループは、その場合は読まずに次の回で取り直します。**空のまま読みません。** `// empty` は外しません。`gh` の版によっては `--jq` が null を空として出しますが、単体の `jq` は `null` という文字列を出すことがあります（実測でどちらも確認済み）。後者で動かすと空チェックをすり抜け、`actions/runs/null` を読み続けます。

- **作業の終わりに、台帳の自分の登録を解放します**（`bash scripts/session-ledger.sh release`。台帳を置いている場合）。着手のときに登録した issue など、残った登録が他のセッションの警告になり続けないようにするためです。マージの実行のあいだだけ持つ登録（マージ・作業ツリーの操作・重いゲート）は、セッション協調フック（`scripts/session-coord-hook.sh`）を配線していれば、フックが実行の前後で登録・解放します。配線していない場合は、8 の直前に `bash scripts/session-ledger.sh claim merge` を実行し、終わったら `bash scripts/session-ledger.sh release merge` で解放します。

## 報告

最後に次をまとめます。closer の出力として求められている「判定根拠」にあたります。

- 判定: マージしたか、どこで止めたか
- 根拠: CI の結果、Copilot と人間の指摘の件数と、それぞれの扱い、自分で差分を読んで気づいたこと
- マージコミット、閉じた issue、配備を確認した場合はその結果
- 止めた場合: 利用者に判断してほしいこと（1 つずつ、選択肢を添えて）
