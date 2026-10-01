# 外部層の定期実行

**外部層の受け入れ検証（`scripts/acceptance-remote.sh` の 40 件）を、利用者の Mac で毎日 12:00 JST に回し、
走ったことと結果を Mac の外（固定の issue）に残します。** GitHub Actions の定期ジョブがその記録を読み、
古い・乖離がある・ある系統の認証が 3 日切れている、のどれかで赤にします（#844）。

宣言と外部状態のずれを、次に terraform を触ったときではなく、**1 日以内に**知るための仕組みです。

## なぜ Mac で回すのか

**34 件の検査のうち 32 件は、期待値を `terraform output`（＝ state）から取ります。** state と
`terraform.tfvars` は追跡外でプライマリにしかなく、リモート state は却下済みです（2026-09-27）。
CI で回せるのは 34 件中 2 件でした（実測の表は #808 のコメント）。そこで、**state のあるプライマリ
（`/workspaces/game-forge`）から、devcontainer の中で**回します。認証（`~/.aws`・`~/.config/gcloud`・
`~/.config/gh`）は Docker のボリュームにあり、ホストからは見えないためです。

## 全体の流れ

| 段 | どこで | 何が | 何をするか |
|---|---|---|---|
| 1 | Mac のホスト | launchd（[雛形](../scripts/launchd/jp.ojos.game-forge.acceptance-remote.plist)） | 毎日 12:00 に起動側を呼ぶ。スリープ中に過ぎた分は復帰時に 1 回 |
| 2 | Mac のホスト | [`scripts/acceptance-remote-launchd.sh`](../scripts/acceptance-remote-launchd.sh) | Docker と devcontainer を起こし、`docker exec` で 3 を呼ぶ。起こした devcontainer は終わったら止め直す |
| 3 | devcontainer | [`scripts/acceptance-remote-scheduled.sh`](../scripts/acceptance-remote-scheduled.sh) | プライマリが main にあり汚れていないことを確かめ、origin/main より遅れていれば fast-forward してから、`acceptance-remote.sh` を**引数なしで**全体を回す |
| 4 | devcontainer | [`scripts/acceptance-remote-summary.sh`](../scripts/acceptance-remote-summary.sh) | 出力から、公開してよい要約だけを作る。FAIL は [系統の対応表](../scripts/lib/acceptance-remote-deps.tsv) で乖離と前提の不成立に読み分ける |
| 5 | devcontainer | `gh issue comment` | 要約を固定の issue へ投稿する |
| 6 | GitHub Actions | [`acceptance-remote-freshness.yml`](../.github/workflows/acceptance-remote-freshness.yml)（毎日 15:00 JST） | [`scripts/acceptance-record-judge.sh`](../scripts/acceptance-record-judge.sh) で記録を判定する。赤はメールで届く |

**2 と 3 で失敗したとき（Docker が起きない・プライマリがずれている以外の理由で投稿できない）は、どこにも投稿しません。**
記録が来ないことを、6 が 3 日で「古い」として赤にします。

**定期ジョブは required check ではありません。** PR でも push でも動かず、外部の可用性をマージの前提に持ち込みません。

## 何が公開されるか

**リポジトリは public です。固定の issue に載るのは次だけです。**

- 時刻（UTC）・プライマリの HEAD（40 桁）
- 結果の分類（下の表）と理由（列挙した綴りだけ）
- 件数（予定・実行・PASS・乖離・前提の不成立・未実行）と、系統ごとの前提の合否
- **ラベルごとの PASS / DRIFT / FAIL-PRECONDITION / NOT-RUN**（ラベルは `acceptance-remote.sh` の `run "<ラベル>"` の綴り）

**検査の出力・plan の出力（ゾーン ID・ARN・トンネル ID・TXT の値など）は載りません。** 要約は
出力のうち `[acceptance-remote] <ラベル>` と `[acceptance-remote] FAIL: <ラベル>` の 2 種類の行しか読まず、
ラベルもスクリプトの綴りと完全一致したものしか出しません。値の形が要約に 1 つも入らないことは、
[`scripts/check-acceptance-remote-record.sh`](../scripts/check-acceptance-remote-record.sh) が仕込みの出力で確かめています。
**値は Mac の手元のログにだけあります**（下の「ログの置き場所」）。

