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

1. **ワークフローが無効化されていないか**（`gh api repos/{owner}/{repo}/actions/workflows` の `state`）。**無効にしていたワークフローを PR の作成後に有効へ戻しても、PR の `opened` は再送されない**ため、実行は作られません。PR を作る前に有効へ戻します。作った後で戻したときは、下の回避策のとおり、意味のある変更を 1 つ積んで別の SHA にします（`reopened` では回復しないことがあります）
2. **Actions の利用枠・予算に当たっていないか**（枠が残っていても、予算の停止設定に当たると止まります）
3. **実行基盤そのものが動くか。** `workflow_dispatch` を持つワークフローを手で起こして確かめます。**これが走るなら、実行基盤ではなく契機の側の問題です**
4. **同じ時間帯に別の PR で実行が作られるか。** 作られるなら、その PR に固有の事象です

**回避するには、新しいコミットを積んで別の SHA にします。** `reopened` や force push では回復しないことがあります。**捨てコミットを作らず、意味のある変更を 1 つ入れてください。**

**あわせて、CI のワークフローに `workflow_dispatch` を持たせておくことを勧めます。** 手動の口が無いと、契機が届かないときに打つ手がありません。

**実行だけを数えれば足りるかどうかは、プロジェクトの CI 構成によります。** パスフィルタで絞ったワークフローがあると、差分の内容によっては対象コミットに実行が 1 件も付きません。また、Actions の実行を出さない外部 CI を使っている場合は、それだけを見ても待ち条件を満たせません。この段では「対象コミットに 1 件以上の実行が付くこと」を待ち条件としていますが、これで足りるかはプロジェクト層で確認し、足りなければ確認方法を補ってください。動くはずのワークフローは、下の完了の待ちで、PR の head と base の両方の YAML から求めます（確実に動くと言えるものだけ。条件は下の「方針」。外部 CI は求められません）。

付いた実行が完了するまで待ち、`conclusion` で成否を判定します。**待ちには `gh run watch` を使わず、上と同じ `actions/runs` を読み直します。** `gh run watch` は実行中のジョブを表示するときに annotations（Checks の API）を読むことがあり、Checks の権限を持たないトークンでの動きを確かめられていないためです。読み直すたびに一覧を取るので、待っているあいだに増えた実行も対象に入ります。

判定の対象は、次の点で絞ります。

