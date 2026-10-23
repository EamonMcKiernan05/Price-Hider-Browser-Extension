#!/usr/bin/env python3
"""
Load the Price Blocker extension into a Chromium-family browser.

Chrome 137+ ignores --load-extension for branded Chrome builds, so this
script does what the "Load unpacked" button does: writes the unpacked
extension into the profile's Secure Preferences as a developer-mode
extension, so it appears on every launch.

Usage:
    python3 install-into-profile.py <browser> [--profile-dir DIR]

    browser: chrome | brave
    Example:
    python3 install-into-profile.py chrome
    python3 install-into-profile.py brave --profile-dir ~/.config/BraveSoftware/Brave-Browser

The browser must be fully closed first, or it will overwrite the file.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

EXT_DIR = Path(__file__).resolve().parent

BROWSER_ROOTS = {
    "chrome": "~/.config/google-chrome",
    "brave": "~/.config/BraveSoftware/Brave-Browser",
    "chromium": "~/.config/chromium",
}

# Unpacked extensions get an ID derived from the absolute path. Chrome uses
# SHA-256 of the path, then maps the first 16 bytes to a-p.
def unpacked_id(path: Path) -> str:
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    raw = path.read_text()
    # Secure Preferences may carry a protection marker used on Windows only.
    return json.loads(raw.replace('\u0000', ""))


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("browser", choices=sorted(BROWSER_ROOTS))
    ap.add_argument("--profile-dir", default=None,
                    help="Override the browser's user data dir")
    args = ap.parse_args()

    root = Path(os.path.expanduser(args.profile_dir or BROWSER_ROOTS[args.browser]))
    if not root.exists():
        print(f"error: {root} does not exist - has {args.browser} been launched once?")
        return 1

    ext_id = unpacked_id(EXT_DIR)
    print(f"extension dir : {EXT_DIR}")
    print(f"extension id  : {ext_id}")

    profiles = ["Default"] + [
        p.name for p in root.iterdir()
        if p.is_dir() and p.name.startswith("Profile ")
    ]
    profiles = [p for p in profiles if (root / p).exists()]
    if not profiles:
        print(f"error: no profile folders under {root}")
        return 1

    for prof in profiles:
        pref_path = root / prof / "Preferences"
        sec_path = root / prof / "Secure Preferences"

        for path in (pref_path, sec_path):
            data = load_json(path)
            data.setdefault("extensions", {}).setdefault("settings", {})
            data["extensions"]["ui"] = data["extensions"].get("ui", {})
            data["extensions"]["ui"]["developer_mode"] = True
            data["extensions"]["settings"][ext_id] = {
                "location": 4,          # 4 = UNPACKED
                "path": str(EXT_DIR),
                "state": 1,             # 1 = ENABLED
                "from_webstore": False,
                "was_installed_by_default": False,
                "was_installed_by_oem": False,
                "creation_flags": 38,   # DEVELOPER_MODE | FROM_WEBSTORE
                "active_permissions": {
                    "api": ["storage", "activeTab", "scripting"],
                    "explicit_host": ["<all_urls>"],
                    "manifest_permissions": [],
                    "scriptable_host": ["<all_urls>"],
                },
                "granted_permissions": {
                    "api": ["storage", "activeTab", "scripting"],
                    "explicit_host": ["<all_urls>"],
                    "manifest_permissions": [],
                    "scriptable_host": ["<all_urls>"],
                },
            }
            # ack the extension so Chrome does not prompt on first run
            data["extensions"].setdefault("autoupdate", {})
            write_json(path, data)
            print(f"  patched {path}")

    print("\nDone. Start the browser normally; the extension will be listed in")
    print("chrome://extensions as 'Price Blocker (Demo)'.")
    print("\nIf Chrome removes it, enable Developer mode and use Load unpacked:")
    print(f"  {EXT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
