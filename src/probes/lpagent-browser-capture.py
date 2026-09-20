import json
import time
import base64
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options


OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)

OUTPUT_FILE = OUTPUT_DIR / "lpagent-network-capture.json"

LPAGENT_URL = (
    "https://app.lpagent.io/pools/"
    "66RWZy7xGkUMQ4Aj3ws394nvfQJqFnfvsZmywZzfvwsi"
)

TARGET_DOMAIN = "api.lpagent.io"


def build_driver():
    options = Options()

    # Chrome normal, bukan headless.
    # Jadi kamu bisa login / klik secara manual.
    options.add_argument("--start-maximized")

    # Aktifkan performance log Chrome
    options.set_capability(
        "goog:loggingPrefs",
        {
            "performance": "ALL"
        }
    )

    driver = webdriver.Chrome(
        options=options
    )

    # Aktifkan Chrome DevTools Network
    driver.execute_cdp_cmd(
        "Network.enable",
        {}
    )

    return driver


def get_response_body(driver, request_id):
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
            try:
                body = (
                    base64
                    .b64decode(body)
                    .decode(
                        "utf-8",
                        errors="replace"
                    )
                )
            except Exception:
                pass

        return body

    except Exception:
        return None


def try_parse_json(text):
    if not text:
        return None

    try:
        return json.loads(text)
    except Exception:
        return text


def main():
    driver = build_driver()

    captured = []
    seen_request_ids = set()

    try:
        print(
            "\n=== LP AGENT BROWSER CAPTURE ==="
        )

        print(
            f"Opening:\n{LPAGENT_URL}\n"
        )

        driver.get(
            LPAGENT_URL
        )

        print(
            "Browser sudah terbuka."
        )

        print()
        print(
            "Sekarang lakukan secara manual:"
        )

        print(
            "1. Login ke LP Agent jika diperlukan."
        )

        print(
            "2. Buka tab Top LPer."
        )

        print(
            "3. Coba pagination / filter jika ada."
        )

        print(
            "4. Tunggu beberapa detik."
        )

        print()
        print(
            "Script akan capture request api.lpagent.io."
        )

        print(
            "Tekan ENTER di terminal jika sudah selesai..."
        )

        # Collect terus sampai user tekan enter.
        input()

        print(
            "\nProcessing network logs..."
        )

        logs = driver.get_log(
            "performance"
        )

        responses = []

        for entry in logs:
            try:
                message = json.loads(
                    entry["message"]
                )["message"]
            except Exception:
                continue

            if (
                message.get("method")
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

            if TARGET_DOMAIN not in url:
                continue

            request_id = params.get(
                "requestId"
            )

            if not request_id:
                continue

            if request_id in seen_request_ids:
                continue

            seen_request_ids.add(
                request_id
            )

            responses.append(
                {
                    "requestId":
                        request_id,

                    "url":
                        url,

                    "status":
                        response.get(
                            "status"
                        ),

                    "mimeType":
                        response.get(
                            "mimeType"
                        ),

                    "type":
                        params.get(
                            "type"
                        ),
                }
            )

        print(
            f"Found {len(responses)} LP Agent responses."
        )

        for index, item in enumerate(
            responses,
            start=1
        ):
            request_id = item[
                "requestId"
            ]

            body = get_response_body(
                driver,
                request_id
            )

            parsed_body = (
                try_parse_json(
                    body
                )
            )

            result = {
                "index":
                    index,

                "url":
                    item["url"],

                "status":
                    item["status"],

                "mimeType":
                    item["mimeType"],

                "resourceType":
                    item["type"],

                "response":
                    parsed_body,
            }

            captured.append(
                result
            )

            print()
            print(
                f"[{index}] "
                f"{item['status']} "
                f"{item['url']}"
            )

            if isinstance(
                parsed_body,
                dict
            ):
                print(
                    "  JSON keys:",
                    list(
                        parsed_body.keys()
                    )
                )

            elif isinstance(
                parsed_body,
                list
            ):
                print(
                    f"  JSON list length: "
                    f"{len(parsed_body)}"
                )

        with open(
            OUTPUT_FILE,
            "w",
            encoding="utf-8"
        ) as f:
            json.dump(
                {
                    "capturedAt":
                        time.strftime(
                            "%Y-%m-%dT%H:%M:%S"
                        ),

                    "page":
                        driver.current_url,

                    "responses":
                        captured,
                },
                f,
                indent=2,
                ensure_ascii=False
            )

        print()
        print(
            "================================"
        )

        print(
            "CAPTURE COMPLETE"
        )

        print(
            "================================"
        )

        print(
            f"Responses captured : "
            f"{len(captured)}"
        )

        print(
            f"Output             : "
            f"{OUTPUT_FILE}"
        )

        print(
            "================================"
        )

    finally:
        driver.quit()


if __name__ == "__main__":
    main()