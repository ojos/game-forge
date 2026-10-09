# 月次の運営報告（note）

月 1 回の運営報告は note（`note.com/gameforgejp`）に置きます（#936）。note には公式の投稿 API が無いので、
**材料集め・下書き・検査を自動にし、人には「読む・直す・貼る・公開する」だけを残します。** 公開するかどうかの
最後の判断は人が持ちます。記事が増えても PR は増えません（下書きも材料もリポジトリに入れません）。

## 流れ

| 段 | どこで | 何が | 何をするか |
|---|---|---|---|
| 1 | Mac のホスト | launchd（[雛形](../scripts/launchd/jp.ojos.game-forge.ops-report.plist)） | 毎月 3 日の 9:00 に起動側を呼ぶ |
| 2 | Mac のホスト | [`scripts/ops-report-launchd.sh`](../scripts/ops-report-launchd.sh) | Docker と devcontainer を起こし、`docker exec` で 3 を呼ぶ。終わったら控えを Mac へ写して通知する。起こした devcontainer は止め直す |
| 3 | devcontainer | [`scripts/ops-report-draft.sh`](../scripts/ops-report-draft.sh) | 4 → 5 → 6 → 7 → 8 を順に回し、結果の行（`OPS_REPORT_*=`）を出す |
| 4 | devcontainer | [`scripts/ops-report-collect.sh`](../scripts/ops-report-collect.sh) | 先月（JST の暦月）の材料を 1 つの JSON にまとめる。本番は読み取りだけ |
| 5 | devcontainer | `claude -p`（道具も MCP も使わせない） | [型](ops-report-template.md)と材料から下書きを書く |
| 6 | devcontainer | [`scripts/check-ops-report.sh`](../scripts/check-ops-report.sh) | 推敲前の下書きを検査する。落ちたら推敲も Docs への書き込みもしない |
| 7 | devcontainer | `claude -p` で `/natural-japanese full`（控えの場所の中のファイルの道具・サブエージェント・スキルの `uv run` だけ） | 下書きを推敲し、6 軸で採点する（下の「推敲（7）」）。推敲した下書きをもう一度 6 で検査する |
| 8 | devcontainer | `claude -p`（Claude Docs の 2 つの道具だけ） | 「運営報告 YYYY-MM（下書き）」の doc を新しく作り、URL を返す |

**文章の生成（5・7・8）はループの検証の外です。** 自己試験（[`scripts/check-ops-report-selftest.sh`](../scripts/check-ops-report-selftest.sh)）は
偽の claude で 3 の分岐（推敲の成功・失敗・推敲後に検査で落ちる場合を含む）と 6 を確かめ、本物の `claude -p` を呼びません。

### 材料（4）

| 材料 | 出どころ | 注意 |
|---|---|---|
| 生成回数・成功率・AI の費用 | `scripts/usage-report.sh --remote --from <月初> --to <月末> --format json` | 月の窓で集計（JST の 0 時で切る） |
| 作品数・フォーク率など | `scripts/kpi-report.sh --remote --format json` | **期間で絞れないので、集めた時点の累計** |
| ビルド時間 | `scripts/build-time-report.sh --from <月初> --to <月末> --format json` | `--remote` は無い（常に本番の CloudWatch）。**保持が 14 日なので月の前半は入らない**。AWS の認証が切れていれば `unavailable` に理由を残して続ける |
| 閉じた issue・マージした PR | `gh issue list` / `gh pr list` | 番号と題名と issue の閉じ方だけ（作った人の名前・ラベル・本文は入れない）。記事に使うのは完了として閉じたもの |

**作品の本文・題名・プロンプト・利用者の文章は読みません。** 丸めた値は `figures` にまとめ、型は「数字は JSON からだけ取る」と指示します。
**費用は実額を載せます**（2026-10-05 の利用者の判断）。材料にあるのは生成にかかった AI の費用だけなので、
そのほかの費用と投げ銭は下書きに「人が埋める欄」として空けてあります。

### 検査（6）

次のどれかがあれば非 0 で止め、Docs には置きません。

- 本文の数字が材料の JSON に無い（日付・月・見出しの番号・「1 回あたり」・人が埋める欄の中は照合しない。決まりの全文はスクリプトの冒頭）
- `@` ハンドルの形（`@gameforgejp` は除く）
- ARN・ID・トークン・メールアドレスの形
- 許可した一覧の外の URL（一覧はスクリプトの `ALLOWED_URLS`）

### 推敲（7）

書いた下書きを、[natural-japanese](../.claude/skills/natural-japanese/UPSTREAM.md)（coji/natural-japanese v1.5.0、MIT。版を固定して
`.claude/skills/natural-japanese/` に置いた写し）の full で推敲します（#956）。構造・読みやすさ・型の照合の 3 つのレビューを
サブエージェントで並列に回し、最後に 6 軸のルーブリックで採点します。

