"""Moss semantic index over the household's notes. Async SDK; one index per household.

Index name is derived from the household id. Documents are the caregiver's notes (familiar places,
habits). Real mode needs MOSS_PROJECT_ID and MOSS_PROJECT_KEY; MOSS_API_KEY alone is not enough.
"""

from __future__ import annotations

import os
from typing import Any


def enabled() -> bool:
    """True when project credentials are configured and MOCK is off."""
    return (
        os.environ.get("MOCK", "1") != "1"
        and bool(os.environ.get("MOSS_PROJECT_ID"))
        and bool(os.environ.get("MOSS_PROJECT_KEY"))
    )


def index_name(household_id: str) -> str:
    return "nightfall-" + household_id.lower().replace("_", "-")


class MossIndex:
    """Thin wrapper: ensure(docs) builds or refreshes the index, search(q, k) returns hits."""

    def __init__(self, household_id: str) -> None:
        from moss import MossClient

        self.name = index_name(household_id)
        self._client = MossClient(os.environ["MOSS_PROJECT_ID"], os.environ["MOSS_PROJECT_KEY"])
        self._loaded = False
        self._empty = False

    async def ensure(self, docs: list[dict[str, Any]]) -> int:
        """Create the index if missing, upsert docs otherwise, then load it locally. Returns doc count."""
        from moss import DocumentInfo, MutationOptions

        items = [
            DocumentInfo(
                id=d["id"],
                text=d["text"],
                metadata={k: str(v) for k, v in d.items() if k not in ("id", "text") and v is not None},
            )
            for d in docs
        ]
        if not items:
            # Moss rejects an empty mutation (HTTP 400 VALIDATION_FAILED). A fresh household has no
            # notes yet: stay on Moss, index nothing, answer searches with [] until notes arrive.
            self._empty = True
            self._loaded = False
            return 0
        self._empty = False
        names = {i.name for i in await self._client.list_indexes()}
        if self.name not in names:
            await self._client.create_index(self.name, items, wait=True)
        else:
            await self._client.add_docs(self.name, items, MutationOptions(upsert=True))
        await self._client.load_index(self.name)
        self._loaded = True
        return len(items)

    async def search(self, query: str, k: int = 3) -> list[dict[str, Any]]:
        """Top-k hits as plain dicts {id, text, score, **metadata}."""
        from moss import QueryOptions

        if self._empty:
            return []
        if not self._loaded:
            await self._client.load_index(self.name)
            self._loaded = True
        res = await self._client.query(self.name, query, QueryOptions(top_k=k))
        out: list[dict[str, Any]] = []
        for h in getattr(res, "docs", None) or []:
            meta = dict(getattr(h, "metadata", None) or {})
            out.append(
                {
                    "id": getattr(h, "id", ""),
                    "text": getattr(h, "text", ""),
                    "score": float(getattr(h, "score", 0.0) or 0.0),
                    **meta,
                }
            )
        return out

    async def close(self) -> None:
        try:
            await self._client.close()
        except Exception as e:  # noqa: BLE001
            print(f"moss close: {e}")
