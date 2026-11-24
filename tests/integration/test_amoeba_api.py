"""HTTP-level tests for the amoeba board API."""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from tests.support.auth import TEST_PASSWORD, bearer, login

OVERVIEW = "/api/amoeba/overview"
TREE = "/api/amoeba/tree"
SOURCE = "/api/amoeba/source"
METRICS = "/api/amoeba/metrics"
BINDINGS = "/api/amoeba/bindings"
SHARED_BOARDS = "/api/amoeba/shared-boards"


async def test_share_html_snapshot_and_withdraw(env) -> None:
    client, _, auth = env
    assert (await client.get(SHARED_BOARDS)).status_code == 401
    assert (await client.get(SHARED_BOARDS, headers=auth)).json() == []

    invalid = await client.post(
        SHARED_BOARDS, headers=auth, files={"file": ("board.html", b"not HTML", "text/html")}
    )
    assert invalid.status_code == 400
    html = b"<!DOCTYPE html><html><body><h1>November</h1></body></html>"
    uploaded = await client.post(
        SHARED_BOARDS, headers=auth, files={"file": ("November.html", html, "text/html")}
    )
    assert uploaded.status_code == 201, uploaded.text
    board = uploaded.json()
    assert board["filename"] == "November.html"
    assert board["can_withdraw"] is True
    snapshot = f"{SHARED_BOARDS}/{board['id']}"

    user = await client.post(
        "/api/users",
        headers=auth,
        json={"username": "boardreader", "password": TEST_PASSWORD, "role": "user"},
    )
    assert user.status_code == 201, user.text
    reader_auth = bearer(await login(client, username="boardreader", password=TEST_PASSWORD))
    listing = await client.get(SHARED_BOARDS, headers=reader_auth)
    assert listing.json() == [{**board, "can_withdraw": False}]
    read = await client.get(snapshot, headers=reader_auth)
    assert read.content == html
    assert read.headers["content-type"] == "application/octet-stream"
    assert read.headers["content-disposition"].startswith("attachment")
    assert (await client.delete(snapshot, headers=reader_auth)).status_code == 403

    updated = await client.patch(
        f"/api/users/{user.json()['id']}", headers=auth, json={"permissions": []}
    )
    assert updated.status_code == 200, updated.text
    assert (await client.get(snapshot, headers=reader_auth)).status_code == 403
    assert (await client.delete(snapshot, headers=auth)).status_code == 204
    assert (await client.get(snapshot, headers=auth)).status_code == 404
    assert (await client.get(SHARED_BOARDS, headers=auth)).json() == []


