#!/usr/bin/env bash
# ops-report-collect.sh — 月次の運営報告の材料を 1 つの JSON にまとめる（#936）
#
# 使い方（devcontainer の中で）:
#   bash scripts/ops-report-collect.sh 2026-09                 # 本番（読み取りのみ）の 2026-09 分
#   bash scripts/ops-report-collect.sh 2026-09 --local         # 手元の D1 で空回し（ビルド時間は集めない）
#   bash scripts/ops-report-collect.sh 2026-09 --local --persist-to <dir>
#   bash scripts/ops-report-collect.sh 2026-10 --allow-partial # 終わっていない月（試しに回すとき）
#
# 月は **JST の暦月**（1 日 0 時から翌月 1 日 0 時の手前まで）。日の境界は
# scripts/report-window.sh と同じ（JST の 0 時）。
#
# 出力: 標準出力へ JSON（1 つ）。経過と道具の出力は標準エラーへ。
# 終了コード: 0 = 出せた / 2 = 出せない（引数の誤り・必須の材料が読めない）
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を集めるか（集計値と、リポジトリの issue / PR の題名だけ）
# ══════════════════════════════════════════════════════════════════════════════
#
#   usage      scripts/usage-report.sh --from <月初> --to <月末> --format json（必須）
#   kpi        scripts/kpi-report.sh --format json（必須）。**期間で絞れない**（--since は
#              下限だけで、しかもフォーク率と系統にしか効かない）ので、**集めた時点の累計**
#              として入れ、そう注記する
#   buildTime  scripts/build-time-report.sh --from <月初> --to <月末> --format json
#              （**任意**。AWS の認証が切れていたら unavailable に理由を残して続ける）。
#              CloudWatch の保持は 14 日なので、**月の前半は入らない**。実際に読めた範囲を注記する。
#              build-time-report.sh は --remote を持たない（常に本番の CloudWatch を読む）。
#              --local のときは回さない
#   github     その月に閉じた issue（完了したものだけ）と、マージした PR の番号と題名。
#              **リポジトリの持ち主が作ったものだけ**（公開リポジトリなので、他人の題名を
#              記事の材料に入れない。dependabot も外れる）。外した件数は残す
#
# **作品の本文・題名・プロンプト・利用者の文章は読まない。** 上の 3 本のレポートは、
# どれも数だけを返す（各スクリプトの冒頭）。
#
# figures は、記事に書く形へ丸めた値（パーセントは小数 1 桁、円は小数 2 桁（実額）、秒は小数 1 桁）。
# **下書きの数字は、この JSON の数値からだけ取る**（docs/ops-report-template.md のプロンプト）。
# 丸めをここで済ませるのは、生成に計算させないためである（検査は数値の一致で見るので、
# 生成が自分で丸めた値は材料に無い数字として落ちる）。
#
# 本番へは読み取りしか送らない（各レポートが select だけを送ることを自分で検査している）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

PREFIX="[ops-report-collect]"
JST_OFFSET=32400

MONTH=""
SCOPE="--remote"
PERSIST_TO=""
ALLOW_PARTIAL=0
NOW="${OPS_REPORT_NOW:-$(date -u +%s)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)         SCOPE="--local"; shift ;;
    --remote)        SCOPE="--remote"; shift ;;
    --persist-to)    PERSIST_TO="${2:-}"; shift 2 ;;
    --allow-partial) ALLOW_PARTIAL=1; shift ;;
    -h|--help)       sed -n '2,15p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    -*)              echo "$PREFIX 不明な引数です: $1" >&2; exit 2 ;;
    *)
      if [[ -n "$MONTH" ]]; then
        echo "$PREFIX 月は 1 つだけ渡してください: $1" >&2; exit 2
      fi
      MONTH="$1"; shift ;;
  esac
done