- **動くはずのワークフローすべてに実行が付くまで待ちます。** 下の下準備で、動くはずのワークフローを求めます。下の「2 回続けて見る」だけでは、先に作られた実行が完了してから 30 秒を超えて遅れて作られる実行を取りこぼし、その受け入れ検証を見ないまま `RUNS_GREEN` になるためです。

  **方針は「確実に動くと言えるワークフローだけを数え、迷うものは数えない」です。** 数えなかったワークフローは、従来どおり「実行が付いていれば判定に入る」扱いなので、最悪でもこの手順を足す前の動きに戻るだけです。逆に、動かないものを数えると、実行が付かないまま 60 分待って毎回 `RUNS_MISSING` で止まり、足す前より悪くなります。そのため、次のものは数えません。
  - **`pull_request` の下に、`types` 以外の子があるもの**（`paths`、`paths-ignore`、`branches`、`branches-ignore`、知らないキーなど）。差分・ブランチによって、実行が作られないことがあるためです。
  - **`pull_request` に `types` があり、`opened`・`synchronize`・`reopened` の 3 つが揃っていないもの**（`[closed]`、`[labeled]`、`[opened, synchronize]` など）。head のコミットに実行を作る契機は、新しく開く（`opened`）、push する（`synchronize`）、閉じた PR を再び開く（`reopened`）の 3 つで、1 つでも欠けると、その契機では実行が作られないためです。3 つが揃うもの（`[opened, synchronize, reopened]`、さらに `ready_for_review` などを足したもの）は、`types` を書かなかったときの既定と同じ契機を含んでおり、絞り込みではないため数えます。ブロックの形（`types:` の下に `- opened` を並べる形）と 1 行の形（`types: [opened, synchronize, reopened]`）の両方を読みます。
  - **`pull_request` 以外の契機で付くもの**（`pull_request_target`、`workflow_run` など）。
  - **head と base の片方でしか「動く」と言えないもの。** GitHub は PR の実行を、head と base を合わせたマージ用の参照から作るため、ワークフローの定義も、そのマージ用の参照にあるものが使われます。head で足したワークフローは、マージ用の参照で動くとは限らず、base で消えたものは、head に残っていても動きません。確実に動くと言えるのは、両方で「動く」と判定したものです。
  - **Actions で無効にしてあるもの**（`state` が `active` でないもの）。
  - **1 行の形の `on:` の中で、`push` に付けた `paths` などの絞り込みも、`pull_request` の絞り込みと区別せず、数えない側に倒しています。** 数えないほうが安全側（上の方針）で、書き方を見分ける実装は誤読の余地を増やすためです。

  **数える形は、確実に読めるものに限ります（認める形を限る方式）。** YAML を完全には読まない（読む専用の道具を使わない）ため、すべての書き方を読もうとすると、読み違えて動かないものを数えます。読み違えて数えるより、数えずに従来どおりの動きに戻るほうが安全です（上の方針）。数えるのは、(1) `on: pull_request`、(2) `on: [a, pull_request, b]`（`{` と `:` を含まない 1 行のリスト）、(3) ブロックの形で、`on:` の直下の子にある `pull_request:`（値も子も無い）か `- pull_request`、の 3 つです。(3) で `pull_request:` の下に子があるときは、子が `types:` だけで、上の条件を満たすものに限ります。フローの形（`on: {pull_request: ...}`）、引用符付きのキー、アンカーやエイリアスなど、これに当てはまらない形はすべて数えません。`on:` の直下より深い位置にある `pull_request` という文字（`workflow_dispatch` の `inputs` の名前、`push` の `paths` の中身など）は見ません。`on:` のキー自体は、引用符付き（`"on":`）も読みます。YAML を読む専用の道具（`yq` など）は雛形が求める道具に含めないため、awk で読みます。求める元を作業ツリーでなく `$sha` と base の中身にするのは、ワークフローを増減する PR で、作業ツリーの一覧が食い違うためです。
- **完了を 2 回続けて見るまで待ちます。** ワークフローごとに実行が作られる時刻はずれるため、先に作られた実行が完了した時点では、後の実行がまだ一覧に無いことがあります。30 秒あけて読んだ一覧が前の回と同じで、すべて完了していれば抜けます。上の「動くはずのワークフロー」に入らないものは、この間隔を超えて遅れると拾えません。
- **ワークフローごとに、最新の実行 1 件だけを見ます。** `reopened` などで同じ SHA に実行が重なると、古い失敗が一覧に残るためです。一覧は全ページを読みます（`--paginate`）。
- **commit status を出すワークフロー（`second-opinion-gate`、`review-gate`）は、実行の成否では判定しません。** 下の commit status で判定します。たとえば `second-opinion-gate` は、記録が無いうちに起動した実行が失敗のまま残り、記録を投稿したあとの緑は、`second-opinion-record.sh post` が起こす手動実行（`workflow_dispatch`）が付ける status として出ます（定期実行は置きません）。実行の成否で判定すると、投稿しても緑になりません。除くワークフローの名前（`gates`）は、プロジェクトの構成に合わせて直してください。

**判定に使う関数（`workflow_runs_on_pr`・`expected_workflows`・`filter_active`・`missing_workflows`・`runs_verdict`）と、有効なワークフローを読む jq の式（`active_jq`）、8 の再判定の関数（`rejudge_one`）は、目印の行（`# >>> land:...` と `# <<< land:...`）で囲んでいます。** テストがこの部分だけを雛形から取り出し、仕込みのリポジトリや仕込みの一覧で実行して確かめるためです。目印の行を消さず、囲んだ部分が外側の変数に依存しない形を保ってください。

**このスキルの本文では、「`$` の直後に数字」を書きません。** awk の欄は `$(0)`・`$(3)`、シェルの引数は `${1}` の形で書きます（コメントの中も同じです）。Claude Code は、スキルを起動するとき、本文の「`$` の直後に数字」を、0 から数えた引数に置き換えるためです（`/land 29` では、`$` のすぐ後に `0` を書いた箇所が `29` になります）。上の 2 つの形は置き換えの規則に一致しないので、スキルとして読み込んでも、テストがファイルから取り出して実行しても、同じに動きます。`tests/test-skill-template-args.sh` がこれを検査します。

