from __future__ import annotations

import numpy as np

from ai_persona import query_retrieval as retrieval


def test_lexical_matching_preserves_chinese_partial_names_and_english_word_boundaries():
    assert retrieval.lexical_score("ED", "performed and learned") == 0
    assert retrieval.lexical_score("ED", "ED simulations") == 1
    assert retrieval.lexical_score("张量", "张量网络") == 1
    assert retrieval.lexical_score("Levy", "Lévy walk") == 1


def test_embedding_cache_is_content_and_pipeline_addressed(tmp_path, monkeypatch):
    calls = []
    class Model:
        def embed(self, texts, **kwargs):
            calls.append(list(texts))
            for text in texts:
                yield np.array([len(text), 1], dtype=np.float32)
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "1")
    monkeypatch.setenv("AI_PERSONA_EMBEDDING_MODEL", retrieval.MODEL_NAME)
    monkeypatch.setattr(retrieval, "embedding_model", lambda *args: Model())
    service = retrieval.SemanticRetriever(tmp_path)
    scores, status = service.rank("question", {"id": "content"})
    assert status["status"] == "ready" and status["local"] and scores
    assert calls == [["passage: content"], ["query: question"]]
    calls.clear()
    service.rank("next question", {"different_id": "content"})
    assert calls == [["query: next question"]]  # Identical content reuses its vector.
    calls.clear()
    service.rank("question", {"id": "modified content"})
    assert calls == [["passage: modified content"], ["query: question"]]
    calls.clear()
    monkeypatch.setattr(retrieval, "PIPELINE_VERSION", "changed-extractor")
    service.rank("question", {"id": "content"})
    assert calls == [["passage: content"], ["query: question"]]


def test_semantic_failure_is_reported_and_disabled_mode_never_loads_model(tmp_path, monkeypatch):
    calls = []
    def fail(*args):
        calls.append(args)
        raise RuntimeError("private host error detail")
    monkeypatch.setattr(retrieval, "embedding_model", fail)
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    service = retrieval.SemanticRetriever(tmp_path)
    assert service.rank("q", {"id": "body"})[1]["status"] == "disabled"
    assert calls == []
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "1")
    scores, status = service.rank("q", {"id": "body"})
    assert scores == {} and status["status"] == "unavailable"
    assert "private host" not in str(status)
    assert len(calls) == 1