if [[ ! "$MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
  echo "$PREFIX 対象の月を YYYY-MM で渡してください（JST の暦月）: ${MONTH:-（なし）}" >&2
  exit 2
fi
if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "$PREFIX --persist-to は --local と一緒にだけ使えます。" >&2
  exit 2
fi
for tool in jq gh; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$PREFIX ${tool} がありません。集められません。" >&2
    exit 2
  fi
done

# 月の境界（JST）。jq の strftime / fromdate は UTC で動くので、JST の暦日を UTC の
# 時刻として計算し、オフセットを引いて UNIX 時刻にする。
WINDOW="$(jq -n --arg month "$MONTH" --argjson off "$JST_OFFSET" --argjson now "$NOW" '
  ($month | split("-") | map(tonumber)) as [$y, $mo]
  | (if $mo == 12 then [$y + 1, 1] else [$y, $mo + 1] end) as [$ny, $nm]
  | def ymd($a; $b): "\($a)-\(if $b < 10 then "0" else "" end)\($b)-01T00:00:00Z" | fromdate;
    (ymd($y; $mo) - $off) as $from
  | (ymd($ny; $nm) - $off) as $to
  | { from: $from, to: $to,
      fromDate: (($from + $off) | strftime("%Y-%m-%d")),
      lastDate: (($to + $off - 86400) | strftime("%Y-%m-%d")),
      boundary: "jst-midnight", interval: "[from, to)",
      complete: ($now >= $to) }')" || { echo "$PREFIX 月の境界を計算できません。" >&2; exit 2; }

FROM_EPOCH="$(jq -r .from <<<"$WINDOW")"
TO_EPOCH="$(jq -r .to <<<"$WINDOW")"
FROM_DATE="$(jq -r .fromDate <<<"$WINDOW")"
LAST_DATE="$(jq -r .lastDate <<<"$WINDOW")"

if [[ "$(jq -r .complete <<<"$WINDOW")" != "true" && "$ALLOW_PARTIAL" -ne 1 ]]; then
  echo "$PREFIX ${MONTH} はまだ終わっていません（JST）。試しに回すなら --allow-partial を付けてください。" >&2
  exit 2
fi

persist_args=()
if [[ -n "$PERSIST_TO" ]]; then
  persist_args=(--persist-to "$PERSIST_TO")
fi

UNAVAILABLE='[]'
NOTES='[]'
add_unavailable() {
  UNAVAILABLE="$(jq -c --arg s "$1" --arg r "$2" '. + [{source: $s, reason: $r}]' <<<"$UNAVAILABLE")"
}
add_note() {
  NOTES="$(jq -c --arg n "$1" '. + [$n]' <<<"$NOTES")"
}

# ── usage（必須） ─────────────────────────────────────────────────────────────
echo "$PREFIX usage-report ${SCOPE} ${FROM_DATE}..${LAST_DATE}" >&2
USAGE="$(bash "$HERE/usage-report.sh" "$SCOPE" --from "$FROM_DATE" --to "$LAST_DATE" \
  --format json ${persist_args[@]+"${persist_args[@]}"})" || {
  echo "$PREFIX usage-report が失敗しました。材料が揃わないので止めます。" >&2
  exit 2
}
if ! jq -e '.totals | type == "object"' <<<"$USAGE" >/dev/null 2>&1; then
  echo "$PREFIX usage-report の出力の形が想定と違います。" >&2
  exit 2
fi

# ── kpi（必須。累計） ─────────────────────────────────────────────────────────
echo "$PREFIX kpi-report ${SCOPE}" >&2
KPI="$(bash "$HERE/kpi-report.sh" "$SCOPE" --format json ${persist_args[@]+"${persist_args[@]}"})" || {
  echo "$PREFIX kpi-report が失敗しました。材料が揃わないので止めます。" >&2
  exit 2
}
if ! jq -e '.forkRate | type == "object"' <<<"$KPI" >/dev/null 2>&1; then
  echo "$PREFIX kpi-report の出力の形が想定と違います。" >&2
  exit 2
fi
add_note "kpi は期間で絞れないため、集めた時点の累計である（scripts/kpi-report.sh）。「今月の」と書かない。"

# ── buildTime（任意） ────────────────────────────────────────────────────────
BUILD='null'
if [[ "$SCOPE" == "--local" ]]; then
  add_unavailable "buildTime" "手元の空回し（--local）では CloudWatch を読まない"
else
  echo "$PREFIX build-time-report ${FROM_DATE}..${LAST_DATE}" >&2
  build_out="$(bash "$HERE/build-time-report.sh" --from "$FROM_DATE" --to "$LAST_DATE" --format json)"
  build_rc=$?
  # JSON の後ろに判定の 1 行（BUILD_HEADROOM_*）が続く。それを落として読む。
  build_json="$(printf '%s\n' "$build_out" | sed '/^BUILD_HEADROOM_/d')"
  if [[ ( $build_rc -eq 0 || $build_rc -eq 1 ) ]] && jq -e '.totals | type == "object"' <<<"$build_json" >/dev/null 2>&1; then
    BUILD="$(jq -c . <<<"$build_json")"
    # 保持は 14 日（terraform/build-function.tf の retention_in_days）。読めた範囲を書く。
    covered_from="$(jq -n --argjson now "$NOW" --argjson from "$FROM_EPOCH" --argjson off "$JST_OFFSET" \
      '[($now - 14 * 86400), $from] | max | (. + $off) | strftime("%Y-%m-%d")')"
    add_note "buildTime は CloudWatch の保持（14 日）の内側だけ。読めたのはおよそ ${covered_from} から ${LAST_DATE} までで、月の全体ではない。「今月の」と書かない。"
  else
    add_unavailable "buildTime" "build-time-report.sh が終了コード ${build_rc} を返した（2 は未認証・ログが無い・呼び出しが 0 件。標準エラーはログにある）"
  fi
fi

# ── github（必須） ────────────────────────────────────────────────────────────
OWNER="$(gh repo view --json owner -q .owner.login 2>/dev/null)"
if [[ -z "$OWNER" ]]; then
  echo "$PREFIX gh でリポジトリの持ち主を読めません（gh の認証を確かめてください）。" >&2
  exit 2
fi
# 検索の日付には時差を付ける（付けないと UTC の日で切られる）。取りこぼしが無いよう
# 検索は広めに取り、窓（JST）での絞り込みは下の jq で行う。
SEARCH_RANGE="${FROM_DATE}T00:00:00+09:00..${LAST_DATE}T23:59:59+09:00"

echo "$PREFIX gh issue list（closed:${SEARCH_RANGE}）" >&2
ISSUES_RAW="$(gh issue list --state closed --search "closed:${SEARCH_RANGE}" --limit 1000 \
  --json number,title,closedAt,stateReason,author,labels)" || {
  echo "$PREFIX gh issue list が失敗しました。" >&2
  exit 2
}
echo "$PREFIX gh pr list（merged:${SEARCH_RANGE}）" >&2
PULLS_RAW="$(gh pr list --state merged --search "merged:${SEARCH_RANGE}" --limit 1000 \
  --json number,title,mergedAt,author,labels)" || {
  echo "$PREFIX gh pr list が失敗しました。" >&2
  exit 2
}
for raw in "$ISSUES_RAW" "$PULLS_RAW"; do
  if [[ "$(jq 'length' <<<"$raw")" -ge 1000 ]]; then
    echo "$PREFIX gh の結果が上限（1000 件）に届きました。取りこぼしがあるので止めます。" >&2
    exit 2
  fi
done

GITHUB="$(jq -n -c \
  --argjson issues "$ISSUES_RAW" --argjson pulls "$PULLS_RAW" \
  --arg owner "$OWNER" --argjson from "$FROM_EPOCH" --argjson to "$TO_EPOCH" '
  def inwin(t): (t | fromdateiso8601) as $e | $e >= $from and $e < $to;
  # 題名の先頭の Conventional Commits の型から、入れたもの / 直したものの手がかりを付ける。
  # 当たらないときに capture は何も返さない（null ではない）。配列に包んで null へ寄せないと、
  # 型の付かない題名の PR が一覧から黙って消える。
  def kind: ([.title | capture("^(?<t>[a-z]+)(\\([^)]*\\))?!?:")] | .[0].t // null) as $t
    | if $t == "feat" then "added" elif $t == "fix" then "fixed"
      elif $t == null then "unknown" else "other" end;
  ($issues | map(select(inwin(.closedAt)))) as $iw
  | ($pulls | map(select(inwin(.mergedAt)))) as $pw
  | {
      owner: $owner,
      closedIssues: [$iw[] | select(.author.login == $owner and .stateReason == "COMPLETED")
                     | {number, title, labels: [.labels[].name]}],
      mergedPulls:  [$pw[] | select(.author.login == $owner)
                     | {number, title, labels: [.labels[].name], kind: kind}],
      excluded: {
        issuesNotByOwner: ([$iw[] | select(.author.login != $owner)] | length),
        issuesNotCompleted: ([$iw[] | select(.author.login == $owner and .stateReason != "COMPLETED")] | length),
        pullsNotByOwner: ([$pw[] | select(.author.login != $owner)] | length)
      }
    }')" || { echo "$PREFIX gh の結果をまとめられません。" >&2; exit 2; }

# ── まとめる ─────────────────────────────────────────────────────────────────
jq -n \
  --arg month "$MONTH" \
  --arg scope "$SCOPE" \
  --argjson window "$WINDOW" \
  --arg collectedAt "$(jq -n --argjson now "$NOW" '$now | todate')" \
  --argjson usage "$USAGE" \
  --argjson kpi "$KPI" \
  --argjson build "$BUILD" \
  --argjson github "$GITHUB" \
  --argjson unavailable "$UNAVAILABLE" \
  --argjson notes "$NOTES" '
  def r1: if . == null then null else (. * 10 | round) / 10 end;
  def r2: if . == null then null else (. * 100 | round) / 100 end;
  def pct(a; b): if (b // 0) == 0 then null else (a * 100 / b) | r1 end;
  def per(a; b): if (b // 0) == 0 then null else (a / b) end;
  def sec: if . == null then null else (. / 1000) | r1 end;
  {
    kind: "ops-report-material",
    version: 1,
    month: $month,
    scope: $scope,
    window: $window,
    collectedAt: $collectedAt,
    figures: {
      month: {
        generations: $usage.totals.calls,
        llmSucceeded: $usage.totals.llmSucceeded,
        llmSucceededPercent: pct($usage.totals.llmSucceeded; $usage.totals.calls),
        # **費用は実額**（利用者の判断）。整数へ丸めない。usage-report.sh の表と同じ小数 2 桁。
        llmCostJpy: ($usage.totals.costJpy | r2),
        llmCostPerGenerationJpy: (per($usage.totals.costJpy; $usage.totals.calls) | r2),
        closedIssues: ($github.closedIssues | length),
        mergedPulls: ($github.mergedPulls | length),
        mergedPullsAdded: ([$github.mergedPulls[] | select(.kind == "added")] | length),
        mergedPullsFixed: ([$github.mergedPulls[] | select(.kind == "fixed")] | length)
      },
      cumulative: {
        totalGames: $kpi.forkRate.totalGames,
        newGames: $kpi.forkRate.newGames,
        forkGames: $kpi.forkRate.forkGames,
        forkRatePercent: (if $kpi.forkRate.rate == null then null else ($kpi.forkRate.rate * 100 | r1) end),
        deepLineages: $kpi.deepLineages.count,
        users: $kpi.generationsPerUser.users,
        gamesPerUser: ($kpi.generationsPerUser.perUser | r1),
        revisions: $kpi.revisionsPerWork.revisions
      },
      build: (if $build == null then null else {
        calls: $build.totals.calls,
        p50Seconds: ($build.totals.p50Ms | sec),
        p95Seconds: ($build.totals.p95Ms | sec),
        maxSeconds: ($build.totals.maxMs | sec),
        timeouts: $build.totals.over,
        timeoutSeconds: $build.ceiling.timeoutSeconds
      } end)
    },
    usage: $usage,
    kpi: $kpi,
    buildTime: $build,
    github: $github,
    unavailable: $unavailable,
    notes: $notes
  }'
