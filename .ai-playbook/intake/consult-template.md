# Consult Session Template

```yaml
agenda:
conclusion:
applyNow: false
deferredIssue:
affectedScope: []
blocking: false
```

## メモ

- 設計 / スコープ / 契約 / 優先度に影響する場合は `blocking: true` を使う
- `blocking: true` の間は、`affectedScope` の作業を進めない
- `applyNow: false` の場合は `deferredIssue` に後続の issue を記録する
- 相談記録に秘密情報を含めない

## 関連

- ロール契約: [consult-facilitator](../role-contracts/consult-facilitator.md)
