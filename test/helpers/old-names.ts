/**
 * 利用者に見える文言から消した旧い呼び名（#513）。
 *
 * **「改造」は「フォーク」、「推敲」「手直し」は「リフォージ」に呼び替えた**（2026-09-14 の利用者の決定。
 * 仕様の付録の確定事項）。画面・メール・FAQ・プライバシーポリシーの出力にこの語が戻っていないことを、
 * 画面ごとのテストがこの 1 つの正規表現で確かめる。**語を画面ごとに書き写さない**——1 画面だけ古い語の
 * 一覧で見ていると、その画面にだけ旧語が戻っても緑になる。
 *
 * **コード・DB・URL・ログの識別子とコメントは対象の外である**（#513 の scope.out）。見るのは出力だけ。
 */
export const OLD_OPERATION_NAMES = /改造|推敲|手直し/gu;

/**
 * 出力に含まれる旧い呼び名を、前後の文字つきで返す（見つからなければ空の配列）。
 *
 * **失敗したときに、どこに残っているかが読めるように前後を付ける。** 件数だけだと、長い HTML の
 * どこを直せばよいか分からない。
 *
 * @param text 画面の HTML やメールの本文
 * @returns 見つかった箇所（前後 20 文字つき）
 */
export function oldOperationNamesIn(text: string): string[] {
  return [...text.matchAll(OLD_OPERATION_NAMES)].map((match) => {
    const start = Math.max(0, match.index - 20);
    return text.slice(start, match.index + match[0].length + 20);
  });
}
