import asyncio
import importlib

import httpx
import pytest

import tracking


@pytest.fixture
def application(monkeypatch, tmp_path):
    monkeypatch.setenv("JELLYFIN_API_KEY", "test-key")
    monkeypatch.setenv("SESSION_SECRET", "test-secret")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "monitor.db"))
    module = importlib.import_module("app")
    monkeypatch.setattr(module, "DB_PATH", str(tmp_path / "monitor.db"))
    module.init_db()
    tracking.initialize(module.DB_PATH)
    return module


def request(application, path, authenticated=True):
    async def run():
        transport = httpx.ASGITransport(app=application.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            if authenticated:
                client.cookies.set(application.COOKIE, application.signer.dumps({"id": "test", "name": "Test", "admin": False}))
            return await client.get(path)
    return asyncio.run(run())


def test_analytics_requires_signed_login(application):
    assert request(application, "/api/analytics", authenticated=False).status_code == 401
    assert request(application, "/api/activity", authenticated=False).status_code == 401


def test_analytics_and_history_validate_dates_and_timezone(application):
    for path in ("/api/analytics", "/api/activity"):
        response = request(application, path + "?start=wrong")
        assert response.status_code == 400
        assert response.json()["detail"] == "Dates must use YYYY-MM-DD"
        assert request(application, path + "?tz=Invalid/Zone").status_code == 400
        assert request(application, path + "?start=2026-10-05&end=2026-10-04").status_code == 400


def test_analytics_default_returns_measured_source_and_empty_history(application):
    response = request(application, "/api/analytics")
    assert response.status_code == 200
    assert response.json()["tracking"]["source"] == "observed_playback"
    assert response.json()["totals"]["seconds"] == 0
    assert request(application, "/api/activity").json() == []


def test_failed_sample_records_no_time(application, monkeypatch):
    class FailedJellyfin:
        async def get(self, *args, **kwargs):
            raise httpx.ConnectError("Jellyfin offline")
    monkeypatch.setattr(application, "jf", FailedJellyfin())
    with pytest.raises(httpx.ConnectError):
        asyncio.run(application.poll_playback())
    assert request(application, "/api/analytics").json()["totals"]["seconds"] == 0
