/**
 * OGP 撮影関数（5.4 / 11.2 / #26）。
 *
 * 公開された作品の `/g/<game_id>/` を headless chromium で開き、**初回フレームの
 * 静止画を 1 枚**撮って、アプリ用ホストのコールバックへ PNG として送り返す。
 *
 * ## 何を受け取り、何を受け取らないか
 *
 * ペイロードは `{ gameId, ogpToken }` の 2 つだけである。**撮る URL も送り先も
 * 受け取らない**（環境変数が持つ。terraform/ogp-function.tf）。ペイロードを
 * 差し替えられる者に、撮る先と送り先を決めさせないためである。
 *
 * ## 「初回フレーム」をどう見分けるか
 *
 * **ローダーが自分で教えてくれる。** src/sandbox-loader.ts の文書は、
 * `WebAssembly.instantiateStreaming` が解決して `go.run` を呼ぶ直前に
 * `#gf-status` を隠す（`status.hidden = true`）。すなわち
 *
 *     document.getElementById('gf-status').hidden === true
 *
 * が真になった時点で、**wasm は起動している。** そこから Ebitengine が canvas を
 * 作って最初の描画をするまでの短い間だけ待てばよい。
 *
 * **固定の待ち時間だけで済ませない。** 「N 秒待って撮る」形は、遅い日に
 * 「読み込み中」の文字を撮り、速い日にも同じだけ待つ。**合図を待ってから、
 * 描画のぶんだけ待つ。**
 *
 * この綴り（`gf-status`）は src/sandbox-loader.ts の写しである。ずれると
 * **撮影が必ず時間切れになる**（合図が永遠に来ない）ので、scripts/check-ogp-copies.sh が
 * 機械で突き合わせる。
 *
 * ## 黙って終わらない
 *
 * 撮れなかったときは**必ず失敗のコールバックを送る。** 送らないと
 * `games.ogp_state` が `capturing` のまま残り、誰も進められない行になる
 * （src/ogp.ts）。関数の中で諦める時間（`CAPTURE_TIMEOUT_MS`）を Lambda の
 * タイムアウトより短くしてあるのは、**そのコールバックを送る時間を残すため**である。
 *
 * ## 設定は 1 つも既定値を持たない
 *
 * 撮る大きさも待ち時間も、**宣言（terraform/ogp-function.tf の `environment`）が
 * 無ければ起動の時点で落ちる**（./config.mjs）。既定値を置くと、宣言が落ちても
 * 関数は自前の値で走り続け、**宣言と実物がずれたまま検査が緑になる。**
 * 理由の全文は ./config.mjs の冒頭にある。
 *
 * ## ログに秘密を出さない
 *
 * `ogpToken` はこの 1 行を進められる資格情報である。**ログへ出さない**
 * （src/bedrock.ts / src/build-client.ts と同じ方針）。出すのは作品 id と、
 * 失敗の種別だけである。
 */
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { readConfig } from './config.mjs';

/**
 * コールバックのパス。
 *
 * **src/ogp.ts の `OGP_CALLBACK_PATH` の写しである。** ずれると撮れた画像が
 * 届かない。scripts/check-ogp-copies.sh が突き合わせる。
 */
const CALLBACK_PATH = '/api/ogp/callback';

/** コールバックのヘッダ名（src/ogp.ts の写し。同上）。 */
const GAME_ID_HEADER = 'x-gf-game-id';
const TOKEN_HEADER = 'x-gf-ogp-token';

/** ローダーが起動時に隠す要素の id（src/sandbox-loader.ts の写し。同上）。 */
const LOADER_STATUS_ID = 'gf-status';

/**
 * 合図が出てから撮るまでの待ち時間（ミリ秒）。
 *
 * **1,500 ms。** `go.run` が呼ばれてから Ebitengine が canvas を作り、最初のフレームを
 * 描くまでの猶予である。**これは見積もりであって実測ではない**（本番でまだ 1 枚も
 * 撮っていない）。撮れた画像が黒い・白いなら、まずこの値を疑うこと。
 */
const FIRST_FRAME_SETTLE_MS = 1500;

