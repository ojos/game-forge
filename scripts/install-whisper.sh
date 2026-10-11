#!/usr/bin/env bash
# install-whisper.sh — devcontainer へ、試用の録画の文字起こしの道具（faster-whisper とモデル）と ffmpeg を、
# 版とチェックサムを固定して入れる（#974）
#
# 使い方: bash scripts/install-whisper.sh [--check]
#   devcontainer の postCreateCommand から呼ぶ（scripts/install-uv.sh の後。uv を使う）。手で打ってもよい
#   （入っていれば何もしない）。
#   --check: 何も入れずに、入っているかだけを確かめる（終了コード 0 = 入っている / 1 = 足りない）。
#
# **なぜ要るのか。** scripts/trial-analyze.sh が、試用の録画（docs/user-trial.md）から文字起こしと
# 数秒おきの静止画を作るため。**音声は外部へ送らない**（同意の文面。文字起こしは手元の機械で行う）ので、
# 文字起こしのモデルを手元に置く。
#
# 入れるもの（置き場所は ${GF_WHISPER_HOME:-~/.local/share/game-forge/whisper}）:
#   venv/        Python 3.12 の仮想環境。faster-whisper（CTranslate2 で動く whisper）と imageio-ffmpeg
#                （ffmpeg の静的なビルドを持つ）。依存はすべて scripts/lib/trial-whisper-requirements.txt の
#                版とハッシュで入れる（uv pip sync --require-hashes。ハッシュが合わなければ入らない）。
#   model/       whisper large-v3-turbo の CTranslate2 形式（dropbox-dash/faster-whisper-large-v3-turbo。
#                旧 mobiuslabsgmbh。約 1.6 GB）。版（commit）を固定し、ファイルごとの sha256 を確かめて置く。
#   bin/ffmpeg   imageio-ffmpeg が持つ ffmpeg への symlink。~/.local/bin/ffmpeg にも同じ symlink を置く
#                （既に別の ffmpeg がそこにあれば触らない）。
#   installed.txt  入れたものの印（要件のファイルの sha256 とモデルの commit）。合っていれば入れ直さない。
#
# **道具の選び方。** whisper.cpp はこの devcontainer に無い cmake でのビルドが要る。faster-whisper なら、
# 依存を uv のハッシュつきの要件のファイル 1 つで固定でき、ffmpeg も同じ要件（imageio-ffmpeg の wheel）で
# 版とハッシュを固定できる（apt の ffmpeg は版の固定が Ubuntu の更新に左右される）。日本語は
# large-v3-turbo で実用になる（2026-10-11 の試し: espeak-ng の日本語の合成音声 9 秒を、漢字まじりで誤りなく書き起こした）。
#
# **版を固定する理由と選び方。** 公開から 2 週間以上たった版だけを使う（#956 の install-uv.sh と同じ規律）。
#   - Python の依存: faster-whisper 1.2.1（2025-10-31 公開）・imageio-ffmpeg 0.6.0（2025-01-16 公開。中の ffmpeg は
#     x86_64 と aarch64 の静的なビルド）。推移的な依存は `--exclude-newer` で 2026-09-27 より前に公開された版に
#     限って解いた。作り直すときは次を打つ（日付は作り直す日の 2 週間前にする）:
#       uv pip compile scripts/lib/trial-whisper-requirements.in --universal --python-version 3.12 \
#         --generate-hashes --exclude-newer <YYYY-MM-DD>T00:00:00Z -o scripts/lib/trial-whisper-requirements.txt
#   - モデル: commit 0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf（2025-11-05。README だけを直した commit で、
#     モデルのファイルは 2024-10-08 の 0c94664 から変わっていない）。sha256 は 2026-10-11 に、model.bin は
#     Hugging Face の LFS の oid（sha256）、ほかは取得した実物の sha256sum と git の blob の id
#     （git hash-object が API の oid と一致）の 2 つで確かめた。
#
# 版を上げるときは、要件のファイル・MODEL_REV・MODEL_FILES を同じコミットで直す。
# scripts/post-rebuild-check.sh はこのファイルの --check を呼ぶので、そちらは直さなくてよい。
#
# ~/.local は volume ではないので、作り直すと消え、postCreateCommand がまた入れる（モデルの取得で 1〜2 分）。
#
# 終了コード: 0 = 入った（または既に入っている）/ 1 = 入れられない（uv が無い・取得の失敗・
#             チェックサムの不一致・入れた後も確かめが通らない）/ 2 = 引数の誤り
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly PREFIX="[install-whisper]"
readonly PYTHON_VERSION="3.12"
readonly REQUIREMENTS="$HERE/lib/trial-whisper-requirements.txt"
readonly MODEL_REPO="dropbox-dash/faster-whisper-large-v3-turbo"
readonly MODEL_REV="0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
# 1 行 = ファイル名・大きさ（バイト）・sha256。
readonly MODEL_FILES="config.json 2263 b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e
preprocessor_config.json 340 7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711
tokenizer.json 2710337 297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd
vocabulary.json 1068114 c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1
model.bin 1617884929 e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da"
readonly WHISPER_HOME="${GF_WHISPER_HOME:-${HOME}/.local/share/game-forge/whisper}"
readonly VENV="$WHISPER_HOME/venv"
readonly MODEL_DIR="$WHISPER_HOME/model"
readonly STAMP="$WHISPER_HOME/installed.txt"
readonly USER_BIN="${HOME}/.local/bin"

