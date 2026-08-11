# Issue Close Policy Task Skill

## 目的

- issue をポリシー準拠でクローズし、追跡可能な理由を残す。

## 入力

- issue 状態、検証結果、関連PR。

## 手順

1. クローズ理由を `completed` / `superseded` / `duplicate` / `invalid` / `deferred` から選ぶ。
2. `superseded` / `duplicate` は置換先 issue を明記する。
3. 実装系 issue は検証結果を1行以上記載する。
4. コメント後に close を実施する。

## 出力

- 理由付きクローズコメントと最終状態。

## 注意事項

- 理由なしでクローズしない。
- 検証未実施の完了扱いをしない。