- **依頼に「動かせない制約」を渡します**: 5 つの見出しと順番、数字は材料にある値だけ、【人が埋める：…】の綴り、
  下書きと材料に無い事実・動機を足さない、来月やることは約束にならない言い方、内部の作業はまとめて 1 行、
  書かないこと（[型](ops-report-template.md)と同じ）。依頼文の全文は `scripts/ops-report-draft.sh` の中にあります。
- **推敲は止める理由にしません。** 推敲の段が失敗したとき（uv やスキルが無い・claude が失敗した・推敲した下書きを受け取れない・
  見出しか人が埋める欄の数が変わった）と、推敲した下書きが 6 の検査で落ちたときは、**推敲前の下書き（検査を通ったもの）で続け**、
  結果の行（`OPS_REPORT_REFINE`）と理由に出します。どちらの場合も、Docs に置くのは検査を通った下書きだけです。
- **6 軸の合格点（全軸 90・平均 92）に届かなくても止めません。** 「人間味・誠実さ」は運営者の一人称と動機が材料に無いので、
  推敲では埋まりません（書くと捏造になる）。届かない分は「人が足すとよい箇所」として控え（`refine-review.json`）に残り、
  件数が通知の理由に載ります。公開の前に、人がそこを埋めます（下のチェックリストの 2）。
- 推敲は控えの場所の `refine/` で行い、作業ツリーには書きません。uv は devcontainer の作り直しで
  [`scripts/install-uv.sh`](../scripts/install-uv.sh) が入れます（版とチェックサムを固定）。
- 推敲を飛ばすときは `--no-refine` を付けます。

### 結果と終了コード（3）

| 終了コード | STATUS | 意味 | 通知 |
|---|---|---|---|
| 0 | `ok` | Docs に置けた（その月の doc が既にあれば作り直さず、その URL を返す） | doc の URL |
| 1 | `check-failed` | 推敲前の下書きが検査で落ちた。推敲も Docs への書き込みもしていない | 理由（種類ごとの件数）と控えの場所 |
| 2 | `collect-failed` / `draft-failed` / `check-error` / `unsafe-settings` / `copy-failed` / `usage` | 材料を集められない・下書きを書けない・検査が成立しない・claude の設定が MCP の道具を先に許している・Docs には置けたが控えを写せない・引数の誤りか同じ月の別の実行が走っている | 理由と控えの場所（あれば）とログ |
| 3 | `docs-failed` | 検査は通ったが Docs に置けなかった（応答に URL が無いことも失敗に数える） | 理由と控えの場所 |

**返答に URL が無くても doc ができていることがあります。** そのときは `docs-pending.txt` が残り、次の実行は
Docs を呼ばずに `docs-failed` で止まります（その月に 2 本目を作らないため）。Claude Docs の一覧に
「運営報告 YYYY-MM（下書き）」が無いことを確かめてから `--force` で回し直してください。

**Docs に置けなかったときも黙って終わりません。** 控え（Markdown）は必ず残り、その場所が通知に載ります。

推敲の段の結果は、終了コードとは別に `OPS_REPORT_REFINE` に出ます（推敲の段まで来なければ空）。どの値でも終了コードは変わりません。

| `OPS_REPORT_REFINE` | 意味 | 理由に付くもの |
|---|---|---|
| `done` | 推敲した下書きを使った | 6 軸の平均・最低の軸・人が足すとよい箇所の件数（採点を読めなければ、その旨） |
| `failed` | 推敲の段が失敗したので、推敲前の下書きを使った | 失敗の理由 |
| `rejected` | 推敲した下書きが検査で落ちたので、推敲前の下書きを使った | 検査の種類ごとの件数と、推敲した下書き（`refined.md`）の場所 |
| `skipped` | `--no-refine` で推敲を飛ばした | その旨 |

## 置き場所

| どこ | ファイル | 中身 |
|---|---|---|
| devcontainer | `~/.local/state/game-forge/ops-report/<YYYY-MM>/`（`OPS_REPORT_DIR` で変えられる） | `material.json`（材料）・`prompt.txt`・`draft-raw.md`（推敲前の下書き）・`check-raw.txt`・`refine/`（推敲の作業場所）・`refine-prompt.txt`・`refine-response.json`・`refined.md`（推敲した下書き）・`refine-review.json`（6 軸の採点と人が足すとよい箇所）・`check-refined.txt`・`draft.md`（使った下書き。推敲後か推敲前）・`docs-draft.md`（Docs に置いたものと同じ控え）・`check.txt`・`docs-url.txt`・`result.txt` |
| Mac | `~/Library/Application Support/game-forge/ops-report/<YYYY-MM>/` | `draft.md` と `result.txt` の写し（推敲できた月は `refine-review.json` も） |
| Mac | `~/Library/Logs/game-forge/ops-report/<UTC の時刻>.log` | 1 回分の全文（400 日で消える） |
| Claude Docs | 「運営報告 YYYY-MM（下書き）」 | 検査を通った下書きだけ。**材料の JSON は置かない** |

**どれもリポジトリの外です。** draft は、控えの場所が git の作業ツリーの中を指していたら止まります。
devcontainer の中の控えは作り直すと消えるので、残したいものは Mac の写しを使ってください。

