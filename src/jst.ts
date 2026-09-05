/**
 * 日本時間の表示（UNIX 秒 → 画面に出す文字列）。
 *
 * ## なぜ独立した葉なのか
 *
 * **#152 の「あなたの作品」一覧が持っていたものを、ここへ出した**（#328）。公開作品の
 * 一覧（`src/works-list.ts`）と作品カード（`src/work-card.ts`）が同じ表記を要るように
 * なり、**書き写すと表記が画面ごとにずれる**（`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * 置き場を `src/html.ts` にしなかったのは、あちらが**外枠の HTML** を組む役で、
 * 日時の表記は別の関心事だからである。どちらも「誰からも借りられる葉」だが、
 * 混ぜると片方を読む理由でもう片方が付いてくる。
 *
 * ## `Intl` / `toLocaleString` を使わない
 *
 * ランタイムに積まれた ICU データの版で出力が変わりうるものを、テストで固定したい
 * 表示面へ持ち込まない。オフセットを足して `toISOString` から切り出すほうが、
 * **どの環境でも同じ文字列**になる。
 */

/** JST の UTC からのずれ（秒）。日本には夏時間が無いため固定でよい。 */
const JST_OFFSET_SECONDS = 9 * 60 * 60;

/**
 * UNIX 秒を ISO 8601 の文字列にする。**読めない値では例外を投げず null を返す。**
 *
 * # なぜ `Number.isFinite` だけでは足りないのか
 *
 * **`Date#toISOString()` は Date が範囲外のときに `RangeError` を投げる。** JavaScript の
 * Date が表せるのは ±8.64e15 ミリ秒（西暦 ±約 27 万年）までで、有限な数でもこの外に
 * 出れば `new Date(...)` は Invalid Date になり、`toISOString()` がそこで投げる。
 *
 * **投げると一覧全体が 500 になる。** `created_at` が想定外の値になった行が 1 つ
 * あるだけで、**他の作品まで見えなくなる。** #152 が作ろうとしているのは「URL を
 * 控えていなくても戻れる道」であり、1 行の異常で道ごと消える形はその性質と噛み合わない。
 * 日時は行の付加情報であって、行を出す条件ではない。
 *
 * 判定を `getTime()` の NaN で行うのは、**範囲外かどうかを桁で書き写さない**ためである
 * （境界値をこちらに複製すると、ランタイムの定義とずれても気づけない）。Date に作らせて、
 * 作れたかどうかを聞く。
 *
 * @param epochSeconds UNIX 秒
 * @param offsetSeconds 足すオフセット（秒）。既定は 0（UTC）
 * @returns ISO 8601 の文字列。読めない値なら null
 */
function isoFrom(epochSeconds: number, offsetSeconds = 0): string | null {
  if (!Number.isFinite(epochSeconds)) {
    return null;
  }
  const date = new Date((epochSeconds + offsetSeconds) * 1000);
  // Invalid Date（範囲外）はここで捕まる。`toISOString()` を呼ぶ前に落とす。
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

/**
 * UNIX 秒を日本時間の `YYYY-MM-DD HH:MM` にする。
 *
 * **`Intl` / `toLocaleString` を使わない。** ランタイムに積まれた ICU データの版で
 * 出力が変わりうるものを、テストで固定したい表示面へ持ち込まない。オフセットを足して
 * `toISOString` から切り出すほうが、**どの環境でも同じ文字列**になる。
 *
 * @param epochSeconds UNIX 秒
 * @returns 日本時間の表記（読めない値なら空文字）
 */
export function formatJstMinutes(epochSeconds: number): string {
  const iso = isoFrom(epochSeconds, JST_OFFSET_SECONDS);
  if (iso === null) {
    return '';
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * UNIX 秒を `<time datetime="...">` に入れる ISO 8601（UTC）にする。
 *
 * 表示は日本時間だが、**機械が読む属性には時差を含んだ絶対時刻を入れる。**
 *
 * @param epochSeconds UNIX 秒
 * @returns ISO 8601 の文字列（読めない値なら空文字）
 */
export function toIsoTimestamp(epochSeconds: number): string {
  return isoFrom(epochSeconds) ?? '';
}

