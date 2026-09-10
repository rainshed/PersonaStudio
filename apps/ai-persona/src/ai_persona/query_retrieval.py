"""Local multilingual retrieval with content-addressed embedding caches."""

from __future__ import annotations

import os
import re
import sqlite3
import threading
import unicodedata
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path

import numpy as np

from .query_contracts import digest

MODEL_NAME = "intfloat/multilingual-e5-small"
PIPELINE_VERSION = "passage-query-v3-e5-int8/fastembed-" + version("fastembed")
_model_lock = threading.RLock()


def normalize(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text.casefold())
                   if not unicodedata.combining(c))


def terms(text: str) -> set[str]:
    result: set[str] = set()
    for term in re.findall(r"[\w]+", normalize(text)):
        if re.search(r"[\u3400-\u9fff]", term):
            # Chinese partial matching also works without a word-boundary tokenizer.
            result.update(term[i:i + 2] for i in range(len(term) - 1))
            if len(term) == 1:
                result.add(term)
        else:
            result.add(term)
    return result


def lexical_score(query: str, text: str) -> float:
    query_terms = terms(query)
    if not query_terms:
        return 0.0
    haystack = normalize(text)
    words = set(re.findall(r"[\w]+", haystack))
    matched = sum(term in haystack if re.search(r"[\u3400-\u9fff]", term)
                  else term in words for term in query_terms)
    return matched / len(query_terms)


@lru_cache(maxsize=2)
def embedding_model(name: str, cache: str):
    from fastembed import TextEmbedding
    from fastembed.common.model_description import ModelSource, PoolingType

    if name == MODEL_NAME and name not in {m["model"] for m in TextEmbedding.list_supported_models()}:
        TextEmbedding.add_custom_model(
            model=name, pooling=PoolingType.MEAN, normalization=True,
            sources=ModelSource(hf="Xenova/multilingual-e5-small"), dim=384,
            model_file="onnx/model_quantized.onnx", license="mit", size_in_gb=0.118,
        )

    return TextEmbedding(model_name=name, cache_dir=cache, threads=2)


class SemanticRetriever:
    """All embeddings stay on the host; no Persona text is sent to a provider."""

    def __init__(self, state_root: Path):
        self.state_root = state_root
        self.model_name = os.environ.get("AI_PERSONA_EMBEDDING_MODEL", MODEL_NAME)
        self.model_cache = os.environ.get(
            "AI_PERSONA_MODEL_CACHE", str(Path.home() / ".cache" / "ai-persona" / "models"),
        )

    @property
    def signature(self) -> str:
        return digest({"model": self.model_name, "pipeline": PIPELINE_VERSION,
                       "enabled": os.environ.get("AI_PERSONA_SEMANTIC_SEARCH", "1")})

    def rank(self, query: str, documents: dict[str, str]) -> tuple[dict[str, float], dict]:
        if not documents:
            return {}, {"status": "ready", "model": self.model_name, "documents": 0}
        if os.environ.get("AI_PERSONA_SEMANTIC_SEARCH", "1") == "0":
            return {}, {"status": "disabled", "model": self.model_name}
        try:
            self.state_root.mkdir(parents=True, exist_ok=True)
            with _model_lock:
                model = embedding_model(self.model_name, self.model_cache)
                model_path = getattr(getattr(model, "model", None), "_model_dir", None)
                artifact = Path(model_path).name if model_path else self.model_name
                keys = {rid: digest({"model": self.model_name, "text": text,
                                    "pipeline": PIPELINE_VERSION, "artifact": artifact})
                        for rid, text in documents.items()}
                vectors = {}
                with sqlite3.connect(self.state_root / "query-vectors.sqlite3") as db:
                    db.execute("CREATE TABLE IF NOT EXISTS vectors "
                               "(key TEXT PRIMARY KEY, vector BLOB NOT NULL)")
                    missing = {}
                    for rid, key in keys.items():
                        row = db.execute("SELECT vector FROM vectors WHERE key=?", (key,)).fetchone()
                        if row:
                            vectors[rid] = np.frombuffer(row[0], dtype=np.float32)
                        else:
                            missing[rid] = documents[rid]
                    if missing:
                        output = (model.embed(["passage: " + text for text in missing.values()], batch_size=16)
                                  if self.model_name == MODEL_NAME else
                                  model.passage_embed(list(missing.values()), batch_size=16))
                        for rid, vector in zip(missing, output, strict=True):
                            vector = np.asarray(vector, dtype=np.float32)
                            vectors[rid] = vector
                            db.execute("INSERT OR REPLACE INTO vectors VALUES (?, ?)",
                                       (keys[rid], vector.tobytes()))
                    query_vectors = (model.embed(["query: " + query]) if self.model_name == MODEL_NAME
                                     else model.query_embed(query))
                    q = np.asarray(next(iter(query_vectors)), dtype=np.float32)
                scores = {}
                for rid, vector in vectors.items():
                    denominator = float(np.linalg.norm(q) * np.linalg.norm(vector))
                    if denominator:
                        cosine = float(np.dot(q, vector) / denominator)
                        # E5 has a compressed cosine distribution. Bring it into the
                        # common ranking range; this is not a calibrated probability.
                        scores[rid] = ((cosine - 0.65) / 0.35 if self.model_name == MODEL_NAME
                                       else cosine)
                return scores, {"status": "ready", "model": self.model_name,
                                "documents": len(documents), "local": True,
                                "model_revision": artifact, "pipeline_version": PIPELINE_VERSION,
                                "score_type": "adjusted_cosine" if self.model_name == MODEL_NAME
                                else "cosine"}
        except Exception:
            # Retrieval remains usable, but must not claim semantic coverage.
            return {}, {"status": "unavailable", "model": self.model_name,
                        "reason": "Local embedding model could not be loaded or evaluated."}
