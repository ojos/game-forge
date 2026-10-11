#!/usr/bin/env bash
# check-trial-recording-browser.sh — 試用の録画（#978）を実ブラウザ（headless の Chromium）で通す
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ実ブラウザが要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **録画は、ブラウザの中でしか起きない。** 単体テスト（`test/trial-recording.test.ts`）が見られるのは口の側
# ——受け取り方・断り方・つなぎ方——だけで、次のことは見られない。
#
#   - 画面の取り込みとマイクを合わせて、MediaRecorder が 5 秒ごとに断片を出すこと
#   - 段を進めても**ページを読み込み直さず**、録画が切れないこと（`src/trial-recorder-script.ts` の差し替え）
#   - 送れなかった断片が手元に溜まり、量が画面に出て、通信が戻ると送り切ること
#   - 「共有を停止」で録画が止まり、理由が口へ届き、再開できること
#   - **つないだ 1 本が、本当に再生できること**（WebM の断片を頭から順につなぐと 1 本に戻ること）
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を見るか
# ══════════════════════════════════════════════════════════════════════════════
#
# 観測は `scripts/trial-recording-browser-probe.mjs`（流れは同ファイルの冒頭）。ここは判定と、D1 の目録の照合を持つ。
#
#   1. 観測の全段が通った（録画の開始 → 自由に触る段 → 口を落として溜まる → 送り切る → 共有の停止 → 再開 →
#      アンケートで止まる → 送り切る → アンケートを送る → 管理画面で落とす）
#   2. 録画の準備の段からアンケートの段まで、**ページを 1 度も読み込み直していない**
#   3. D1 の目録に録画が 2 本あり、1 本目は `share-ended`、2 本目は `finished` で止まり、どちらも断片が 2 つ以上
#   4. 管理画面から落とした 2 本が、どちらも WebM の頭（`1a45dfa3`）で始まり、`<video>` で開けて、
#      **映像も声も復号された**（`webkitVideoDecodedByteCount` と `webkitAudioDecodedByteCount` が 0 より大きい）
#
# **Safari と Firefox はこの検査の外である**（headless の自動検査が無い。利用者の Mac で手で確かめる）。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ scripts/verify.sh のローカル層に入れないのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **ブラウザの実行ファイルを前提にし、実時間で 1 分ほど録画するため**である（`scripts/check-page-width.sh` と同じ
# 置き場所。録画の画面・口・スクリプトを触ったときに手で回す層）。所要は 2026-10-11 の実測で約 50 秒
# （下ごしらえ（`scripts/lib/dev-fixture.sh`）を含む）。
#
# 使い方:
#   bash scripts/check-trial-recording-browser.sh
#   GF_BROWSER_BIN=/path/to/headless_shell bash scripts/check-trial-recording-browser.sh
#
# 終了コード: 0 = TRIAL_RECORDING_BROWSER_PASS / 1 = 失敗・検査不能
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

TIMEOUT_MS="${GF_TRIAL_RECORDING_TIMEOUT_MS:-30000}"

export GF_FIXTURE_LABEL='[trial-recording-browser]'
export GF_FIXTURE_PORT="${GF_TRIAL_RECORDING_PORT:-8797}"

fail() {
  printf '[trial-recording-browser] %s\n' "$*" >&2
  echo "TRIAL_RECORDING_BROWSER_FAIL"
  exit 1
}

note() { printf '[trial-recording-browser] %s\n' "$*"; }

# shellcheck source=scripts/lib/dev-fixture.sh
. scripts/lib/dev-fixture.sh
trap dev_fixture_down EXIT
dev_fixture_up

# ── 仕込み: 仕込んだ利用者を、同意して録画の準備の段にいる試用者にする ──────────
#
# **同意の段は通さない**（同意の画面と口は `test/trial.test.ts` が見る）。版は D1 に残す値の形だけを満たせばよい。
d1() {
  npx wrangler d1 execute DB --local --persist-to "$STATE" --json --command "$1" 2>"$WORK/d1-trial.log"
}
NOW_S="$(date +%s)"
d1 "insert into trial_participants (user_id, marked_at, stage, consent_version, consented_at)
    values ('${USER_ID}', ${NOW_S}, 'recording', 'browser-check', ${NOW_S})" >/dev/null ||
  { sed 's/^/    /' "$WORK/d1-trial.log" >&2; fail "試用者の印を仕込めませんでした。"; }

# ── 実ブラウザで通す ──────────────────────────────────────────────────────────

