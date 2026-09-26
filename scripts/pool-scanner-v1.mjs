import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const SOL_MINT =
    "So11111111111111111111111111111111111111112";

const METEORA_API =
    "https://dlmm.datapi.meteora.ag/pools";

const CDP_URL =
    process.env.CDP_URL ??
    "http://127.0.0.1:9222";


// ======================================================
// CLI
// ======================================================

function getArg(name) {
    const index = process.argv.indexOf(name);

    if (index === -1) {
        return null;
    }

    return process.argv[index + 1] ?? null;
}


const TOKEN_CA =
    getArg("--token") ??
    process.env.TOKEN_CA;

if (!TOKEN_CA) {
    throw new Error(
        "Token CA diperlukan. Gunakan --token <TOKEN_CA>"
    );
}


// ======================================================
// TUNING VARIABLES
// ======================================================

// Delay antar infinite-scroll page.
const MIN_SCROLL_DELAY =
    Number(getArg("--min-delay") ?? 400);

const MAX_SCROLL_DELAY =
    Number(getArg("--max-delay") ?? 800);

// Delay setelah selesai satu pool sebelum pindah pool.
const MIN_POOL_DELAY = 2000;
const MAX_POOL_DELAY = 4500;


// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
    return new Promise((resolve) =>
        setTimeout(resolve, ms)
    );
}


function randomDelay(min, max) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}


async function waitUntil(
    condition,
    timeout = 20000,
    interval = 250
) {
    const started = Date.now();

    while (true) {
        if (condition()) {
            return;
        }

        if (Date.now() - started > timeout) {
            throw new Error("waitUntil timeout");
        }

        await sleep(interval);
    }
}


// ======================================================
// METEORA POOL DISCOVERY
// ======================================================

async function discoverPools(tokenCA) {
    const url = new URL(METEORA_API);

    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", "1000");
    url.searchParams.set("query", tokenCA);

    console.log("\n[Meteora] Discovering pools...");

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Meteora API HTTP ${response.status}`
        );
    }

    const json = await response.json();

    const pools = [];

    for (const pool of json.data ?? []) {
        const tokenX = pool.token_x ?? {};
        const tokenY = pool.token_y ?? {};

        const xAddress = tokenX.address;
        const yAddress = tokenY.address;

        /*
          Exact filter:
          TOKEN/SOL atau SOL/TOKEN saja.
        */
        const isTokenSol =
            (
                xAddress === tokenCA &&
                yAddress === SOL_MINT
            ) ||
            (
                xAddress === SOL_MINT &&
                yAddress === tokenCA
            );

        if (!isTokenSol) {
            continue;
        }

        pools.push({
            pool: pool.address,

            pair:
                `${tokenX.symbol ?? "?"}/` +
                `${tokenY.symbol ?? "?"}`,

            binStep:
                pool.pool_config?.bin_step ?? null,

            tokenX: xAddress,
            tokenY: yAddress,
        });
    }

    console.log(
        `[Meteora] Total API results: ${json.total}`
    );

    console.log(
        `[Meteora] TOKEN/SOL pools: ${pools.length}`
    );

    for (const [index, pool] of pools.entries()) {
        console.log(
            `  ${index + 1}. ` +
            `${pool.pair}` +
            ` | bin=${pool.binStep}` +
            ` | ${pool.pool}`
        );
    }

    return pools;
}


// ======================================================
// LP AGENT POOL SCANNER
// ======================================================

async function fetchTopLpersPage(
  page,
  poolAddress,
  pageNumber
) {
  return await page.evaluate(
    async ({ poolAddress, pageNumber }) => {
      const url =
        `https://api.lpagent.io/api/v1/pools/${poolAddress}/top-lpers` +
        `?page=${pageNumber}` +
        `&pageSize=20` +
        `&order_by=total_pnl_native` +
        `&sort_order=desc`;

      const response = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `LP Agent HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }

      const json = JSON.parse(text);

      if (
        json?.status !== "success" ||
        !Array.isArray(json?.data)
      ) {
        throw new Error(
          `Invalid LP Agent response page ${pageNumber}`
        );
      }

      return json;
    },
    {
      poolAddress,
      pageNumber,
    }
  );
}


async function scanPoolDirect(
  page,
  poolAddress
) {
  const owners = new Set();

  await page.goto(
    `https://app.lpagent.io/pools/${poolAddress}?tab=top`,
    {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    }
  );

  const first =
    await fetchTopLpersPage(
      page,
      poolAddress,
      1
    );

  const totalPages =
    Number(
      first?.pagination?.totalPages ?? 1
    );

  const totalCount =
    Number(
      first?.pagination?.totalCount ?? 0
    );

  for (const row of first.data) {
    if (
      typeof row?.owner === "string" &&
      row.owner.trim()
    ) {
      owners.add(row.owner.trim());
    }
  }

  console.log(
    `    Page 1/${totalPages} | rows=${first.data.length} | unique=${owners.size}`
  );

  console.log(
    `    Top LPers=${totalCount} | pages=${totalPages}`
  );

  for (
    let pageNumber = 2;
    pageNumber <= totalPages;
    pageNumber++
  ) {
    const delay =
      350 +
      Math.floor(
        Math.random() * 450
      );

    await new Promise(
      (resolve) =>
        setTimeout(resolve, delay)
    );

    const json =
      await fetchTopLpersPage(
        page,
        poolAddress,
        pageNumber
      );

    for (const row of json.data) {
      if (
        typeof row?.owner === "string" &&
        row.owner.trim()
      ) {
        owners.add(row.owner.trim());
      }
    }

    console.log(
      `    Page ${pageNumber}/${totalPages} | rows=${json.data.length} | unique=${owners.size}`
    );
  }

  console.log(
    `    COMPLETE | pages=${totalPages} | wallets=${owners.size}`
  );

  return {
    owners: [...owners],
    totalPages,
    totalCount,
  };
}