## 結果の分類

**FAIL は検査ごとに、依存する認証の系統で読み分けます**（利用者の決定。PR #853）。対応は
[`scripts/lib/acceptance-remote-deps.tsv`](../scripts/lib/acceptance-remote-deps.tsv) が 1 か所で持ちます
（根拠は #808 のコメントの実測表と、各検査の中の `gh` / `aws` / `cf_api` / `gcloud` の呼び出し）。

| ラベルの行 | 意味 |
|---|---|
| `PASS` | 通った |
| `DRIFT` | 落ちた。**依存する系統の前提はすべて通っていた**（または依存が無い）ので、宣言と外部状態の乖離の疑い |
| `FAIL-PRECONDITION` | 落ちた。依存する系統の前提のどれかが落ちていたので、**この回はこの検査を判定していない**（前提の検査そのものの FAIL もここ） |
| `NOT-RUN` | 回らなかった |

GCP の ADC は 24 時間で切れます。前提が 1 つ落ちた回をまるごと「乖離ではない」と読むと、その日は
Cloudflare や AWS の本物の乖離が見えなくなるので、この形にしています。**検査を足したら、対応表にも
1 行足してください。** run と対応表が 1 対 1 でなければ要約は作られず、`verify` の自己試験も赤になります。

| result | 意味 | CI の扱い |
|---|---|---|
| `ok` | 40 件すべて PASS | 緑 |
| `drift` | `DRIFT` が 1 件以上。**ほかの系統の前提が落ちていても drift** | 赤（`FAIL drift`） |
| `precondition` | `DRIFT` は無く、前提の不成立がある（下の reason） | その回は数えない。続けば系統ごとに赤 |
| `incomplete` | 途中で止まった・終了コードが合わない。合格にも乖離にも数えない | 赤（`FAIL incomplete`） |

| reason（`precondition` のとき） | 意味 | 直し方 |
|---|---|---|
| `prerequisite-failed` | gh / aws / cloudflare / gcp の前提の検査のどれかが FAIL（`prereq.<系統>: fail` を見る） | 下の「認証の切れ」 |
| `primary-not-on-main` | プライマリがブランチか detach にある | プライマリで `git checkout main` |
| `primary-not-at-origin-main` | プライマリの main が origin/main から**分岐している**（手元にだけコミットがある） | 手元のコミットを片付ける |
| `primary-ff-failed` | 遅れていたので fast-forward を試みたが失敗した（追跡外のファイルが上書きされる等） | ログの git の出力を見る |
| `primary-dirty` | プライマリの追跡ファイルに手元の変更がある、または `terraform/` に追跡外の `*.tf`（`override.tf` など。`.gitignore` が除外している）がある | 変更を片付ける。override はプライマリに置かない |
| `state-missing` | プライマリに `terraform/terraform.tfstate` が無い（期待値を output から取れず、検査が乖離に見えるため回さない） | state を戻す（追跡外。プライマリにだけある） |
| `fetch-failed` | origin の main を取れない | ネットワーク・git の認証 |
| `invocation-error` | `acceptance-remote.sh` が終了コード 2（引数の誤り。#850） | 起動側の不具合。定期実行は引数を渡さない |

**遅れているだけなら fast-forward してから回します**（利用者の決定。PR #853）。条件は、main にいる・
追跡ファイルが汚れていない・`terraform/` に追跡外の宣言が無い・HEAD が origin/main の祖先、のすべてです。
ff したことは Mac のログに残り、要約には載りません。**checkout・reset・分岐の解消はしません**——
プライマリは他のセッションも配備に使う場所で、無人の実行がそれ以上動かすと、そちらの手順の前提が
黙って変わるためです（`docs/handoff.md` 3 章「プライマリの作業ツリーは `main` に置いてください」）。

