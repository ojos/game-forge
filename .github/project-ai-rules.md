# プロジェクト共通 AI ルール

このファイルはプロジェクト共通ルールの正本です。
全体共通ルールを、このプロジェクトの事情に合わせて具体化します。

## 参照先

- 全体共通ルール: `.ai-playbook/shared-ai-rules.md`
- ロール責務: `.ai-playbook/role-contracts/`
- タスク手順: `.ai-playbook/task-playbooks/`
- レビュー運用: `.ai-playbook/review-workflow.md`
- intake 規律・判定根拠: `.ai-playbook/intake/`

実行環境の入口ファイル（`CLAUDE.md` 等）はこのファイルを参照し、最小差分のみを記述します。

## このプロジェクト固有の値

（プロジェクト固有の制約・検証手順を記述します）

## 機密の具体化

共通規範「機密の取り扱い」を、このプロジェクトで具体化します。

- 機密の読み取り元: （例: `.env` / シークレット管理サービス）
- 追跡除外の対象: （例: `.env`）
- 共有する雛形: （例: 値のない `.env.example`）

**機械化された検知層があります。** `scripts/check-no-secrets.sh` が、機密を含みやすい名前のファイルを「追跡対象へ入る前」と「追跡済み」の 2 経路で検査し、あわせて `.env.example` に機密の値が入っていないことと、`.env` とのキー整合を検査します。`scripts/verify.sh` が受け入れ条件の手前で呼ぶため、受け入れ条件を書き換えても検査は残ります。

```bash
bash scripts/check-no-secrets.sh   # 終了コード 0 / 標準出力 SECRETS_PASS
```

- **検知層であって、機密を置いてよい根拠ではありません。** 名前で判定するため、規約外の名前を付けた機密は捕まりません。上の 3 項目をプロジェクトで具体化し、`.gitignore` で除外することが一次の対策です。
- **git を前提にします。** 作業ツリーでない、追跡ファイルが 1 件も無い、といった「検査が成立しない」状態は合格にせず失敗させます（検査していないことと、機密が無いことは別です）。
- **検知した場合の対処**: 追跡前なら `.gitignore` へ加える。追跡済みなら `git rm --cached` で外す。既にコミット済みなら、削除コミットでは漏洩は解消しないため、履歴からの除去と当該資格情報の失効・再発行まで行う。

### GitHub 認証（gh）だけを例外にする理由

トークンをファイルへ書き写さず、ツール自身のログイン状態に持たせるのが原則です。**GitHub CLI だけはこの原則の例外**として、PAT（personal access token）を `.env` の `GH_TOKEN` へ置くことを認めます。

- **理由**: gh の OAuth App には「ユーザー × アプリ × scope あたり 10 トークン」の上限があります。上限に達した状態でどこかの環境が認証すると、GitHub が既存のトークンを 1 本破棄します（理由コード `max_for_app`）。溜まる単位は環境ではなく**認証の回数**で、`gh auth login` も `gh auth refresh` も自分の古い枠を返しません。失効に気づいた環境が再認証し、それがまた別の環境を失効させる連鎖になるため、**運用ルールでは回避できません**。PAT は OAuth App の認可ではないため、この枠の外にあります。
- **名前**: `GH_TOKEN`（gh 自身が読む名前）をそのまま使います。`GIT_IDENTITY_*` を別名にしているのと方針が逆に見えますが、理由が違います。git は自身が読む名前（`GIT_AUTHOR_EMAIL` 等）を環境へ置くと `user.useConfigOnly` の保護が無効になるため別名にします。gh には、環境変数を置くことで無効化される保護がありません。
- **空でも壊れません**: `GH_TOKEN` が空の環境は従来どおり保存済み認証で動きます。
- **設定中は `gh auth login` を実行しません**: env が優先されるためログイン結果は使われず、それでも OAuth トークンは 1 本発行されます。上限に達していれば、他環境のトークンを 1 本失効させるだけの結果になります。これは制約ではなく安全装置として扱います。

発行手順と必要権限は、対象リポジトリと行う操作によって変わります。**このプロジェクトでは、環境ごとに別の PAT を置きます**（#869。2026-10-01 に利用者が決定し、#869 の当初の scope.out「Mac は保存済み OAuth のまま」を取り消した——[#869 のコメント](https://github.com/ojos/game-forge/issues/869#issuecomment-5932339469)。Mac と dev01 の 2 本。片方を失効させても、もう片方は動き続け、**dev01 に管理者の権限を持ち込まない**）。

