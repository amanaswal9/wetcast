"""Official alerts: parsing, polling and the endpoint, offline.

The feed, CAP messages and polygons below are small hand-written fixtures in the
same format as NDMA Sachet's (tests only)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from app import alerts, db

NOW = datetime(2026, 11, 19, 18, 0, tzinfo=timezone.utc)
# A square district around (20.1, 85.1); a point inside and one outside.
SQUARE = "19.9,84.9 19.9,85.3 20.3,85.3 20.3,84.9 19.9,84.9"
INSIDE = (20.13, 85.10)
OUTSIDE = (20.30, 85.82)


def rss(*guids: str) -> bytes:
    items = "".join(
        f"<item><title>t</title><category>Met</category>"
        f"<link>https://sachet.example/cap?identifier={g}</link>"
        f"<author>controlroom@ndma.gov.in (IMD Bhubaneswar)</author><guid isPermaLink=\"false\">{g}</guid>"
        f"<pubDate>Thu, 19 Nov 2026 17:{i:02d}:00 GMT</pubDate></item>"
        for i, g in enumerate(guids)
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel><title>All India</title>{items}</channel></rss>'.encode()


def cap(guid: str, *, msg_type="Alert", status="Actual", expires="2026-11-20T02:30:00+05:30", refs="", event="Heavy Rain", polygon_url=True) -> bytes:
    param = (
        f"<cap:parameter><cap:valueName>Polygon URL</cap:valueName><cap:value>https://sachet.example/poly?identifier={guid}</cap:value></cap:parameter>"
        if polygon_url
        else ""
    )
    info = lambda lang, headline: (  # noqa: E731
        f"<cap:info><cap:language>{lang}</cap:language><cap:category>Met</cap:category><cap:event>{event}</cap:event>"
        "<cap:urgency>Immediate</cap:urgency><cap:severity>Severe</cap:severity><cap:certainty>Likely</cap:certainty>"
        "<cap:effective>2026-11-19T23:00:00+05:30</cap:effective>"
        f"<cap:expires>{expires}</cap:expires><cap:headline>{headline}</cap:headline><cap:description/>"
        f"<cap:instruction>Stay indoors.</cap:instruction>{param}"
        "<cap:area><cap:areaDesc>Nayagarh district of Odisha</cap:areaDesc></cap:area></cap:info>"
    )
    return (
        '<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">'
        f"<cap:identifier>IN-{guid}</cap:identifier><cap:sender>Odisha-SDMA</cap:sender>"
        "<cap:sent>2026-11-19T23:00:00+05:30</cap:sent>"
        f"<cap:status>{status}</cap:status><cap:msgType>{msg_type}</cap:msgType><cap:scope>Public</cap:scope>"
        f"<cap:references>{refs}</cap:references>"
        + info("OD", "ଓଡ଼ିଆ")
        + info("en-IN", f"{event} likely over Nayagarh in the next 3 hours.")
        + "</cap:alert>"
    ).encode()


def transport(feed: bytes, caps: dict[str, bytes], calls: list[str] | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(str(request.url))
        if request.url.host == "sachet.ndma.gov.in":
            return httpx.Response(200, content=feed)
        guid = request.url.params.get("identifier")
        if request.url.path == "/poly":
            return httpx.Response(200, content=f"<alert><identifier>x</identifier><polygon>{SQUARE}</polygon></alert>".encode())
        if guid in caps:
            return httpx.Response(200, content=caps[guid])
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def poll(feed: bytes, caps: dict[str, bytes], calls: list[str] | None = None, now: datetime = NOW) -> dict:
    with db.new_session() as session, httpx.Client(transport=transport(feed, caps, calls)) as client:
        return alerts.poll_sachet(session, client, now=now, gap=0)


# ---- parsing and geometry -------------------------------------------------------------


def test_cap_uses_the_english_block_and_reads_references():
    msg = alerts.parse_cap(cap("2", msg_type="Update", refs="IMD-Bhubaneswar,IN-1,2026-11-19T22:00:00+05:30"))
    assert msg.headline.startswith("Heavy Rain likely")
    assert msg.severity == "Severe" and msg.msg_type == "Update"
    assert msg.references == ["IN-1"]
    assert msg.expires == datetime(2026, 11, 19, 21, 0, tzinfo=timezone.utc)
    assert msg.polygon_url.endswith("identifier=2")


def test_rss_reads_guid_link_and_issuer():
    items = alerts.parse_rss(rss("1", "2"))
    assert [i.guid for i in items] == ["1", "2"]
    assert items[0].author == "IMD Bhubaneswar"


def test_point_in_polygon():
    assert alerts.covers(SQUARE, *INSIDE)
    assert not alerts.covers(SQUARE, *OUTSIDE)
    assert not alerts.covers(None, *INSIDE)


def test_unsafe_xml_is_refused():
    bomb = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss>&b;</rss>'
    with pytest.raises(Exception):
        alerts.parse_rss(bomb)


@pytest.mark.parametrize(
    ("lat", "lon", "country", "expected"),
    [(28.6, 77.2, None, "india"), (39.7, -105.0, None, "us"), (51.5, -0.1, None, "none"), (31.5, 74.3, "PK", "none"), (18.4, -66.1, "PR", "us")],
)
def test_coverage(lat, lon, country, expected):
    assert alerts.coverage_for(lat, lon, country) == expected


# ---- polling --------------------------------------------------------------------------


def test_poll_stores_new_alerts_once_with_polygons(client):
    calls: list[str] = []
    summary = poll(rss("1"), {"1": cap("1")}, calls)
    assert summary == {"items": 1, "new": 1, "stored": 1, "failed": 0}
    assert len(calls) == 3  # feed, message, polygon
    calls.clear()
    assert poll(rss("1"), {"1": cap("1")}, calls)["stored"] == 0
    assert len(calls) == 1  # only the feed: known messages aren't fetched again
    with db.new_session() as s:
        row = s.scalars(select(db.Alert)).one()
        assert row.sender_name == "IMD Bhubaneswar" and row.min_lat == pytest.approx(19.9)


def test_updates_and_cancellations_retire_earlier_messages(client):
    poll(rss("1"), {"1": cap("1")})
    poll(rss("1", "2"), {"2": cap("2", msg_type="Update", refs="IMD,IN-1,2026-11-19T22:00:00+05:30")})
    with db.new_session() as s:
        active = alerts.active_sachet_alerts(s, *INSIDE, NOW)
        assert [a.identifier for a in active] == ["IN-2"]
    poll(rss("1", "2", "3"), {"3": cap("3", msg_type="Cancel", refs="IMD,IN-2,2026-11-19T22:30:00+05:30")})
    with db.new_session() as s:
        assert alerts.active_sachet_alerts(s, *INSIDE, NOW) == []


def test_expired_test_and_unreadable_messages(client):
    caps = {
        "1": cap("1", expires="2026-11-19T20:00:00+05:30"),  # expired before NOW
        "2": cap("2", status="Exercise"),
    }
    summary = poll(rss("1", "2", "3"), caps)  # "3" returns 404
    assert summary["failed"] == 1 and summary["stored"] == 2
    with db.new_session() as s:
        assert alerts.active_sachet_alerts(s, *INSIDE, NOW) == []
        assert all(r.polygons is None for r in s.scalars(select(db.Alert)))  # no polygon fetched for dead alerts


def test_old_alerts_are_removed_a_week_after_expiry(client):
    poll(rss("1"), {"1": cap("1")})
    poll(rss(), {}, now=NOW + timedelta(days=8))
    with db.new_session() as s:
        assert s.scalars(select(db.Alert)).all() == []


# ---- endpoint -------------------------------------------------------------------------


def test_endpoint_india_inside_and_outside(client, monkeypatch):
    poll(rss("1"), {"1": cap("1", expires="2099-01-01T00:00:00+05:30")})
    monkeypatch.setattr(alerts.POLL, "last_ok", datetime.now(timezone.utc))
    body = client.get("/api/alerts", params={"latitude": INSIDE[0], "longitude": INSIDE[1], "country": "IN"}).json()
    assert body["coverage"] == "india" and body["stale"] is False
    assert [a["event"] for a in body["alerts"]] == ["Heavy Rain"]
    assert body["alerts"][0]["sender"] == "IMD Bhubaneswar"
    assert "does not rule out" in body["note"]
    outside = client.get("/api/alerts", params={"latitude": OUTSIDE[0], "longitude": OUTSIDE[1]}).json()
    assert outside["alerts"] == []


def test_endpoint_says_when_the_feed_is_stale(client, monkeypatch):
    monkeypatch.setattr(alerts.POLL, "last_ok", None)
    body = client.get("/api/alerts", params={"latitude": 28.6, "longitude": 77.2}).json()
    assert body["coverage"] == "india" and body["stale"] is True


def test_endpoint_us_uses_nws(client, monkeypatch):
    warning = {"event": "Winter Storm Warning", "severity": "Severe", "expires": "2026-11-21T13:00:00+00:00"}
    monkeypatch.setattr(alerts, "fetch_nws", lambda lat, lon: [warning])
    body = client.get("/api/alerts", params={"latitude": 39.74, "longitude": -104.99, "country": "US"}).json()
    assert body["coverage"] == "us" and body["alerts"] == [warning]
    assert body["source"]["name"] == "US National Weather Service"


def test_endpoint_us_reports_an_unreachable_service(client, monkeypatch):
    def down(lat, lon):
        raise alerts.AlertSourceError("Couldn't reach the US National Weather Service.")

    monkeypatch.setattr(alerts, "fetch_nws", down)
    body = client.get("/api/alerts", params={"latitude": 39.74, "longitude": -104.99}).json()
    assert body["stale"] is True and "Couldn't reach" in body["error"]


def test_nws_mapping_and_out_of_area(monkeypatch):
    alerts._nws_cache.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params["point"].startswith("28"):
            return httpx.Response(400, json={"title": "Invalid Parameter"})
        return httpx.Response(200, json={"features": [
            {"properties": {"status": "Actual", "messageType": "Alert", "event": "Flood Watch", "severity": "Moderate", "areaDesc": "X"}},
            {"properties": {"status": "Test", "messageType": "Alert", "event": "Test"}},
        ]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        assert [a["event"] for a in alerts.fetch_nws(39.74, -104.99, c)] == ["Flood Watch"]
        assert alerts.fetch_nws(28.6, 77.2, c) == []


def test_endpoint_elsewhere_says_no_feed(client):
    body = client.get("/api/alerts", params={"latitude": 51.5, "longitude": -0.12, "country": "GB"}).json()
    assert body["coverage"] == "none" and body["alerts"] == []
    assert "doesn't have an official warning feed" in body["note"]