## 人のチェックリスト（公開の前に）

1. 通知の URL（または控え）を開き、全文を読む。事実と違うこと・言い過ぎ・約束に読める書き方を直す
2. 【人が埋める：…】の欄を埋める（そのほかの費用の実額・投げ銭の額）。**欄を残したまま公開しない**。
   推敲の採点（`refine-review.json` の `human_todo`）が挙げた「人が足すとよい箇所」に、運営者の言葉（動機・実感）を足す
3. 数字を直したら、材料（`material.json` の `figures`）と照らし直す。検査は直した後の文章を見ていない
4. 人の名前・作品名・ID・他人のハンドル・許可外の URL が入っていないことを目で確かめる
5. note に貼る。見出し画像は logobake の既存のものを使う（毎月作り直さない）
6. **note の公開設定で「AI 学習への提供」がオフになっていることを確かめる**
7. 公開する。Claude Docs の下書きは、公開後に不要なら消す

## 導入（一度だけ。Mac で）

### 1. 手で 1 回回す（初回は 2026-09 分で型を固める）

devcontainer の中で、まず Docs に置かずに試します。

```bash
bash scripts/ops-report-draft.sh 2026-09 --no-docs
cat ~/.local/state/game-forge/ops-report/2026-09/draft.md
```

型を直したら（[ops-report-template.md](ops-report-template.md)）、もう一度回します。納得したら Docs へ置きます。

```bash
bash scripts/ops-report-draft.sh 2026-09
```

材料を集め直さずに書き直すときは `--material ~/.local/state/game-forge/ops-report/2026-09/material.json`、
その月の doc を作り直すときは `--force` を付けます。**`--force` は新しい doc を作ります**（前の doc は残ります）。
前の doc の URL は結果の理由と `docs-url.previous.txt` に出るので、Docs の一覧から消してください。

### 2. launchd に登録する（Mac のホストで）

```bash
cd <Mac 上のリポジトリ>
mkdir -p ~/Library/Logs/game-forge/ops-report ~/Library/LaunchAgents
sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" \
  scripts/launchd/jp.ojos.game-forge.ops-report.plist \
  > ~/Library/LaunchAgents/jp.ojos.game-forge.ops-report.plist
plutil -lint ~/Library/LaunchAgents/jp.ojos.game-forge.ops-report.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/jp.ojos.game-forge.ops-report.plist
```

**ログのディレクトリを先に作ること**（launchd は `StandardOutPath` の親を作りません）。devcontainer の探し方と
フルディスクアクセスの注意は [外部層の定期実行](acceptance-remote-schedule.md) の導入 4 と同じです。

### 3. launchd から 1 回起こして確かめる

```bash
OPS_REPORT_ARGS="2026-09 --force" bash scripts/ops-report-launchd.sh   # 手で起動側を回す（月と引数を渡せる）
launchctl kickstart -p "gui/$(id -u)/jp.ojos.game-forge.ops-report"     # launchd から回す（先月の分）
ls -t ~/Library/Logs/game-forge/ops-report/ | head -n 3
```

通知が出ないときは、システム設定 → 通知 で「スクリプトエディタ」（osascript の通知の出し手）を許可してください。
launchd から `docker exec` で起こしたときにも claude.ai のログインが効くかは、ここで確かめます。

### 外し方

```bash
launchctl bootout "gui/$(id -u)/jp.ojos.game-forge.ops-report"
rm ~/Library/LaunchAgents/jp.ojos.game-forge.ops-report.plist
```

## 知っておくこと

- **外部層の定期実行（毎日 12:00）と時刻をずらしてあります。** どちらも devcontainer を起こした側が終わったら止めます。
  スリープから復帰した直後に両方が同時に走ると、先に終わった側が devcontainer を止め、もう一方が途中で切れることがあります。
  その月は手で回し直してください。
- **devcontainer の `~/.claude/settings.json` が MCP の道具（`mcp__…`）を `permissions.allow` で許していたり、`defaultMode` が `bypassPermissions` だったりすると、claude を 1 度も呼ばずに止まります**（`unsafe-settings`）。
  `--allowedTools` は許す指定であって、設定が先に許した道具を取り消せないためです。下書きには issue / PR の題名に由来する文が入るので、Docs 以外の接続（作品の書き換えなど）を動かせる余地を残しません。
- draft はプライマリ（`/workspaces/game-forge`）のスクリプトを使います。型を直したら main に入れてから回します。
- 費用と時間（1 か月分）: Docs への書き込みは下調べで 1 回 $0.16（2 ターン）でした。2026-10-09 に 2026-09 の材料の写しで
  `--no-docs` を通しで回した実測は、書く段が 35 秒・$0.50、推敲の段が 309 秒・$3.73（38 ターン）、全体で 345 秒でした
  （どちらも `generate-response.json` / `refine-response.json` の `total_cost_usd` と `duration_ms`）。推敲の段の上限は
  `OPS_REPORT_REFINE_TIMEOUT`（既定 1800 秒）です。
