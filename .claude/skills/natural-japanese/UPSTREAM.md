# natural-japanese の取得元

このディレクトリは、上流のスキルを**改変せずに**置いた写しです（#956）。直したいところがあっても、ここでは直しません
（上流へ伝えるか、版を上げて取り込み直します）。このファイルと `LICENSE` だけが、game-forge 側で足したものです。

| 項目 | 値 |
|---|---|
| 取得元 | https://github.com/coji/natural-japanese |
| 版 | v1.5.0 |
| コミット | `9a78a42964096da509b8f3e011f0085a5f080151` |
| 写した範囲 | 上流の `skills/natural-japanese/` の全体（`SKILL.md`・`references/`・`assets/`・`scripts/`） |
| ライセンス | MIT（上流のリポジトリの直下の `LICENSE` を、同じ場所へ写した） |
| 取り込んだ日 | 2026-10-09 |

## 使っているところ

`scripts/ops-report-draft.sh` の推敲の段が、`claude -p` から `/natural-japanese full` として呼びます
（月次の運営報告の下書き。`docs/ops-report.md`）。`scripts/lint.py`・`outline.py`・`terms.py` は
`uv run` で動きます（依存の sudachipy などは uv が初回に取得します）。`semantic.py`（深層検出。初回に約 1 GB を
取得する）と `calibrate.py` は、推敲の段では使いません。

## 版を上げるとき

1. 上流を clone し、上げる先のコミットを決める。
2. `skills/natural-japanese/` の中身でこのディレクトリを置き換え（このファイルと `LICENSE` は残す）、
   上流の `LICENSE` を写し直す。
3. 上の表の版・コミット・取り込んだ日を直す。
4. `scripts/` の差分を読み、外部への通信・別のプロセスの起動・入力の外へのファイルの書き込みが増えていないことを確かめる。
5. `bash scripts/ops-report-draft.sh <月> --material <材料> --no-docs` を 1 回回し、推敲の段が通ることを確かめる。