- **PAT の発行手順**: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token。Token name は環境が分かる名前（例 `game-forge-mac` / `game-forge-dev01`）、Resource owner は `ojos`、Repository access は **Only select repositories → `ojos/game-forge`**、Expiration は選べる中で最も長い期間（1 年が目安）。値はその環境の `.env` の `GH_TOKEN` にだけ置き、リポジトリにも会話の記録にも書きません。
- **必要な権限**（Repository permissions。ここに無いものは No access）:

  | 権限 | Mac | dev01 | 使い道 |
  |---|---|---|---|
  | Metadata | Read-only | Read-only | 必須 |
  | Contents | Read and write | Read and write | git push（`credential.helper` に `gh auth git-credential`）、`gh pr merge` |
  | Pull requests | Read and write | Read and write | PR の作成・コメント・マージ |
  | Issues | Read and write | Read and write | 第二意見や外部層の記録のコメント、lock |
  | Actions | Read and write | Read and write | `gh workflow run` / `gh run watch` |
  | Workflows | Read and write | Read and write | `.github/workflows/` を変える push |
  | Commit statuses | Read-only | Read-only | status の読み取り（`land`） |
  | Administration | Read and write | No access | terraform（`GITHUB_TOKEN="$(gh auth token)"`。リポジトリの設定・既定のブランチ・branch protection・脆弱性アラート・Dependabot のセキュリティ更新）と、外部層の検査の読み取り |
  | Variables | Read and write | No access | terraform の Actions の変数と、外部層の検査の読み取り |

  Mac の組は 2026-10-01 に実測した——外部層の gh の 7 検査（前提・リポジトリ・private vulnerability reporting・既定のブランチ・branch protection・Actions の変数・OIDC）と production deployment が PASS、terraform が読む脆弱性アラート・Dependabot のセキュリティ更新・Actions の変数・private vulnerability reporting の読み取りが通った。**書き込み（apply）は次の apply で確かめる。** dev01 では terraform も外部層も動かない形にしてある（tfvars・state・`CLOUDFLARE_API_TOKEN` を置かず、`terraform plan` は必須変数の不足で落ちることを #802 で確かめた）ので、管理者と変数の権限を持たせません。
- **失効時・期限切れ時の再発行手順**: 上と同じ手順で同じ名前・同じ権限の PAT を発行し、その環境の `.env` の `GH_TOKEN` を差し替えます。古い PAT は GitHub の画面で削除します。**期限切れは Mac では #844 の定期実行が投稿できなくなる形で現れ、鮮度のジョブ（`acceptance-remote-freshness`）が 3 日で赤になります。** 端末を失くしたときは、その環境の PAT だけを削除します。

## 生成物の具体化

- コミットしない生成物: （例: ビルド成果物、メディアファイル）
- 再生成手順: （コマンドを記載）

## 作業状況の記録先

共通規範「作業状況の記録」を、このプロジェクトで具体化します。
単一ファイルへの集中更新は並列実行と衝突するため、追記のみの形式や作業単位ごとの分割を検討します。

- 未完了の作業: （記録先を記載）
- 完了した作業の履歴: （記録先を記載）

## 外部サービスの状態管理

共通規範「外部サービスの状態管理」を、このプロジェクトで具体化します。

- 対象の外部状態: （例: クラウドリソース、公開リポジトリ、リリース）
- 宣言・適用の手段: （例: Terraform、専用スクリプト）
- 手動操作の扱い: 状態確認・調査に留め、恒久的な変更は宣言側を通す

### 外部層の受け入れ検証

宣言と実際の外部状態が一致しているかを、機械判定できる形で確かめます（`.ai-playbook/loop-workflow.md`「受け入れ条件の二層」）。

