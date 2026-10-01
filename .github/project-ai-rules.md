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

発行手順と必要権限は、対象リポジトリと行う操作によって変わります。**このプロジェクトでは、環境ごとに別の PAT を置きます**（#869。2026-10-01 に利用者が決定。Mac と dev01 の 2 本。片方を失効させても、もう片方は動き続け、**dev01 に管理者の権限を持ち込まない**）。

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

  Mac の組は 2026-10-01 に実測した——外部層の gh の 7 検査（前提・リポジトリ・private vulnerability reporting・既定のブランチ・branch protection・Actions の変数・OIDC）と production deployment が PASS、terraform が読む脆弱性アラート・Dependabot のセキュリティ更新・Actions の変数・private vulnerability reporting の読み取りが通った。**書き込み（apply）は次の apply で確かめる。** dev01 は terraform も外部層も回さない（#802）ので、管理者と変数の権限を持たせません。
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

### 判定の形は規範から逸脱しています（#804。意図した逸脱）

**共通規範（`.ai-playbook/review-workflow.md`）は「出力の最後の行に置かれた判定トークン」で通過を判定すると定めていますが、このプロジェクトは 2026-09-29 から使いません。** 代わりに**構造化出力（`scripts/second-opinion-schema.json`）で回答の形を強制し、判定はスクリプトが下します**。

**理由は、規範自身が名指しした故障を構造的に消すためです。** 規範は「モデルが回答の前に作業ナレーションを 1 行出したために、指摘が 1 件も無いのに 3 回の実行すべてが『指摘あり』に分類された」「**回数を増やしても消えない**」と書いています。**判定トークンを解析しなければ、この故障クラスは存在しません**（実測: 前置きを書かせても codex の回答は純粋な JSON でした）。

**規範の意図は保っています。**

| 規範が要求すること | この実装での満たし方 |
|---|---|
| 実装したモデルとは別ベンダー | 変わりません（codex / antigravity / gemini） |
| 非対話で実行でき、機械的に判定できる | 変わりません（JSON を読んで判定します） |
| 指摘があるときに通過させない | `category` が `bug` / `vulnerability` / `type-error` / `edge-case` のいずれかなら落とします |
| 判定できない出力を通さない | **JSON として読めない回答は落とします**（「読めなかった」を「指摘なし」に倒しません） |

**`.ai-playbook/` は上流パッケージの写しです**（`.ai-playbook/VERSION` に `source=https://github.com/ojos/ai-playbook/…/v0.2.0.tar.gz`）。**ここを編集しても次の展開で消えるため、逸脱はこのプロジェクト層に書きます。** 規範側を変えるなら、上流の `ojos/ai-playbook` へ提案します（**未起票**）。

### 受け入れ検証の二層

上記 1 の受け入れ検証は 2 層に分かれます（`.ai-playbook/loop-workflow.md`「受け入れ条件の二層」）。**単一入口が直列化するのはローカル層だけです。**

- ローカル層: （記載。ネットワークも外部認証も要さない検証。ループの接地信号）
- 外部層: （記載。宣言と実際の外部状態の一致を検証。実行体と起動方法は上記「外部層の受け入れ検証」に書きます）
- **外部層を単一入口へ含めない理由**: 外部認証の失効やオフラインでゲート全体が止まり、**実装が正しいのにループが止まります。** 単一入口の目的は複数の段を思い出す運用を機構で塞ぐことであって、外部の可用性をゲートの前提条件に持ち込むことではありません。
- 外部層を通す契機: （記載。既定は外部状態の宣言を変更したとき）

### リモート最終ゲート

push / PR 作成後の最終ゲートを、このプロジェクトで具体化します（`.ai-playbook/review-workflow.md`「リモート最終ゲート」）。

- 手段: **置きません（2026-09-30 から。#807）。** GitHub Copilot code review を撤退し、要求側（`copilot-review.yml`）と確認側（`review-gate.yml`）を撤去しました。Codex の GitHub code review などの代わりも置いていません（利用者の判断）。
- **PR の上で機構が確かめるのは 3 つです。** `verify.yml` の verify ジョブがローカル層の受け入れ検証を再実行すること（`scripts/check-doc-links.sh` を含む。#803）、`identity-guard.yml` がコミットの作者が許可した identity であることを確かめること、`second-opinion-gate.yml` が head SHA に紐づく第二意見の記録を確かめること（#806）です。terraform/ を触る PR では、`acceptance-remote-pr.yml` が apply の後の外部層の記録を head SHA で確かめます（#845。差分のレビューではなく、外部状態の確認です）。
- **Dependabot の PR には、第二意見の記録を求めません（#838）。** ゲートが検出したいのは著者の失念で、Dependabot の PR には回す著者がいないためです。除外しないと毎回赤くなり、赤が失念の意味を失います。条件は PR の著者とすべてのコミットの author が `dependabot[bot]` であることで、人がコミットを足した PR は、いつもどおり記録を求めます。差分を読むのは `land` の手順 4、マージの承認はフックの確認です。
- **判断の要る指摘の受け皿は、`land` の手順 4（自分で差分を読む）です。** 機構ではなく人間とエージェントが最後に読む、という着地を受け入れています。