note "録画を通します（実時間で 1 分ほどかかります）"
node scripts/trial-recording-browser-probe.mjs \
  --browser "$BROWSER_BIN" \
  --base "$BASE" \
  --admin-base "$ADMIN_BASE" \
  --cookie "__Host-gf_session=$COOKIE_VALUE" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/probe.json" ||
  fail "ブラウザでの観測ができませんでした。"

d1 "select id, mime_type, container, browser, display_surface, next_seq, total_bytes, end_reason
      from trial_recordings where user_id = '${USER_ID}' order by started_at, rowid" >"$WORK/recordings.json" ||
  { sed 's/^/    /' "$WORK/d1-trial.log" >&2; fail "録画の目録を読めませんでした。"; }
d1 "select stage from trial_participants where user_id = '${USER_ID}'" >"$WORK/participant.json" ||
  { sed 's/^/    /' "$WORK/d1-trial.log" >&2; fail "試用者の段を読めませんでした。"; }

# ── 判定 ──────────────────────────────────────────────────────────────────────

node -e '
const fs = require("node:fs");
const probe = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))[0].results;
const participant = JSON.parse(fs.readFileSync(process.argv[3], "utf8"))[0].results;
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`[trial-recording-browser] ${ok ? "OK  " : "FAIL"} ${label}${detail === "" ? "" : `（${detail}）`}`);
  if (!ok) failed += 1;
};
for (const step of probe.steps) {
  check(step.ok, step.label, step.ok ? `stage=${step.stage} recording=${step.recording} pending=${step.pending}` : JSON.stringify(step.last));
}
check(probe.ok === true, "観測の全段を通した", probe.failure ?? "");
check(probe.sameDocumentAfterStart === true && probe.sameDocumentUntilSurvey === true,
  "録画の準備からアンケートまで、ページを読み込み直していない");
check((probe.failedWhileOffline ?? 0) >= 1, "口を落とした間に、送れなかった断片がある", `失敗=${probe.failedWhileOffline}`);
check(participant.length === 1 && participant[0].stage === "done", "試用者がアンケートを送って終えた", JSON.stringify(participant));
check(rows.length === 2, "録画の目録が 2 本（共有の停止の前と後）", `本数=${rows.length}`);
if (rows.length === 2) {
  check(rows[0].end_reason === "share-ended", "1 本目は共有の停止で止まった", rows[0].end_reason);
  check(rows[1].end_reason === "finished", "2 本目はアンケートの段で止まった", rows[1].end_reason);
  for (const [index, row] of rows.entries()) {
    check(row.next_seq >= 2 && row.total_bytes > 0, `${index + 1} 本目に断片が 2 つ以上届いた`, `断片=${row.next_seq} 大きさ=${row.total_bytes}`);
    check(row.container === "webm" && /^video\/webm/u.test(row.mime_type), `${index + 1} 本目は WebM`, row.mime_type);
    check(row.browser === "chrome", `${index + 1} 本目のブラウザは chrome`, String(row.browser));
  }
}
const playbacks = probe.playbacks ?? [];
check(playbacks.length === rows.length && rows.length > 0, "管理画面に、録画の数だけ「録画を落とす」がある", `ボタン=${playbacks.length}`);
for (const playback of playbacks) {
  const row = rows.find((r) => r.id === playback.id);
  const label = `録画 ${String(playback.id).slice(0, 8)}`;
  check(row !== undefined && playback.size === row.total_bytes, `${label}: 落とした大きさが受け取った大きさと同じ`, `${playback.size} / ${row?.total_bytes}`);
  check(playback.head === "1a45dfa3", `${label}: WebM の頭で始まる`, playback.head ?? playback.error);
  check(playback.metadata === "ok" && playback.videoWidth > 0, `${label}: <video> で開ける`, `${playback.metadata} ${playback.videoWidth}x${playback.videoHeight}`);
  check(playback.played === "ok" && playback.videoBytes > 0, `${label}: 映像を復号した`, `played=${playback.played} video=${playback.videoBytes}`);
  check(playback.audioBytes > 0, `${label}: 声を復号した`, `audio=${playback.audioBytes}`);
  check(typeof playback.duration === "number" && playback.duration >= 5, `${label}: 長さが 5 秒以上`, String(playback.duration));
}
if ((probe.errors ?? []).length > 0) {
  console.log("[trial-recording-browser] ページの例外・console.error（参考）:");
  for (const error of probe.errors) console.log(`    ${error}`);
}
process.exit(failed === 0 ? 0 : 1);
' "$WORK/probe.json" "$WORK/recordings.json" "$WORK/participant.json" || fail "判定に落ちた項目があります（上の FAIL）。"

echo "TRIAL_RECORDING_BROWSER_PASS"
