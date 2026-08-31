#!/usr/bin/env bash
# verify-effort-spelling.sh — `effort` の綴りを、実呼び出し 1 回ぶんの費用で確かめる（#25 / 4.2）。
#
# ## なぜ要るのか
#
# `src/bedrock.ts` は `effort` を
# `additionalModelRequestFields.output_config.effort` として送るが、**この綴りは実呼び出しで
# 確かめられていない**（#83 は実呼び出しを行っていない）。登録簿の既定は `effort: null` なので
# 既定の経路では送られず、**A/B の 1 回目で初めて真偽が分かる**状態にある。
#
# **綴りが違っていても、A/B は静かに成立してしまいうる。** Bedrock が未知の項目を
# 素通しするなら、両群とも `effort` の効かない同じ生成になり、**「差が無かった」という
# 誤った結論**が出る。差が出ないことは、綴りが正しいことの証拠にはならない。
#
# ## 検査そのものを疑う（対照を置く理由）
#
# **「正しい綴りで 200 が返った」は、綴りが効いた証拠にならない。** API が未知の項目を
# 黙って捨てているだけかもしれない。そこでこのスクリプトは、**明らかに存在しない綴り**を
# 送る対照を先に打つ。
#
# | 対照（でたらめな綴り） | 本番の綴り | 読み方 |
# |---|---|---|
# | **拒否された** | 受理された | **綴りは正しい。** API は項目を検証しており、本番の綴りはその検証を通った |
# | 受理された | 受理された | **判定できない。** API は未知の項目を素通ししている。200 は何も意味しない |
# | （何であれ） | **拒否された** | **綴りが違う。** 出力の ValidationException を読んで直す |
#
# 引き継ぎ 4 章「確かめていない検査は、確かめた証拠として読まれるぶん赤より悪い」。
#
# ## 費用
#
# **3 回の呼び出しで 1 円未満である。** 入力は数トークン、出力上限は 64 トークンで、
# Sonnet 4.6 の出力単価 $15/100 万トークン・150 円/ドルなら 1 回あたり最大 0.15 円。
# 拒否された呼び出しは課金されない。**それでも自動では走らせない**——生成 API を
# 呼ぶスクリプトを受け入れ検証（scripts/acceptance.sh）へ入れない、という方針は
# 金額ではなく経路の話である。
#
# 使い方:
#   AWS_PROFILE=game-forge-prod bash scripts/verify-effort-spelling.sh
#
# 事前に必要なもの:
#   - AWS CLI v2 と、Bedrock の InvokeModel 権限を持つ資格情報
#     （SSO が切れていれば aws sso login --profile game-forge-prod --use-device-code）
#   - 東京リージョンでの Sonnet 4.6 のモデルアクセス（docs/bedrock-access.md）
#
# 環境変数:
#   GF_BEDROCK_REGION  既定 ap-northeast-1（jp. の推論プロファイルはここで呼ぶ）
#
# 終了コード:
#   0 = 判定できた（綴りが正しい／違う、のどちらかを出力する）
#   1 = 判定できなかった（対照が素通しされた・呼び出せなかった・実装の綴りが変わった）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

REGION="${GF_BEDROCK_REGION:-ap-northeast-1}"

# **実装と同じものを送っていることを、送る前に確かめる。**
#
# ここに書いた綴りは `src/bedrock.ts` の写しである（shell から TypeScript を呼べない
# 以上、写しは避けられない）。**写しが古くなったまま実行すると、実装が送っていない
# 綴りを検証して「正しい」と報告する**——確かめていない検査そのものになる。
#
# **したがって、実装側に同じ綴りが在ることを先に見る。** 実装が変わったらこの検査は
# **走る前に落ちる**（緑にはならない）。綴りを絞った検査は対象が変われば空振りするが、
# 空振りが「通過」ではなく「失敗」になるなら、写しの古さは必ず人に見える。
#
# **grep は必ず -F（固定文字列）で当てる。** 探している綴りには `.` や `{` が入って
# おり、正規表現として解釈させると `jp.anthropic...` の `.` が任意 1 文字になる——
# **綴りが違っていても一致してしまう。** それはこの検査の目的そのもの（写しの古さを
# 見つける）を損なう。緩く一致する検査は、確かめた証拠として読まれるぶん赤より悪い。
IMPL="src/bedrock.ts"
REGISTRY="src/generation-models.ts"
MODEL_ID="jp.anthropic.claude-sonnet-4-6"

if [[ ! -f "$IMPL" || ! -f "$REGISTRY" ]]; then
  echo "[effort] $IMPL / $REGISTRY が見つかりません（リポジトリのルートで実行してください）" >&2
  exit 1
fi

if ! grep -qF "output_config: { effort: model.effort }" "$IMPL"; then
  echo "[effort] $IMPL の綴りが変わっています。" >&2
  echo "[effort] このスクリプトが送る項目（output_config.effort）は実装の写しです。" >&2
  echo "[effort] 実装を読み直し、このスクリプトを更新してから再実行してください。" >&2
  exit 1
fi

if ! grep -qF "modelId: '$MODEL_ID'" "$REGISTRY"; then
  echo "[effort] $REGISTRY に $MODEL_ID がありません。登録簿を読み直してください。" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "[effort] aws CLI が見つかりません（AWS CLI v2 が要ります）" >&2
  exit 1
fi

