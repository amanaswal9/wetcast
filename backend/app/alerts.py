"""Official severe-weather alerts from free public sources.

- India: NDMA's Sachet portal publishes an all-India RSS feed (public domain) whose
  items link to CAP 1.2 messages from IMD's regional centres and state disaster
  management authorities. Each message names its area and links to a polygon.
  The feed lists only its latest 100 items, so a job reads it every few minutes
  and keeps each alert here until shortly after it expires.
- United States: the National Weather Service answers point queries directly
  (api.weather.gov), so it is asked live and cached briefly.
- Elsewhere no official feed is connected, and the API says so instead of
  implying there are no warnings.

XML from the feeds is parsed with defusedxml.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from xml.etree.ElementTree import Element, ParseError

import httpx
from defusedxml import ElementTree as SafeET
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from .db import Alert, new_session

log = logging.getLogger("weatherai.alerts")

SACHET_RSS = "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml"
SACHET_HOME = "https://sachet.ndma.gov.in/"
NWS_ALERTS = "https://api.weather.gov/alerts/active"
NWS_HOME = "https://www.weather.gov/"
# A generic client name (no personal contact details), as NWS asks clients to identify themselves.
USER_AGENT = "Wetcast/0.1 (open-source portfolio weather app)"
CAP = {"cap": "urn:oasis:names:tc:emergency:cap:1.2"}  # XML namespace of CAP 1.2 messages

KEEP_AFTER_EXPIRY = timedelta(days=7)
MAX_NEW_PER_POLL = 150
REQUEST_GAP_SECONDS = 0.25  # be gentle with the portal when reading many new messages
NWS_CACHE_SECONDS = 300
SEVERITY_ORDER = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3}

# Rough boxes, used only when the caller doesn't say which country a place is in.
INDIA_BOX = (6.0, 37.5, 68.0, 97.5)
US_BOXES = ((24.0, 50.0, -125.0, -66.0), (51.0, 72.0, -180.0, -129.0), (18.5, 22.5, -161.0, -154.0), (17.5, 18.6, -67.5, -65.0))
US_CODES = {"US", "PR", "GU", "VI", "AS", "MP"}


class AlertSourceError(RuntimeError):
    """An alert source could not be read."""


# Parsing the feed and its messages.


@dataclass
class RssItem:
    """One entry in the Sachet RSS feed, pointing to a CAP message."""

    guid: str
    link: str
    author: str | None
    published: datetime | None


@dataclass
class CapMessage:
    """The parts of a CAP 1.2 alert message that Wetcast stores and shows."""

    identifier: str | None
    status: str | None
    msg_type: str | None
    sent: datetime | None
    references: list[str]
    event: str | None = None
    severity: str | None = None
    urgency: str | None = None
    certainty: str | None = None
    headline: str | None = None
    description: str | None = None
    instruction: str | None = None
    onset: datetime | None = None
    expires: datetime | None = None
    area_desc: str | None = None
    polygons: list[str] = field(default_factory=list)
    polygon_url: str | None = None


def parse_time(value: str | None) -> datetime | None:
    """An ISO time from a feed as an aware datetime (UTC when no offset is given), or None."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _text(element: Element | None, path: str) -> str | None:
    """Trimmed text of a child element in the CAP namespace, or None when missing or empty."""
    if element is None:
        return None
    found = element.find(path, CAP)
    if found is None or found.text is None:
        return None
    return found.text.strip() or None


def parse_rss(content: bytes) -> list[RssItem]:
    """The items of the Sachet feed. The sender's name is taken from the brackets in <author>."""
    root = SafeET.fromstring(content)
    items = []
    for item in root.iter("item"):
        guid, link = item.findtext("guid"), item.findtext("link")
        if not guid or not link:
            continue
        author = item.findtext("author") or ""
        name = author[author.find("(") + 1 : author.rfind(")")].strip() if "(" in author else None
        published = None
        if item.findtext("pubDate"):
            try:
                published = datetime.strptime(item.findtext("pubDate").strip(), "%a, %d %b %Y %H:%M:%S GMT").replace(tzinfo=timezone.utc)
            except ValueError:
                published = None
        items.append(RssItem(guid=guid.strip(), link=link.strip(), author=name or None, published=published))
    return items