## CI が赤にする条件

判定は持ち主（`ojos`）が書いた記録だけを数えます。**固定の issue は public で、誰でもコメントできる**
ため、印（`<!-- acceptance-remote-record v1 -->`）だけで探すと、他人が「全件 PASS」を貼って止まった
定期実行を緑に見せられます。条件は `user.login` が持ち主で、`author_association` が `OWNER` であることです。

| 赤の行 | 意味 | まず見るもの |
|---|---|---|
| `FAIL no-record` | 持ち主の記録が 1 件も無い | 導入が済んでいるか |
| `FAIL stale` | 最新の記録が 3 日より古い（定期実行が止まっている） | Mac のログ（launchd.out と日ごとのログ） |
| `FAIL drift` | ラベルごとに、判定できた最新の回（`PASS` か `DRIFT` だった回）が `DRIFT`。行にラベルと回が出る | その回のログの FAIL の行 |
| `FAIL incomplete` | 検査を回した最新の回が途中で止まっている | その回のログ |
| `FAIL system-stale <系統>` | その系統の前提が 3 日通っていない | 下の「認証の切れ」 |
| `外部層の記録を確かめられませんでした` | **記録が無いのではなく、読めなかった**（GitHub API の失敗・記録先の未設定） | ジョブのログ。次の日も続くなら設定 |

**乖離はラベルごとに「判定できた最新の回」で見ます。** 乖離の翌日にその系統の認証が切れても、
その回は `FAIL-PRECONDITION`（判定していない）なので乖離は隠れません。直ったと数えるのは、
そのラベルが `PASS` した回だけです。

## 導入（一度だけ）

### 1. 認証の期間を延ばす（利用者の手作業）

- **AWS**: IAM Identity Center のセッション期間を **7 日**にする（既定の 8 時間では 1 日もたない。
  2026-09-30 に実測）。AWS コンソール → IAM Identity Center → 設定 → 認証 → セッション設定 →
  「セッション期間」を 7 日。長命のアクセスキーは使いません（[build-invocation.md](build-invocation.md)
  の「長命キーになるのは構成上の帰結であり、選好ではない」）。
- **GCP**: Google Workspace の管理コンソール → セキュリティ → アクセスとデータ管理 →
  **Google Cloud のセッション管理**で、再認証の間隔を **24 時間**にする（選べるのは 1〜24 時間か
  「要求しない」だけ。「要求しない」は、持ち歩く端末に期限のない資格情報を置くので採らない。2026-09-30 に設定済み）。
  GCP が要るのは plan だけです。**ログインしない日が 3 日続くと `system-stale gcp` で赤になるのは想定どおりです。**

### 2. 固定の issue を作り、ロックする

**記録先は #854 で、作成とロックは済んでいます**（2026-10-01）。作り直すときの手順です。

```bash
gh issue create --title "外部層の受け入れ検証の記録（自動投稿。#844）" \
  --body "外部層の受け入れ検証の定期実行（docs/acceptance-remote-schedule.md）が、毎日の要約をここへ載せます。閉じないでください。"
gh issue lock <番号> --reason off_topic
```

**`--reason` の綴りは `off_topic`（下線）です。** `off-topic` は gh が `invalid reason` で拒否します（実測）。

**ロックすると、協力者以外はコメントできなくなります。** 判定は持ち主の記録しか数えないので、
ロックは判定の担保ではなく、記録の列を読みやすく保つためです（CI はロックされていないと警告を出します）。
**閉じないこと**（閉じてもコメントは付けられますが、見落としやすくなります）。

番号を [`scripts/lib/acceptance-record.sh`](../scripts/lib/acceptance-record.sh) の
`ACCEPTANCE_RECORD_ISSUE` に書いて main へ入れます。**書く側（Mac）と読む側（CI）が同じこのファイルを読みます。**

### 3. gh の権限を確かめる

投稿は devcontainer の `gh` が、`.env` の `GH_TOKEN`（持ち主の PAT）で行います。
**PAT に、このリポジトリの Issues の書き込みが要ります。** 持ち主以外のアカウントで投稿された記録は数えません。