**実行の `path` が空（null）の実行が一覧に混じっていたら、その回は「実行が付いていない」の判定をしません。** どのワークフローの実行か照合できず、付いているものを「付いていない」と取り違えて、実行が付いているのに `RUNS_MISSING` で止まるためです。その回だけは、この手順を足す前の動き（付いている実行だけで判定する）に戻ります。

**パイプの後ろに `grep -q` を置きません。** `pipefail` の下では、`grep -q` が一致した時点で終了し、前段が SIGPIPE で失敗して、一致しているのに不一致と判定されることがあるためです。判定は、入力を最後まで読む awk の終了コードか、`if` の条件で行います。

**PR の head と base の取得は、リモート名（`origin`）を決め打ちしません。** `pull/N/head` と base のコミットを持つのは PR のあるリポジトリです。`origin` がフォーク側を指す構成などでは、`origin` から取れないことがあります。そこで PR 自身の URL（`gh pr view N --json url`）の末尾 `/pull/N` を落としたものを取得元にします。URL は PR のあるリポジトリを指すため、リモートの名前や構成に左右されません。base は、`baseRefOid` を SHA で直接取ります。ブランチ名で取ると、取得のあいだに base が進んだとき、判定した SHA と食い違うためです。

**動くはずのワークフローを求められなかったときは、空として扱いません。** 取得・読み取り・API のどれかが失敗したのに空の一覧で進むと、数えるものが無いまま従来の動きに黙って戻り、気づけません。`EXPECTED_UNKNOWN` を出して止め、報告します。一覧が本当に空（動くはずのものが 0 本）のときとは区別します（その場合は何も待たず、そのまま判定に進みます）。