- 実行体: （記載。例: `scripts/acceptance-remote.sh`。DCB は `--with-aws` / `--with-gcp` を選んだときに雛形を配置します）
- 起動方法: （記載。例: `VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh`）
- 検証する内容: （記載。例: 宣言の差分検出が差分なしを返すこと、宣言したリソースが実在すること）
- 通す契機: 外部状態の宣言を変更したとき。**反復のたびに回す層ではなく、ローカル事前ゲートにも含めません**（下記「レビューの起動方法」）。
- 定期実行（#844）: 利用者の Mac の launchd が毎日 12:00 JST に devcontainer の中のプライマリから全体を回し、要約だけを固定の issue へ載せます。鮮度と乖離は `acceptance-remote-freshness.yml` の定期ジョブが見ます（required check にしません）。手順と、公開される内容は `docs/acceptance-remote-schedule.md`。
- terraform/ を触る PR（#845）: apply の後に、PR の head へ `--detach` で置いたプライマリから `bash scripts/acceptance-remote-scheduled.sh --pr <N>` で全体を回し、要約だけを PR へ載せます。`acceptance-remote-pr.yml` が PR の head SHA に一致する持ち主の記録を確かめ、commit status（`acceptance-remote-pr`）を付けます。required check にはせず、`land` の手順 5 が読みます。手順は `docs/acceptance-remote-schedule.md`「terraform/ を触る PR」。
- 前提: 対象サービスへ認証済みであること。**この検証は認証を行いません**（資格情報をスクリプトへ書き写す経路を作らないため）。未認証やオフラインでの失敗は、宣言と外部状態の乖離ではありません。

## レビューの起動方法

共通規範「レビューワークフロー」のクロスモデル二段ゲートを、このプロジェクトで具体化します。

1. 主レビュー: 実装したモデル自身が差分を読み直します（実行体はありません）。
2. 第二意見: `scripts/second-opinion-review.sh`。エンジンは `.env` の `SECOND_OPINION_ENGINE`（`codex` / `antigravity` / `gemini`）で選びます。既定の運用は **codex**（#805）。
3. 単一入口: `bash scripts/loop-gate.sh`（identity → ローカル層の受け入れ検証 → 第二意見 → 記録）。**push / PR 作成の前にこれを通します。**

- 3 つを別々に思い出す運用は破綻するため、単一入口へまとめることを推奨します。実行体は利用側で用意します（このパッケージは実行ランタイムを持ちません）。
- 両段とも**落とす**対象は致命バグ・脆弱性・型エラー・エッジケースの見落としに限ります。
- 修正は 1 イテレーションで完結させます。
- **別リポジトリの issue / PR 番号は、必ず `owner/repo#N`（例: `ojos/ai-packages-dev#382`）と繋げて書きます。** コミットメッセージ・差分・PR 本文のどこでも同じです。第二意見は差分の追加行とコミットメッセージの `#N` を game-forge の issue / PR として引き、文脈に載せます。番号の直前が英数字なら拾わないので、繋げて書けば外れます。「上流 ojos/ai-packages-dev の #382」のように間に語を挟むと、game-forge の #382 として載ります（#882 / #883 で実際に起き、事実誤認の指摘が 1 件出ました）。読み取りは賢くせず、書き方で揃えます。繋げた形が外れることは `scripts/second-opinion-codex-selftest.sh` が固定しています（#902）。

### 判定の形はスキーマ方式を選んでいます（#804 / #877）

**共通規範（`.ai-playbook/review-workflow.md`「② 第二意見」）は、判定の返し方として「出力の最後の行に置く判定トークン」と「回答の形をスキーマで強制し、指摘の種別から判定を導出する」の 2 通りを認めています。このプロジェクトは 2026-09-29 から後者を使います。** **構造化出力（`scripts/second-opinion-schema.json`）で回答の形を強制し、判定はスクリプトが下します**。採用した時点の規範（ai-playbook v0.2.0）は判定トークンだけを認めていたので、この節は「意図した逸脱」として書いていました。v0.5.0 を #877 で取り込み、規範どおりの選択になりました。

**理由は、規範自身が名指しした故障を構造的に消すためです。** 規範は「モデルが回答の前に作業ナレーションを 1 行出したために、指摘が 1 件も無いのに 3 回の実行すべてが『指摘あり』に分類された」「**回数を増やしても消えない**」と書いています。**判定トークンを解析しなければ、この故障クラスは存在しません**（実測: 前置きを書かせても codex の回答は純粋な JSON でした）。

**規範がこの方式に求めることは、次のように満たしています。**

| 規範が要求すること | この実装での満たし方 |
|---|---|
| 実装したモデルとは別ベンダー | 変わりません（codex / antigravity / gemini） |
| 非対話で実行でき、機械的に判定できる | 変わりません（JSON を読んで判定します） |
| 指摘があるときに通過させない | `category` が `bug` / `vulnerability` / `type-error` / `edge-case` のいずれかなら落とします |
| 判定できない出力を通さない | **JSON として読めない回答は落とします**（「読めなかった」を「指摘なし」に倒しません）。**差分を読めなかったと答えた回答（`reviewed: false`）も落とし、記録も残しません**（#873） |

