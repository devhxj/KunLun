from tests.support.auth import TEST_PASSWORD, bearer, login

DEPARTMENTS = "/api/departments"


async def test_department_tree_crud(env_admin_client):
    client, auth = env_admin_client
    assert (await client.get(DEPARTMENTS, headers=auth)).json() == []

    root = await client.post(DEPARTMENTS, headers=auth, json={"name": "  总部  "})
    assert root.status_code == 201, root.text
    root_id = root.json()["department_id"]
    assert root.json() == {"department_id": root_id, "parent_id": None, "name": "总部"}

    child = await client.post(
        DEPARTMENTS, headers=auth, json={"name": "工程部", "parent_id": root_id}
    )
    assert child.status_code == 201, child.text
    child_path = f"{DEPARTMENTS}/{child.json()['department_id']}"
    root_path = f"{DEPARTMENTS}/{root_id}"
    assert child.json()["parent_id"] == root_id

    renamed = await client.patch(child_path, headers=auth, json={"name": "研发部"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "研发部"
    assert renamed.json()["parent_id"] == root_id
    assert (await client.get(DEPARTMENTS, headers=auth)).json() == [root.json(), renamed.json()]

    blocked = await client.delete(root_path, headers=auth)
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["error"]["code"] == "DEPARTMENT_HAS_CHILDREN"
    assert (await client.delete(child_path, headers=auth)).status_code == 204
    assert (await client.delete(root_path, headers=auth)).status_code == 204
    assert (await client.delete(root_path, headers=auth)).status_code == 404
    missing_parent = await client.post(
        DEPARTMENTS, headers=auth, json={"name": "研发部", "parent_id": root_id}
    )
    assert missing_parent.status_code == 404, missing_parent.text


async def test_department_management_requires_admin(env_admin_client):
    client, auth = env_admin_client
    assert (await client.get(DEPARTMENTS)).status_code == 401
    user = await client.post(
        "/api/users",
        headers=auth,
        json={"username": "orgmember", "password": TEST_PASSWORD, "role": "user"},
    )
    assert user.status_code == 201, user.text
    member_auth = bearer(await login(client, username="orgmember", password=TEST_PASSWORD))
    assert (await client.get(DEPARTMENTS, headers=member_auth)).status_code == 403
    response = await client.post(DEPARTMENTS, headers=member_auth, json={"name": "总部"})
    assert response.status_code == 403
    blank = await client.post(DEPARTMENTS, headers=auth, json={"name": "   "})
    assert blank.status_code == 422, blank.text


async def test_department_profile_round_trip(env_admin_client):
    client, auth = env_admin_client
    first = await client.post(DEPARTMENTS, headers=auth, json={"name": "总部"})
    second = await client.post(DEPARTMENTS, headers=auth, json={"name": "分部"})
    first_id = first.json()["department_id"]
    second_id = second.json()["department_id"]
    path = f"{DEPARTMENTS}/{second_id}/profile"

    initial = await client.get(path, headers=auth)
    assert initial.status_code == 200
    assert initial.json()["updated_at"] is None
    assert initial.json()["details"]["enabled"] is True

    details = {
        "full_name": "分部全称",
        "enabled": False,
        "effective_date": "2024-01-01",
        "code_path": "[532]/[900]/",
        "city_company_code": "0056341",
        "virtual_site": False,
        "business_type_code": "0",
        "service_items": "普通站（10）、便利店（20）",
        "contact_phone": "01234567890",
    }
    saved = await client.put(
        path, headers=auth, json={"name": "新的简称", "sort_order": 0, "details": details}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["updated_at"].endswith("Z")
    assert saved.json()["sort_order"] == 0
    assert all(saved.json()["details"][key] == value for key, value in details.items())
    assert (await client.get(path, headers=auth)).json() == saved.json()

    rows = (await client.get(DEPARTMENTS, headers=auth)).json()
    assert [row["department_id"] for row in rows] == [second_id, first_id]
    assert rows[0]["name"] == "新的简称"
    assert (await client.delete(f"{DEPARTMENTS}/{second_id}", headers=auth)).status_code == 204
    assert (await client.get(path, headers=auth)).status_code == 404