// ======================================================
// OUTPUT
// ======================================================

async function saveOutputs({
    outputDirectory,
    tokenCA,
    pools,
    poolResults,
    wallets,
}) {
    await fs.mkdir(
        outputDirectory,
        {
            recursive: true,
        }
    );


    await fs.writeFile(
        path.join(
            outputDirectory,
            "pools.json"
        ),

        JSON.stringify(
            pools,
            null,
            2
        ) + "\n"
    );


    await fs.writeFile(
        path.join(
            outputDirectory,
            "wallets.json"
        ),

        JSON.stringify(
            [...wallets].sort(),
            null,
            2
        ) + "\n"
    );


    const successful =
        poolResults.filter(
            (result) =>
                result.status === "success" ||
                result.status === "ok"
        );

    const failed =
        poolResults.filter(
            (result) =>
                result.status === "failed"
        );


    const summary = {
        tokenCa: tokenCA,

        generatedAt:
            new Date().toISOString(),

        poolCount:
            pools.length,

        poolsScanned:
            successful.length,

        poolsFailed:
            failed.length,

        uniqueWallets:
            wallets.size,

        pools:
            poolResults.map(
                (result) => ({
                    pool:
                        result.pool,

                    pair:
                        result.pair,

                    binStep:
                        result.binStep,

                    status:
                        result.status,

                    walletCount:
                        Array.isArray(result.wallets)
                            ? result.wallets.length
                            : (typeof result.wallets === "number"
                                ? result.wallets
                                : (result.wallets?.length ?? 0)),

                    reportedTopLpers:
                        result.reportedTopLpers ??
                        result.totalCount ??
                        null,

                    pages:
                        result.pages ?? null,

                    error:
                        result.error ?? null,
                })
            ),
    };


    await fs.writeFile(
        path.join(
            outputDirectory,
            "summary.json"
        ),

        JSON.stringify(
            summary,
            null,
            2
        ) + "\n"
    );
}


// ======================================================
// MAIN
// ======================================================

