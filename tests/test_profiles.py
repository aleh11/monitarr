import asyncio
import base64
from io import BytesIO

import httpx
import pytest
from PIL import Image

from test_api import application

ALICE = "a" * 32
BOB = "b" * 32


def picture(size=(80, 120), image_format="PNG"):
    output = BytesIO()
    Image.new("RGB", size, "navy").save(output, format=image_format)
    return output.getvalue()


@pytest.fixture
def jellyfin(application, monkeypatch):
    state = {"tag": "first", "editable": True, "disabled": False, "status": 204, "calls": []}

    def handle(request):
        state["calls"].append(request)
        profile = {"Id": ALICE, "Name": "Alice", "PrimaryImageTag": state["tag"],
                   "Policy": {"EnableUserPreferenceAccess": state["editable"], "IsDisabled": state["disabled"]}}
        if request.url.path == "/Users":
            return httpx.Response(200, json=[profile, {"Id": BOB, "Name": "Bob", "Policy": {},
                                                      "PrimaryImageTag": None}])
        if request.url.path == f"/Users/{ALICE}":
            return httpx.Response(200, json=profile)
        if request.url.path.endswith("/Images/Primary"):
            if request.method == "GET":
                return httpx.Response(200, content=picture(), headers={"Content-Type": "image/png"})
            if state["status"] == 204:
                state["tag"] = "updated" if request.method == "POST" else None
            return httpx.Response(state["status"])
        return httpx.Response(404)

    client = httpx.AsyncClient(base_url="http://jellyfin", transport=httpx.MockTransport(handle))
    monkeypatch.setattr(application, "jf", client)
    yield state
    asyncio.run(client.aclose())


def request(application, path, method="GET", content=None, content_type="image/png", authenticated=True):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application.app), base_url="http://test") as client:
            if authenticated:
                client.cookies.set(application.COOKIE, application.signer.dumps({"id": ALICE, "name": "Alice", "admin": True}))
            return await client.request(method, path, content=content, headers={"Content-Type": content_type})
    return asyncio.run(run())


@pytest.mark.parametrize("path,method", [("/api/users", "GET"), (f"/api/users/{ALICE}/image", "GET"),
                                        ("/api/me/image", "POST"), ("/api/me/image", "DELETE")])
def test_profile_routes_require_authentication(application, jellyfin, path, method):
    assert request(application, path, method, picture(), authenticated=False).status_code == 401
    assert not jellyfin["calls"]


def test_directory_exposes_only_public_profile_fields(application, jellyfin):
    response = request(application, "/api/users")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == [{"id": ALICE, "name": "Alice", "image_tag": "first", "can_edit_image": True},
                               {"id": BOB, "name": "Bob", "image_tag": None, "can_edit_image": False}]


def test_upload_targets_cookie_user_and_sends_valid_normalized_base64(application, jellyfin):
    response = request(application, f"/api/me/image?user_id={BOB}", "POST", picture(image_format="JPEG"), "image/jpeg")
    assert response.status_code == 200
    assert response.json()["image_tag"] == "updated"
    sent = next(r for r in jellyfin["calls"] if r.method == "POST")
    assert sent.url.path == f"/Users/{ALICE}/Images/Primary"
    assert sent.headers["Content-Type"] == "image/png"
    with Image.open(BytesIO(base64.b64decode(sent.content, validate=True))) as image:
        assert image.size == (512, 512)
        assert image.format == "PNG"
        assert not image.info


def test_removal_targets_only_current_user(application, jellyfin):
    response = request(application, f"/api/me/image?user_id={BOB}", "DELETE")
    assert response.status_code == 200
    assert response.json()["image_tag"] is None
    assert next(r for r in jellyfin["calls"] if r.method == "DELETE").url.path == f"/Users/{ALICE}/Images/Primary"
    assert request(application, f"/api/users/{BOB}/image", "DELETE").status_code == 405


@pytest.mark.parametrize("method", ["POST", "DELETE"])
def test_current_jellyfin_policy_overrules_old_admin_cookie(application, jellyfin, method):
    jellyfin["editable"] = False
    assert request(application, "/api/me/image", method, picture()).status_code == 403
    assert all(r.method == "GET" for r in jellyfin["calls"])


def test_disabled_user_cannot_change_picture(application, jellyfin):
    jellyfin["disabled"] = True
    assert request(application, "/api/me/image", "POST", picture()).status_code == 403


@pytest.mark.parametrize("data,mime,status", [(b"<svg></svg>", "image/svg+xml", 415),
                                              (b"not an image", "image/png", 422),
                                              (b"x" * (5 * 1024 * 1024 + 1), "image/png", 413)])
def test_invalid_uploads_do_not_reach_jellyfin(application, jellyfin, data, mime, status):
    assert request(application, "/api/me/image", "POST", data, mime).status_code == status
    assert not jellyfin["calls"]


def test_oversized_pixel_dimensions_are_rejected(application, jellyfin):
    assert request(application, "/api/me/image", "POST", picture((4001, 4000))).status_code == 413
    assert not jellyfin["calls"]


def test_image_proxy_is_private_and_validates_id(application, jellyfin):
    response = request(application, f"/api/users/{ALICE}/image?tag=first")
    assert response.status_code == 200
    assert response.headers["Content-Type"] == "image/png"
    assert response.headers["Cache-Control"] == "private, max-age=300"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert request(application, "/api/users/not-a-user/image").status_code == 400


@pytest.mark.parametrize("status,expected", [(400, 400), (403, 403), (404, 404), (500, 502)])
def test_upstream_upload_failures_are_reported(application, jellyfin, status, expected):
    jellyfin["status"] = status
    response = request(application, "/api/me/image", "POST", picture())
    assert response.status_code == expected
    assert jellyfin["tag"] == "first"


def test_jellyfin_outage_has_actionable_error(application, monkeypatch):
    def handle(request):
        raise httpx.ConnectError("offline")
    client = httpx.AsyncClient(base_url="http://jellyfin", transport=httpx.MockTransport(handle))
    monkeypatch.setattr(application, "jf", client)
    try:
        response = request(application, "/api/users")
        assert response.status_code == 502
        assert "Please try again" in response.json()["detail"]
    finally:
        asyncio.run(client.aclose())