def parse_cap(content: bytes) -> CapMessage:
    """One CAP 1.2 message. Uses the English <info> block when there is one."""
    root = SafeET.fromstring(content)
    # References look like "sender,identifier,sent"; only the identifier is needed.
    references = []
    for ref in (_text(root, "cap:references") or "").split():
        parts = ref.split(",")
        if len(parts) >= 2:
            references.append(parts[1])
    message = CapMessage(
        identifier=_text(root, "cap:identifier"),
        status=_text(root, "cap:status"),
        msg_type=_text(root, "cap:msgType"),
        sent=parse_time(_text(root, "cap:sent")),
        references=references,
    )
    infos = root.findall("cap:info", CAP)
    if not infos:
        return message
    info = next((i for i in infos if (_text(i, "cap:language") or "").lower().startswith("en")), infos[0])
    message.event = _text(info, "cap:event")
    message.severity = _text(info, "cap:severity")
    message.urgency = _text(info, "cap:urgency")
    message.certainty = _text(info, "cap:certainty")
    message.headline = _text(info, "cap:headline")
    message.description = _text(info, "cap:description")
    message.instruction = _text(info, "cap:instruction")
    message.onset = parse_time(_text(info, "cap:onset") or _text(info, "cap:effective"))
    message.expires = parse_time(_text(info, "cap:expires"))
    areas = info.findall("cap:area", CAP)
    message.area_desc = "; ".join(d for d in (_text(a, "cap:areaDesc") for a in areas) if d) or None
    for area in areas:
        message.polygons += [p.text.strip() for p in area.findall("cap:polygon", CAP) if p.text and p.text.strip()]
    for parameter in info.findall("cap:parameter", CAP):
        if (_text(parameter, "cap:valueName") or "").lower() == "polygon url":
            message.polygon_url = _text(parameter, "cap:value")
    return message


def parse_polygon_file(content: bytes) -> list[str]:
    """The rings in one of Sachet's polygon files, each written as "lat,lon lat,lon" pairs."""
    root = SafeET.fromstring(content)
    return [p.text.strip() for p in root.iter() if p.tag.split("}")[-1] == "polygon" and p.text and p.text.strip()]


# Geometry: is a point inside an alert's area?


def parse_ring(text: str) -> list[tuple[float, float]]:
    """A ring of "lat,lon" pairs as (lat, lon) tuples; malformed pairs are skipped."""
    points = []
    for pair in text.split():
        lat, _, lon = pair.partition(",")
        try:
            points.append((float(lat), float(lon)))
        except ValueError:
            continue
    return points


def bounding_box(rings: list[str]) -> tuple[float, float, float, float] | None:
    """(min lat, max lat, min lon, max lon) around all rings, used as a quick database filter."""
    points = [p for ring in rings for p in parse_ring(ring)]
    if not points:
        return None
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    return min(lats), max(lats), min(lons), max(lons)


def in_ring(lat: float, lon: float, ring: list[tuple[float, float]]) -> bool:
    """Ray casting; points are (lat, lon)."""
    inside = False
    n = len(ring)
    for i in range(n):
        lat1, lon1 = ring[i]
        lat2, lon2 = ring[(i + 1) % n]
        if (lon1 > lon) != (lon2 > lon):
            crossing = lat1 + (lon - lon1) * (lat2 - lat1) / (lon2 - lon1)
            if lat < crossing:
                inside = not inside
    return inside


def covers(polygons: str | None, lat: float, lon: float) -> bool:
    """True when the point lies inside any of the stored rings."""
    if not polygons:
        return False
    return any(in_ring(lat, lon, parse_ring(ring)) for ring in polygons.split("|") if ring)