```bash
# >>> land:expected-workflows
# on: に pull_request を持つか読む。標準入力はワークフローの YAML。数える（0 を返す）のは、次の形に限る。
#   1. on: pull_request
#   2. on: [a, pull_request, b]（1 行のリスト。{ や : を含まない）
#   3. ブロックの形で、on: の直下の子に pull_request:（値と子が無い）か - pull_request があるもの。
#      pull_request: の下の子が types: だけで、opened・synchronize・reopened の 3 つを含むものも数える。
# それ以外（フローの形 { }、引用符付きのキー、アンカー、paths / branches など types 以外の子）は読み違えうるので、すべて数えない。
# on: の直下より深い位置にある pull_request という文字（workflow_dispatch の inputs、push の paths の中身など）は見ない。
workflow_runs_on_pr() {
  awk '
    function strip(s) { sub(/[ \t]+#.*$/, "", s); sub(/[ \t\r]+$/, "", s); return s }
    function has(s, w) { return s ~ ("(^|[^A-Za-z0-9_-])" w "([^A-Za-z0-9_-]|$)") }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    BEGIN { base = -1 }
    /^["'\'']?on["'\'']?[ \t]*:/ {
      v = $(0); sub(/^["'\'']?on["'\'']?[ \t]*:[ \t]*/, "", v); v = strip(v)
      if (v == "") { inon = 1; next }
      inon = 0
      if (v == "pull_request") hit = 1
      else if (v ~ /^\[[^{}:]*\]$/) {
        sub(/^\[/, "", v); sub(/\]$/, "", v); k = split(v, items, ",")
        for (i = 1; i <= k; i++) if (trim(items[i]) == "pull_request") hit = 1
      }
      next
    }
    inon && /^[^ \t#-]/ { inon = 0 }
    inon {
      t = $(0); match(t, /^[ \t]*/); n = RLENGTH; t = strip(substr(t, n + 1))
      if (t == "" || t ~ /^#/) next
      if (base < 0) base = n
      if (n < base) { bad = 1; next }
      if (n == base) {
        inpr = 0; intypes = 0; cn = -1
        if (t == "pull_request:") { hit = 1; inpr = 1 }
        else if (t == "- pull_request") hit = 1
        next
      }
      if (!inpr) next
      if (cn < 0) cn = n
      if (intypes && t ~ /^-/ && n >= cn) { ts = ts " " t; next }
      intypes = 0
      if (n == cn && t ~ /^types:/) {
        tseen = 1; ts = ts " " t
        w = t; sub(/^types:[ \t]*/, "", w); if (w == "") intypes = 1
      } else if (n > cn) { }
      else bad = 1
    }
    END { exit (hit && !bad && (!tseen || (has(ts, "opened") && has(ts, "synchronize") && has(ts, "reopened")))) ? 0 : 1 }'
}
# コミット（${1}）の .github/workflows/ から、動くはずのワークフローのパスを出す（作業ツリーは見ない）。
# 読めなかったときは 1 を返す（空の一覧と区別するため）。--full-tree は、サブディレクトリから実行しても同じ結果にするため。
workflows_at() {
  files="$(git ls-tree --full-tree --name-only "${1}" .github/workflows/)" || return 1
  printf '%s\n' "$files" | while read -r f; do
    case "$f" in *.yml|*.yaml) ;; *) continue ;; esac
    body="$(git show "${1}:$f")" || exit 1
    if printf '%s\n' "$body" | workflow_runs_on_pr; then echo "$f"; fi
  done
}
# head（${1}）と base（${2}）の両方で動くはずのワークフローのパスを出す。どちらかが読めなければ 1 を返す。
expected_workflows() {
  h="$(workflows_at "${1}")" || return 1
  b="$(workflows_at "${2}")" || return 1
  comm -12 <(printf '%s\n' "$h" | awk 'NF' | sort) <(printf '%s\n' "$b" | awk 'NF' | sort)
}
# 有効なワークフローの path を読む jq の式（gh api repos/{owner}/{repo}/actions/workflows の出力に使う）
active_jq='.workflows[] | select(.state == "active") | .path'
# 動くはずの一覧（${1}）から、有効なもの（${2} = active_jq の出力）に無いものを除く。
filter_active() {
  comm -12 <(printf '%s\n' "${1}" | awk 'NF' | sort) <(printf '%s\n' "${2}" | awk 'NF' | sort)
}
# <<< land:expected-workflows

# >>> land:runs-verdict
# 動くはずなのに、まだ実行が付いていないワークフローを出す。
# ${1} = 動くはずのワークフローの一覧、${2} = 実行の一覧（6 列目が path）
# path が空の実行が 1 件でもあれば、どのワークフローの実行か照合できないので、その回は何も出さない（従来どおりの動きに戻す）。
# 照合できないまま「付いていない」と判定すると、実行が付いているのに RUNS_MISSING で止まるため。
missing_workflows() {
  if printf '%s\n' "${2}" | awk -F '\t' 'NF && $(6) == "" { h = 1 } END { exit !h }'; then return 0; fi
  printf '%s\n' "${1}" | while read -r f; do
    [ -n "$f" ] || continue
    if ! printf '%s\n' "${2}" | awk -F '\t' -v f="$f" '$(6) == f { h = 1 } END { exit !h }'; then echo "$f"; fi
  done
}
# 最後の判定。${1} = 一覧を読めたか（1 / 0）、${2} = 実行が付いていないワークフロー（空でなければ付いていない）、
# 標準入力 = 判定の対象の実行の一覧
runs_verdict() {
  awk -F '\t' -v listed="${1}" -v missing="${2:+1}" '
    NF { n++; if ($(3) != "completed" || $(4) !~ /^(success|skipped|neutral)$/) bad = 1 }
    END { if (listed != 1) print "RUNS_UNKNOWN"; else if (missing == 1) print "RUNS_MISSING"; else if (n == 0) print "RUNS_NONE"; else print bad ? "RUNS_NOT_GREEN" : "RUNS_GREEN" }'
}
# <<< land:runs-verdict

gates='second-opinion-gate|review-gate'
# PR のあるリポジトリから head と base を取る（手元に無いときだけ）。求められなければ EXPECTED_UNKNOWN で止める
expected_ok=0
if prurl="$(gh pr view N --json url --jq .url)" && base="$(gh pr view N --json baseRefOid --jq .baseRefOid)"; then
  { git cat-file -e "$sha^{commit}" 2>/dev/null || git fetch -q "${prurl%/pull/*}" "pull/N/head"; } \
    && { git cat-file -e "$base^{commit}" 2>/dev/null || git fetch -q "${prurl%/pull/*}" "$base"; } \
    && expected="$(expected_workflows "$sha" "$base")" \
    && active="$(gh api --paginate "repos/{owner}/{repo}/actions/workflows?per_page=100" --jq "$active_jq")" \
    && expected="$(filter_active "$expected" "$active")" \
    && expected_ok=1
fi
[ "$expected_ok" = 1 ] || { echo EXPECTED_UNKNOWN; exit 1; }
latest() (  # 対象の実行を、ワークフローごとに最新の 1 件だけ出す（全ページ）
  set -o pipefail
  gh api --paginate "$url" --jq "$sel | [.workflow_id, .run_number, .status, (.conclusion // \"-\"), .name, (.path // \"\" | sub(\"@.*$\"; \"\"))] | @tsv" \
    | sort -t "$(printf '\t')" -k1,1 -k2,2nr | awk -F '\t' '!seen[$(1)]++'
)
listed=0; prev=""; missing=""
for _ in $(seq 120); do  # 30 秒 × 120 回 = 60 分
  if all="$(latest)"; then listed=1; else listed=0; all=""; fi
  runs="$(printf '%s\n' "$all" | awk -F '\t' -v g="^($gates)\$" 'NF && $(5) !~ g')"
  missing="$(missing_workflows "$expected" "$all")"
  # 読めていて、動くはずのワークフローすべてに実行が付き、ゲート以外に未完了が 1 件も無く、
  # 一覧が前の回と同じなら抜ける。2 回続けて同じ一覧を見るのは、後から作られる実行を
  # 取りこぼさないため（awk に最後まで読ませ、終了コードで判定する。空行は数えない）。
  if [ "$listed" = 1 ] && [ -n "$all" ] && [ -z "$missing" ] && printf '%s\n' "$all" | awk -F '\t' 'NF && $(3) != "completed" { p = 1 } END { exit p }'; then
    [ "$all" = "$prev" ] && break
    prev="$all"
  else
    prev=""
  fi
  sleep 30
done
echo "-- 実行（判定の対象）"; printf '%s\n' "$runs"
[ -z "$missing" ] || { echo "-- 実行が付いていないワークフロー"; printf '%s\n' "$missing"; }
echo "-- ゲートの実行（参考。成否は commit status で判定する）"; printf '%s\n' "$all" | awk -F '\t' -v g="^($gates)\$" 'NF && $(5) ~ g'
printf '%s\n' "$runs" | runs_verdict "$listed" "$missing"
```