**gemini の経路だけは、規範の条件の外です（意図した逸脱として残します）。** 規範はスキーマ方式を「ツールが構造化出力の強制に対応する場合」に限っています。codex（`--output-schema`）と antigravity（`--json-schema`）は強制できますが、gemini には当たる旗がありません。gemini にはプロンプトで JSON の形を指示し、返答の後にスクリプトがスキーマで検証します。形を満たさない回答は落とします（`scripts/second-opinion-review.sh` の注記）。既定の運用は codex なので、gemini を使うのはエンジンを切り替えたときだけです。

**`.ai-playbook/` は上流パッケージの写しです**（`.ai-playbook/VERSION` に `source=https://github.com/ojos/ai-playbook/…/v0.5.0.tar.gz`）。**ここを編集しても次の展開で消えるため、プロジェクトの選択と具体化はこのプロジェクト層に書きます。**

### 受け入れ検証の二層

上記 1 の受け入れ検証は 2 層に分かれます（`.ai-playbook/loop-workflow.md`「受け入れ条件の二層」）。**単一入口が直列化するのはローカル層だけです。**

- ローカル層: （記載。ネットワークも外部認証も要さない検証。ループの接地信号）
- 外部層: （記載。宣言と実際の外部状態の一致を検証。実行体と起動方法は上記「外部層の受け入れ検証」に書きます）
- **外部層を単一入口へ含めない理由**: 外部認証の失効やオフラインでゲート全体が止まり、**実装が正しいのにループが止まります。** 単一入口の目的は複数の段を思い出す運用を機構で塞ぐことであって、外部の可用性をゲートの前提条件に持ち込むことではありません。
- 外部層を通す契機: （記載。既定は外部状態の宣言を変更したとき）

**道具の自己検査も、すべてローカル層（`scripts/acceptance.sh`）に置いたままにします（#890）。** 規範（`.ai-playbook/loop-workflow.md`「道具自体を見る検査の置き場所」）の基準「実装を変えたときに壊れるか」で `scripts/acceptance.sh` の検査を 1 本ずつ分けると、壊れない側（判定に使う道具を既知の入力で確かめる自己検査）は次の 15 本です（#890 で分類した 13 本と、#903 と #925 で 1 本ずつ足した 2 本）。

| 自己検査 | 確かめている道具 | 単独の所要 | 注記 |
|---|---|---|---|
| `scripts/check-writeback-serial.sh` | `scripts/writeback-serial.sh` / `writeback-serial.yml` | 0.03 秒 | |
| `scripts/check-second-opinion-gate-exempt.sh` | `scripts/second-opinion-gate-exempt.sh` | 0.02 秒 | |
| `scripts/check-second-opinion-gate-workflow.sh` | `second-opinion-gate.yml` の run の本文 | 0.31 秒 | 本文が呼ぶ `second-opinion-gate-exempt.sh` と、本物の `scripts/second-opinion-record.sh` の save（#888 で追加）も実行する |
| `scripts/check-on-attach-gh-guidance.sh` | `scripts/on-attach.sh` | 0.02 秒 | |
| `scripts/check-acceptance-remote-record.sh` | 外部層の記録・鮮度・PR の記録の道具 | 2.20 秒 | **本物の宣言を読む**: E3 が `terraform/variables.tf` の `required_status_checks` を見るので、宣言を変えると壊れうる |
| `node scripts/lib/dev-fixture-seed-check.mjs --selftest` | 仕込みが入ったことを確かめる判定 | 0.01 秒 | |
| `scripts/second-opinion-codex-selftest.sh` | 第二意見の codex の配線 | 0.89 秒 | |
| `scripts/loop-gate-range-selftest.sh` | `scripts/loop-gate.sh` のレビュー範囲 | 0.08 秒 | |
| `scripts/check-devcontainer-dev01.sh` | devcontainer の dev01 の分岐 | 0.29 秒 | |
| `scripts/check-devhost.sh` | `tools/devhost/` | 0.18 秒 | |
| `scripts/acceptance-remote-aws-failure-selftest.sh` | 外部層の IAM の検査 3 本 | 0.29 秒 | **本物の宣言を読む**: 本物の `scripts/acceptance-remote.sh` が `terraform/*.tf` から期待値を導くので、宣言を変えると壊れうる |
| `scripts/ojos-jp-records-selftest.sh` | 外部層の DNS レコードの照合 | 0.06 秒 | |
| `scripts/chat-bundle-changed-selftest.sh` | `scripts/chat-bundle-changed.sh`（チャットの束の関門の判定。#903） | 約 1 秒 | #903 のレーンが別の時点で測った値。下の合計 4.43 秒には含まない |
| `scripts/orchestrator-bundle-changed-selftest.sh` | `scripts/orchestrator-bundle-changed.sh`（オーケストレータの束の関門の判定。#925） | 約 0.9 秒 | #925 のレーンが別の時点で測った値。下の合計 4.43 秒には含まない |
| `scripts/tile-reachability/` の `go test` | タイル地図の到達判定（運営の手元の道具） | 0.05 秒 | Go のビルドキャッシュがある状態 |