async function main() {
    console.log(
        "======================================"
    );

    console.log(
        "POOL SCANNER V1"
    );

    console.log(
        "======================================"
    );

    console.log(
        "Token:",
        TOKEN_CA
    );


    // --------------------------------------------------
    // 1. Meteora
    // --------------------------------------------------

    const pools =
        await discoverPools(
            TOKEN_CA
        );


    if (!pools.length) {
        console.log(
            "\nNo TOKEN/SOL pools found."
        );

        return;
    }


    // --------------------------------------------------
    // 2. Browser
    // --------------------------------------------------

    console.log(
        "\n[Browser] Connecting..."
    );

    const browser =
        await chromium.connectOverCDP(
            CDP_URL
        );


    const context =
        browser.contexts()[0];


    if (!context) {
        throw new Error(
            "Browser context tidak ditemukan"
        );
    }


    let page =
        context
            .pages()
            .find(
                (page) =>
                    !page.isClosed() &&
                    page
                        .url()
                        .includes(
                            "app.lpagent.io"
                        )
            );


    if (!page) {
        page =
            await context.newPage();
    }


    // --------------------------------------------------
    // 3. Scan pools
    // --------------------------------------------------

    const globalWallets =
        new Set();

    const poolResults = [];


    const outputDirectory =
        path.join(
            "data",
            "discovery",
            "pool-scanner",
            TOKEN_CA
        );


    for (
        let index = 0;
        index < pools.length;
        index++
    ) {
        const pool =
            pools[index];

        console.log(
            `\n======================================`
        );

        console.log(
            `POOL ${index + 1}/${pools.length}`
        );

        console.log(
            `======================================`
        );


        console.log(
            `\n[Pool] ${pool.pair}` +
            ` | bin=${pool.binStep}`
        );

        console.log(
            `       ${pool.pool}`
        );


        try {
            const result =
                await scanPoolDirect(
                    page,
                    pool.pool
                );


            for (
                const owner of
                result.owners
            ) {
                globalWallets.add(
                    owner
                );
            }


            poolResults.push({
                status: "ok",

                pool:
                    pool.pool,

                pair:
                    pool.pair,

                binStep:
                    pool.binStep,

                wallets:
                    result.owners,

                pages:
                    result.totalPages,

                totalCount:
                    result.totalCount,

                reportedTopLpers:
                    result.totalCount,
            });


            console.log(
                `\n[Global] Unique wallets: ${globalWallets.size}`
            );


        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            console.error(
                `    FAILED: ${message}`
            );


            poolResults.push({
                status: "failed",

                pool:
                    pool.pool,

                pair:
                    pool.pair,

                binStep:
                    pool.binStep,

                wallets: [],

                pages: 0,

                totalCount: 0,

                error:
                    message,
            });


            /*
              Save checkpoint sebelum throw error,
              sehingga hasil failure dan pool sebelumnya tersimpan.
            */
            await saveOutputs({
                outputDirectory,

                tokenCA:
                    TOKEN_CA,

                pools,

                poolResults,

                wallets:
                    globalWallets,
            });


            throw error;
        }


        /*
          Save checkpoint setelah setiap pool.
          Kalau scanner berhenti di tengah jalan,
          hasil sebelumnya tidak hilang.
        */
        await saveOutputs({
            outputDirectory,

            tokenCA:
                TOKEN_CA,

            pools,

            poolResults,

            wallets:
                globalWallets,
        });


        if (
            index <
            pools.length - 1
        ) {
            const poolDelay =
                randomDelay(
                    MIN_POOL_DELAY,
                    MAX_POOL_DELAY
                );

            console.log(
                `[Global] Waiting ${poolDelay}ms` +
                ` before next pool...`
            );

            await sleep(
                poolDelay
            );
        }
    }


    // --------------------------------------------------
    // FINAL
    // --------------------------------------------------

    console.log(
        "\n======================================"
    );

    console.log(
        "POOL SCANNER V1 COMPLETE"
    );

    console.log(
        "======================================"
    );

    console.log(
        "TOKEN/SOL pools:",
        pools.length
    );

    console.log(
        "Unique wallets:",
        globalWallets.size
    );

    console.log(
        "Output:",
        outputDirectory
    );


    /*
      Jangan browser.close().
      Kita reuse Brave profile yang sama untuk Fabriq.
    */
    process.exit(0);
}


main().catch(
    (error) => {

        console.error(
            "\nPOOL SCANNER V1 FAILED"
        );

        console.error(
            error
        );

        process.exit(1);
    }
);