判定の出力は 6 通りです（`EXPECTED_UNKNOWN` は待ちに入る前に出ます）。

- `RUNS_GREEN`: ゲート以外の実行がすべて通っています。
- `RUNS_NOT_GREEN`: 「実行（判定の対象）」の一覧（4 列目が `conclusion`）を読み、失敗した実行（`failure`、`cancelled`、`timed_out` など）を止めて報告します。60 分で終わらなかった場合もここに入ります。その場合は失敗でなく時間切れなので、3 列目（`status`）を見て、止めて報告します。
- `RUNS_NONE`: ゲート以外の実行がありません（付いていたのはゲートの実行だけ）。CI の成否は、下の commit status だけで判定します。
- `RUNS_UNKNOWN`: 一覧を読めませんでした。「通った」とも「落ちた」とも扱わず、止めて報告します。
- `EXPECTED_UNKNOWN`: 動くはずのワークフローの一覧を求められませんでした（head・base の取得、ワークフローの読み取り、`actions/workflows` の API のどれかの失敗）。「動くはずのものが無い」とは別です。空として進めず、止めて報告します。
- `RUNS_MISSING`: 60 分待っても、動くはずのワークフローに実行が付きませんでした（「実行が付いていないワークフロー」の一覧）。「落ちた」ではなく「作られていない」です。上の `CHECKS_NOT_ATTACHED` と同じ切り分けの順序で確かめます。**数えない条件は、絞り込み（`paths` / `types` / `branches` など）・無効化・head と base の片方にしか無い、です。** これらに当たるものは一覧に入らないので、一覧に出たのは「数えた」ものです。数えたのに実行が付かないときは、(1) そのワークフローの `on:` を読み直す（雛形の読み方に合わず、動かないものを「動くはず」と読んでいないか）、(2) 無効化・ブランチ保護・ブランチ名など、`actions/workflows` の `state` に現れない理由が無いか（無効にしていたワークフローを PR の作成後に有効へ戻した場合、`opened` は再送されないので、意味のある変更を 1 つ積んで別の SHA にします）、(3) 上の切り分けの 4 点（無効化・利用枠・実行基盤・同時間帯の別 PR）の順に見ます。確かめたら止めて報告します。