check_only=0
case "${1:-}" in
  "") ;;
  --check) check_only=1 ;;
  *)
    echo "$PREFIX usage: bash scripts/install-whisper.sh [--check]" >&2
    exit 2
    ;;
esac

# ファイルの sha256 を返す。
#
# @param $1 ファイル
# @return 標準出力に sha256（16 進）
sha256_of() {
  openssl dgst -sha256 -r "$1" | awk '{ print $1 }'
}

# 入れたものの印の中身（要件のファイルの sha256 とモデルの commit）を返す。
#
# @return 標準出力に印の中身
expected_stamp() {
  printf 'requirements=%s\nmodel=%s@%s\n' "$(sha256_of "$REQUIREMENTS")" "$MODEL_REPO" "$MODEL_REV"
}

# モデルのファイルが、決めた大きさと sha256 で揃っているか。--check でも sha256 を取り直す（1.6 GB で
# 約 1.4 秒。2026-10-11 の aarch64）。大きさだけだと、置いた後で壊れたファイルを「入っている」と見て
# 入れ直さず、文字起こしの時まで気づけない。
#
# @return 0 = 揃っている / 1 = 足りないか壊れている
model_ok() {
  local name size want got
  while read -r name size want; do
    [[ -f "$MODEL_DIR/$name" ]] || return 1
    got="$(wc -c < "$MODEL_DIR/$name" | tr -d ' ')"
    [[ "$got" == "$size" ]] || return 1
    [[ "$(sha256_of "$MODEL_DIR/$name")" == "$want" ]] || return 1
  done <<<"$MODEL_FILES"
}

# 仮想環境の ffmpeg（imageio-ffmpeg が持つもの）のパスを返す（無ければ空）。
#
# @return 標準出力にパス
venv_ffmpeg() {
  if [[ -x "$VENV/bin/python" ]]; then
    "$VENV/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' 2>/dev/null || true
  fi
}

# 入っているかを行に書き、すべてそろっていれば 0 を返す。
#
# @return 0 = 入っている / 1 = 足りない
report_state() {
  local ok=0 ff ver
  if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$(expected_stamp)" ]]; then
    echo "$PREFIX stamp OK ($STAMP)"
  else
    echo "$PREFIX stamp missing or stale ($STAMP)"
    ok=1
  fi
  if [[ -x "$VENV/bin/python" ]] && "$VENV/bin/python" -c 'import faster_whisper' >/dev/null 2>&1; then
    ver="$("$VENV/bin/python" -c 'import faster_whisper; print(faster_whisper.__version__)' 2>/dev/null || true)"
    echo "$PREFIX faster-whisper OK (${ver:-?}: $VENV)"
  else
    echo "$PREFIX faster-whisper missing ($VENV)"
    ok=1
  fi
  if model_ok; then
    echo "$PREFIX model OK (${MODEL_REPO}@${MODEL_REV:0:7}: $MODEL_DIR)"
  else
    echo "$PREFIX model missing, incomplete or corrupted ($MODEL_DIR)"
    ok=1
  fi
  ff="$WHISPER_HOME/bin/ffmpeg"
  if [[ -x "$ff" ]] && "$ff" -hide_banner -version >/dev/null 2>&1; then
    ver="$("$ff" -hide_banner -version 2>/dev/null | awk 'NR == 1 { print $3 }')"
    echo "$PREFIX ffmpeg OK (${ver:-?}: $ff)"
  else
    echo "$PREFIX ffmpeg missing ($ff)"
    ok=1
  fi
  return "$ok"
}

