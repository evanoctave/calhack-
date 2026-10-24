"""Twilio REST: outbound call that fetches TwiML from our server, and an SMS. Basic auth over httpx."""

from __future__ import annotations

import os
from typing import Final

import httpx

BASE: Final = "https://api.twilio.com/2010-04-01"


def enabled() -> bool:
    """True when account, token and from-number are configured and MOCK is off."""
    return os.environ.get("MOCK", "1") != "1" and all(
        os.environ.get(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM")
    )


def _auth() -> tuple[str, str]:
    return os.environ["TWILIO_ACCOUNT_SID"], os.environ["TWILIO_AUTH_TOKEN"]


def create_call(to: str, twiml_url: str) -> str:
    """Start a call; Twilio POSTs to twiml_url for instructions. Returns the call SID."""
    sid, _ = _auth()
    r = httpx.post(
        f"{BASE}/Accounts/{sid}/Calls.json",
        auth=_auth(),
        timeout=10.0,
        data={"To": to, "From": os.environ["TWILIO_FROM"], "Url": twiml_url, "Method": "POST"},
    )
    r.raise_for_status()
    return str(r.json().get("sid", ""))


def send_sms(to: str, body: str) -> str:
    """Send one SMS. Returns the message SID."""
    sid, _ = _auth()
    r = httpx.post(
        f"{BASE}/Accounts/{sid}/Messages.json",
        auth=_auth(),
        timeout=10.0,
        data={"To": to, "From": os.environ["TWILIO_FROM"], "Body": body},
    )
    r.raise_for_status()
    return str(r.json().get("sid", ""))