「ゲートの実行」の一覧は、判定には使いませんが、status が付かない理由を切り分けるときに読みます（下の「置いている場合」の、ジョブだけが失敗する形）。

`second-opinion-gate` や `review-gate` のように **commit status で出るもの**は、実行ではなく Commit statuses の権限で読みます。`pending` のあいだは待ち、`success` で通過、`failure` と `error` は失敗です。このエンドポイント（combined status）は、**context ごとに最新の 1 件だけ**を返します。同じ context に status が積み重なっても（例: 記録を投稿して `failure` から `success` へ変わった）、過去の結果は並びません（実測で確認済み）。

```bash
for _ in $(seq 60); do  # 30 秒 × 60 回 = 30 分。ゲートの status が付き、pending でなくなるまで待つ
  st="$(gh api "repos/{owner}/{repo}/commits/$sha/status" --jq '.statuses[] | [.context, .state, .description] | @tsv')" || st=""
  printf '%s\n' "$st" | awk -F '\t' -v g="^($gates)\$" '$(1) ~ g { n++; if ($(2) == "pending") p = 1 } END { exit (n > 0 && !p) ? 0 : 1 }' && break
  sleep 30
done
printf '%s\n' "$st"
```

ゲートの status が 30 分たっても付かない、または `pending` のままなら、最後に出した一覧をもとに止めて報告します（イベントの取りこぼしで判定されていないことがあります。定期実行は置かないため、報告の前に 8 の再判定の手動実行を一度起こして確かめてかまいません）（下の「`second-opinion-gate` の確認」と、置いている場合の失敗の形に従います）。

**`second-opinion-gate` の確認（リモート最終ゲートの有無にかかわらず行います）**:

- `second-opinion-gate` の status を、上の `commits/<sha>/status` で確認します。**`failure`**（説明文が `no second-opinion record for this head`）なら、push 後に記録を投稿していません。`bash scripts/second-opinion-record.sh post` を実行してから（`post` は投稿の直後に、確認側を既定ブランチで手動実行します。起こせなかったときは非 0 で終わり、手で起こすコマンドを示すので、その手順で起こします）、もう一度、上の実行の完了の待ちと commit status の確認をやり直します。ローカルに記録が残っていない場合（別セッションが push した等）は、このブランチで第二意見を回し直す必要があるため、止めて報告します。
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
- **差分が変えた決定を説明している文章が、最終的な差分と一致しているか確かめます。** 対象の一覧は `.ai-playbook/review-workflow.md`「指摘を取り込んで中身を変えたら、説明も見直す」にあります（ここへは書き写しません）。途中で中身を変えると、最初に書いた説明が初版の中身のまま取り残されやすいためです。食い違いを見つけたら、次のように直します。
  - **PR 本文だけの食い違いは、`gh pr edit N --body-file <ファイル>` で直します。** push は要らないので、7 には進みません。直したら、この 4 を続けます。
  - **ファイル（リリースノート・README・雛形・コメントなど）の食い違いは、7 の手順で直し、2 に戻ります。** 7 の 1 巡を既に使っていれば、直さずに止めて報告します（7 の「止めて報告する」条件と同じ扱い）。
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

**最初に、マージの直前の再判定を行います。** 定期実行は置かないため、ゲート（`second-opinion-gate`、`review-gate` のうち配置されているもの）の判定は、ここで必ず既定ブランチの版で書き直します。イベントの取りこぼしで判定されないまま残った PR を拾い、PR 側のワークフローの書き換えで偽った成功を、既定ブランチの判定で上書きするためです（`.ai-playbook/review-workflow.md`「要求されたことを別の契機で確認する」と「この機構が保証すること／しないこと」）。手順は、(1) 既定ブランチを `--ref` に指定して手動実行を起こす、(2) 起こした実行の終わりを待つ、(3) head の commit status を確かめる、の 3 つです。**手動実行を起こすには Actions の書き込み権限が要ります。** 起こせなければ、止めて報告します（権限の表は `.github/project-ai-rules.md` か `packages/devcontainer-bootstrap/README.md`）。

