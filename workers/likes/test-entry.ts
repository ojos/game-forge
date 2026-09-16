/**
 * テストの実行体の入口（`vitest.config.ts` の `main`）。**本番では使わない。**
 *
 * # なぜ入口を分けるのか
 *
 * 本番では、Pages（`src/index.ts`）と `game-forge-likes`（`workers/likes/src/index.ts`）は
 * **別のスクリプト**で、Pages は `script_name` で向こうの `LikeHub` を指す。テストで同じ
 * 形を作るには、Miniflare に 2 本目の Worker を立てる必要があるが、**2 本目は
 * TypeScript をそのまま動かせず**（事前に JavaScript へ束ねる必要がある）、しかも
 * `cloudflare:test` の `runInDurableObject` / `runDurableObjectAlarm` は**自分自身の DO に
 * しか使えない**。後者が無いと、「101 回目が DO に書かない」と「アラームの同期」を
 * 中から確かめられない。
 *
 * **だからテストでは、Pages の既定の輸出はそのまま（`src/index.ts`）に、`LikeHub` を
 * 同じ実行体へ並べて輸出する。** バインディング `LIKE_HUB` は `vitest.config.ts` で
 * 自分自身を指すように差し替える。**失うのは「別スクリプトを指す結線」の検証だけ**で、
 * それは Miniflare では本番と同じにならない部分である（`docs/likes.md` の
 * 「確かめられていないこと」）。
 */
/**
 * **本番で別スクリプトになる DO は、すべてここへ並べる。**
 *
 * `vitest.config.ts` の `main` はこのファイル 1 本で、Miniflare はここから見える DO しか
 * 立てられない。`WithdrawalHub`（退会の後続の処理。`workers/cleanup/`。#586）は本番では
 * `game-forge-likes` とは**別の Worker**（`game-forge-cleanup`）に載り、**Pages からは指されない**
 * が、アラームの結線を中から確かめる手段が `runDurableObjectAlarm` しか無いので、ここに並べる。
 * **置き場がこのファイルなのは、テストの実行体が 1 つしか無いからであって、
 * `game-forge-likes` に載るからではない。**
 */
export { default } from '../../src/index.js';
export { LikeHub } from './src/hub.js';
export { PlayHub } from './src/play-hub.js';
export { WithdrawalHub } from '../cleanup/src/hub.js';
