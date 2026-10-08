#!/usr/bin/env bash
# confirm-merge-hook.sh — マージ実行の前に確認を挟む PreToolUse フック。
#
# 規範（role-contracts/closer.md）は「既定の merge 方針は手動承認とする」と定めるが、
# 呼びかけでは破れる。ある利用プロジェクトでは、対話中の許可承認によりマージコマンドが
# 技術的に実行可能になった結果、承認を経ないまま PR 2 本がマージされた。実行できることと
# 実行してよいことが混同された形で、shared-ai-rules.md 12 章が「機構で保証する」を
# 求める対象そのものにあたる。
#
# 保証するのは「黙ってマージしない」ことであって「マージさせない」ことではない。判定は
# deny ではなく ask を返し、利用者が承認すればマージは実行される。指示に従うマージまで
# 塞ぐと「PR を作り、指示を待ち、指示されたらマージする」という本来の運用が成り立たない。
#
# ── なぜ settings.json の permissions.ask で足りないか ────────────────────────
#
# permissions の allow / ask / deny は、コマンド名と引数文字列の前方一致で判定する
# （実測。下記の 2 例はいずれも harmless な echo で確認した）。そのため次を表現できない。
#
#   - 同じ操作の別経路: gh pr merge を対象にした規則は gh api --method PUT .../merge や
#     gh api graphql の mergePullRequest に一致しない。gh api ごと対象にすると、状態を
#     変えない GET まで確認を求める。
#   - 引数の位置に依らない判定: --method PUT が引数の途中や末尾へ来る綴りは、前方一致
#     では捕捉できない（実測: deny 規則 Bash(echo --method PUT:*) は
#     `echo --method PUT repos/o/r/pulls/1/merge` を止めるが、
#     `echo repos/o/r/pulls/1/merge --method PUT` は素通りする）。
#
# 迂回できる機構は守られている外観だけを作る（12 章）。フックは文字列全体を検査できる
# ため、上の 2 つを 1 か所で扱える。
#
# なお「連結（cd ... && gh pr merge）が前方一致を抜ける」は理由として採らない。実測では
# deny 規則 Bash(echo alpha:*) が `cd /tmp && echo alpha beta` を止めており、&& で連結した
# 各コマンドが個別に判定されていた。実行環境の版によって変わり得る挙動であり、この
# フックは連結も捕捉するが、permissions で足りない理由としては上の 2 点だけを挙げる。
#
# ── 検査対象 ──────────────────────────────────────────────────────────────────
#
#   1. gh pr merge          — コマンド位置にあるもの
#   2. pulls/<n>/merge      — かつ PUT を指定しているもの（REST 経由の merge 実行）
#   3. mergePullRequest     — かつ gh api graphql から呼ばれているもの
#
# いずれも「文字列に含まれるか」ではなく「実行しようとしているか」で判定する。単純な
# 部分一致にすると `grep -rn 'mergePullRequest' .` や `git log -S 'gh pr merge'`、GET での
# `pulls/1/merge`（マージ済みか調べるだけ）まで確認を要求する。確認が頻発すれば内容を
# 読まずに承認する習慣ができ、機構は形だけになる。
#
# ── コマンド位置の判定: クォート認識の解析 1 つに集約する ─────────────────────
#
# 「コマンド位置か」は command_position_has（下で定義）だけで判定する。クォート
# を認識しながら文字単位で区切り文字を走査し（for_each_clause）、単純コマンド
# ごとの語のリストを組み立てて、期待する語列と完全一致するかを見る。
#
# かつては、同じ問いをもう 1 つの独立した経路（制御語などを前置きとして列挙した
# 正規表現。クォートを認識しない grep）でも判定し、どちらか一致すれば ask にする
# 二重化を採っていた。役割としては、列挙が実測した迂回を確実に塞ぐ下限の保証、
# 解析が未知の書き方（グループコマンドの入れ子など）に届く担当という住み分け
# だったが、OR で結ぶ限り、クォートを見ない側だけが起こす誤検知は構造として
# 避けられなかった。`'if' gh pr merge 1`（予約語ではなく if という名前のコマンド
# を実行する入力）を予約語 if の直後と誤認し、`echo "x; gh pr merge 1"`（二重
# 引用符の中の ;）を区切り文字と誤認して、どちらも確認を求めていた（実測）。
# 走査を 1 つにし、この種の食い違いを構造として作れないようにした。
#
# 列挙（if / elif / while / until / then / do / else / 否定の !）自体は消して
# いない。for_each_clause の中の _cmd_start_idx（下で定義）が唯一の置き場所に
# なった。節の語のリストを先頭から見て、環境変数代入（FOO=bar）とこれらの制御語
# の繰り返しを読み飛ばし、そこから先を「実コマンドの語」として扱う。**この 2 つは
# クォートの扱いが違うため、判定条件も分けている。** 予約語として読み飛ばすのは、
# その語がクォートもバックスラッシュエスケープも含まないときだけにしている。
# `'if'` や `"if"`、`i\f` のように一部でも引用・エスケープされた語は、bash の
# 文法上そもそも予約語として認識されず、実際に起動されるコマンド名の一部
# （＝実コマンドの語そのもの）になるため、ここで読み飛ばしてはならない（実測）。
# 環境変数代入として読み飛ばすのは逆に、`name=` の部分に引用符を挟んでいない
# ときだけで、値側の引用符は問わない。`VAR="foo" gh pr merge 1` や
# `KEY='bar' gh pr merge 1` は値側だけがクォートされた代入で、実際に `gh` が
# コマンド位置に来る（実測: `env` で代入として効くことを確認）。予約語と同じ
# 「語にクォートが 1 文字でもあれば読み飛ばさない」を代入にも適用すると、この
# 2 例を取りこぼして素通りしてしまう（実測。解析を `grep` の列挙へ一本化した
# ときに、クォートを見ない `grep` 側のフォールバックが無くなったことで露見した
# 退行）。詳細と判定条件は _cmd_start_idx のコメントを参照。
#
# 列挙を解析の外に出さなかった代わりに、実測で踏んだ形（if / elif / while /
# until / then / do / else / ! それぞれの直後）が確実に ask になることは、
# 実装の構造にではなくテスト（tests/test-confirm-merge-hook.sh）で固定する。
# 解析は bash の文法を全部実装したものではなく部分実装であり、取りこぼしうる
# （範囲は下のコメントに明記する）。「解析が拾うはずだから列挙のテストは要らない」
# とはしない。
#
# 先行する環境変数代入はどちらの語（制御語・実コマンド）の前でも読み飛ばす。
# 前方一致にしないのは cd との連結を捕捉するためで、逆に引用符の内側は通る。
#
# JSON から command を取り出せなかった場合（ペイロード全体を検査対象にしている
# とき）は command_position_has を使わない。ペイロード全体はシェルの行ではなく
# JSON テキストであり、位置を解析する土台が無いためである。この場合は位置を
# 問わない語の並び照合へ落とす（cmd_pos_ask、下で定義）。
#
# `{`（グループコマンド）は、その節で「環境変数代入と制御語だけ」を前置きとして
# 許した上で、まだ実コマンドの語を 1 つも集めていないときだけ、グループコマンド
# の開始として読み飛ばす（_clause_prefix_is_reserved_only、下で定義）。かつては
# 「節でまだ語を 1 つも集めていない」を唯一の条件にしていたため、`if { gh pr
# merge 1; }; then :; fi` のように制御語を 1 つ前置くだけで `{` が語として残り、
# 解析が gh pr merge へ到達できずに素通りしていた（実測）。正規表現には「その
# 位置が本当にコマンド位置か」を判定する手段が無く、`{` を素朴に境界へ加えると
# `echo hi { gh pr merge 1`（`{` 以降も echo の引数でしかなく、実際には実行され
# ない）のような無害な文字列まで拾ってしまうため、列挙（cmd_pos_ask の grep 側）
# には `{` を加えていない（実測）。解析は「この節の語が制御語・代入だけで説明
# できるか」を判定できるため、真にコマンド位置にある `{` だけを区別できる。
#
# `case` / `esac` / `fi` / `done` / `}` は予約語としては扱っていない。これらは
# 必ず直後に区切り文字（; か改行）を要求する構文であり（実測: `fi echo hi` や
# `done echo hi` は構文エラーで実行されない）、既存の区切り文字判定がそのまま
# 効くため、独立した対応は要らない。`in`（for / case で使う語）も加えていない。
# `for x in gh pr merge 1; do ...; done` の `gh pr merge 1` は for のワードリスト
# （x が順に取る値）であって実行されるコマンドではなく、この節の先頭の語は
# `for` のままなので gh pr merge との一致は生じない（実測）。
#
# ── fail-open にしない ───────────────────────────────────────────────────────
#
# jq でコマンドを取り出せなかった場合は、ペイロード全体を検査対象にする。「取れなければ
# 通す」にすると、jq が無い環境・壊れた JSON・将来のペイロード変更のいずれでも検査を黙って
# 飛ばして通す。検知層が黙って無効化されるのは最悪の壊れ方で、このフックが防ごうとして
# いる「気づかないまま実行できる」状態そのものを再現する。出力側も同じ理由で jq に
# 依存させない（printf のフォールバックを持つ）。
#
# ── この解析は bash の字句解析の部分的な再実装である ──────────────────────────
#
# for_each_clause 以下の解析は、bash の字句解析（トークナイザ）を部分的に
# 再現したものであり、bash の文法を全部実装したものではない（範囲は
# for_each_clause のコメントに明記している）。ここまでに、少なくとも次の
# 境界事例が、いずれも実際にこの解析へ入力してから見つかっている。
#
#   - コマンド位置の判定を「列挙（クォートを認識しない正規表現）」と「解析
#     （クォート認識）」の二重化にしていたことに起因する誤検知
#     （`'if' gh pr merge 1` / `echo "x; gh pr merge 1"`）
#   - 環境変数代入の判定に、予約語と同じ「語にクォートが 1 文字でもあれば
#     読み飛ばさない」を適用していたことによる迂回
#     （`VAR="foo" gh pr merge 1` のように値側だけをクォートした代入）
#   - 空クォート（`''` / `""`）の中身が空であるために「語が始まった」ことを
#     記録し損ね、直後の語の切り出し範囲が直前の区切り文字まで巻き込まれた
#     ことによる迂回・誤検知
#     （`echo '' ; FOO=bar gh pr merge 1` / `'' gh pr merge 1`）
#
# いずれも「新しく入れた処理が別の経路で穴を作っていないか」という観点の
# 変異テストを実際にかけて初めて見つかっている。この経緯が示すのは、
# bash の字句規則を部分的に再実装する以上、境界事例は今後も見つかりうる
# ということである。**「境界事例を網羅した」とは書かない。** 見つかった
# 形はそのつど実測し、塞いで、テスト（tests/test-confirm-merge-hook.sh）
# へ固定する、という「踏んだら足す」運用を前提にしている。
#
# ── 既知の限界（意図的に塞がない）────────────────────────────────────────────
#
# これは「うっかり実行」に確認を挟む guardrail であって、意図的な迂回を防ぐ
# security boundary ではない。文字列照合である以上、書き方を変えれば抜けられる。
#
#   gh -R owner/repo pr merge 1      gh とサブコマンドの間にオプションが挟まる形
#   /usr/bin/gh pr merge 1           絶対パス・相対パスでの起動
#   env gh pr merge 1                env / command などのプレフィックス
#   bash -c "gh pr merge 1"          引用符の内側（引用符の内側を通すことの裏返し）
#   gh api .../pulls/$N/merge        URL に変数展開を含む形
#   gh api graphql -F query=@q.gql   クエリを外部ファイルから読む形
#
# なお -XPUT（連結形）・--method=PUT（= 連結）・--method put（小文字）は、上の一覧とは
# 違って意図的な迂回ではなく curl 風のごく普通の綴りである（実測: いずれも gh が受理する）。
# 「うっかり実行」の側にあたるため、下の判定はこれらも拾う。
#
# ペイロードが空（stdin が空）の場合は確認を求める（ask）。マージコマンドを検知した
# のではなく、検査そのものが成立しなかったことを理由文で伝える。将来ペイロードの
# 渡し方が変わって stdin へ何も来なくなったときにここで気づけるようにするための措置
# であって、配線が生きていることそのものを保証するものではない。配線が生きている
# ことは、フックへ実際にペイロードを流して確かめる以外に保証できない。
#
# 塞ぐたびに新しい書き方が見つかるため、完全性は達成できない。完全であるかのように
# 記録すると、実態より強い保証があると誤認させる（12 章）。
#
# main への直接 push は扱わない。ブランチ保護がサーバ側で拒否しており、そちらのほうが
# 確実なため。ブランチ名に main を含む feature ブランチへの push を誤って止める副作用も
# 避けられる。
#
# 副作用: マージコマンドに見える文字列を行頭に含むコミットメッセージやテストは、そのまま
# では実行できず確認を求められる。ファイル経由（git commit -F、テストスクリプト）で
# 回避できる。
#
# ── squash 本文の CI 抑止の綴り ──────────────────────────────────────────────
#
# gh pr merge をコマンド位置で検知したときは、承認の判断材料を増やすため、squash
# マージの本文になるテキストに CI を飛ばす綴りが無いかも見て、見つかれば理由へ
# 添える（deny にはしない。上の「保証するのは黙ってマージしないことであって
# マージさせないことではない」と同じ位置づけ）。ある事例では、この綴りは指示
# として書かれたのではなく「この検査がコミットメッセージしか見ていないこと」を
# 説明する文章の中にあった。GitHub は見出しでなく本文のどこにあっても従うため、
# 検知は行の先頭や見出しの形には絞らない。
#
# squash 本文の組み立て方（PR の説明文だけを使うか、各コミットのメッセージを
# 連ねるか）はリポジトリの設定（squash_merge_commit_message）による。配布物
# なので特定の設定を前提にせず、設定を読んで検査対象を切り替えることもしない
# （判定を 2 経路に分けるほど、どちらかの経路だけが古くなる余地が増える）。
# 代わりに、設定によらず両方（PR 本文と全コミットメッセージ）を常に見る。
#
# --body / --subject に明示された文字列も見る（実測で判明した漏れ）。これらは
# 最終的な squash 本文を CLI 側で直接差し替えるものであり、リモートの PR 本文が
# 綺麗でも、渡された文面に綴りがあれば CI は飛ぶ。しかも squash 前の人手の手順
# （land スキル）は「該当行が出たら、その指示を除いた本文をファイルに書き、
# --body-file で差し替えてマージする」という回復手順を持つ。--body 系を検査
# しないと、この回復手順そのものがこの検査をすり抜ける経路になる。--body /
# --subject の値はコマンド文字列から直接取り出して判定でき、gh を待たずに
# 済む。リモート側（PR 本文・コミットメッセージ）も打ち切らずに別途見るのは、
# --body 等が実際にどこまで上書きするかを完全には前提にしないためで、見た
# 結果は「found（後述の優先順位で上書きされない）」側にしか働かない。
#
# --body-file の中身は読まない。このフックはコマンドの実行前に走るため、同じ
# コマンド内で（例: echo ... > file && gh pr merge ... --body-file file）これ
# から書かれるファイルを正しく読める保証が無く、cwd の想定もフック側とコマンド
# 側で揃うとは限らない。**読まないと決めた以上、その対象は「綴りが無い」とは
# 扱わない**（読めなかったことを合格にしない、という下の方針と同じ）。--body-file
# を検出したら、その対象は unavailable として扱う（他の情報源で found が確定
# すれば found が優先される。優先順位は下記）。
#
# 1 つのコマンド文字列に gh pr merge が複数回現れる場合（例:
# gh pr merge 1 && gh pr merge 2）、全対象を集約して見る。片方だけを見て
# 判定を確定させると、承認 1 回で残りの対象が未検査のまま実行されてしまう
# （実測で判明した漏れ）。
#
# 複数の対象・複数の情報源（--body / --subject / リモートの本文・コミット）を
# 見た結果は、found（綴りあり） > unavailable（確認できていない） > clean
# （綴りなし）の優先順位で 1 つに集約する。found が 1 件でもあれば、他の対象
# や情報源の結果に関わらず found を報告する。found が無く、unavailable が
# 1 件でもあれば、他が clean であっても全体を clean とはしない。
#
# 判定できなかったとき（gh コマンドが無い・PR 情報を取得できない・コマンド
# 文字列を取り出せていない・--body-file の中身を読んでいない、など）は
# 「綴りが無い」とは扱わない。確認できていないことをそのまま理由文へ書く。
# 読めなかったことを合格にはしない、という上の「fail-open にしない」と同じ
# 方針をこの検査にも適用する。
#
# 綴りの一覧は、このフックだけの独自の一覧を持たず、squash 前に人手でも同じ
# 判定を行う手順（land スキルの対応する手順）と同じものを使う。一覧を 2 か所に
# 複製すると、見つかった綴りを片方にだけ足して他方が古くなる余地ができる。
# 一致は配布物側のテスト（tests/test-confirm-merge-hook.sh）で検査し、複製の
# 食い違いを機械的に検知できるようにしている。
#
# gh pr merge 以外（REST の PUT / gh api graphql の mergePullRequest）には、この
# 検査を広げていない。REST 経由の URL は変数展開を含む形が普通にあり（上の
# 「既知の限界」参照）、PR 番号やリポジトリをそこから安全に取り出せる保証が
# 無い。誤って別の PR の本文を見にいく（見当違いの結果を確信を持って返す）ほう
# が、確認しないより悪いと判断した。これらの経路でも既存の ask 自体は変わらず
# 働く。
#
# この追加検査も security boundary ではない。squash 本文に実際に何が入るかは
# GitHub 側の設定と挙動に依存し、ここでの判定は近似でしかない。
#
# 終了コード: 常に 0。判定は標準出力の JSON（permissionDecision）で伝える。
set -uo pipefail

