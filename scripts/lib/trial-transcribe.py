"""試用の録画の音声を、手元の機械で文字起こしする（#974）。

scripts/trial-analyze.sh が、scripts/install-whisper.sh の入れた仮想環境の Python で呼ぶ。
**音声はこの機械の外へ出さない**（docs/user-trial.md 3 章の同意の文面）。モデルは
install-whisper.sh がチェックサムを確かめて置いたディレクトリから読み、実行中に取りに行かない
（HF_HUB_OFFLINE を立てる）。

使い方:
    python trial-transcribe.py --model-dir <dir> --language ja <音声（16 kHz の WAV）> <出力の JSON>

出力の JSON:
    {"language": "ja", "duration": 秒, "segments": [{"start": 秒, "end": 秒, "text": "…"}, …]}

終了コード: 0 = 書けた / 1 = 文字起こしに失敗した / 2 = 引数の誤り・入力が無い
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import TypedDict


class Segment(TypedDict):
    """文字起こしの 1 区間（録画の頭からの秒）。"""

    start: float
    end: float
    text: str


def parse_args(argv: list[str]) -> argparse.Namespace:
    """引数を読む。

    Args:
        argv: コマンドラインの引数（プログラム名を除く）。

    Returns:
        読んだ引数。
    """
    parser = argparse.ArgumentParser(description="試用の録画の音声を文字起こしする（#974）")
    parser.add_argument("--model-dir", required=True, help="faster-whisper の形式のモデルのディレクトリ")
    parser.add_argument("--language", default="ja", help="話されている言語（既定 ja）")
    parser.add_argument("audio", help="16 kHz・モノラルの WAV")
    parser.add_argument("output", help="書き出す JSON のパス")
    return parser.parse_args(argv)


def transcribe(audio: Path, model_dir: Path, language: str) -> tuple[float, list[Segment]]:
    """音声を文字起こしする。

    Args:
        audio: 16 kHz・モノラルの WAV。
        model_dir: faster-whisper の形式のモデルのディレクトリ。
        language: 話されている言語。

    Returns:
        音声の長さ（秒）と、区間の一覧。
    """
    # 取り込みを遅らせるのは、--help と引数の誤りを依存なしで返すため。
    from faster_whisper import WhisperModel

    model = WhisperModel(
        str(model_dir),
        device="cpu",
        compute_type="int8",
        cpu_threads=os.cpu_count() or 4,
        local_files_only=True,
    )
    # vad_filter: 黙っている区間を飛ばす。無音の区間でモデルが文を作り出す（幻聴）のを減らす。
    segments, info = model.transcribe(str(audio), language=language, beam_size=5, vad_filter=True)
    out: list[Segment] = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            out.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
    return float(info.duration), out


def main(argv: list[str]) -> int:
    """入口。

    Args:
        argv: コマンドラインの引数（プログラム名を除く）。

    Returns:
        終了コード。
    """
    args = parse_args(argv)
    audio = Path(args.audio)
    model_dir = Path(args.model_dir)
    if not audio.is_file():
        print(f"[trial-transcribe] 音声がありません: {audio}", file=sys.stderr)
        return 2
    if not (model_dir / "model.bin").is_file():
        print(f"[trial-transcribe] モデルがありません: {model_dir}（bash scripts/install-whisper.sh）", file=sys.stderr)
        return 2
    os.environ["HF_HUB_OFFLINE"] = "1"
    try:
        duration, segments = transcribe(audio, model_dir, args.language)
    except Exception as exc:  # noqa: BLE001 — 失敗の種類によらず、理由を出して 1 で終える
        print(f"[trial-transcribe] 文字起こしに失敗しました: {exc}", file=sys.stderr)
        return 1
    result = {"language": args.language, "duration": round(duration, 2), "segments": segments}
    try:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"[trial-transcribe] 書き出せません: {exc}", file=sys.stderr)
        return 1
    print(f"[trial-transcribe] {len(segments)} 区間（{duration:.1f} 秒）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
