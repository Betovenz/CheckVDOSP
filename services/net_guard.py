"""
Guards for outbound requests to URLs that come from the user or from a request.

`guarded_client()` returns an httpx.AsyncClient that refuses to connect to loopback,
private (LAN), link-local or other non-public addresses — on the first request AND on
every redirect hop — so endpoints like /api/proxy-image can't be used to reach the
user's own machine or home network.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Any

import httpx


class BlockedURLError(httpx.RequestError):
    pass


async def _assert_public_host(host: str) -> None:
    host = (host or "").strip("[]")
    if not host:
        raise BlockedURLError("URL has no host")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise BlockedURLError(f"Cannot resolve host {host}: {exc}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if not ip.is_global:
            raise BlockedURLError(f"Blocked request to non-public address ({host})")


async def _check_request(request: httpx.Request) -> None:
    if request.url.scheme not in ("http", "https"):
        raise BlockedURLError(f"Blocked URL scheme: {request.url.scheme}")
    await _assert_public_host(request.url.host)


def guarded_client(**kwargs: Any) -> httpx.AsyncClient:
    hooks = dict(kwargs.pop("event_hooks", None) or {})
    hooks["request"] = [_check_request, *hooks.get("request", [])]
    return httpx.AsyncClient(event_hooks=hooks, **kwargs)