所要は 2026-10-02 に devcontainer（14 コア、ロードアベレージ 4.6〜4.8）で 1 本ずつ測った値で、**合計 4.43 秒**です。同じ条件で `bash scripts/acceptance.sh` 全体は 89.7 秒だったので、**約 5% にあたります**。

残りの検査は、実装・配備物・文書を変えると壊れるのでローカル層です（費用を理由に外しません）。内訳は次のとおりです。

- 衛生と文書: 制御文字・表崩れ・相対リンク・app.css・トークンのコントラスト・用語・仕様 / ロードマップ / handoff の版と日付・`/waitlist`
- 写しと宣言の照合: Go の版・Ebitengine のキー・ロゴ（`--check` と、`brand/logo/` を照合する `logobake.node-test.mjs`）とその写し・オーケストレータのリトライと束・OGP / アイコン / チャット / 学習クローラの写し・terraform の output の参照・Lambda を呼ぶ許可の導出・ojos.jp のレコードの output
- 配備スクリプトを含む検査: シェルの移植性・aws CLI の引数の形
- node の一式（依存・生成物・likes / cleanup の Worker・`npm test`・アイコンの再エンコード・型検査・束ね）・Worker のバインディング・`.dev.vars`・`terraform fmt`

**外さない理由は 3 つです。**

1. **払う費用が小さい。** #890 の 13 本を合わせても上の 4.43 秒で、ローカル層の約 5% です。
2. **外すには新しい誤りの元が要る。** 「道具を変えた差分のときだけ回す」には、差分の起点の判定・見張るファイルの表・その表を点検する道具が必要になります。起点の取り違えは、`scripts/loop-gate.sh` が #878 で実際に踏んだ種類の誤りです。しかも上の 2 本は本物の宣言を読むので、見張るファイルに `terraform/` まで含めないと、実装を変えたときに壊れる検査を黙って外すことになります。
3. **規範が求めるのは「契機を定めずに外さない」ことで、外さない選択は妨げません。** ローカル層に置いたままなので、道具を変えた反復でも必ず回ります（規範「この層が守らないもの」の心配が生じない）。

**見直す契機**: 上の自己検査（と今後増える自己検査）の合計が、ローカル層の所要の 1 割を超えたとき。そのときは、外す検査ごとに契機を定め、それが道具を変えた PR で回ることを終了コードで確かめる検査とあわせて移します。

### リモート最終ゲート

push / PR 作成後の最終ゲートを、このプロジェクトで具体化します（`.ai-playbook/review-workflow.md`「リモート最終ゲート」）。

- 手段: **置きません（2026-09-30 から。#807）。** GitHub Copilot code review を撤退し、要求側（`copilot-review.yml`）と確認側（`review-gate.yml`）を撤去しました。Codex の GitHub code review などの代わりも置いていません（利用者の判断）。
- **PR の上で機構が確かめるのは 3 つです。** `verify.yml` の verify ジョブがローカル層の受け入れ検証を再実行すること（`scripts/check-doc-links.sh` を含む。#803）、`identity-guard.yml` がコミットの作者が許可した identity であることを確かめること、`second-opinion-gate.yml` が head SHA に紐づく第二意見の記録を確かめること（#806）です。terraform/ を触る PR では、`acceptance-remote-pr.yml` が apply の後の外部層の記録を head SHA で確かめます（#845。差分のレビューではなく、外部状態の確認です）。
- **Dependabot の PR には、第二意見の記録を求めません（#838）。** ゲートが検出したいのは著者の失念で、Dependabot の PR には回す著者がいないためです。除外しないと毎回赤くなり、赤が失念の意味を失います。条件は PR の著者とすべてのコミットの author が `dependabot[bot]` であることで、人がコミットを足した PR は、いつもどおり記録を求めます。差分を読むのは `land` の手順 4、マージの承認はフックの確認です。
- **判断の要る指摘の受け皿は、`land` の手順 4（自分で差分を読む）です。** 機構ではなく人間とエージェントが最後に読む、という着地を受け入れています。