# 1 回の呼び出し。標準出力と標準エラーをまとめて受け、終了コードで受理／拒否を判定する。
#
# 出力を変数へ入れるのは、**本文をそのまま端末へ流さないため**でもある。
# ValidationException は入力を引用しうる（`src/bedrock.ts` の BedrockCallFailed）。
# ここで送っているのは "ping" だけなので実害は無いが、経路の扱いはそろえておく。
PROBE_OUTPUT=""

# 呼び出しが失敗したとき、**それが「項目の検証で断られた」のか「そもそも呼べていない」のか**
# を分ける。
#
# **ここを分けないと、資格情報切れが「綴りが違う」と報告される。** 実際に踏んだ
# （2026-08-31。SSO の期限切れで 3 回とも失敗し、対照の失敗を「API は項目を検証している」、
# 本番の綴りの失敗を「綴りが違う」と読んで EFFORT_SPELLING_WRONG を出した）。
# **終了コードだけを見る検査は、確かめていないものを確かめた証拠として報告する。**
#
# `ValidationException` は Bedrock が入力を見て断った証拠であり、この検査が見たいものは
# それだけである。それ以外（SSO / 権限 / 疎通 / スロットリング）は**判定不能**であって、
# 綴りについて何も言えない。
is_validation_error() {
  printf '%s' "$PROBE_OUTPUT" | grep -qF 'ValidationException'
}

# 判定できない失敗を報告して終える。**綴りについて何も言わない。**
abort_undecidable() {
  echo "[effort] $1" >&2
  echo "[effort] **綴りについては何も判定できていません。**" >&2
  echo "[effort] 出力:" >&2
  printf '%s\n' "$PROBE_OUTPUT" >&2
  echo "[effort] SSO が切れているなら:" >&2
  echo "[effort]   aws sso login --profile game-forge-prod --use-device-code" >&2
  echo "EFFORT_SPELLING_UNDECIDABLE"
  exit 1
}

probe() {
  local fields="$1"
  local rc=0
  PROBE_OUTPUT="$(
    aws bedrock-runtime converse \
      --region "$REGION" \
      --model-id "$MODEL_ID" \
      --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
      --inference-config '{"maxTokens":64}' \
      --additional-model-request-fields "$fields" 2>&1
  )" || rc=$?
  return "$rc"
}

echo "[effort] region=$REGION model=$MODEL_ID"

# 1. 対照。**存在しないはずの綴り**を送る。ここが受理されたら、この検査は成立しない。
echo "[effort] 1/3 対照（でたらめな綴り）を送ります"
if probe '{"output_config":{"effort_this_field_does_not_exist":"high"}}'; then
  echo "[effort] 対照が受理されました。" >&2
  echo "[effort] Bedrock は未知の項目を素通ししています。**本番の綴りが 200 を返しても、" >&2
  echo "[effort] それは綴りが効いた証拠になりません。**この方法では判定できません。" >&2
  echo "[effort] 次の手は、high と medium で usage.outputTokens に差が出るかを見ることです" >&2
  echo "[effort] （thinking は出力として課金される。4.2）。差が出なければ効いていません。" >&2
  echo "EFFORT_SPELLING_UNDECIDABLE"
  exit 1
fi
# **対照が「拒否された」だけでは足りない。** 呼べていないだけかもしれない。
if ! is_validation_error; then
  abort_undecidable "対照は失敗しましたが、ValidationException ではありません（呼び出せていません）。"
fi
echo "[effort]     対照は ValidationException で拒否されました（API は項目を検証しています）"

# 2. 本番の綴りを、A/B の 2 群ぶん送る。
#
# **両方を打つ。** 片方だけ通る綴りは考えにくいが、A/B で使うのは 2 つの値であり、
# 「検証したのは high だけだった」という状態を残さない。
status=0
for effort in high medium; do
  echo "[effort] 2/3, 3/3 本番の綴り（effort=$effort）を送ります"
  if probe "{\"output_config\":{\"effort\":\"$effort\"}}"; then
    # 出力トークンも出す。high と medium で差があれば、効いていることの傍証になる
    # （thinking は出力として課金される。4.2）。
    tokens="$(printf '%s' "$PROBE_OUTPUT" | tr ',' '\n' | grep -iF 'outputTokens' | head -1 || true)"
    echo "[effort]     受理されました${tokens:+（$tokens）}"
  else
    # **ここでも種類を見る。** 対照のあとに SSO が切れることもある。
    if ! is_validation_error; then
      abort_undecidable "effort=$effort の呼び出しが ValidationException 以外で失敗しました。"
    fi
    echo "[effort]     ValidationException で拒否されました（effort=$effort）" >&2
    printf '%s\n' "$PROBE_OUTPUT" >&2
    status=1
  fi
done

if [[ "$status" -ne 0 ]]; then
  echo "[effort] **綴りが違います。** 上の ValidationException を読み、" >&2
  echo "[effort] $IMPL の additionalModelRequestFields を直してください。" >&2
  echo "[effort] 直したら、このスクリプトの写しも同じコミットで直すこと。" >&2
  echo "EFFORT_SPELLING_WRONG"
  exit 0
fi

echo "[effort] 対照は拒否され、本番の綴りは 2 群とも受理されました。"
echo "[effort] **綴りは正しい**と判定できます。A/B（#25）へ進めます。"
echo "EFFORT_SPELLING_OK"