# Polling the Sachet feed.


@dataclass
class PollState:
    """When the feed was last read, shown on the API so a stale feed is visible."""

    last_attempt: datetime | None = None
    last_ok: datetime | None = None
    last_error: str | None = None
    stored: int = 0


POLL = PollState()


def poll_sachet(session: Session, client: httpx.Client, now: datetime | None = None, gap: float = REQUEST_GAP_SECONDS) -> dict:
    """Read the feed and store messages not seen before. Returns a summary."""
    now = now or datetime.now(timezone.utc)
    POLL.last_attempt = now
    response = client.get(SACHET_RSS)
    response.raise_for_status()
    items = parse_rss(response.content)
    known = set(session.scalars(select(Alert.guid).where(Alert.source == "sachet", Alert.guid.in_([i.guid for i in items]))))
    new = sorted((i for i in items if i.guid not in known), key=lambda i: i.published or now)[:MAX_NEW_PER_POLL]
    stored = failed = 0
    for item in new:
        try:
            cap = parse_cap(client.get(item.link).raise_for_status().content)
        except (httpx.HTTPError, ParseError, ValueError) as exc:
            failed += 1
            log.warning("alerts: couldn't read %s: %s", item.link, exc)
            continue
        live = cap.status == "Actual" and cap.msg_type != "Cancel" and (cap.expires is None or cap.expires > now)
        rings = cap.polygons
        if live and not rings and cap.polygon_url:
            try:
                rings = parse_polygon_file(client.get(cap.polygon_url).raise_for_status().content)
            except (httpx.HTTPError, ParseError, ValueError) as exc:
                log.warning("alerts: no polygon for %s: %s", item.guid, exc)
        box = bounding_box(rings)
        session.add(
            Alert(
                source="sachet", guid=item.guid, identifier=cap.identifier, status=cap.status, msg_type=cap.msg_type,
                sender_name=item.author, event=cap.event, severity=cap.severity, urgency=cap.urgency,
                certainty=cap.certainty, headline=cap.headline, description=cap.description,
                instruction=cap.instruction, area_desc=cap.area_desc, sent=cap.sent, onset=cap.onset,
                expires=cap.expires, polygons="|".join(rings) if rings and live else None,
                min_lat=box[0] if box else None, max_lat=box[1] if box else None,
                min_lon=box[2] if box else None, max_lon=box[3] if box else None,
                link=item.link[:300],
            )
        )
        if cap.msg_type in ("Update", "Cancel") and cap.references:
            session.execute(
                update(Alert)
                .where(Alert.source == "sachet", Alert.identifier.in_(cap.references), Alert.superseded_at.is_(None))
                .values(superseded_at=now)
            )
        session.commit()
        stored += 1
        if gap:
            time.sleep(gap)
    session.execute(delete(Alert).where(Alert.source == "sachet", Alert.expires < now - KEEP_AFTER_EXPIRY))
    session.commit()
    POLL.last_ok, POLL.last_error, POLL.stored = now, None, POLL.stored + stored
    summary = {"items": len(items), "new": len(new), "stored": stored, "failed": failed}
    log.info("alerts: Sachet feed has %(items)d items, %(new)d new, %(stored)d stored, %(failed)d failed", summary)
    return summary


def poll_once() -> None:
    """Read the feed once with its own session and client; errors are logged, not raised."""
    try:
        with new_session() as session, httpx.Client(timeout=20, headers={"User-Agent": USER_AGENT}) as client:
            poll_sachet(session, client)
    except Exception as exc:  # noqa: BLE001 - keep the schedule alive and report on the API
        POLL.last_error = str(exc)[:200]
        log.warning("alerts: Sachet poll failed: %s", exc)


async def scheduler(minutes: int, first_delay_seconds: float = 10) -> None:
    """Read the feed shortly after startup and then every `minutes` minutes."""
    await asyncio.sleep(first_delay_seconds)
    while True:
        await asyncio.to_thread(poll_once)
        await asyncio.sleep(minutes * 60)