### リモート最終ゲートを置かないことは規範どおりの選択です（#807 / #877）

**共通規範は、リモート最終ゲートを任意の層にしています**（`.ai-playbook/review-workflow.md`「リモート最終ゲート（任意の層）」）。置くかどうかはプロジェクト層が選び、**このプロジェクトは置かない側を選んでいます。** 撤退した 2026-09-30 の時点の規範（ai-playbook v0.2.0）は置くことを前提にしていたので、この節は「意図した逸脱」として書いていました。上流が ojos/ai-packages-dev#364 でこの選択を規範へ取り込み、ai-playbook v0.5.0 を #877 で取り込んだので、逸脱ではなくなりました。

**置かない場合に規範が標準の機構層とする 2 つを、このプロジェクトは次のように満たします。**

| 規範が置かない場合に求めること | このプロジェクトでの満たし方 |
|---|---|
| push 前に回した第二意見の出力を記録に残す | `scripts/loop-gate.sh` が第二意見の直後に `scripts/second-opinion-record.sh save` を呼びます。指摘の有無にかかわらず残し、判定に到達しなかった実行は残しません（差分を読めなかった回答 `reviewed: false` を含む。#873） |
| 記録を PR へ載せる | **push のたびに** `bash scripts/second-opinion-record.sh post` を打ちます。記録は head SHA に紐づくので、直して push し直したら打ち直します（`land` の手順 2 と 7 も同じ） |
| 確認側が、push 後の別の契機（PR 更新・定期実行）から head に紐づく記録を確かめる。要求はしない | `.github/workflows/second-opinion-gate.yml`（#806）。`pull_request` と 20 分ごとの `schedule` で、記録の有無だけを見て commit status を付けます。第二意見を回すかどうかは著者側の判断のままです。required check にはしません |
| CI による受け入れ検証の再実行 | `verify.yml` の verify ジョブがローカル層の受け入れ検証を再実行します（#803） |

**理由は費用の形です。** Copilot の消費は 100% が PR code review で、`credits ≒ 16.1 × PR 本数 + 0.0172 × 変更行数`（#654 の実測）。**PR 本数に線形なので、複数プロジェクトへ広げると増え続けます**（2026-09 の超過は $164.60）。第二意見の codex は定額です（#805）。

**失うものは判断済みです（2026-09-27）。** リモートのレビューが持つ性質のうち、ローカル実行では原理的に得られない 3 つを手放します（表の 4 つの性質は、規範の「置かない場合」の表と同じです）。

| | 性質 | 撤退後 |
|---|---|---|
| (a) | 著者の操作なしに記録が作られる | ❌ 第二意見の記録は著者側が投稿する |
| (b) | 作られた記録を著者が消せない | △ 「書かない」は確認側が検出する。「消す」は意図的な行為として見える |
| (c) | 記録が無いことを検出できる | ✅ `second-opinion-gate.yml` |
| (d) | 記録される内容が著者を通らない | ❌ |

**代わりに、機械検査へ落とせるものは 4 つとも無料で付きます**（`verify.yml` の再実行が供給する）。Copilot の指摘を分類すると 71% がそれにあたり（7 件中 5 件）、#803 がその層です。

**偽造は防ぎません。** 第二意見を回さずに記録だけを作って投稿すれば通ります。確認側が検出できるのは失念であって迂回ではない、という規範の割り切りをそのまま受け入れます。他人が書いた記録で緑にならないよう、確認側が数えるのは持ち主の記録だけです（#865）。

**規範の「置く場合」の規律のうち、指摘の扱いはこのプロジェクトでも使います。** 指摘を解決済みとみなす条件・2 巡目以降は人間が却下すること・指摘の却下の記録は、第二意見と人間の指摘にそのまま当てはめます。「要求と確認を 2 本で 1 組にする」「1 回だけ要求する」「要求された ≠ 読まれた」は、置かないので当てはまりません。

**戻すときは、規範の「置く場合」に従い、要求側と確認側の 2 本で 1 組にします。** 確認側だけを省くと、要求側の契機が届かなかったときに最終ゲートが黙って抜けます（規範「要求されたことを別の契機で確認する」）。撤去した 2 本は `git log --diff-filter=D -- .github/workflows/copilot-review.yml .github/workflows/review-gate.yml` で辿れます。

