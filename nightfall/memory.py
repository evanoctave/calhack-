"""Caregiver notes memory: familiar places and habits, searched semantically.

Real: Moss index (integrations/moss.py). Mock: TF-IDF cosine over the same notes with sparse dict
vectors. Both expose ensure() and search(query, k). Used by the redirect line ("the store is closed,
Dad"), the brief (habits section) and the call agent's fact sheet. Rejected: embedding with Claude;
notes are tiny and Moss is the sponsor track.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

from nightfall.household import Household
from nightfall.integrations import moss

_TOK = re.compile(r"[a-z0-9]+")
_STOP = frozenset(
    {"the", "a", "an", "to", "he", "she", "on", "at", "in", "of", "and", "is", "was", "i", "go", "went", "every"}
)


def notes_from(hh: Household) -> list[dict[str, Any]]:
    """Flatten household notes and familiar places into documents."""
    docs: list[dict[str, Any]] = []
    for i, p in enumerate(hh.familiar_places):
        docs.append(
            {
                "id": f"NT-place-{i}",
                "text": ", ".join(filter(None, (p["name"], p.get("note", "")))),
                "kind": "familiar_place",
                "lat": p.get("lat"),
                "lng": p.get("lng"),
            }
        )
    for i, n in enumerate(hh.notes):
        docs.append({"id": f"NT-note-{i}", "text": n["text"], "kind": n.get("kind", "habit")})
    return docs


def _vec(text: str) -> Counter[str]:
    return Counter(t for t in _TOK.findall(text.lower()) if t not in _STOP)


class TfidfMemory:
    """Deterministic mock. Precomputes idf and norms once."""

    def __init__(self) -> None:
        self._docs: list[dict[str, Any]] = []
        self._vecs: list[dict[str, float]] = []
        self._idf: dict[str, float] = {}

    async def ensure(self, docs: list[dict[str, Any]]) -> int:
        self._docs = list(docs)
        tfs = [_vec(d["text"]) for d in docs]
        n = max(len(docs), 1)
        df: Counter[str] = Counter(t for tf in tfs for t in tf)
        self._idf = {t: math.log((1 + n) / (1 + c)) + 1 for t, c in df.items()}
        self._vecs = [self._weigh(tf) for tf in tfs]
        return len(docs)

    def _weigh(self, tf: Counter[str]) -> dict[str, float]:
        w = {t: c * self._idf.get(t, 1.0) for t, c in tf.items()}
        norm = math.sqrt(sum(v * v for v in w.values())) or 1.0
        return {t: v / norm for t, v in w.items()}

    async def search(self, query: str, k: int = 3) -> list[dict[str, Any]]:
        q = self._weigh(_vec(query))
        scored = []
        for d, v in zip(self._docs, self._vecs):
            s = sum(q.get(t, 0.0) * w for t, w in v.items())
            if s > 0:
                scored.append((s, d))
        scored.sort(key=lambda x: (-x[0], x[1]["id"]))
        return [{**d, "score": round(s, 3)} for s, d in scored[:k]]

    async def close(self) -> None:
        return None


class Memory:
    """Facade that picks Moss or TF-IDF and never raises into the caller."""

    def __init__(self, hh: Household) -> None:
        self.source = "moss" if moss.enabled() else "mock"
        self._impl: Any = None
        self._hh = hh
        self.ready = False

    async def ensure(self) -> int:
        docs = notes_from(self._hh)
        if self.source == "moss":
            try:
                self._impl = moss.MossIndex(self._hh.id)
                n = await self._impl.ensure(docs)
                self.ready = True
                return n
            except Exception as e:  # noqa: BLE001
                print(f"moss fallback: {e}")
                self.source = "mock"
        self._impl = TfidfMemory()
        n = await self._impl.ensure(docs)
        self.ready = True
        return n

    async def search(self, query: str, k: int = 3) -> list[dict[str, Any]]:
        """Semantic hits for a query; empty list on any failure."""
        if not self.ready:
            return []
        try:
            return await self._impl.search(query, k)
        except Exception as e:  # noqa: BLE001
            print(f"memory search fallback: {e}")
            return []

    async def close(self) -> None:
        if self._impl is not None:
            await self._impl.close()
