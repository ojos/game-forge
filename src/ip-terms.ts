/**
 * 著名 IP 名の一覧（6.2 / #39）。**このファイルはデータだけを持つ。**
 *
 * 突き合わせの規則（正規化・語境界の扱い・開示の文言）は `src/ip-substitution.ts` に
 * あり、そちらには名前が 1 つも書かれていない。**`src/denied-terms.ts` と
 * `src/output-moderation.ts` の分け方をそのまま倒している。** 分ける理由は 2 つで、
 * **名前の増減はレビューで 1 ファイルに閉じる**ことと、**規則を試すテストが名前を
 * 1 つも要らなくなる**ことである（`test/ip-substitution.test.ts` はダミーを注入する）。
 *
 * ## この一覧は「拒否リスト」ではない
 *
 * **6.2 は拒否しない。** 「生成を拒否せず、コアとなるゲーム性のみ抽出し、安全な
 * パロディ・オリジナル要素に自動置換する」と定めている。置換そのものを行うのは
 * システムプロンプト（`src/system-prompt.ts` の `COPYRIGHT`。#16 で入った）であって、
 * この一覧ではない。**ここが決めるのは「開示を出すかどうか」だけである。**
 *
 * したがって**取りこぼしは拒否漏れにならない。** 一覧に無い名前が来ても、置換は
 * システムプロンプト側で起きる。起きないのは開示だけである。**逆に言えば、
 * この一覧を長くしても安全性は上がらない**——上がるのは開示の網羅性だけである。
 *
 * ## 誤検出のほうが害が大きい
 *
 * 当たると作者へ「置き換えました」と出る。**当たっていないのに出ると、こちらが
 * 嘘をつくことになる。** ASCII の短い名前は他の語の一部になりやすいので
 * （`mario` が `marionette` に含まれる）、`word` を立てて語境界を要求する。
 * 日本語には語境界が無いため、そちらは部分一致で見る。
 *
 * ## コードへ直書きにする
 *
 * `src/denied-terms.ts` と同じ理由による。外（D1 / 環境変数 / R2）へ出すと、
 * **読めなかった実行環境で一覧が空になり、開示が静かに出なくなる。**
 */

/** 一覧の 1 件。 */
export interface IpTerm {
  /**
   * 開示に出す正式名。**`games.ip_notice` へ入るのはこの値である**
   * （利用者が書いた文字列ではない。`migrations/0015_games_ip_notice.sql`）。
   */
  readonly label: string;
  /**
   * 突き合わせる綴り。表記ゆれをここへ並べる。`label` 自身も含めること
   * （規則の側は `label` を綴りとして使わない）。
   */
  readonly aliases: readonly string[];
  /**
   * 綴りに語境界を要求するか。**ASCII の短い名前では立てる**（上記）。
   * 日本語の綴りでは立てない（語境界が無いため、立てると当たらなくなる）。
   */
  readonly word?: boolean;
}

/**
 * 著名 IP 名。**網羅を目指さない**（冒頭のとおり、取りこぼしは拒否漏れにならない）。
 *
 * 足すときは `label` を 1 つに決め、表記ゆれを `aliases` へ並べること。
 */
export const IP_TERMS: readonly IpTerm[] = [
  { label: 'マリオ', aliases: ['マリオ', 'mario'], word: true },
  { label: 'ポケモン', aliases: ['ポケモン', 'ポケットモンスター', 'pokemon', 'pokémon'], word: true },
  { label: 'ゼルダ', aliases: ['ゼルダ', 'zelda'], word: true },
  { label: 'ドラゴンクエスト', aliases: ['ドラゴンクエスト', 'ドラクエ', 'dragon quest'] },
  { label: 'ファイナルファンタジー', aliases: ['ファイナルファンタジー', 'final fantasy'] },
  { label: 'ソニック', aliases: ['ソニック', 'sonic the hedgehog'] },
  { label: 'パックマン', aliases: ['パックマン', 'pac-man', 'pacman'], word: true },
  { label: 'カービィ', aliases: ['カービィ', 'カービー', 'kirby'], word: true },
  { label: 'メタルギア', aliases: ['メタルギア', 'metal gear'] },
  { label: 'ストリートファイター', aliases: ['ストリートファイター', 'ストファイ', 'street fighter'] },
  { label: 'マインクラフト', aliases: ['マインクラフト', 'マイクラ', 'minecraft'], word: true },
  { label: 'ドラゴンボール', aliases: ['ドラゴンボール', 'dragon ball'] },
  { label: 'ワンピース', aliases: ['ワンピース', 'one piece'] },
  { label: 'ガンダム', aliases: ['ガンダム', 'gundam'], word: true },
  { label: 'ディズニー', aliases: ['ディズニー', 'disney'], word: true },
  { label: 'スーパーマリオブラザーズ', aliases: ['スーパーマリオブラザーズ', 'super mario bros'] },
  { label: 'どうぶつの森', aliases: ['どうぶつの森', 'あつ森', 'animal crossing'] },
  { label: 'スプラトゥーン', aliases: ['スプラトゥーン', 'スプラ', 'splatoon'] },
];