**v0.5.0 の雛形（`templates/second-opinion-gate.yml` / `templates/second-opinion-record.sh`）とは、記録の数え方の 1 点だけを違えたまま残します（#888）。** 雛形は「書き手が PR の作者で、かつ `author_association` が `OWNER` / `MEMBER` / `COLLABORATOR`」のコメントを数えます。このプロジェクトは「書き手がリポジトリの持ち主で、かつ `OWNER`」だけを数えます（#865）。理由は 3 つです。個人所有の public リポジトリで、PR を作るのも記録を投稿するのも持ち主の gh だけなので、どちらの条件でも数えるコメントは変わりません。書き手を 1 人に固定するので、協力者を迎えたときも、その人が自分で投稿した記録では緑にならない（持ち主が回すまで赤のままの）安全な側に倒れます。そして、外部層の記録の確認側（`scripts/acceptance-record-judge.sh`。#844 / #845）と同じ綴りに揃っています。**Organization へ移すときは雛形の条件へ揃えます**——持ち主の名前（組織名）がコメントの書き手と一致することはなく、持ち主で絞ったままだと記録があっても常に赤になります。ほかの 3 点（check-run が無い PR を掃き寄せで更新時刻により判定する・`permissions` に `checks: read` を宣言する・`save` を一時ファイル経由で置き換える）は雛形に揃え、`scripts/check-second-opinion-gate-workflow.sh` が確かめます。

### 書き戻しの直列化

**`docs/handoff.md` を触る open PR は、同時に 1 本までにします**（#650）。2 本目が出ると、`.github/workflows/writeback-serial.yml` が後から出たほうへ `writeback-serial` の status を failure で付けます。**同じ日の追記は、先に open している PR へ足してください。** 先の PR が閉じると、次の 1 本は自動で緑に変わります。

- **理由は、複数のセッションが同時に `handoff.md` を書き換えると、片方の追記がもう片方へ相乗りすることです**（`docs/handoff.md` 4 章の #229）。もとは Copilot code review の PR 1 本あたりの固定費（2026-09 の実績で 63%）も理由でしたが、#807 の撤退で消えました。
- **呼びかけでは担保しません。** 並行するセッションは互いの open PR を見ないまま書き戻すので、機構で見ます。見るのは「同じファイルを触る open PR があるか」という実質です（`.ai-playbook/shared-ai-rules.md` 12 章）。
- **required check にはしません。** 急ぎの書き戻しまで止めたいわけではありません。赤のまま通すときは、先行する PR と衝突しないことを確かめてから通します。
- 判定の正本は `scripts/writeback-serial.sh`、表は `scripts/check-writeback-serial.sh`（`scripts/acceptance.sh` から回ります）。**判定を YAML へ書き写しません。**
- **束ねられるのは #656 の後だからです。** それまでは書き戻し 1 本で GitHub が `patch` を落とし、当時のリモート最終ゲート（Copilot）が読めませんでした。解体後の書き戻しは `patch` 4 KB 台（#660）です。束ねた PR も、第二意見が 1 チャンクで通る大きさ（`[second-opinion] run 1/1`）に収めてください。

## 委譲先と作業ツリーの分離

共通規範 13 章「実装委譲パターン」を、このプロジェクトで具体化します（#889）。**委譲先の役割・モデル・ツールは、Claude Code が読むエージェント定義（`.claude/agents/*.md` の frontmatter）で固定します。** 指示文で「haiku を使う」と書いても迂回できますが、実行環境が読む frontmatter は迂回できないためです（12 章）。

### 委譲先の一覧

| 役割 | 定義の場所 | model | tools | 起動 | 使う場面 |
|---|---|---|---|---|---|
| implementer | `.claude/agents/implementer.md` | `opus` | Read, Grep, Glob, Bash, Edit, Write, NotebookEdit, TodoWrite | Agent の `subagent_type: "implementer"` | 承認済みの intake 票の実装を、親が切った worktree の中で PR 作成まで進める（並列レーンを含む） |
| explorer | `.claude/agents/explorer.md` | `haiku` | Read, Grep, Glob, Bash | Agent の `subagent_type: "explorer"` | 13 章「調査を委譲する条件」の 3 条件をすべて満たす、広域で機械的な調査 |