async def test_personal_dashboard_visibility_and_replacement(env) -> None:
    client, server, admin = env
    accounts = {}
    for name in ("boardowner", "ingroup", "outsider"):
        created = await client.post(
            "/api/users",
            headers=admin,
            json={"username": name, "password": TEST_PASSWORD, "role": "user"},
        )
        assert created.status_code == 201
        accounts[name] = created.json()["id"]
    owner = bearer(await login(client, username="boardowner", password=TEST_PASSWORD))
    member = bearer(await login(client, username="ingroup", password=TEST_PASSWORD))
    outsider = bearer(await login(client, username="outsider", password=TEST_PASSWORD))
    repos = server.services.repos
    group = repos.user_group_repo.create(name="Retail", description=None)
    group_id = group.user_group_id
    repos.user_group_member_repo.replace(group_id, [accounts["ingroup"]])
    groups = await client.get(f"{SHARED_BOARDS}/groups", headers=owner)
    assert groups.json() == [{"id": group_id, "name": "Retail"}]

    original = b"<!DOCTYPE html><html><body>First</body></html>"
    new_html = b"<!DOCTYPE html><html><body>Second</body></html>"
    uploaded = await client.post(
        SHARED_BOARDS,
        headers=owner,
        data={"visibility": "owner"},
        files={"file": ("Report.html", original, "text/html")},
    )
    assert uploaded.status_code == 201, uploaded.text
    board = uploaded.json()
    path = f"{SHARED_BOARDS}/{board['id']}"
    assert (await client.get(SHARED_BOARDS, headers=owner)).json() == [board]
    assert (await client.get(SHARED_BOARDS, headers=owner, params={"mine": 1})).json() == [board]
    assert (await client.get(SHARED_BOARDS, headers=admin)).json() == []
    assert (await client.get(path, headers=outsider)).status_code == 404

    audience = {"visibility": "groups", "group_ids": [group_id]}
    assert (await client.patch(path, headers=outsider, json=audience)).status_code == 403
    changed = await client.patch(path, headers=owner, json=audience)
    assert changed.status_code == 200 and changed.json()["group_ids"] == [group_id]
    assert (await client.get(SHARED_BOARDS, headers=member)).json()[0]["id"] == board["id"]
    assert (await client.get(SHARED_BOARDS, headers=member, params={"mine": 1})).json() == []
    assert (await client.get(SHARED_BOARDS, headers=outsider)).json() == []
    assert (await client.get(path, headers=member)).content == original

    files = {"file": ("replacement.html", new_html, "text/html")}
    assert (await client.put(f"{path}/file", headers=member, files=files)).status_code == 403
    replaced = await client.put(f"{path}/file", headers=owner, files=files)
    assert replaced.status_code == 200 and replaced.json() == changed.json()
    assert (await client.get(path, headers=member)).content == new_html

    invalid = await client.put(
        f"{path}/file", headers=owner, files={"file": ("invalid.html", b"oops", "text/html")}
    )
    assert invalid.status_code == 400
    assert (await client.get(path, headers=member)).content == new_html
    repos.user_group_member_repo.replace(group_id, [])
    assert (await client.get(path, headers=member)).status_code == 404
    assert (await client.get(SHARED_BOARDS, headers=member)).json() == []
    assert (await client.patch(path, headers=owner, json={"visibility": "all"})).status_code == 200
    assert (await client.get(path, headers=outsider)).content == new_html
    assert (
        await client.patch(path, headers=owner, json={"visibility": "owner"})
    ).status_code == 200
    assert (await client.get(path, headers=outsider)).status_code == 404
    assert (await client.get(path, headers=owner)).content == new_html

    group_upload = await client.post(
        SHARED_BOARDS,
        headers=owner,
        data={"visibility": "groups", "group_ids": group_id},
        files={"file": ("Group.html", original, "text/html")},
    )
    assert group_upload.status_code == 201 and group_upload.json()["group_ids"] == [group_id]

    legacy_id = uuid4().hex
    legacy = server.services.paths.root / "amoeba-shared-boards" / legacy_id
    legacy.mkdir()
    metadata = {
        "id": legacy_id,
        "filename": "Legacy.html",
        "owner_id": accounts["boardowner"],
        "created_at": 1,
    }
    (legacy / "board.json").write_text(json.dumps(metadata), encoding="utf-8")
    (legacy / "board.html").write_bytes(original)
    legacy_visible = await client.get(SHARED_BOARDS, headers=outsider)
    assert [b["id"] for b in legacy_visible.json()] == [legacy_id]
    assert (await client.get(f"{SHARED_BOARDS}/{legacy_id}", headers=outsider)).content == original


async def _seed_tree(server: Any) -> dict[str, str]:
    repos = server.services.repos
    root = repos.department_repo.create("全省", None)
    assert root is not None
    am = repos.department_repo.create("武汉阿米巴", root.department_id)
    assert am is not None
    other = repos.department_repo.create("江汉平原阿米巴", root.department_id)
    assert other is not None
    st1 = repos.department_repo.create("雄楚大道站", am.department_id)
    assert st1 is not None
    st2 = repos.department_repo.create("珞喻路站", am.department_id)
    assert st2 is not None
    st3 = repos.department_repo.create("荆州古城站", other.department_id)
    assert st3 is not None
    repos.amoeba_repo.upsert_snapshots(
        [
            (st1.department_id, "2026-11-11", "gas", 100.0),
            (st1.department_id, "2026-11-11", "die", 50.0),
            (st1.department_id, "2026-11-11", "rev", 40000.0),
            (st2.department_id, "2026-11-11", "gas", 25.0),
            (st2.department_id, "2026-11-11", "die", 25.0),
            # Outside the first amoeba — must never leak into its scope.
            (st3.department_id, "2026-11-11", "gas", 777.0),
        ]
    )
    return {
        "root": root.department_id,
        "am": am.department_id,
        "other": other.department_id,
        "st1": st1.department_id,
        "st2": st2.department_id,
        "st3": st3.department_id,
    }