```bash
gh api user --jq .login     # ojos であること（devcontainer の中で）
```

### 4. devcontainer を見つけられるか確かめる（Mac のホストで）

```bash
cd <Mac 上のリポジトリ>
docker ps -a --filter "label=devcontainer.local_folder=$PWD" --format '{{.ID}} {{.Status}}'
```

**1 行出ること。** 出なければ、VS Code で一度開いて devcontainer を作ってください。
リポジトリを `~/Documents` や `~/Desktop` の下に置いているときは、launchd から読めるよう
システム設定 → プライバシーとセキュリティ → フルディスクアクセス に `/bin/bash` を足す必要があります。

### 5. launchd に登録する（Mac のホストで）

```bash
cd <Mac 上のリポジトリ>
mkdir -p ~/Library/Logs/game-forge/acceptance-remote ~/Library/LaunchAgents
sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" \
  scripts/launchd/jp.ojos.game-forge.acceptance-remote.plist \
  > ~/Library/LaunchAgents/jp.ojos.game-forge.acceptance-remote.plist
plutil -lint ~/Library/LaunchAgents/jp.ojos.game-forge.acceptance-remote.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/jp.ojos.game-forge.acceptance-remote.plist
```

**ログのディレクトリを先に作ること。** launchd は `StandardOutPath` の親を作らず、無いと起動に失敗します。
予定は **この Mac の時刻で 12:00** です（JST の設定を前提にしています）。

### 6. 1 回目を走らせて確かめる

```bash
launchctl kickstart -p "gui/$(id -u)/jp.ojos.game-forge.acceptance-remote"
ls -t ~/Library/Logs/game-forge/acceptance-remote/ | head -n 3
```

160 秒ほどで終わります（plan を含む。#808 の実測）。固定の issue に要約が載ったら、CI 側も手で流します。

```bash
gh workflow run acceptance-remote-freshness.yml
gh run list --workflow acceptance-remote-freshness.yml --limit 1
```

投稿せずに要約だけを見たいときは、devcontainer の中で `bash scripts/acceptance-remote-scheduled.sh --print`。

## ログの置き場所

| ファイル | 中身 |
|---|---|
| `~/Library/Logs/game-forge/acceptance-remote/<UTC の時刻>.log` | 1 回分の全文（起動側の経過・`acceptance-remote.sh` の出力・要約・投稿の結果）。**値を含む。30 日で消える** |
| `~/Library/Logs/game-forge/acceptance-remote/launchd.out` | launchd が起動側を呼べなかったときの出力 |

**ログは Mac の外へ出しません。** issue へ貼らないこと。

## 認証の切れ

`prereq.<系統>: fail` や `FAIL system-stale <系統>` が出たら、devcontainer の中で再ログインします
（`docs/handoff.md` 3 章「AWS SSO と GCP の ADC は切れます」）。

```bash
aws sso login --profile game-forge-prod --use-device-code
gcloud auth application-default login --no-launch-browser   # URL はスマホで開けるが、認可コードは devcontainer のプロンプトへ貼り戻す
```

GCP は認証後に `ido@ojos.jp` であることを確かめます（別アカウントでも成功し、plan だけが権限エラーで落ちます）。

## 知っておくこと

- **Mac の電源が切れていた日の分は走りません**（スリープなら復帰時に 1 回）。3 日続けば `stale` で赤になります。
- **利用者の `terraform apply` と重なった回は、plan だけが赤になります**（state のロックは待たずに失敗する既定のまま）。
  その回は `drift` として記録されます。翌日の回で戻れば読み流してよく、ログの plan の行で見分けられます。
- **偽造は塞ぎません。** 記録を書くのは回すのと同じ持ち主の端末です。検出できるのは「止まった」「認証が切れた」「乖離した」
  であって、持ち主自身の迂回ではありません（second-opinion-gate と同じ線）。
- **terraform/ を触る PR で記録を求める**のは #845 です（下の「terraform/ を触る PR」。要約の形と判定はこの仕組みと共有します）。

