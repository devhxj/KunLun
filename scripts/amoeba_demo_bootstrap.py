"""One-shot demo bootstrap: admin setup → amoeba source config → sync → check.

Run while `octop run` (OCTOP_PORT=8800, fresh OCTOP_HOME) and the stub
(`scripts/amoeba_stub_server.py`) are both up:

    uv run python scripts/amoeba_demo_bootstrap.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8800"
STUB_URL = "http://127.0.0.1:8765/mcp"
HOME = Path("D:/repository/KunLun/.demo-octop-home")
ADMIN_USER = "admin"
ADMIN_PASSWORD = "AmoebaDemo12"


async def main() -> int:
    async with httpx.AsyncClient(base_url=BASE, timeout=300) as client:
        wizard_pw = (HOME / "octop-login.txt").read_text(encoding="utf-8").strip()
        tok = (
            await client.post(
                "/api/setup/verify-password", json={"password": wizard_pw}
            )
        ).json()["wizard_token"]
        auth_wizard = {"Authorization": f"Bearer {tok}"}

        status = (await client.get("/api/setup/status")).json()
        if status.get("setup_required"):
            if not status.get("database_bound"):
                db = await client.post(
                    "/api/setup/database",
                    json={"driver": "sqlite"},
                    headers=auth_wizard,
                )
                db.raise_for_status()
                print("[demo] database bound:", db.json())
            r = await client.post(
                "/api/setup/initial-admin",
                json={"username": ADMIN_USER, "password": ADMIN_PASSWORD},
                headers=auth_wizard,
            )
            r.raise_for_status()
            r = await client.post(
                "/api/setup/finish", json={"provider_draft": None}, headers=auth_wizard
            )
            r.raise_for_status()
            print("[demo] admin created")
        else:
            print("[demo] admin exists, skipping setup")

        login = await client.post(
            "/api/auth/login",
            json={"username": ADMIN_USER, "password": ADMIN_PASSWORD},
        )
        login.raise_for_status()
        auth = {"Authorization": f"Bearer {login.json()['access_token']}"}

        saved = await client.put(
            "/api/amoeba/source",
            headers=auth,
            json={
                "enabled": True,
                "url": STUB_URL,
                "token": "stub-token",
                "sync_days": 800,
                "auto_sync": True,
                "sync_schedule": "0 3 * * *",
            },
        )
        saved.raise_for_status()
        print("[demo] source:", saved.json())

        test = await client.post("/api/amoeba/source/test", headers=auth, json={})
        print("[demo] probe:", test.json())

        print("[demo] syncing (800 days × 24 stations; this takes a while)…")
        sync = await client.post("/api/amoeba/sync", headers=auth)
        sync.raise_for_status()
        print("[demo] sync:", sync.json())

        tree = (await client.get("/api/amoeba/tree", headers=auth)).json()
        print(f"[demo] tree: {len(tree['departments'])} departments")

        for dim in ("d", "m", "y"):
            overview = (
                await client.get("/api/amoeba/overview", headers=auth, params={"dim": dim})
            ).json()
            metrics = overview.get("metrics", {})
            picks = {
                key: {
                    "value": card["dims"].get(dim),
                    "delta": card.get("delta_pct"),
                    "budget": card.get("budget_pct"),
                }
                for key, card in metrics.items()
                if key in ("oil", "kwh", "rev", "profit", "dis", "chgfee", "invdays")
            }
            print(f"[demo] dim={dim} asof={overview.get('asof')}:")
            print(json.dumps(picks, ensure_ascii=False, indent=2))

        summary = (
            await client.get("/api/amoeba/summary", headers=auth, params={"dim": "m"})
        ).json()
        print("[demo] AI summary items:")
        for item in summary.get("items", []):
            print(f"  - [{item['source']}] {item['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