# ── 節ごとの走査（クォート認識を 1 箇所に集約する）─────────────────────────────
#
# 「gh pr merge がコマンド位置にあるか」（語の完全一致）と「PUT と merge
# エンドポイントが同じコマンド節にあるか」（正規表現一致）は、判定の中身は
# 違っても「クォートを認識しながら ; & | ( ) と改行でコマンド節へ分ける」という
# 走査そのものは同じであるべきだった。かつては両者を別々に実装しており、片方
# （REST 判定側）だけがクォートを見ずに ; & | を機械的に改行へ立て替えていた。
# その結果、クォートの中身や URL のクエリ文字列に現れる ; & | まで区切りとして
# 扱ってしまい、同一コマンドを別々の節へ割ってしまっていた（実測:
# `gh api 'repos/o/r/pulls/1/merge?commit_title=foo&commit_message=bar' -X PUT`、
# `gh api repos/o/r/pulls/1/merge -f commit_message="fix bug & test" -X PUT`、
# `gh api -X PUT -f message="fix; test" repos/o/r/pulls/1/merge` のいずれも、
# PUT とエンドポイントが別の節へ分断されて素通りしていた）。誤検知を直すために
# 入れた処理が新しい迂回を作っていた形で、この票が塞ごうとしているものと同じ
# 種類の欠陥である。
#
# 対策として、走査そのものを 1 つの関数（for_each_clause）へ集約する。節が
# 確定するたびに、その節の語のリスト（clause_words。クォートは剥がれる）と、
# 元のテキストそのもの（clause_text。クォートは残したまま）の両方を用意して
# から、呼び出し側が渡したハンドラ関数を呼ぶ。語の完全一致判定（コマンド位置か）
# と正規表現判定（PUT / merge エンドポイントか）は、このハンドラの中身が違う
# だけで、節を切り出す走査そのものは 1 つしかない。「片方だけクォートを見て、
# もう片方が見ていない」という食い違いを、構造として作れないようにする。
#
# 解析する範囲: ; & && | || ( ) と改行を区切りとして扱う。単一引用符・二重引用符
# の中身（二重引用符内のバックスラッシュエスケープを含む）、引用符の外の
# バックスラッシュエスケープは区切りとして扱わない。空白を伴う { は、その節の
# 語が「環境変数代入と制御語だけ」で説明できる間（＝真にコマンド位置にある間）
# だけ、その場の語・節テキストへ加えずに読み飛ばす（グループコマンド
# `{ gh pr merge 1; }` の開始を、制御語や代入だけを前置いた真のコマンド位置に
# あるときも含めてコマンド位置として扱うため。詳細は上のヘッダを参照）。
#
# 語ごとに「クォート・バックスラッシュエスケープを 1 文字でも含むか」も
# clause_word_quoted（clause_words と対になる配列）へ、「元テキストそのもの
# （クォートを残したまま）」も clause_word_raw へ記録する。予約語としての判定
# （_cmd_start_idx、下で定義）は、clause_word_quoted が立っていない語（＝完全に
# 素の語）に対してだけ行う。`'if'` のように一部でもクォートされた語は bash 上
# そもそも予約語ではなく実コマンド名になるため、ここで区別できないと予約語だけ
# を読み飛ばす判定が誤検知を起こす（実測）。環境変数代入としての判定は逆に
# clause_word_quoted を見ず、clause_word_raw に対して直接正規表現を当てる。
# `VAR="foo"` のように値側だけがクォートされていても代入として有効なままの
# ため、語全体のクォート有無では代入かどうかを見分けられない（詳細は
# _cmd_start_idx のコメントを参照）。
#
# 解析しない範囲（意図的に見ない。bash の文法を完全に実装すると雛形として
# 重くなりすぎるため、範囲を絞っている。ここでの取りこぼしは、実測した形に
# 限ってはテスト側で固定し、それ以外は取りこぼしうる）:
#   - 変数展開・コマンド置換・算術展開（$(...) `...` $((...))）の中身。展開の
#     結果によってコマンドが変わる形までは追わない
#   - here-document（<<, <<-, <<<）の本体。区切り文字と同じ規則で割ってしまう
#     （本体に ; や改行があれば、そこで単純コマンドが終わったと誤認する）
#   - サブシェルの深さ。( と ) は対応を数えず常に境界として扱う
#   - for / case / function などの構文そのもの（予約語としては扱わない）。ただし
#     for ... ; do や case ... ) は、; や ) が境界になる副作用で結果的に多くの形を
#     拾える
#
# 引数: $1 = 節ごとに呼び出すハンドラ関数名、$2 = 検査対象テキスト。
# ハンドラは clause_words（配列。クォートは剥がれる）・clause_word_quoted（配列。
# 各語がクォート・バックスラッシュエスケープを 1 文字でも含んでいたか）・
# clause_word_raw（配列。各語の元テキストそのもの。クォートは残したまま）・
# clause_text（節全体の元テキスト。クォートは残したまま）を読める。
#
# clause_word_raw を別に持つ理由: 環境変数代入（FOO=bar）の判定は、bash の
# 実際の挙動に合わせて「name= の部分が引用符を 1 文字も挟まずに書かれている
# か」で見る必要がある（実測: `VAR="foo" env` は代入として効くが、`"VAR"=foo env`
# は代入にならず `VAR=foo` という名前のコマンドを探しにいく）。value 側は引用符
# で囲んでも代入として有効なままなので、clause_word_quoted（語全体にクォートが
# 1 文字でもあるか）だけでは name= 部分だけを見分けられない。clause_word_raw
# （引用符を残した元テキスト）に対して `^[A-Za-z_][A-Za-z0-9_]*=` を当てれば、
# name 部分に引用符が挟まっている場合は正規表現がそこで止まって一致せず、
# value 側だけが引用符で囲まれている場合は = より前で一致が確定するため、
# 追加の状態管理なしで両方を正しく判定できる。
for_each_clause() {
  local handler="$1" text="$2"
  local i n c
  local word="" have_word=0 word_quoted=0 word_start=-1
  local in_squote=0 in_dquote=0

  clause_words=()
  clause_word_quoted=()
  clause_word_raw=()
  clause_text=""
  n=${#text}

  for ((i = 0; i < n; i++)); do
    c="${text:i:1}"

    if [[ $in_squote -eq 1 ]]; then
      clause_text+="$c"
      if [[ "$c" == "'" ]]; then
        in_squote=0
      else
        word+="$c"
        have_word=1
        word_quoted=1
      fi
      continue
    fi
    if [[ $in_dquote -eq 1 ]]; then
      if [[ "$c" == '"' ]]; then
        in_dquote=0
        clause_text+="$c"
      elif [[ "$c" == $'\\' ]]; then
        clause_text+="$c"
        i=$((i + 1))
        if [[ $i -lt $n ]]; then
          clause_text+="${text:i:1}"
          word+="${text:i:1}"
          have_word=1
          word_quoted=1
        fi
      else
        clause_text+="$c"
        word+="$c"
        have_word=1
        word_quoted=1
      fi
      continue
    fi

    case "$c" in
      "'")
        # クォートが開いた時点で「語が始まった」ことを記録する。空クォート
        # （'' / ""）は中身の文字を 1 つも追加しないため、内容が付くときにだけ
        # have_word を立てる実装だと、空クォートだけの語はいつまでも
        # have_word=0 のまま扱われる（実測）。その結果、空白や区切り文字に
        # 達しても「語を確定させて word_start をリセットする」処理
        # （下の空白・区切り文字の分岐、いずれも have_word -eq 1 を条件にする）
        # が走らず、word_start が空クォートの開始位置に残り続ける。次の語の
        # 先頭でも word_start が -1 に戻っていないため上書きされず、
        # clause_word_raw の切り出しに直前の空クォートや区切り文字まで
        # 巻き込んでしまい、環境変数代入の判定（^[A-Za-z_][A-Za-z0-9_]*=）が
        # raw の先頭に来るはずの文字の前へ無関係な文字が挟まって外れる
        # （実測: `echo '' ; FOO=bar gh pr merge 1` が素通りしていた）。逆に
        # `'' gh pr merge 1` では、空クォートが語として clause_words に入らない
        # ため gh が誤って先頭語として扱われ、逆方向の誤検知も起きていた
        # （実測）。クォートが開いた瞬間に have_word と word_quoted を立てる
        # ことで、中身が空でも「クォートで作った語」を 1 つの語として確定
        # できるようにする。
        [[ $word_start -eq -1 ]] && word_start=$i
        have_word=1
        word_quoted=1
        in_squote=1
        clause_text+="$c"
        ;;
      '"')
        [[ $word_start -eq -1 ]] && word_start=$i
        have_word=1
        word_quoted=1
        in_dquote=1
        clause_text+="$c"
        ;;
      $'\\')
        [[ $word_start -eq -1 ]] && word_start=$i
        clause_text+="$c"
        i=$((i + 1))
        if [[ $i -lt $n ]]; then
          clause_text+="${text:i:1}"
          word+="${text:i:1}"
          have_word=1
          word_quoted=1
        fi
        ;;
      ' ' | $'\t')
        clause_text+="$c"
        if [[ $have_word -eq 1 ]]; then
          clause_words+=("$word")
          clause_word_quoted+=("$word_quoted")
          clause_word_raw+=("${text:word_start:i-word_start}")
          word=""
          have_word=0
          word_quoted=0
          word_start=-1
        fi
        ;;
      '{')
        # グループコマンドの開始として読み飛ばすのは、(1) まだ語の途中でなく、
        # (2) この節でここまでに集めた語が環境変数代入・制御語だけで説明でき
        # （＝実コマンドの語をまだ 1 つも集めていない。_clause_prefix_is_reserved_only、
        # 下で定義）、(3) 直後が空白であるときだけ。それ以外（他のコマンドの
        # 引数の途中など）は素通しの文字として扱う。(2) を「節の語が空か」だけに
        # すると、`if { gh pr merge 1; }; then :; fi` のように制御語を 1 つ
        # 前置くだけで { が語として残り、解析が gh pr merge へ届かなくなる
        # （実測）。逆に無条件で許すと `echo hi { gh pr merge 1`（{ 以降も echo
        # の引数でしかなく実際には実行されない）のような無害な文字列まで拾って
        # しまう（実測）。
        if [[ $have_word -eq 0 ]] && _clause_prefix_is_reserved_only \
          && { [[ "${text:$((i + 1)):1}" == ' ' ]] \
            || [[ "${text:$((i + 1)):1}" == $'\t' ]] \
            || [[ "${text:$((i + 1)):1}" == $'\n' ]]; }; then
          :
        else
          [[ $word_start -eq -1 ]] && word_start=$i
          clause_text+="$c"
          word+="$c"
          have_word=1
        fi
        ;;
      $'\n' | ';' | '&' | '|' | '(' | ')')
        if [[ $have_word -eq 1 ]]; then
          clause_words+=("$word")
          clause_word_quoted+=("$word_quoted")
          clause_word_raw+=("${text:word_start:i-word_start}")
          word=""
          have_word=0
          word_quoted=0
          word_start=-1
        fi
        if [[ -n "$clause_text" || ${#clause_words[@]} -gt 0 ]]; then
          "$handler"
        fi
        clause_words=()
        clause_word_quoted=()
        clause_word_raw=()
        clause_text=""
        # && / || の 2 文字目は読み飛ばす（境界としては 1 回でよい）。
        if { [[ "$c" == '&' ]] || [[ "$c" == '|' ]]; } \
          && [[ "${text:$((i + 1)):1}" == "$c" ]]; then
          i=$((i + 1))
        fi
        ;;
      *)
        [[ $word_start -eq -1 ]] && word_start=$i
        clause_text+="$c"
        word+="$c"
        have_word=1
        ;;
    esac
  done

  if [[ $have_word -eq 1 ]]; then
    clause_words+=("$word")
    clause_word_quoted+=("$word_quoted")
    clause_word_raw+=("${text:word_start:n-word_start}")
  fi
  if [[ -n "$clause_text" || ${#clause_words[@]} -gt 0 ]]; then
    "$handler"
  fi
  clause_words=()
  clause_word_quoted=()
  clause_word_raw=()
  clause_text=""
}

# clause_words / clause_word_quoted / clause_word_raw（グローバル。for_each_clause
# が用意する）を先頭から見て、環境変数代入（FOO=bar）とシェルの制御語（if /
# elif / while / until / then / do / else / 否定の !）の繰り返しを読み飛ばした
# 次のインデックスを _cmd_start_idx_result へ設定する。
#
# 環境変数代入と予約語（制御語・否定）は、クォートの扱いが違うため判定条件も
# 分けている（実測。以下はいずれも `env` で確認した実際の bash の挙動）。
#
#   - 環境変数代入: name= の部分に引用符が 1 文字も挟まっていないことだけを
#     求める。値側の引用符は問わない。`VAR="foo" env` / `KEY='bar' env` は
#     どちらも代入として有効に効く。判定は clause_word_raw（引用符を残した
#     元テキスト）に対して `^[A-Za-z_][A-Za-z0-9_]*=` を当てる。value 側が
#     引用符で囲まれていても = より前で一致が確定するため代入として読み飛ばす
#     一方、`"VAR"=foo env` のように name 側に引用符が挟まっていると `"` の
#     時点で正規表現が止まり一致しないため、代入として読み飛ばさない
#     （これは実際に `"VAR"=foo` という名前のコマンドを探しにいく入力であり、
#     env は実行されない）。
#   - 予約語（制御語・否定 !）: 語がクォート・バックスラッシュエスケープを
#     1 文字も含まない（clause_word_quoted が 0 の）ときだけ読み飛ばす。
#     `'if'` や `"if"`、`i\f` のように一部でも引用・エスケープされた語は、
#     bash の文法上そもそも予約語として認識されず、実際に起動されるコマンド
#     名の一部（＝実コマンドの語そのもの）になるため、ここで読み飛ばしては
#     ならない。
#
# command_position_has（下）と for_each_clause の `{` 判定
# （_clause_prefix_is_reserved_only、下）の両方がこの関数だけを参照しており、
# 列挙（制御語の一覧）の置き場所はここ 1 か所にまとめている。
_cmd_start_idx() {
  local idx=0 w
  while [[ $idx -lt ${#clause_words[@]} ]]; do
    if [[ "${clause_word_raw[$idx]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      idx=$((idx + 1))
      continue
    fi
    if [[ "${clause_word_quoted[$idx]:-0}" -eq 0 ]]; then
      w="${clause_words[$idx]}"
      case "$w" in
        if | elif | while | until | then | do | else | '!')
          idx=$((idx + 1))
          continue
          ;;
      esac
    fi
    break
  done
  _cmd_start_idx_result=$idx
}

# for_each_clause の `{` 判定用。ここまでに集めた clause_words が「環境変数代入と
# 制御語だけ」で説明できる（＝実コマンドの語がまだ 1 つも無い）ときに真を返す。
# clause_words が空（まだ何も集めていない）ときも、_cmd_start_idx_result が 0 で
# 長さも 0 になるため真になる。
_clause_prefix_is_reserved_only() {
  _cmd_start_idx
  [[ $_cmd_start_idx_result -eq ${#clause_words[@]} ]]
}

# for_each_clause のハンドラ。呼び出し側が cph_expect（配列）を用意してから
# command_position_has を呼ぶ。節の語のリスト（clause_words）が、_cmd_start_idx
# の読み飛ばし（環境変数代入・制御語の繰り返し。読み飛ばす条件は語の種類ごとに
# 違う。詳細は _cmd_start_idx のコメントを参照）の直後に、cph_expect と
# 完全一致すれば cph_found を立てる。
# shellcheck disable=SC2329  # for_each_clause から "$handler" 経由で間接的に呼ばれる
_cph_clause_handler() {
  _cmd_start_idx
  local idx=$_cmd_start_idx_result
  local j=0 ok=1
  while [[ $j -lt ${#cph_expect[@]} ]]; do
    if [[ "${clause_words[$((idx + j))]:-}" != "${cph_expect[$j]}" ]]; then
      ok=0
      break
    fi
    j=$((j + 1))
  done
  [[ $ok -eq 1 && ${#cph_expect[@]} -gt 0 ]] && cph_found=1
}

# 引数: 検査対象テキスト、続けて期待する語（可変長。例: gh pr merge）。
# 戻り値: 0 = 一致する単純コマンドがある、1 = 無い。
# コマンド位置の判定はこの関数（と for_each_clause / _cmd_start_idx）に集約して
# いる。上のヘッダ「コマンド位置の判定」を参照。
command_position_has() {
  local text="$1"
  shift
  cph_expect=("$@")
  cph_found=0
  for_each_clause _cph_clause_handler "$text"
  [[ $cph_found -eq 1 ]]
}

# コマンド位置に期待する語列があるかを判定する。extracted=="yes"（Bash ツールの
# tool_input.command を取り出せた）ときは command_position_has だけで判定する。
# extracted=="no"（JSON からの取り出しに失敗し、ペイロード全体を検査対象にして
# いる）ときは、そもそも「シェルの行」ではなく JSON テキストであり位置を解析する
# 土台が無いため、位置を問わない語の並び照合（grep）へ落とし、確認を増やす側へ
# 振る（fail-open にしない）。
#
# 引数: $1 = 検査対象テキスト、$2 = extracted（yes/no）、$3 = 語末境界の正規表現
# （呼び出し側の word_end）、続けて期待する語（可変長。例: gh pr merge）。
cmd_pos_ask() {
  local text="$1" ex="$2" wend="$3"
  shift 3
  if [[ "$ex" == "yes" ]]; then
    command_position_has "$text" "$@"
    return $?
  fi
  local re="" w
  for w in "$@"; do
    if [[ -n "$re" ]]; then
      re="${re}[[:space:]]+"
    fi
    re="${re}${w}"
  done
  grep -qE "${re}${wend}" <<<"$text"
}

# for_each_clause のハンドラ。節のテキスト（clause_text。クォートは残ったまま）
# が、merge エンドポイントと PUT 指定の両方を含めば rest_found を立てる。呼び出し
# 側が事前に put_re を用意しておく。REST 判定（PUT の指定と merge エンドポイントが
# 同じコマンド節にあるか）に使う。
# shellcheck disable=SC2329  # for_each_clause から "$handler" 経由で間接的に呼ばれる
_rest_clause_handler() {
  if [[ "$clause_text" =~ pulls/[0-9]+/merge ]] && [[ "$clause_text" =~ $put_re ]]; then
    rest_found=1
  fi
}

# for_each_clause のハンドラ。節が「gh pr merge」をコマンド位置に持つ場合、その
# 直後に続く語から、対象 1 件ぶんの情報（PR セレクタ・--repo・--body・
# --subject・--body-file の有無）を取り出し、mth_targets_*（配列。呼び出し側が
# 用意する）の末尾（mth_count）へ積む。1 つのコマンド文字列に gh pr merge が
# 複数回現れれば、この関数もその回数だけ呼ばれ、対象が積み上がる（同じコマンド
# の承認 1 回で複数 PR がマージされうるため、全対象を見る必要がある。実測で
# 判明した漏れ）。
#
# --repo=value・--repo value・-R value、--body=value・--body value、
# --subject=value・--subject value を認識する。--body-file はどちらの形
# （--body-file=path・--body-file path）でも中身は読まず、有無だけを記録する
# （理由はヘッダ「squash 本文の CI 抑止の綴り」を参照）。それ以外の語でハイフン
# 始まりのものは値を取るかどうかを個別には追わず、素通りする
# （--match-head-commit の値などを誤って PR セレクタと取り違える余地が残る）。
# 取り違えた場合、その語は実在しない PR セレクタとして gh へ渡ることになり、
# _check_one_merge_target（下で定義）側の gh 呼び出しが失敗して「確認できて
# いない」側へ倒れる。セレクタの取り違えが「綴りが無い」という誤った判定には
# つながらない設計であるため、ここでは簡便な抽出にとどめている。
# shellcheck disable=SC2329  # for_each_clause から "$handler" 経由で間接的に呼ばれる
_gh_pr_merge_target_handler() {
  _cmd_start_idx
  local idx=$_cmd_start_idx_result
  if [[ "${clause_words[$idx]:-}" != gh ]] \
    || [[ "${clause_words[$((idx + 1))]:-}" != pr ]] \
    || [[ "${clause_words[$((idx + 2))]:-}" != merge ]]; then
    return
  fi
  local sel="" repo="" body="" subject="" hasfile=0
  local j=$((idx + 3)) w skip_next=0
  while [[ $j -lt ${#clause_words[@]} ]]; do
    w="${clause_words[$j]}"
    if [[ $skip_next -eq 1 ]]; then
      skip_next=0
      j=$((j + 1))
      continue
    fi
    case "$w" in
      --repo=*) repo="${w#--repo=}" ;;
      --repo | -R)
        repo="${clause_words[$((j + 1))]:-}"
        skip_next=1
        ;;
      --body=*) body="${w#--body=}" ;;
      --body)
        body="${clause_words[$((j + 1))]:-}"
        skip_next=1
        ;;
      --subject=*) subject="${w#--subject=}" ;;
      --subject)
        subject="${clause_words[$((j + 1))]:-}"
        skip_next=1
        ;;
      --body-file=*) hasfile=1 ;;
      --body-file)
        hasfile=1
        skip_next=1
        ;;
      -*) : ;;
      *)
        [[ -z "$sel" ]] && sel="$w"
        ;;
    esac
    j=$((j + 1))
  done
  mth_targets_selector[mth_count]="$sel"
  mth_targets_repo[mth_count]="$repo"
  mth_targets_body[mth_count]="$body"
  mth_targets_subject[mth_count]="$subject"
  mth_targets_hasfile[mth_count]="$hasfile"
  mth_count=$((mth_count + 1))
}

# 対象 1 件ぶん（PR セレクタ・リポジトリ・--body・--subject の文字列・
# --body-file の有無）について、squash 本文になるテキストに CI 抑止の綴りが
# 無いかを見る。_one_status（found / clean / unavailable）と _one_detail
# （unavailable のときの理由）を設定する。ネットワークに出る（gh 経由で PR
# 情報を取得する）唯一の箇所。
_check_one_merge_target() {
  local sel="$1" repo="$2" body="$3" subject="$4" hasfile="$5"
  _one_status=clean
  _one_detail=""

  # --body-file の中身は読まない（理由はヘッダ参照）。読まないと決めた以上、
  # 確認できていないという扱いにする。found で上書きされうる（下）。
  if [[ "$hasfile" -eq 1 ]]; then
    _one_status=unavailable
    _one_detail='--body-file の中身は確認していない'
  fi

  # --body / --subject に明示された文字列は、gh を待たずにその場で判定できる。
  local inline="${body}"$'\n'"${subject}"
  if grep -n -i -E "$SQUASH_CI_SKIP_RE" <<<"$inline" >/dev/null; then
    _one_status=found
    return
  fi

  if ! command -v gh >/dev/null 2>&1; then
    [[ "$_one_status" == clean ]] && { _one_status=unavailable; _one_detail='gh コマンドが無い'; }
    return
  fi

  local gh_args=(pr view)
  [[ -n "$sel" ]] && gh_args+=("$sel")
  [[ -n "$repo" ]] && gh_args+=(--repo "$repo")
  gh_args+=(--json "body,commits" --jq '.body, (.commits[] | .messageHeadline, .messageBody)')

  local body_text gh_rc
  body_text="$(gh "${gh_args[@]}" 2>/dev/null)"
  gh_rc=$?
  if [[ $gh_rc -ne 0 ]]; then
    [[ "$_one_status" == clean ]] && { _one_status=unavailable; _one_detail='PR 情報を取得できなかった'; }
    return
  fi

  # land スキルの対応する手順と同じ一覧を使う（ヘッダ参照）。行頭に絞らない
  # （skip-checks: true 行だけは元の手順どおり行頭を要求する）。GitHub は
  # 見出しでなく本文のどこにあっても従うため、位置は問わない。
  if grep -n -i -E "$SQUASH_CI_SKIP_RE" <<<"$body_text" >/dev/null; then
    _one_status=found
  fi
}

# gh pr merge がコマンド位置で見つかったときに呼ぶ。コマンド文字列に含まれる
# 全対象（_gh_pr_merge_target_handler が積んだもの）それぞれについて
# _check_one_merge_target で判定し、found > unavailable > clean の優先順位
# （ヘッダ参照）で 1 つに集約する。squash_ci_skip_status / squash_ci_skip_detail
# を設定する。
squash_ci_skip_check() {
  local text="$1"
  mth_count=0
  mth_targets_selector=()
  mth_targets_repo=()
  mth_targets_body=()
  mth_targets_subject=()
  mth_targets_hasfile=()
  for_each_clause _gh_pr_merge_target_handler "$text"

  squash_ci_skip_status=unavailable
  squash_ci_skip_detail=""

  if [[ "$mth_count" -eq 0 ]]; then
    squash_ci_skip_detail='マージ対象の PR を特定できなかった'
    return
  fi

  local overall=clean overall_detail="" i
  for ((i = 0; i < mth_count; i++)); do
    _check_one_merge_target \
      "${mth_targets_selector[$i]}" "${mth_targets_repo[$i]}" \
      "${mth_targets_body[$i]}" "${mth_targets_subject[$i]}" \
      "${mth_targets_hasfile[$i]}"

    if [[ "$_one_status" == found ]]; then
      overall=found
      overall_detail=""
      break
    fi
    if [[ "$_one_status" == unavailable ]] && [[ "$overall" != found ]]; then
      overall=unavailable
      overall_detail="$_one_detail"
    fi
  done

  squash_ci_skip_status="$overall"
  squash_ci_skip_detail="$overall_detail"
}

payload="$(cat)"

reason=""

if [[ -z "$payload" ]]; then
  # ペイロードが空＝配線不全の疑い。matcher で絞られた Bash ツール実行に対して
  # PreToolUse から何も渡っていないということは、フックが実行はされていても実質
  # 機能していない状態になり得る。jq 不在時に「取れなければ通す」を採らなかったのと
  # 同じ理由（検知層が黙って無効化されるのは最悪の壊れ方）で、ここも fail-open に
  # しない。ただしマージを検知したわけではないので、理由文はマージ云々ではなく
  # 「検査が成立しなかったこと」を伝える内容にする。
  reason='PreToolUse フックへ届いたペイロードが空でした。マージを検知したのではなく、検査そのものが成立していません。.claude/settings.json の PreToolUse 配線を確認してください。'
else
  # 検査対象の決定。Bash ツールのコマンド文字列を取り出せればそれを、取り出せなければ
  # ペイロード全体を対象にする（fail-open にしない）。全体を対象にすると確認が増える
  # 側へ振れるが、検査を飛ばす側へ振れるより安全である。
  target=""
  if command -v jq >/dev/null 2>&1; then
    target="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
  fi
  extracted=yes
  if [[ -z "$target" ]]; then
    extracted=no
    target="$payload"
  fi

  # バックスラッシュ行継続（\ + 改行）だけを空白へ正規化する。判定にのみ使い、
  # payload・target 自体や理由文は書き換えない。長い REST 呼び出しを \ で複数行に
  # 分けるのは普通の書き方で、-XPUT / --method=PUT と同じ「うっかり実行」側にあたる。
  # 分けて書くと pulls/<n>/merge と PUT が別行になり、REST 判定の同一節条件が外れて
  # 検知漏れになる（実測）。
  #
  # 改行を一律には潰さない。無関係な 2 行（例: echo の次行にたまたま別の gh api 呼び
  # 出しが続くだけの形）まで 1 行へ結合すると、同一節条件が意味を失い誤検知する。
  # 落とすのは直前にバックスラッシュがある改行だけにする。
  #
  # CRLF を先に処理する。LF だけを落とすと \ + CR が残り、CR が語末境界として働いて
  # 判定が外れる。CRLF がこのフックへ届く経路は実測できていないが、置換 1 行で
  # 恒久的に問いを消せるため入れておく。
  norm_target="${target//$'\\\r\n'/ }"
  norm_target="${norm_target//$'\\\n'/ }"

  # 語末の境界。空白か行末だけにすると、JSON の引用符（"gh pr merge"）に隣接した形を
  # 取りこぼす。逆に境界を置かないと gh pr mergequeue のような別サブコマンドまで拾う。
  word_end='([^A-Za-z0-9_-]|$)'

  # squash 本文に含まれていると CI を飛ばす綴り。land スキルの対応する手順と
  # 同じ一覧（ヘッダ「squash 本文の CI 抑止の綴り」参照）。ここだけの一覧を
  # 別に持たない。
  SQUASH_CI_SKIP_RE='\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks: *true'

  # パイプは使わずヒアストリングで渡す。grep -q は一致した時点で終了するため、上流を
  # パイプにすると SIGPIPE で pipefail が発火し、一致したのに条件が偽になる経路ができる。
  # cmd_pos_ask（上で定義）はこのヒアストリング渡しをそのまま踏襲する。
  #
  # コマンド位置の判定は cmd_pos_ask（extracted に応じて解析と位置を問わない
  # 照合を切り替える）に一本化している。上のヘッダ「コマンド位置の判定」を参照。
  if cmd_pos_ask "$norm_target" "$extracted" "$word_end" gh pr merge; then
    reason='gh pr merge をコマンド位置で実行しようとしています。既定の merge 方針は手動承認です。承認の記録を確認してください。'

    # squash 本文の検査（ヘッダ「squash 本文の CI 抑止の綴り」参照）。実際の
    # コマンド文字列を取り出せた（extracted=yes）ときだけ行う。ペイロード全体
    # （JSON テキスト）を対象にしているときは、シェルのコマンド節を解析する
    # 土台が無く、PR セレクタを安全に取り出せない。
    if [[ "$extracted" == yes ]]; then
      squash_ci_skip_check "$norm_target"
    else
      squash_ci_skip_status=unavailable
      squash_ci_skip_detail='コマンド文字列を取り出せていない'
    fi

    case "$squash_ci_skip_status" in
      found)
        reason="${reason} squash 本文になるテキスト（PR 本文・コミットメッセージ・--body 等の指定）に CI を飛ばす綴りが見つかりました。除いてよいか確認してからマージしてください。"
        ;;
      unavailable)
        reason="${reason} squash 本文の CI 抑止の綴りは確認できていません（${squash_ci_skip_detail}）。"
        ;;
      clean) : ;;
    esac
  else
    # REST 経由の merge。PUT の指定と merge エンドポイントが同じコマンド節にある
    # ことを条件にする。GET は「マージ済みか」を調べるだけで状態を変えないため
    # 対象にしない。
    #
    # --method PUT（空白区切り）に加え、--method=PUT（= 連結）・-XPUT（-X への直接連結）・
    # --method put（小文字）も拾う。value 側の大小混在は [Pp][Uu][Tt] で吸収する
    # （GET 側はそもそもこのパターンに現れないため波及しない）。
    #
    # PUT の直後には word_end を要求する。無いと -XPUTS のような無関係な綴りまで拾う。
    # --method の直後は区切り（= か空白）を要求する。無いと --methodology のような別
    # オプション名の内部にまで一致する。norm_target を見るので、\ 行継続で PUT が
    # 次行にずれていても同一節条件を満たす。
    #
    # 節の切り出しは for_each_clause（上で定義）に委ねる。「行」を単位にすると、
    # クォートの中や URL のクエリ文字列に現れる ; & | まで区切りとして扱ってしまい、
    # 同一コマンドを別の節へ割ってしまう（実測、詳細は for_each_clause のコメント）。
    put_re="(--method(=|[[:space:]]+)|-X[[:space:]]*)[Pp][Uu][Tt]${word_end}"
    rest_found=0
    for_each_clause _rest_clause_handler "$norm_target"

    if [[ "$rest_found" -eq 1 ]]; then
      reason='PR の merge エンドポイントへ PUT を実行しようとしています（REST 経由の merge）。既定の merge 方針は手動承認です。承認の記録を確認してください。'
    elif grep -qF 'mergePullRequest' <<<"$norm_target" \
      && cmd_pos_ask "$norm_target" "$extracted" "$word_end" gh api graphql; then
      # mergePullRequest の有無はクォートを問わない部分一致でよい（クエリは
      # ヒアドキュメントや複数行の -f query=... で渡されることがあり、行や節を
      # またいでよいテキストのため）。gh api graphql がコマンド位置にあるかは
      # cmd_pos_ask（コマンド位置の判定）に委ねる。
      reason='gh api graphql から mergePullRequest を実行しようとしています。既定の merge 方針は手動承認です。承認の記録を確認してください。'
    fi
  fi
fi

if [[ -z "$reason" ]]; then
  exit 0
fi

# 出力も jq に依存させない。理由文には二重引用符とバックスラッシュを含めないため、
# フォールバックの printf でも JSON として妥当な出力になる。
if command -v jq >/dev/null 2>&1; then
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $reason
    }
  }'
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$reason"
fi
exit 0
