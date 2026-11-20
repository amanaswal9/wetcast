"""Key journeys through WeatherAI, checked in a real browser against recorded data."""

from __future__ import annotations

import re

import pytest
from playwright.sync_api import expect

from conftest import DESKTOP, PHONE, axe_violations, close, expect_screenshot, goto, open_app

PAGES = ["dashboard", "forecast", "map", "assistant", "analytics", "models", "locations", "about"]


def test_dashboard_shows_the_weather(desktop):
    goto(desktop)
    expect(desktop.get_by_role("heading", level=1)).to_contain_text("New Delhi")
    lcd = desktop.locator(".r-lcd")
    expect(lcd).to_contain_text("°C")
    expect(desktop.get_by_text(re.compile(r"^It's -?\d+°C and"))).to_be_visible()
    # The official warnings line has answered (warnings or "none", never stuck on "checking").
    expect(desktop.get_by_text(re.compile(r"warnings", re.I)).filter(visible=True).first).to_be_visible()
    expect(desktop.get_by_text("Official warnings: checking…")).to_have_count(0)
    # The hourly chart tells screen readers what it shows, not only that it is a chart.
    expect(desktop.get_by_role("group", name=re.compile("^Temperature by hour"))).to_have_accessible_description(
        re.compile(r"Lowest -?\d+ °C at \d\d:\d\d, highest -?\d+ °C at \d\d:\d\d")
    )
    expect_screenshot(desktop, "dashboard-desktop")


def test_dashboard_on_a_phone(phone):
    goto(phone)
    expect(phone.locator(".r-lcd")).to_be_visible()
    # The phone header is one row: no menu bar, icon-only toolbar.
    expect(phone.get_by_role("navigation", name="Pages", exact=True)).to_be_hidden()
    expect(phone.get_by_role("navigation", name="Quick launch")).to_be_visible()
    expect_screenshot(phone, "dashboard-phone")


def test_search_for_a_city(desktop):
    goto(desktop)
    desktop.get_by_role("combobox").fill("Jaipur")
    option = desktop.get_by_role("option").filter(has_text="Jaipur").first
    expect(option).to_be_visible()
    option.click()
    expect(desktop.get_by_role("heading", level=1)).to_contain_text("Jaipur")
    expect(desktop.locator(".r-lcd")).to_contain_text("°C")
    expect(desktop.get_by_text(re.compile(r"\(European AQI\)"))).to_be_visible()  # air quality for Jaipur too
    desktop.wait_for_load_state("networkidle")


def test_start_menu_by_keyboard_then_pick_a_day(desktop):
    goto(desktop)
    start = desktop.get_by_role("button", name="Start")
    start.click()
    desktop.keyboard.press("f")  # underlined shortcut letter for Forecast
    expect(desktop).to_have_url(re.compile(r"#/forecast$"))
    days = desktop.get_by_role("tablist", name="Choose a day").get_by_role("tab")
    expect(days).to_have_count(7)
    days.nth(2).click()
    expect(days.nth(2)).to_have_attribute("aria-selected", "true")
    expect(desktop.get_by_text("WeatherAI model prediction, next 24 hours")).to_be_visible()
    # Delhi is a training city: the panel says so, with the error measured there.
    note = desktop.locator('[data-coverage="trained"]')
    expect(note).to_contain_text("Trained city.")
    expect(note).to_contain_text("Average error to expect from the Ensemble")
    expect_screenshot(desktop, "forecast-desktop")


def test_switch_units_to_fahrenheit(desktop):
    goto(desktop)
    desktop.get_by_role("button", name="Start").click()
    desktop.get_by_role("button", name=re.compile("^Units")).click()
    dialog = desktop.get_by_role("dialog", name="Units")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role("radio", name="Celsius (°C)")).to_be_focused()
    dialog.get_by_role("radio", name="Fahrenheit (°F)").check()
    dialog.get_by_role("radio", name="Miles per hour (mph)").check()
    dialog.get_by_role("radio", name="12-hour (1:15 pm)").check()
    expect(dialog.get_by_text(re.compile(r"Example: 70°F, wind 7 mph, sunset 5:45 pm"))).to_be_visible()
    dialog.get_by_role("button", name="OK").click()
    expect(dialog).to_be_hidden()
    expect(desktop.locator(".r-lcd")).to_contain_text("°F")
    expect(desktop.get_by_text(re.compile(r"^It's -?\d+°F and"))).to_be_visible()
    expect(desktop.locator("footer time")).to_have_text(re.compile(r"(am|pm)$"))


def test_map_layers_and_pin(desktop):
    goto(desktop, "map")
    tools = desktop.get_by_role("group", name="Map layer")
    expect(tools.get_by_role("button", name="Temperature")).to_have_attribute("aria-pressed", "true")
    expect(desktop.locator(".r-map-pointer")).to_be_visible()
    tools.get_by_role("button", name="Rain").click()
    expect(tools.get_by_role("button", name="Rain")).to_have_attribute("aria-pressed", "true")
    expect(desktop.get_by_text(re.compile(r"Rain, showers and snow .*\(mm\)"))).to_be_visible()


def test_unknown_address_says_not_found(desktop):
    goto(desktop, "radar")
    alert = desktop.get_by_role("alert", name="WeatherAI")
    expect(alert).to_contain_text("Not found.")
    expect(alert).to_contain_text('"radar"')
    expect_screenshot(desktop, "not-found-desktop")
    alert.get_by_role("button", name="Go to the Dashboard").click()
    expect(desktop.locator(".r-lcd")).to_be_visible()


def test_every_page_loads_without_errors(desktop):
    errors: list[str] = []
    desktop.on("pageerror", lambda e: errors.append(str(e)))
    goto(desktop)
    for page_id in PAGES:
        goto(desktop, page_id)
        expect(desktop.locator("#content")).not_to_be_empty()
        expect(desktop.get_by_text("This page stopped working")).to_have_count(0)
    assert errors == []


@pytest.mark.parametrize("theme", ["light", "dark"])
@pytest.mark.parametrize("page_id", PAGES)
def test_accessibility(browser, server, page_id, theme):
    page = open_app(browser, server, DESKTOP, theme=theme)
    try:
        goto(page, page_id)
        page.wait_for_timeout(300)
        found = axe_violations(page)
        assert found == [], "\n".join(f"{v['impact']}: {v['id']} ({v['help']}) at {v['nodes']}" for v in found)
    finally:
        close(page)


def test_accessibility_on_a_phone(browser, server):
    page = open_app(browser, server, PHONE)
    try:
        goto(page)
        page.get_by_role("button", name="Start").click()
        found = axe_violations(page)
        assert found == [], "\n".join(f"{v['impact']}: {v['id']} ({v['help']}) at {v['nodes']}" for v in found)
    finally:
        close(page)