**判定は、実行の成否ではなく head の commit status で行います。** 手動実行は open な PR を全件判定するので、実行は他の PR の失敗で落ちることがあります。また、push の直後（猶予の内側）で記録がまだ無い PR は判定を見送るため、status が変わらないことがあります（記録が在れば猶予の中でも緑が付きます）。見送られたときは、猶予が過ぎてからやり直します。

```bash
# sha は 2 で最後に確かめたコミット。再判定するゲートは「既定ブランチにあるもの」で決める
# （PR の作業ツリーで決めると、PR でゲートを消せば再判定を飛ばせ、ゲートを新設する PR は
# 既定ブランチにまだ無いワークフローを起こそうとして止まる）
# >>> land:rejudge
# rejudge_one <ワークフローのファイル名> <既定ブランチ> <sha> — 1 つのゲートを再判定する。
# 結果を REJUDGE_* の行で出し、通らなければ 1 を返す。
rejudge_one() {
  local wf="${1}" base="${2}" sha="${3}" ctx me prev t0 verdict st id run pending
  ctx="${wf%.yml}"
  # 自分の login。待ちを「自分が起こした手動実行」に絞るために要る。読めなければ止める
  # （絞らないと、ほかの人の手動実行が先に終わっただけで、自分の実行を待たずに打ち切る）
  me="$(gh api user --jq .login)" || me=""
  if [ -z "$me" ]; then echo "REJUDGE_FAIL $wf: 自分の login を読めない（gh api user）"; return 1; fi
  # 起こす前の最新の手動実行の番号（誰が起こした実行でも数える）。判定結果が「起こしたあとの
  # 実行」のものかを見る基準なので、絞らない。読めなければ止める（0 で代えると古い実行を取り違える）
  prev="$(gh run list --workflow "$wf" --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // 0')" || prev=""
  if [ -z "$prev" ]; then echo "REJUDGE_FAIL $wf: 実行の一覧を読めない"; return 1; fi
  # 起こした時刻（GitHub 側との時計のずれを見込んで 60 秒戻す）。自分が起こした手動実行に
  # 絞っているので、この余裕のあいだに作られたほかの人の実行は数えない。これより後に作られた
  # 自分の手動実行が現れるまでは、「手動実行がすべて終わった」と判定しない
  t0="$(date -u -d '-60 sec' +%Y-%m-%dT%H:%M:%SZ)"
  if ! gh workflow run "$wf" --ref "$base"; then echo "REJUDGE_DISPATCH_FAILED $wf: 手で起こす: gh workflow run $wf --ref $base"; return 1; fi
  # head の判定結果を書いた実行（status の target_url）が、起こしたあとに既定ブランチで
  # 始まった手動実行で、終わっていることを確かめる。誰が起こした実行でも、既定ブランチの
  # 版で動いた実行なら同じ判定ロジックなので、取り違えても判定の信頼性は変わらない。
  # 30 秒 × 40 回 = 20 分。自分の手動実行がすべて終わっても書き直されなければ、その時点で止める。
  # 限界: 同じアカウントの別のセッションが同時に起こした実行は区別できず、unchanged で止まりうる。
  # そのときは案内どおり、猶予が過ぎてから 1 回やり直す
  verdict=""
  for _ in $(seq 40); do
    sleep 30
    st="$(gh api "repos/{owner}/{repo}/commits/$sha/status" --jq ".statuses[] | select(.context == \"$ctx\") | \"\(.state) \(.target_url)\"")" || st=""
    id="${st##*/actions/runs/}"
    case "$id" in ''|*[!0-9]*) id=0 ;; esac
    if [ "$id" -gt "$prev" ]; then
      run="$(gh api "repos/{owner}/{repo}/actions/runs/$id" --jq '"\(.event) \(.head_branch) \(.status) \(.path // "" | sub("@.*$"; ""))"')" || run=""
      if [ "$run" = "workflow_dispatch $base completed .github/workflows/$wf" ]; then verdict="${st%% *} run $id"; break; fi
    fi
    pending="$(gh run list --workflow "$wf" --event workflow_dispatch --user "$me" --limit 20 --json databaseId,status,createdAt \
      --jq "[.[] | select(.databaseId > $prev)] | (any(.createdAt >= \"$t0\") and all(.status == \"completed\"))")" || pending=""
    if [ "$pending" = true ]; then verdict="unchanged"; break; fi
  done
  case "$verdict" in
    "success run "*) echo "REJUDGE_OK $wf: ${verdict#success }" ;;
    "") echo "REJUDGE_FAIL $wf: 20 分待っても、起こした手動実行が判定結果を書かない"; return 1 ;;
    unchanged) echo "REJUDGE_FAIL $wf: 手動実行は終わったが、head の判定結果が書き直されていない（猶予の内側で見送られた可能性）: ${st:-なし}"; return 1 ;;
    *) echo "REJUDGE_FAIL $wf: 再判定の結果が success ではない: $verdict"; return 1 ;;
  esac
}
# <<< land:rejudge

ng=0
base="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)" || base=""
wfs="$([ -n "$base" ] && gh api "repos/{owner}/{repo}/contents/.github/workflows?ref=$base" --jq '.[].name')" || wfs=""
[ -n "$base" ] && [ -n "$wfs" ] || { echo "REJUDGE_FAIL 既定ブランチ、またはそのワークフローの一覧を読めない"; ng=1; }
for wf in second-opinion-gate.yml review-gate.yml; do
  [ "$ng" -eq 0 ] || break
  case " ${wfs//$'\n'/ } " in *" $wf "*) ;; *) continue ;; esac
  ctx="${wf%.yml}"
  # この head の実行（PR 側の版で動く）が終わっていなければ判定しない。動いている PR 側の
  # 実行は、再判定の後で status を書き直せるため。件数で打ち切らず全ページを見る
  busy="$(gh api --paginate "repos/{owner}/{repo}/actions/runs?head_sha=$sha&per_page=100" \
    --jq ".workflow_runs[] | select((.path // \"\" | sub(\"@.*$\"; \"\")) == \".github/workflows/$wf\" and .status != \"completed\") | .id")" || busy="?"
  if [ -n "$busy" ]; then echo "REJUDGE_BUSY $wf: この head の実行が終わっていない（または読めない）: $busy"; ng=1; continue; fi
  rejudge_one "$wf" "$base" "$sha" || ng=1
done
[ "$ng" -eq 0 ]
```

