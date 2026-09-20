import json
import time
import base64
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options


# ============================================================
# CONFIG
# ============================================================

POOL = "66RWZy7xGkUMQ4Aj3ws394nvfQJqFnfvsZmywZzfvwsi"

POOL_URL = f"https://app.lpagent.io/pools/{POOL}"

TARGET_TEXT = "/top-lpers"

CAPTURE_SECONDS = 90

OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)

OUTPUT_FILE = OUTPUT_DIR / "lpagent-single-pool-test.json"

PROFILE_DIR = (
    Path.home()
    / "Documents"
    / "selenium-lpagent-profile"
)


# ============================================================
# DRIVER
# ============================================================

def build_driver():

    options = Options()

    # Dedicated persistent profile.
    # Login / Cloudflare session bisa tersimpan antar-run.
    options.add_argument(
        f"--user-data-dir={PROFILE_DIR}"
    )

    options.add_argument(
        "--start-maximized"
    )

    options.set_capability(
        "goog:loggingPrefs",
        {
            "performance": "ALL"
        }
    )

    driver = webdriver.Chrome(
        options=options
    )

    driver.execute_cdp_cmd(
        "Network.enable",
        {}
    )

    return driver


# ============================================================
# RESPONSE HELPERS
# ============================================================

def get_response_body(
    driver,
    request_id
):

    try:

        result = driver.execute_cdp_cmd(
            "Network.getResponseBody",
            {
                "requestId": request_id
            }
        )

        body = result.get(
            "body",
            ""
        )

        if result.get(
            "base64Encoded",
            False
        ):

            body = (
                base64
                .b64decode(body)
                .decode(
                    "utf-8",
                    errors="replace"
                )
            )

        return body

    except Exception:
        return None


def parse_json(
    value
):

    if not value:
        return None

    try:
        return json.loads(
            value
        )

    except Exception:
        return None


# ============================================================
# EXTRACT WALLET RECORDS
# ============================================================

def find_wallet_list(
    obj
):

    if isinstance(
        obj,
        list
    ):

        if (
            len(obj) > 0
            and isinstance(
                obj[0],
                dict
            )
            and "owner" in obj[0]
        ):
            return obj

        for item in obj:

            result = find_wallet_list(
                item
            )

            if result is not None:
                return result

    elif isinstance(
        obj,
        dict
    ):

        for value in obj.values():

            result = find_wallet_list(
                value
            )

            if result is not None:
                return result

    return None


# ============================================================
# MAIN
# ============================================================

def main():

    driver = build_driver()

    captures = []

    seen_request_ids = set()

    wallets = {}

    try:

        print(
            "========================================"
        )

        print(
            "LP AGENT SINGLE POOL TEST"
        )

        print(
            "========================================"
        )

        print(
            f"Pool    : {POOL}"
        )

        print(
            f"Page    : {POOL_URL}"
        )

        print(
            f"Profile : {PROFILE_DIR}"
        )

        print()

        driver.get(
            POOL_URL
        )

        print(
            "Browser sudah terbuka."
        )

        print()
        print(
            "Lakukan manual:"
        )

        print(
            "1. Selesaikan Cloudflare jika muncul."
        )

        print(
            "2. Login ke LP Agent jika diperlukan."
        )

        print(
            "3. Pastikan halaman pool sudah terbuka."
        )

        print(
            "4. Klik tab Top LPer."
        )

        print()

        input(
            "Kalau tabel Top LPer sudah terlihat, tekan ENTER di terminal..."
        )

        print()
        print(
            f"Capture dimulai selama {CAPTURE_SECONDS} detik."
        )

        print(
            "Selama capture, coba klik page 2, page 3, lalu kembali page 1."
        )

        print()

        started_at = time.time()

        while (
            time.time()
            - started_at
            <
            CAPTURE_SECONDS
        ):

            logs = driver.get_log(
                "performance"
            )

            for entry in logs:

                try:

                    message = json.loads(
                        entry[
                            "message"
                        ]
                    )[
                        "message"
                    ]

                except Exception:
                    continue

                if (
                    message.get(
                        "method"
                    )
                    !=
                    "Network.responseReceived"
                ):
                    continue

                params = message.get(
                    "params",
                    {}
                )

                response = params.get(
                    "response",
                    {}
                )

                url = response.get(
                    "url",
                    ""
                )

                if (
                    "api.lpagent.io"
                    not in url
                ):
                    continue

                if (
                    TARGET_TEXT
                    not in url
                ):
                    continue

                request_id = params.get(
                    "requestId"
                )

                if (
                    not request_id
                ):
                    continue

                if (
                    request_id
                    in
                    seen_request_ids
                ):
                    continue

                seen_request_ids.add(
                    request_id
                )

                body = get_response_body(
                    driver,
                    request_id
                )

                parsed = parse_json(
                    body
                )

                capture = {
                    "url":
                        url,

                    "status":
                        response.get(
                            "status"
                        ),

                    "response":
                        parsed
                }

                captures.append(
                    capture
                )

                print()
                print(
                    "[TOP LPERS RESPONSE]"
                )

                print(
                    f"Status : {response.get('status')}"
                )

                print(
                    f"URL    : {url}"
                )

                wallet_list = (
                    find_wallet_list(
                        parsed
                    )
                    if parsed
                    else None
                )

                if wallet_list:

                    print(
                        f"Wallet rows : {len(wallet_list)}"
                    )

                    for item in wallet_list:

                        owner = item.get(
                            "owner"
                        )

                        if not owner:
                            continue

                        wallets[
                            owner
                        ] = item

                else:

                    print(
                        "Wallet list tidak ditemukan otomatis."
                    )

            time.sleep(
                0.5
            )

        # ====================================================
        # SAVE RESULT
        # ====================================================

        result = {

            "capturedAt":
                time.strftime(
                    "%Y-%m-%dT%H:%M:%S"
                ),

            "pool":
                POOL,

            "page":
                driver.current_url,

            "responsesCaptured":
                len(captures),

            "uniqueWallets":
                len(wallets),

            "captures":
                captures,

            "wallets":
                list(
                    wallets.values()
                ),
        }

        with open(
            OUTPUT_FILE,
            "w",
            encoding="utf-8"
        ) as f:

            json.dump(
                result,
                f,
                indent=2,
                ensure_ascii=False
            )

        print()
        print(
            "========================================"
        )

        print(
            "TEST COMPLETE"
        )

        print(
            "========================================"
        )

        print(
            f"Top-LPer responses : {len(captures)}"
        )

        print(
            f"Unique wallets      : {len(wallets)}"
        )

        print(
            f"Output              : {OUTPUT_FILE}"
        )

        print(
            "========================================"
        )

        input(
            "\nTekan ENTER untuk menutup browser..."
        )

    finally:

        driver.quit()


if __name__ == "__main__":
    main()