async def test_amoeba_overview_rollup_and_permission_scope(env) -> None:
    client, server, auth = env
    ids = await _seed_tree(server)

    assert (await client.get(OVERVIEW)).status_code == 401
    overview = await client.get(OVERVIEW, headers=auth, params={"dim": "d"})
    assert overview.status_code == 200, overview.text
    body = overview.json()
    assert body["asof"] == "2026-11-11"
    metrics = body["metrics"]
    # Global admin view includes every amoeba: (100+50) + (25+25) + (777+0).
    assert metrics["oil"]["dims"]["d"] == 977.0
    assert metrics["oil"]["name_zh"] == "油品销量"
    assert body["groups"][0]["category"] == "core"

    # Drill into one amoeba: the other amoeba's station stays out.
    scoped = await client.get(OVERVIEW, headers=auth, params={"dim": "d", "dept": ids["am"]})
    assert scoped.status_code == 200, scoped.text
    assert scoped.json()["metrics"]["oil"]["dims"]["d"] == 200.0
    global_gas = await client.get(OVERVIEW, headers=auth, params={"dim": "d"})
    assert global_gas.json()["metrics"]["gas"]["dims"]["d"] == 902.0  # includes st3

    detail = await client.get(
        f"{METRICS}/oil", headers=auth, params={"dim": "d", "dept": ids["am"]}
    )
    assert detail.status_code == 200, detail.text
    assert [(r["name"], r["value"]) for r in detail.json()["ranking"]] == [
        ("雄楚大道站", 150.0),
        ("珞喻路站", 50.0),
    ]

    # Metric drawer for a hidden feeder or unknown key → 404.
    missing = await client.get(f"{METRICS}/nope", headers=auth)
    assert missing.status_code == 404

    # Admin-only endpoints reject plain users.
    user = await client.post(
        "/api/users",
        headers=auth,
        json={"username": "amember", "password": TEST_PASSWORD, "role": "user"},
    )
    assert user.status_code == 201, user.text
    member_auth = bearer(await login(client, username="amember", password=TEST_PASSWORD))
    assert (await client.get(SOURCE, headers=member_auth)).status_code == 403
    assert (await client.post("/api/amoeba/sync", headers=member_auth)).status_code == 403


async def test_amoeba_data_scope_from_department_binding(env) -> None:
    client, server, auth = env
    ids = await _seed_tree(server)

    user = await client.post(
        "/api/users",
        headers=auth,
        json={"username": "ascoped", "password": TEST_PASSWORD, "role": "user"},
    )
    assert user.status_code == 201, user.text
    member_id = user.json()["id"]
    member_auth = bearer(await login(client, username="ascoped", password=TEST_PASSWORD))

    # New users get the amoeba permission by default; with no binding the tree is empty.
    unbound_tree = await client.get(TREE, headers=member_auth)
    assert unbound_tree.status_code == 200, unbound_tree.text
    assert unbound_tree.json() == {"departments": [], "restricted": True}
    empty = await client.get(OVERVIEW, headers=member_auth)
    assert empty.json()["metrics"] == {}

    # Bind to the first amoeba → tree and overview collapse to its subtree.
    put = await client.put(
        BINDINGS, headers=auth, json={"user_id": member_id, "department_ids": [ids["am"]]}
    )
    assert put.status_code == 200, put.text
    scoped_tree = await client.get(TREE, headers=member_auth)
    names = {d["name"] for d in scoped_tree.json()["departments"]}
    assert names == {"武汉阿米巴", "雄楚大道站", "珞喻路站"}

    scoped = await client.get(OVERVIEW, headers=member_auth)
    assert scoped.json()["metrics"]["gas"]["dims"]["d"] == 125.0  # st3 excluded

    comparison = await client.get(OVERVIEW, headers=member_auth, params={"include_comparison": 1})
    assert comparison.status_code == 200, comparison.text
    assert {r["department_id"] for r in comparison.json()["comparison"]["rows"]} == {
        ids["st1"],
        ids["st2"],
    }

    # Drilling outside the bound subtree is forbidden.
    forbidden = await client.get(OVERVIEW, headers=member_auth, params={"dept": ids["other"]})
    assert forbidden.status_code == 403

    # Unknown department in bindings is rejected.
    bad = await client.put(
        BINDINGS, headers=auth, json={"user_id": member_id, "department_ids": ["missing"]}
    )
    assert bad.status_code == 404


async def test_amoeba_unit_comparison_includes_direct_and_subtree_facts(env) -> None:
    client, server, auth = env
    ids = await _seed_tree(server)
    repos = server.services.repos
    assert repos.department_repo.create("公司机关", ids["root"]) is not None
    repos.amoeba_repo.upsert_snapshots(
        [
            (ids["am"], "2026-11-11", "gas", 10.0),
            (ids["other"], "2026-11-11", "kwh", 0.0),
        ]
    )

    response = await client.get(OVERVIEW, headers=auth, params={"include_comparison": 1})
    assert response.status_code == 200, response.text
    comparison = response.json()["comparison"]
    assert comparison["metric_keys"] == ["oil", "ng", "kwh", "rev", "profit", "dis"]
    rows = {row["department_id"]: row["values"] for row in comparison["rows"]}
    assert set(rows) == {ids["am"], ids["other"]}
    assert rows[ids["am"]]["oil"] == 210.0
    assert rows[ids["am"]]["kwh"] is None
    assert rows[ids["other"]]["oil"] == 777.0
    assert rows[ids["other"]]["kwh"] == 0.0