/** `games.id` の綴り（`crypto.randomUUID()` が返す形）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 使い捨てトークンの綴り（16 進 64 桁）。 */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * 撮影の結果を送り返す。
 *
 * **成功は PNG そのものを本文にする。** base64 で包むと 33% 太り、受け取る側は
 * 復号してから形を確かめることになる。識別子はヘッダに載る（src/ogp.ts）。
 *
 * @param {object} config 設定
 * @param {string} gameId 作品 id
 * @param {string} token 使い捨てトークン
 * @param {Buffer | null} png 撮れた画像（失敗なら null）
 * @returns {Promise<void>}
 */
async function sendCallback(config, gameId, token, png) {
  const headers = {
    [GAME_ID_HEADER]: gameId,
    [TOKEN_HEADER]: token,
    'content-type': png === null ? 'application/json' : 'image/png',
  };
  const response = await fetch(`${config.callbackBaseUrl}${CALLBACK_PATH}`, {
    method: 'POST',
    headers,
    body: png === null ? JSON.stringify({ error: 'capture-failed' }) : png,
  });
  // **本文は読まない。** 受け取る側が返すのは受理の可否だけで、こちらにできることは
  // 無い（再送はしない。基盤の再試行が 1 回だけある。terraform/ogp-function.tf）。
  console.log(
    JSON.stringify({
      at: 'callback',
      gameId,
      ok: png !== null,
      status: response.status,
    }),
  );
}

/**
 * 1 枚撮る。
 *
 * @param {object} config 設定
 * @param {string} gameId 作品 id
 * @returns {Promise<Buffer>} PNG
 */
async function capture(config, gameId) {
  const target = `${config.sandboxBaseUrl}/g/${gameId}/`;

  // **WebGL を有効にする。** 既定では graphics mode が切られており、そのままだと
  // Ebitengine（WebGL）は起動できず、**真っ黒な画像が撮れてしまう**（撮影そのものは
  // 成功するので、黙って壊れる形になる）。
  chromium.setGraphicsMode = true;

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: config.width, height: config.height, deviceScaleFactor: 1 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    // ページ内のエラーは撮影の失敗の手掛かりになる。**本文は出さない**（UGC である）。
    page.on('pageerror', (error) => {
      console.log(JSON.stringify({ at: 'pageerror', gameId, name: error.name }));
    });

    const deadline = Date.now() + config.captureTimeoutMs;
    await page.goto(target, { waitUntil: 'load', timeout: config.captureTimeoutMs });

    // **ローダーの合図を待つ**（モジュール冒頭）。`go.run` の直前に `#gf-status` が
    // 隠れる。canvas も出来ていることを同時に見る。
    await page.waitForFunction(
      (statusId) => {
        const status = document.getElementById(statusId);
        return status !== null && status.hidden === true && document.querySelector('canvas') !== null;
      },
      { timeout: Math.max(1000, deadline - Date.now()), polling: 100 },
      LOADER_STATUS_ID,
    );

    // 最初のフレームが描かれるまでの猶予。
    await new Promise((resolve) => setTimeout(resolve, FIRST_FRAME_SETTLE_MS));

    return await page.screenshot({ type: 'png', fullPage: false });
  } finally {
    // **必ず閉じる。** 閉じないと、暖まった実行環境が次の呼び出しでメモリを引きずる。
    await browser.close();
  }
}

/**
 * Lambda の入口。
 *
 * @param {{ gameId?: unknown, ogpToken?: unknown }} event ペイロード
 * @returns {Promise<{ ok: boolean }>}
 */
export async function handler(event) {
  const config = readConfig();

  const gameId = typeof event?.gameId === 'string' ? event.gameId : '';
  const token = typeof event?.ogpToken === 'string' ? event.ogpToken : '';
  // **形を確かめてから使う。** gameId は URL へ、token はヘッダへ入る。
  if (!GAME_ID_PATTERN.test(gameId) || !TOKEN_PATTERN.test(token)) {
    // **コールバックも送れない**（どの行を進めてよいか分からない）。
    // ここは呼び出し側の誤りなので、例外として基盤のログへ残す。
    throw new Error('ペイロードの形が正しくありません');
  }

  let png = null;
  try {
    png = await capture(config, gameId);
    console.log(JSON.stringify({ at: 'captured', gameId, bytes: png.length }));
  } catch (error) {
    // **握り潰さない。失敗として送り返す**（モジュール冒頭「黙って終わらない」）。
    console.log(
      JSON.stringify({
        at: 'capture-failed',
        gameId,
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
  }

  await sendCallback(config, gameId, token, png);
  return { ok: png !== null };
}