最後の行が 0 で終われば、再判定の結果は緑です。**0 以外なら、マージせずに止めます。** 出力の行で次のように扱います。

- `REJUDGE_FAIL` で、判定結果が `failure` / `error` のとき: マージせずに止めて報告します。
- `REJUDGE_BUSY`、または判定結果が書き直されていないとき: push の直後（猶予の内側）で見送られたか、PR 側の実行がまだ動いています。猶予（数分）が過ぎてから 1 回だけやり直し、それでも通らなければ止めて報告します。待ちは自分のアカウントが起こした手動実行に絞っているので、ほかの人の手動実行とは取り違えません。**同じアカウントの別のセッションが同時に起こした実行は区別できず**、その実行が先に終わると、判定結果が書き直される前に止まることがあります。このときも、猶予が過ぎてから 1 回やり直します。
- `REJUDGE_FAIL` で自分の login を読めないとき: 待ちを自分が起こした手動実行に絞れないので、止めて報告します（認証を確かめる）。
- `REJUDGE_DISPATCH_FAILED`、または 20 分待っても判定結果が書かれないとき: 止めて報告します（権限の不足が多い）。

**判定結果は、起こしたあとに既定ブランチで始まり、終わった手動実行が書いたものだけを受け入れます。** status の `target_url` は書いた実行の URL なので、その実行が既定ブランチの手動実行（`workflow_dispatch`）で、起こす前の最新の番号より新しく、終わっていることを確かめてから、その `success` を緑とします。前からある `success`（PR 側の版の実行が偽って書いたものを含む）は、変わっていなければこの照合で落ちます。**この再判定を飛ばしません。** 飛ばすと、定期実行を置かない構成では、偽の成功や取りこぼしが残ったままマージされます。**`/land` を通さないマージ（画面から直接など）は、この再判定を通りません。**

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