async def test_amoeba_source_config_and_metric_admin(env_admin_client) -> None:
    client, auth = env_admin_client

    initial = await client.get(SOURCE, headers=auth)
    assert initial.status_code == 200
    assert initial.json()["configured"] is False

    saved = await client.put(
        SOURCE,
        headers=auth,
        json={"enabled": False, "url": "http://localhost:9999/mcp", "token": "secret"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["url"] == "http://localhost:9999/mcp"
    assert saved.json()["token_set"] is True
    assert saved.json()["configured"] is False  # enabled stays off

    enabled_blank = await client.put(SOURCE, headers=auth, json={"enabled": True, "url": ""})
    assert enabled_blank.status_code == 400

    listing = await client.get(METRICS, headers=auth)
    assert listing.status_code == 200, listing.text
    keys = {m["metric_key"] for m in listing.json()["metrics"]}
    assert {"oil", "gas", "dis1"} <= keys

    created = await client.post(
        METRICS,
        headers=auth,
        json={
            "metric_key": "custom_kpi",
            "name_zh": "自定义指标",
            "name_en": "Custom KPI",
            "unit": "元",
            "category": "ops",
            "formula": "rev*0.1",
        },
    )
    assert created.status_code == 201, created.text
    duplicate = await client.post(
        METRICS,
        headers=auth,
        json={
            "metric_key": "custom_kpi",
            "name_zh": "重复",
            "name_en": "Dup",
            "unit": "",
            "category": "ops",
        },
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "AMOEBA_METRIC_TAKEN"

    bad_formula = await client.post(
        METRICS,
        headers=auth,
        json={
            "metric_key": "bad_one",
            "name_zh": "坏公式",
            "name_en": "Bad",
            "unit": "",
            "category": "ops",
            "formula": "__import__('os')",
        },
    )
    assert bad_formula.status_code == 400
    assert bad_formula.json()["error"]["code"] == "AMOEBA_METRIC_BAD_FORMULA"

    patched = await client.patch(f"{METRICS}/custom_kpi", headers=auth, json={"enabled": False})
    assert patched.status_code == 200

    # Builtin metrics disable on delete; custom ones really delete.
    disable = await client.delete(f"{METRICS}/oil", headers=auth)
    assert disable.status_code == 200
    assert disable.json() == {"metric_key": "oil", "disabled": True}
    removed = await client.delete(f"{METRICS}/custom_kpi", headers=auth)
    assert removed.json() == {"metric_key": "custom_kpi", "deleted": True}

    # Sync without a configured source surfaces a clean error.
    sync = await client.post("/api/amoeba/sync", headers=auth)
    assert sync.status_code == 400
    assert sync.json()["error"]["code"] == "AMOEBA_SOURCE_NOT_CONFIGURED"


async def test_amoeba_leaves_wall_and_narrative_shape(env_admin_client) -> None:
    client, auth = env_admin_client
    depts = await client.post("/api/departments", headers=auth, json={"name": "全省"})
    root_id = depts.json()["department_id"]
    st1 = await client.post(
        "/api/departments", headers=auth, json={"name": "雄楚站", "parent_id": root_id}
    )
    st2 = await client.post(
        "/api/departments", headers=auth, json={"name": "珞喻站", "parent_id": root_id}
    )
    assert st1.status_code == 201 and st2.status_code == 201, (st1.text, st2.text)

    # The board seeds builtin metrics lazily; trigger it via the overview call.
    overview = await client.get("/api/amoeba/overview", headers=auth)
    assert overview.status_code == 200, overview.text

    leaves = await client.get(
        "/api/amoeba/leaves", headers=auth, params={"metric": "oil", "dim": "m"}
    )
    assert leaves.status_code == 200, leaves.text
    # No synced facts in this env → the wall is a well-formed empty list.
    assert leaves.json() == {"rows": []}

    missing = await client.get(
        "/api/amoeba/leaves", headers=auth, params={"metric": "nope", "dim": "m"}
    )
    assert missing.status_code == 404

    narrative = await client.get("/api/amoeba/summary", headers=auth, params={"dim": "m"})
    assert narrative.status_code == 200, narrative.text
    body = narrative.json()
    assert set(body) == {"lead", "items"}
    assert isinstance(body["lead"], str)
    for item in body["items"]:
        assert set(item) >= {"level", "title", "evidence", "action", "source"}
        assert item["level"] in {"risk", "warn", "opp", "info"}