# Answering for a place.


def coverage_for(latitude: float, longitude: float, country: str | None) -> str:
    """Which official source covers a place: 'india', 'us' or 'none'."""
    if country:
        code = country.upper()
        return "india" if code == "IN" else "us" if code in US_CODES else "none"
    lat0, lat1, lon0, lon1 = INDIA_BOX
    if lat0 <= latitude <= lat1 and lon0 <= longitude <= lon1:
        return "india"
    if any(a <= latitude <= b and c <= longitude <= d for a, b, c, d in US_BOXES):
        return "us"
    return "none"


def active_sachet_alerts(session: Session, latitude: float, longitude: float, now: datetime | None = None) -> list[Alert]:
    """Stored Sachet alerts in effect now whose area contains the point. The bounding box narrows
    the query; the polygon test then decides."""
    now = now or datetime.now(timezone.utc)
    rows = session.scalars(
        select(Alert).where(
            Alert.source == "sachet",
            Alert.status == "Actual",
            Alert.msg_type != "Cancel",
            Alert.superseded_at.is_(None),
            Alert.expires > now,
            Alert.min_lat <= latitude,
            Alert.max_lat >= latitude,
            Alert.min_lon <= longitude,
            Alert.max_lon >= longitude,
        )
    ).all()
    return [a for a in rows if covers(a.polygons, latitude, longitude)]


_nws_cache: dict[str, tuple[float, list[dict]]] = {}
_nws_lock = threading.Lock()


def fetch_nws(latitude: float, longitude: float, client: httpx.Client | None = None) -> list[dict]:
    """Active NWS alerts at a point (cached for a few minutes)."""
    key = f"{latitude:.2f},{longitude:.2f}"
    with _nws_lock:
        hit = _nws_cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    owns = client is None
    client = client or httpx.Client(timeout=15, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
    try:
        response = client.get(NWS_ALERTS, params={"point": key})
        if response.status_code in (400, 404):  # outside NWS's area
            features = []
        else:
            response.raise_for_status()
            features = response.json().get("features", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise AlertSourceError("Couldn't reach the US National Weather Service.") from exc
    finally:
        if owns:
            client.close()
    out = []
    for f in features:
        p = f.get("properties", {})
        if p.get("status") != "Actual" or p.get("messageType") == "Cancel":
            continue
        out.append(
            {
                "id": p.get("id"),
                "event": p.get("event"),
                "severity": p.get("severity"),
                "urgency": p.get("urgency"),
                "certainty": p.get("certainty"),
                "headline": p.get("headline"),
                "description": p.get("description"),
                "instruction": p.get("instruction"),
                "area": p.get("areaDesc"),
                "onset": p.get("onset") or p.get("effective"),
                "expires": p.get("ends") or p.get("expires"),
                "sender": p.get("senderName"),
                "link": None,
            }
        )
    with _nws_lock:
        _nws_cache[key] = (time.monotonic() + NWS_CACHE_SECONDS, out)
    return out


def _iso(value: datetime | None) -> str | None:
    """ISO time in UTC; SQLite hands back naive datetimes, which are UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def alert_out(a: Alert) -> dict:
    """A stored alert in the same shape as an NWS one, for the API."""
    return {
        "id": a.identifier or a.guid,
        "event": a.event,
        "severity": a.severity,
        "urgency": a.urgency,
        "certainty": a.certainty,
        "headline": a.headline,
        "description": a.description,
        "instruction": a.instruction,
        "area": a.area_desc,
        "onset": _iso(a.onset),
        "expires": _iso(a.expires),
        "sender": a.sender_name,
        "link": a.link,
    }


def sort_alerts(alerts: list[dict]) -> list[dict]:
    """Most severe first, then the ones that end soonest."""
    return sorted(alerts, key=lambda a: (SEVERITY_ORDER.get(a.get("severity") or "", 9), a.get("expires") or ""))