## terraform/ を触る PR（#845）

**apply の後に、apply したのと同じツリーから外部層を回し、要約をその PR へ載せます。** CI
（[`acceptance-remote-pr.yml`](../.github/workflows/acceptance-remote-pr.yml)）が、PR の head SHA に一致する
持ち主の記録を探して commit status `acceptance-remote-pr` を付けます。毎日の定期実行はマージの後
1 日以内に乖離を拾いますが、**apply の直後に外部層を回したかどうかは拾えない**ので、ここで結びます。

### 手順（利用者の端末で。apply と続けて）

apply は**マージの前に、プライマリを PR の head へ `--detach` で置いて**当てます（`docs/handoff.md` 3 章。
worktree からは state が見えず、ブランチ名の checkout は別の worktree が握っていると断られます）。

```bash
cd /workspaces/game-forge                       # プライマリ。worktree からは回さない
git fetch origin
sha="$(gh pr view <N> --json headRefOid --jq .headRefOid)"
git checkout --detach "$sha"
terraform -chdir=terraform plan                 # destroy の件数の期待値を先に決める（3 章）
terraform -chdir=terraform apply
bash scripts/acceptance-remote-scheduled.sh --pr <N>   # 160 秒ほど。要約が PR #<N> へ載る
git checkout main                               # すぐ戻す（3 章「プライマリは main に」）
```

`--pr` は定期実行と同じ確認（追跡ファイルの汚れ・`terraform/` の追跡外の宣言・state の有無）をしたうえで、
**プライマリの HEAD が PR の head と一致しなければ、回さず、何も載せません**（終了コード 3）。定期実行と違って
**fetch も fast-forward もしません**——apply を当てたツリーそのものを確かめるためです。全文の出力は端末にだけ
出ます。**PR へ貼らないでください**（値を含みます。PR に載るのは要約だけです）。

### status の読み方

| status | 説明文 | 意味 | 次にすること |
|---|---|---|---|
| success | `External acceptance passed at this head (all checks PASS)` | いまの head で回した最新の記録が全件 PASS | なし |
| failure | `No external acceptance record for this PR; …` | 記録が無い（apply の前、または回し忘れ） | 上の手順 |
| failure | `… record is for an older head; re-run after apply` | 記録の後に push した | 新しい head で plan → 差分があれば apply → `--pr` で回し直す |
| failure | `… found drift` | 回したが乖離があった | PR のコメントの `DRIFT` の行と端末の出力 |
| failure | `… did not run checks (<理由>)` | 前提の不成立（認証の切れ・汚れ・state が無い） | 上の「認証の切れ」や理由の表を見て、回し直す |
| failure | `… is incomplete` | 途中で止まった | 端末の出力を見て回し直す |
| （無し） | — | terraform/ を触らない PR・fork の PR、または GitHub API から読めなかった | 触る PR で無いなら正常。読めなかったときはジョブのログ（次の契機で判定し直す） |

**前提の不成立も failure に数えます。** 検査を回せていない記録は、apply の後の外部状態を確かめていないためです。

**判定し直す契機**: 記録のコメントが付いたとき（`issue_comment`）・30 分ごとの掃き寄せ（`schedule`）・
手で流すとき（`gh workflow run acceptance-remote-pr.yml -f pr=<N>`）。push の直後の failure は、apply の前の
正しい状態です（猶予は置いていません。理由はワークフローの冒頭）。**required check ではありません**——赤は
`land` の手順 5 が読みます。

## 外し方

```bash
launchctl bootout "gui/$(id -u)/jp.ojos.game-forge.acceptance-remote"
rm ~/Library/LaunchAgents/jp.ojos.game-forge.acceptance-remote.plist
gh workflow disable acceptance-remote-freshness.yml   # 外したまま放置すると 3 日で赤になるため
rm -r ~/Library/Logs/game-forge/acceptance-remote     # ログも要らなければ
```

固定の issue は残してかまいません（過去の記録の置き場所）。