- **正本は各定義の frontmatter です。** この表はその写しで、`scripts/check-agents-list.sh` が `acceptance.sh` の衛生の検査で照合します（12 章「一覧の複製は機械照合で担保する」。#900）。定義があるのに行が無い・行があるのに定義が無い・役割 / 定義の場所 / model / tools の値が違う、のどれも赤です。検査は今の表の書式（列の順と、定義の場所と model のバッククォート）をそのまま読むので、表の書式を変えるときは検査も同じ PR で直します。定義を変える PR では、この表も同じ PR で直します。
- **implementer を雛形の `sonnet` ではなく `opus` にしているのは、既存のレーン運用を変えないためです。** これまでのレーンは汎用のサブエージェントとして親と同じモデルで回り、第二意見の指摘が実在するか偽陽性かを実測で判定するところまでレーンが行っています（handoff 3 章の反証の表）。モデルを下げるかどうかは、レーンの結果を比べてから別の issue で決めます。
- **explorer は、組み込みの `Explore` ではなくこちらを使います。** model と tools をこのリポジトリの定義で固定できるのは、こちらだけです。
- **判定から外れる作業は委譲しません。** 文書の編集、設計や判断、仮説を立てながら絞り込む調査（原因不明の不具合の切り分けなど）、親が既に文脈を持っている小さな変更は、親が自分で行います（13 章「委譲の判定」「委譲の閾値」）。

### 作業ツリーの分離

実装を委譲するとき（1 本でも並列でも）は、**レーンごとに専用の worktree とブランチを渡します。** プライマリ（`/workspaces/game-forge`）は `main` に置いたまま、レーンに触らせません。

- **既定は、親が手で切ります。** `git fetch` の後、`git worktree add .claude/worktrees/lane-<issue> -b <branch> origin/main` で切り、`git log --oneline -1` で起点を確かめてから、パスとブランチを implementer へ渡します（`.claude/worktrees/` は `.gitignore` で除外済み）。`git worktree add` が分離されたツリーそのものを生むので、指示文ではなく機構による分離です（12 章）。
- **手で切る理由は 3 つです。** (1) 起点を `origin/main` に固定して確かめられる（プライマリの HEAD が古いと前の変更が相乗りする。13 章「相乗りの防止」）。(2) ブランチ名と worktree の名前を issue に揃えられ、所有一覧や報告と突き合わせやすい。(3) worktree を消さずに再利用でき、`npm ci` を省ける。
- **Agent の `isolation: "worktree"` は、PR を作らない使い捨ての試しに限ります**（差分を見るだけの試作、手元での再現など）。起点とブランチ名を親が選べず、変更が無ければ自動で片付けられるので、PR まで進めるレーンには使いません。
- **どちらの場合も、worktree の中で `npm ci` を打って `node_modules` の実体を置きます。** プライマリの `node_modules` を symlink で借りると、束のハッシュの測定が使えず、ツリーも汚れます。
- **スクラッチはレーンごとに分けます**（`<scratchpad>/lane-<issue>/`）。ログや一時ファイルを共有すると、別のレーンの出力を自分の結果として読みます。
- **worktree の中で `git config` を打ちません。** identity は共有の設定から来ます（`aizu@bascule.co.jp` は禁止。上の「機密の具体化」と `scripts/verify-commit-identity.sh`）。
- **`docs/product-spec.md` と `docs/handoff.md` はレーンに編集させません**（13 章「正本文書の扱い」）。書き加えたい文面は報告で受け取り、取り込む側が 1 本で入れます。
- **レーンは PR を作り、`bash scripts/second-opinion-record.sh post` を打ったところで止まります。** CI と第二意見の記録を待ち、指摘を読んでから起こすのは親です。所有一覧の機械照合（`comm -12`）など、統合する側の実務は `docs/handoff.md` 4 章「並列作業のやり方」に従います。
- 読み取り専用の explorer には、作業ツリーの分離は要りません。

### 品質整理（任意の前段）の起動手段

`.ai-playbook/review-workflow.md`「品質整理（任意の前段）」の起動手段は、Claude Code の組み込みの `/simplify` です（再利用・簡素化・効率化の観点で差分のコードを整理し、その場で直す。バグは探さない）。

- **使うかどうかは実装者の任意です。** ゲートにせず、`scripts/loop-gate.sh` にも含めません。省いても push は妨げられません。
- 使うときは、受け入れ条件を満たした後、`bash scripts/loop-gate.sh` の前に **1 回だけ**回します。整理で差分が変わるので、受け入れ検証は loop-gate が整理後の差分に対して改めて通します。第二意見の後には回しません。
- **対象はコードだけです。** 規範文書・README・`docs/` の文章には使いません（規則に添えた理由が削られるため）。