### リモート最終ゲートを置かないことは規範から逸脱しています（#807。意図した逸脱）

**共通規範は、リモート最終ゲートを置くことを前提にしています**（「1 回だけ要求する」「要求されたことを別の契機で確認する」）。このプロジェクトは置きません。

**理由は費用の形です。** Copilot の消費は 100% が PR code review で、`credits ≒ 16.1 × PR 本数 + 0.0172 × 変更行数`（#654 の実測）。**PR 本数に線形なので、複数プロジェクトへ広げると増え続けます**（2026-09 の超過は $164.60）。第二意見の codex は定額です（#805）。

**失うものは判断済みです（2026-09-27）。** リモートのレビューが持つ性質のうち、ローカル実行では原理的に得られない 3 つを手放します。

| | 性質 | 撤退後 |
|---|---|---|
| (a) | 著者の操作なしに記録が作られる | ❌ 第二意見の記録は著者側が投稿する |
| (b) | 作られた記録を著者が消せない | △ 「書かない」は確認側が検出する。「消す」は意図的な行為として見える |
| (c) | 記録が無いことを検出できる | ✅ `second-opinion-gate.yml` |
| (d) | 記録される内容が著者を通らない | ❌ |

**代わりに、機械検査へ落とせるものは 4 つとも無料で付きます**（`verify.yml` の再実行が供給する）。Copilot の指摘を分類すると 71% がそれにあたり（7 件中 5 件）、#803 がその層です。

**規範の他の部分は変わりません。** 指摘を解決済みとみなす条件・2 巡目以降は人間が却下すること・指摘の却下の記録は、第二意見と人間の指摘にそのまま当てはめます。**`.ai-playbook/` は上流の写しなので、ここへ書きます。** 上流への提案は未起票です。

**戻すときは、要求側と確認側の 2 本で 1 組にします。** 確認側だけを省くと、要求側の契機が届かなかったときに最終ゲートが黙って抜けます（規範「要求されたことを別の契機で確認する」）。撤去した 2 本は `git log --diff-filter=D -- .github/workflows/copilot-review.yml .github/workflows/review-gate.yml` で辿れます。

### 書き戻しの直列化

**`docs/handoff.md` を触る open PR は、同時に 1 本までにします**（#650）。2 本目が出ると、`.github/workflows/writeback-serial.yml` が後から出たほうへ `writeback-serial` の status を failure で付けます。**同じ日の追記は、先に open している PR へ足してください。** 先の PR が閉じると、次の 1 本は自動で緑に変わります。

- **理由は、複数のセッションが同時に `handoff.md` を書き換えると、片方の追記がもう片方へ相乗りすることです**（`docs/handoff.md` 4 章の #229）。もとは Copilot code review の PR 1 本あたりの固定費（2026-09 の実績で 63%）も理由でしたが、#807 の撤退で消えました。
- **呼びかけでは担保しません。** 並行するセッションは互いの open PR を見ないまま書き戻すので、機構で見ます。見るのは「同じファイルを触る open PR があるか」という実質です（`.ai-playbook/shared-ai-rules.md` 12 章）。
- **required check にはしません。** 急ぎの書き戻しまで止めたいわけではありません。赤のまま通すときは、先行する PR と衝突しないことを確かめてから通します。
- 判定の正本は `scripts/writeback-serial.sh`、表は `scripts/check-writeback-serial.sh`（`scripts/acceptance.sh` から回ります）。**判定を YAML へ書き写しません。**
- **束ねられるのは #656 の後だからです。** それまでは書き戻し 1 本で GitHub が `patch` を落とし、当時のリモート最終ゲート（Copilot）が読めませんでした。解体後の書き戻しは `patch` 4 KB 台（#660）です。束ねた PR も、第二意見が 1 チャンクで通る大きさ（`[second-opinion] run 1/1`）に収めてください。