if [[ "$check_only" == "1" ]]; then
  report_state
  exit $?
fi

if report_state >/dev/null; then
  echo "$PREFIX faster-whisper, the model and ffmpeg are already installed, skipping"
  exit 0
fi

command -v uv >/dev/null 2>&1 || { echo "$PREFIX error: uv が見つかりません（bash scripts/install-uv.sh）" >&2; exit 1; }
[[ -f "$REQUIREMENTS" ]] || { echo "$PREFIX error: 要件のファイルがありません: $REQUIREMENTS" >&2; exit 1; }

mkdir -p "$WHISPER_HOME" "$MODEL_DIR" "$WHISPER_HOME/bin"
rm -f -- "$STAMP"

# ── Python の依存 ─────────────────────────────────────────────────────────────
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "$PREFIX creating a Python ${PYTHON_VERSION} venv at $VENV ..."
  uv venv --quiet --python "$PYTHON_VERSION" "$VENV"
fi
echo "$PREFIX installing faster-whisper and imageio-ffmpeg (hash-pinned) ..."
# --require-hashes: 要件のファイルのハッシュと合わない wheel は入れない。sync は要件に無いものを外す。
if ! uv pip sync --quiet --require-hashes --python "$VENV/bin/python" "$REQUIREMENTS"; then
  echo "$PREFIX error: 依存を入れられません（上の uv の出力）" >&2
  exit 1
fi

# ── モデル ───────────────────────────────────────────────────────────────────
while read -r name size want; do
  dest="$MODEL_DIR/$name"
  if [[ -f "$dest" && "$(wc -c < "$dest" | tr -d ' ')" == "$size" && "$(sha256_of "$dest")" == "$want" ]]; then
    continue
  fi
  url="https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REV}/${name}"
  echo "$PREFIX fetching ${name} (${size} bytes) ..."
  if ! curl -fsSL --retry 3 -o "$dest.part" "$url"; then
    rm -f -- "$dest.part"
    echo "$PREFIX error: 取得できません: ${url}" >&2
    exit 1
  fi
  got="$(sha256_of "$dest.part")"
  if [[ "$got" != "$want" ]]; then
    rm -f -- "$dest.part"
    echo "$PREFIX error: ${name} のチェックサムが合いません（期待 ${want} / 実際 ${got}）。置きません" >&2
    exit 1
  fi
  mv -f -- "$dest.part" "$dest"
done <<<"$MODEL_FILES"

# ── ffmpeg ───────────────────────────────────────────────────────────────────
ff_real="$(venv_ffmpeg)"
if [[ -z "$ff_real" || ! -x "$ff_real" ]]; then
  echo "$PREFIX error: imageio-ffmpeg の ffmpeg が見つかりません" >&2
  exit 1
fi
ln -sfn -- "$ff_real" "$WHISPER_HOME/bin/ffmpeg"
mkdir -p "$USER_BIN"
# ~/.local/bin/ffmpeg は、無いか、ここが置いた symlink のときだけ置き直す（手で入れた ffmpeg を潰さない）。
if [[ ! -e "$USER_BIN/ffmpeg" && ! -L "$USER_BIN/ffmpeg" ]] \
   || [[ -L "$USER_BIN/ffmpeg" && "$(readlink "$USER_BIN/ffmpeg")" == "$VENV/"* ]]; then
  ln -sfn -- "$ff_real" "$USER_BIN/ffmpeg"
else
  echo "$PREFIX note: $USER_BIN/ffmpeg は別のものなので触りません（scripts/trial-analyze.sh は $WHISPER_HOME/bin/ffmpeg を使います）"
fi

expected_stamp > "$STAMP"
if ! report_state; then
  echo "$PREFIX error: 入れた後も確かめが通りません（上の行）" >&2
  exit 1
fi
echo "$PREFIX installed"
