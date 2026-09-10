"""Project-owned prompt versions and finite experiment records. No model calls."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

TOKEN = re.compile(r"\{\{\s*(@?[a-zA-Z0-9_.-]+)\s*\}\}")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def now():
    return datetime.now(UTC).isoformat()


class PromptError(ValueError):
    def __init__(self, message, code="invalid_request", status=400):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


class PromptStore:
    def __init__(self, directory, catalog=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / "prompts.sqlite3"
        items = (
            catalog
            if catalog is not None
            else json.loads((Path(__file__).parent / "prompts/catalog.json").read_text())
        )
        self.definitions = {v["id"]: v for v in items}
        if len(self.definitions) != len(items):
            raise PromptError("提示词 ID 重复。")
        with self.db() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS versions (prompt_id TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(prompt_id,id));
            CREATE TABLE IF NOT EXISTS active (prompt_id TEXT PRIMARY KEY, version TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt_id TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS trigger_models (prompt_id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS plan_history (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            """)
            for definition in items:
                value = self.make_version(definition["id"], definition["templates"], "项目默认版本")
                db.execute(
                    "INSERT OR IGNORE INTO versions VALUES (?,?,?)",
                    (definition["id"], value["id"], encoded(value)),
                )
                if definition["id"] in {"ai-persona.activation", "ai-persona.conversation-candidate"}:
                    active = self._version(db, definition["id"])
                    if active["signature"] != value["signature"]:
                        # Keep previous text in history; execution uses the current protocol.
                        db.execute("UPDATE active SET version=? WHERE prompt_id=?",
                                   (value["id"], definition["id"]))
        self.path.chmod(0o600)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=20)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def definition(self, identifier):
        if identifier not in self.definitions:
            raise PromptError("提示词不存在。", "not_found", 404)
        return self.definitions[identifier]

    def signature(self, identifier):
        d = self.definition(identifier)
        return digest(
            {key: d.get(key) for key in ("kind", "variables", "schema_version", "dependencies")}
        )

    def make_version(self, identifier, templates, note="", base=None):
        d = self.definition(identifier)
        if not isinstance(templates, dict) or set(templates) != set(d["templates"]):
            raise PromptError("模板字段与当前功能不兼容。")
        if not all(isinstance(v, str) and len(v) <= 50000 for v in templates.values()):
            raise PromptError("模板必须是文本，每段不超过 50000 字符。")
        if not isinstance(note, str) or len(note) > 500:
            raise PromptError("修改说明不超过 500 字符。")
        variables = {v["name"] for v in d["variables"]}
        refs = set(TOKEN.findall("\n".join(templates.values())))
        if refs - variables - {"@" + dep for dep in d.get("dependencies", [])}:
            raise PromptError("模板使用了未声明的变量或共用规则。")
        required = {v["name"] for v in d["variables"] if v.get("required", True)}
        if required - refs:
            raise PromptError("模板缺少必要变量：" + ", ".join(sorted(required - refs)))
        # Dependencies are part of the executable contract, not removable display text.
        if {"@" + dep for dep in d.get("dependencies", [])} - refs:
            raise PromptError("模板必须保留声明的共用规则引用。")
        value = {"templates": templates, "signature": self.signature(identifier)}
        return {
            **value,
            "id": digest(value),
            "prompt_id": identifier,
            "note": note,
            "base_version": base,
            "created_at": now(),
        }

    def _version(self, db, identifier, version=None):
        d = self.definition(identifier)
        if version in (None, "active"):
            row = db.execute(
                "SELECT version FROM active WHERE prompt_id=?", (identifier,)
            ).fetchone()
            version = row[0] if row else "default"
        if version == "default":
            version = self.make_version(identifier, d["templates"])["id"]
        row = db.execute(
            "SELECT data FROM versions WHERE prompt_id=? AND id=?", (identifier, version)
        ).fetchone()
        if not row:
            raise PromptError("版本不存在。", "not_found", 404)
        return json.loads(row[0])

    def version(self, identifier, version=None):
        with self.db() as db:
            return self._version(db, identifier, version)

    def compatible(self, identifier, version):
        if version["signature"] != self.signature(identifier):
            raise PromptError(
                "此版本与当前输入协议不兼容，请基于新默认版本合并修改。", "incompatible", 409
            )

    def detail(self, identifier):
        d = self.definition(identifier)
        with self.db() as db:
            versions = [
                json.loads(row[0])
                for row in db.execute(
                    "SELECT data FROM versions WHERE prompt_id=? ORDER BY rowid DESC", (identifier,)
                )
            ]
        active = self.version(identifier)
        return {
            **d,
            "active_version": active["id"],
            "active_compatible": active["signature"] == self.signature(identifier),
            "active": active,
            "default_version": self.version(identifier, "default")["id"],
            "versions": [
                {**v, "compatible": v["signature"] == self.signature(identifier)} for v in versions
            ],
            "used_by": [
                v["id"]
                for v in self.definitions.values()
                if identifier in v.get("dependencies", [])
            ],
        }

    def catalog(self):
        return [
            {
                key: value
                for key, value in self.detail(identifier).items()
                if key not in ("templates", "versions", "active", "example")
            }
            for identifier in self.definitions
        ]

    def save_version(self, identifier, templates, note="", base_version=None):
        if base_version is not None:
            self.version(identifier, base_version)
        version = self.make_version(identifier, templates, note, base_version)
        with self.db() as db:
            db.execute(
                "INSERT OR IGNORE INTO versions VALUES (?,?,?)",
                (identifier, version["id"], encoded(version)),
            )
        return self.version(identifier, version["id"])

    def activate(self, changes):
        if not isinstance(changes, list) or not changes or len(changes) > 100:
            raise PromptError("请选择要启用的版本。")
        if len({v.get("prompt_id") for v in changes}) != len(changes):
            raise PromptError("一次启用不能重复指定提示词。")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            for change in changes:
                identifier = change["prompt_id"]
                version = self._version(db, identifier, change["version"])
                self.compatible(identifier, version)
                if self._version(db, identifier)["id"] != change.get("expected_active"):
                    raise PromptError("启用版本已改变，请刷新后比较再操作。", "conflict", 409)
                db.execute(
                    "INSERT INTO active VALUES (?,?) ON CONFLICT(prompt_id) DO UPDATE SET version=excluded.version",
                    (identifier, version["id"]),
                )
        return {"activated": changes}

    def snapshot(self):
        with self.db() as db:
            db.execute("BEGIN")
            versions = {
                identifier: self._version(db, identifier) for identifier in self.definitions
            }
            models = {key: json.loads(data) for key, data in db.execute("SELECT * FROM trigger_models")}
        return {
            "versions": versions,
            "fingerprint": digest({k: v["id"] for k, v in versions.items()}),
            "trigger_models": models,
        }

    def preview(self, identifier, variables, *, snapshot=None, variant=None,
                legacy_activation=False):
        bundle = json.loads(encoded(snapshot or self.snapshot()))
        variant = variant or {}
        overrides = {identifier: variant, **variant.get("overrides", {})}
        for key, override in overrides.items():
            if override.get("templates") is not None:
                bundle["versions"][key] = self.make_version(key, override["templates"])
            elif override.get("version"):
                bundle["versions"][key] = self.version(key, override["version"])
        d = self.definition(identifier)
        if not isinstance(variables, dict):
            raise PromptError("变量必须是 JSON 对象。")
        for spec in d["variables"]:
            if spec.get("required", True) and spec["name"] not in variables:
                raise PromptError("缺少变量：" + spec["name"])
        used = {}

        def render(key, field, chain=()):
            if key in chain or len(chain) > 12:
                raise PromptError("共用规则出现循环引用。")
            version = bundle["versions"][key]
            legacy = False
            if legacy_activation and key == "ai-persona.activation":
                definition = self.definition(key)
                legacy_signature = digest({
                    field: "1" if field == "schema_version" else definition.get(field)
                    for field in ("kind", "variables", "schema_version", "dependencies")
                })
                legacy = version["signature"] == legacy_signature
            if not legacy:
                self.compatible(key, version)
            used[key] = version["id"]

            def replace(match):
                name = match[1]
                if name.startswith("@"):
                    return render(name[1:], "text", (*chain, key))
                if name not in variables:
                    raise PromptError("缺少变量：" + name)
                value = variables[name]
                return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)

            return TOKEN.sub(replace, version["templates"][field])

        rendered = {field: render(identifier, field) for field in d["templates"]}
        if len(rendered.get("system", "")) > 10000 or len(rendered.get("user", "")) > 300000:
            raise PromptError("完整提示词超过当前模型接口长度上限。")
        return {
            "prompt_id": identifier,
            "variables": variables,
            "rendered": rendered,
            "versions": used,
            "templates": bundle["versions"][identifier]["templates"],
        }

    def put_record(self, kind, value):
        if kind not in ("samples", "captures", "experiments"):
            raise PromptError("记录类型无效。")
        self.definition(value["prompt_id"])
        value = {"id": kind[:-1] + "-" + uuid.uuid4().hex, "created_at": now(), **value}
        if len(encoded(value)) > 1_200_000:
            raise PromptError("记录过大，请缩小样例。")
        with self.db() as db:
            db.execute(
                "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (value["id"], kind, value["prompt_id"], encoded(value)),
            )
            if kind == "captures":
                db.execute(
                    "DELETE FROM records WHERE kind='captures' AND id NOT IN (SELECT id FROM records WHERE kind='captures' ORDER BY rowid DESC LIMIT 30)"
                )
        return value

    def record(self, kind, identifier):
        with self.db() as db:
            row = db.execute(
                "SELECT data FROM records WHERE kind=? AND id=?", (kind, identifier)
            ).fetchone()
        if not row:
            raise PromptError("记录不存在。", "not_found", 404)
        return json.loads(row[0])

    def records(self, kind, prompt_id=None, limit=100):
        with self.db() as db:
            rows = db.execute(
                "SELECT data FROM records WHERE kind=? AND (? IS NULL OR prompt_id=?) ORDER BY rowid DESC LIMIT ?",
                (kind, prompt_id, prompt_id, limit),
            )
            return [json.loads(row[0]) for row in rows]

    def delete(self, kind, identifier):
        value = self.record(kind, identifier)
        if kind == "experiments" and value.get("status") in ("queued", "running"):
            raise PromptError("请先取消实验。", "busy", 409)
        with self.db() as db:
            db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, identifier))
        return {"deleted": identifier}

    def capture(self, identifier, variables, snapshot, context=None, origin=None):
        return self.put_record(
            "captures",
            {
                "prompt_id": identifier,
                "variables": variables,
                "snapshot": snapshot,
                "context": context or {},
                "origin": origin,
                "name": self.definition(identifier)["name"],
            },
        )


def default_text(identifier, field="system"):
    catalog = json.loads((Path(__file__).parent / "prompts/catalog.json").read_text())
    return next(v["templates"][field] for v in catalog if v["id"] == identifier)
