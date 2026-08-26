"""層 2（暴走検知）の実行部（仕様 4.3 / #82）。

CloudWatch アラーム → SNS → この関数、という経路の終端である。やることは 1 つで、
``game-forge-bedrock-invoker`` へ**明示的 Deny のポリシーを付ける**こと。それだけを行う。

## なぜ「Deny を付ける」なのか

4.3 が求めているのは **Bedrock の呼び出しが止まること**であって、特定の API を
呼ぶことではない。**v1.6 までの 4.3 は「ポリシーを剥がす」と書いていたが、剥奪では
成立しないことがこの実装で分かり、仕様側を改めた（v1.7）。** 剥奪を採らなかった
理由は 2 つある。

1. **剥がすと宣言と喧嘩する。** 許可は ``aws_iam_user_policy.bedrock_invoke`` として
   Terraform が持っている。関数がそれを消すと ``terraform plan`` に差分が出て、
   **誰かが無関係な変更（DNS など）を apply した拍子に、原因を調べる前に許可が
   戻る。** 4.3 は「復旧は手動とする。暴走の原因を調べる前に自明で戻すと、同じ
   暴走を繰り返す」と明記しており、これに反する。
   Deny ポリシーの**アタッチ**は宣言集合の外側にあるため、apply では剥がれない。
2. **層 3（Budgets Actions）が Deny の付与しかできない。** AWS Budgets の
   ``APPLY_IAM_POLICY`` は指定ポリシーを**付ける**動作しか持たない。層 2 と層 3 で
   復旧手順が違うと、発火時に「どちらの層が撃ったか」で操作を変えることになる。
   同じ機構に揃えれば、復旧は常に「Deny を detach する」1 つで済む。

明示的 Deny は同一アカウント内の Allow を必ず上書きするため、効果は剥奪と同じである。

## 冪等である

``attach_user_policy`` は既にアタッチ済みでもエラーにならない。アラームは
状態遷移のたびに発火しうるので、二重発火で落ちない性質が要る。

## 復旧しない

この関数に detach の経路は無い。IAM ロールにも ``iam:DetachUserPolicy`` を与えて
いない。**復旧は人間が手でやる**（docs/bedrock-access.md）。自動で戻す口を用意すると、
それが誤って呼ばれた時点で層 2 が無効になる。
"""

import json
import os

import boto3

# ハンドラの外で作る。Lambda の実行環境は再利用されるため、呼び出しごとに
# クライアントを作り直すと発火時に無駄な遅延が乗る。層 2 は「速いこと」が
# 存在理由なので、削れる遅延は削る。
_iam = boto3.client("iam")


def handler(event, context):
    """SNS 経由でアラームを受け、対象ユーザーへ Deny ポリシーを付ける。

    引数:
        event: SNS のイベント。中身は使わない（下記）。
        context: Lambda のコンテキスト。使わない。

    戻り値: 付けた対象を含む dict（CloudWatch Logs に残す用）。
    """
    user = os.environ["TARGET_USER_NAME"]
    policy_arn = os.environ["HALT_POLICY_ARN"]

    # **イベントの中身で分岐しない。** この関数を呼べるのは、リソースポリシーで
    # 許可した 1 つの SNS トピックだけであり、そのトピックへ Publish できるのは
    # トピックポリシーで許可した 1 つのアラームだけである。到達したという事実が
    # すでに「発火した」を意味する。中身を解析して条件を足すと、解析の失敗が
    # そのまま「止め損ない」になる。**費用ガードは、迷ったら止める側へ倒す。**
    #
    # ただし受け取ったものは丸ごとログへ残す。事後に原因を追うのはこのログである。
    print(json.dumps({"event": "layer2_triggered", "sns": event}, ensure_ascii=False))

    _iam.attach_user_policy(UserName=user, PolicyArn=policy_arn)

    result = {"event": "layer2_halted", "user": user, "policy_arn": policy_arn}
    print(json.dumps(result, ensure_ascii=False))
    return result
