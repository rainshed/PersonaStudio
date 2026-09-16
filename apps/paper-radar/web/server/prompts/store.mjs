import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { autonomousPrompts } from './autonomous.mjs';
import { agentScreenPrompt } from './agent-screen.mjs';
import { PROMPT_RENDER_POLICY, skipPromptDependency, fingerprintInput, compositionFor } from './render-policy.mjs';
import { languagePrompts, stripSharedReferences, sharedId, ruleId } from './language-prompts.mjs';
import { withTaskInstructions } from './task-instructions.mjs';
import { TASK_CONTEXT_POLICY } from './context-policy.mjs';
const sorted = (v) =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted(v[k])]),
        )
      : v;
export const encode = (v) => JSON.stringify(sorted(v));
export const digest = (v) => createHash("sha256").update(encode(v)).digest("hex");
const now = () => new Date().toISOString();
const tokens = /\{\{\s*(@?[a-zA-Z0-9_.-]+)\s*\}\}/g;
export class PromptError extends Error {
  constructor(message, code = "invalid_request", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = false;
  }
}
export const defaultCatalog = () => {
  const current = [structuredClone(agentScreenPrompt), ...structuredClone(autonomousPrompts)];
  const catalog = [
    ...JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")),
    {...structuredClone(agentScreenPrompt), id:'paper-radar.screen-agent', schema_version:'1', name:'每日初筛 Agent（旧协议）'},
    ...current,
  ];
  return [...catalog.map((p) => ({ ...p, settings_visible: false })), ...languagePrompts(catalog)];
};
export function defaultText(id, field = "text") {
  return defaultCatalog().find((p) => p.id === id).templates[field];
}
export class PromptStore {
  constructor(directory, catalog = defaultCatalog()) {
    this.definitions = Object.fromEntries(catalog.map((p) => [p.id, p]));
    if (Object.keys(this.definitions).length !== catalog.length)
      throw new PromptError("提示词 ID 重复。");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "prompts.sqlite3");
    this.db = new DatabaseSync(path, { timeout: 5000 });
    chmodSync(path, 0o600);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS versions (prompt_id TEXT,id TEXT,data TEXT NOT NULL,PRIMARY KEY(prompt_id,id)); CREATE TABLE IF NOT EXISTS active (prompt_id TEXT PRIMARY KEY,version TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY,kind TEXT NOT NULL,prompt_id TEXT NOT NULL,data TEXT NOT NULL);`,
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,seq));
    `);
    for (const d of catalog) {
      const v = this.makeVersion(d.id, d.templates, "项目默认版本");
      this.db.prepare("INSERT OR IGNORE INTO versions VALUES (?,?,?)").run(d.id, v.id, encode(v));
    }
    this.migrateLanguagePrompts(catalog);
    this.migrateTaskInstructions(catalog);
  }
  migrateLanguagePrompts(catalog) {
    const targets = catalog.filter((entry) => entry.migration_from);
    if (!targets.length) return;
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const target of targets) {
        const marker = `language-prompts/v1:${target.id}`;
        if (this.db.prepare('SELECT id FROM migrations WHERE id=?').get(marker)) continue;
        const source = target.migration_from;
        const active = this.version(source);
        const versions = this.detail(source).versions;
        let migratedActive;
        for (const version of versions.reverse()) {
          if (!version.compatible) continue;
          const templates = target.settings_role === 'task' ? stripSharedReferences(version.templates)
            : target.settings_role === 'screening_rule' ? { text: version.templates[target.screening_rule] }
            : version.templates;
          const migrated = this.makeVersion(target.id, templates, version.note || '从原提示词迁移');
          migrated.created_at = version.created_at;
          migrated.migrated_from = { prompt_id: source, version: version.id };
          this.db.prepare('INSERT OR IGNORE INTO versions VALUES (?,?,?)').run(target.id, migrated.id, encode(migrated));
          if (version.id === active.id) migratedActive = migrated.id;
        }
        if (migratedActive && migratedActive !== this.version(target.id, 'default').id) this.db.prepare('INSERT OR IGNORE INTO active VALUES (?,?)').run(target.id, migratedActive);
        this.db.prepare('INSERT INTO migrations VALUES (?)').run(marker);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  migrateTaskInstructions(catalog) {
    const targets = catalog.filter((entry) => entry.settings_role === 'task');
    if (!targets.length) return;
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const target of targets) {
        const marker = `${TASK_CONTEXT_POLICY}:${target.id}`;
        if (this.db.prepare('SELECT id FROM migrations WHERE id=?').get(marker)) continue;
        const active = this.version(target.id);
        const templates = withTaskInstructions(active.templates, target.task, target.language);
        if (encode(templates) !== encode(active.templates)) {
          const version = this.saveVersion(target.id, templates, '将原有任务目标迁移到可编辑提示词，保留自定义内容。', active.id);
          this.db.prepare('INSERT INTO active VALUES (?,?) ON CONFLICT(prompt_id) DO UPDATE SET version=excluded.version').run(target.id, version.id);
        }
        this.db.prepare('INSERT INTO migrations VALUES (?)').run(marker);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  definition(id) {
    if (!Object.hasOwn(this.definitions, id))
      throw new PromptError("提示词不存在。", "not_found", 404);
    return this.definitions[id];
  }
  signature(id) {
    const d = this.definition(id);
    return digest(
      Object.fromEntries(
        ["kind", "variables", "schema_version", "dependencies"].map((k) => [k, d[k] ?? null]),
      ),
    );
  }
  makeVersion(id, templates, note = "", base = null) {
    const d = this.definition(id);
    if (
      !templates ||
      Array.isArray(templates) ||
      encode(Object.keys(templates).sort()) !== encode(Object.keys(d.templates).sort())
    )
      throw new PromptError("模板字段与当前功能不兼容。");
    if (!Object.values(templates).every((v) => typeof v === "string" && v.length <= 50000))
      throw new PromptError("模板必须是文本，每段不超过 50000 字符。");
    if (typeof note !== "string" || note.length > 500)
      throw new PromptError("修改说明不超过 500 字符。");
    const refs = new Set(
      [...Object.values(templates).join("\n").matchAll(tokens)].map((m) => m[1]),
    );
    const allowed = new Set([
      ...d.variables.map((v) => v.name),
      ...(d.dependencies ?? []).map((v) => "@" + v),
    ]);
    if ([...refs].some((v) => !allowed.has(v)))
      throw new PromptError("模板使用了未声明的变量或共用规则。");
    const required = [
      ...d.variables.filter((v) => v.required !== false).map((v) => v.name),
      ...(d.dependencies ?? []).map((v) => "@" + v),
    ];
    if (required.some((v) => !refs.has(v)))
      throw new PromptError(
        "模板缺少必要变量或共用规则：" + required.filter((v) => !refs.has(v)).join(", "),
      );
    const value = { templates, signature: this.signature(id) };
    return {
      ...value,
      id: digest(value),
      prompt_id: id,
      note,
      base_version: base,
      created_at: now(),
    };
  }
  version(id, version = "active") {
    const d = this.definition(id);
    if (version == null || version === "active")
      version =
        this.db.prepare("SELECT version FROM active WHERE prompt_id=?").get(id)?.version ??
        "default";
    if (version === "default") version = this.makeVersion(id, d.templates).id;
    const row = this.db
      .prepare("SELECT data FROM versions WHERE prompt_id=? AND id=?")
      .get(id, version);
    if (!row) throw new PromptError("版本不存在。", "not_found", 404);
    return JSON.parse(row.data);
  }
  compatible(id, version) {
    if (version.signature !== this.signature(id))
      throw new PromptError(
        "此版本与当前输入协议不兼容，请基于新默认版本合并修改。",
        "incompatible",
        409,
      );
  }
  detail(id) {
    const d = this.definition(id),
      active = this.version(id);
    return {
      ...d,
      active_version: active.id,
      active,
      default_version: this.version(id, "default").id,
      versions: this.db
        .prepare("SELECT data FROM versions WHERE prompt_id=? ORDER BY rowid DESC")
        .all(id)
        .map((r) => {
          const v = JSON.parse(r.data);
          return { ...v, compatible: v.signature === this.signature(id) };
        }),
      used_by: Object.values(this.definitions)
        .filter((v) => v.dependencies?.includes(id) || (v.language === d.language && v.settings_role === 'task' && (d.settings_role === 'shared' || d.settings_role === 'screening_rule' && v.task === 'screen')))
        .map((v) => v.id),
    };
  }
  catalog() {
    return Object.keys(this.definitions).map((id) =>
      Object.fromEntries(
        Object.entries(this.detail(id)).filter(
          ([key]) => !["templates", "versions", "active", "example"].includes(key),
        ),
      ),
    );
  }
  saveVersion(id, templates, note = "", baseVersion = null) {
    if (baseVersion) this.version(id, baseVersion);
    const v = this.makeVersion(id, templates, note, baseVersion);
    this.db.prepare("INSERT OR IGNORE INTO versions VALUES (?,?,?)").run(id, v.id, encode(v));
    return this.version(id, v.id);
  }
  activate(changes) {
    if (
      !Array.isArray(changes) ||
      !changes.length ||
      changes.length > 100 ||
      new Set(changes.map((v) => v.prompt_id)).size !== changes.length
    )
      throw new PromptError("请选择不重复的提示词版本。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const c of changes) {
        const v = this.version(c.prompt_id, c.version);
        this.compatible(c.prompt_id, v);
        if (this.version(c.prompt_id).id !== c.expected_active)
          throw new PromptError("启用版本已改变，请刷新后比较再操作。", "conflict", 409);
        this.db
          .prepare(
            "INSERT INTO active VALUES (?,?) ON CONFLICT(prompt_id) DO UPDATE SET version=excluded.version",
          )
          .run(c.prompt_id, v.id);
      }
      this.db.exec("COMMIT");
      return { activated: changes };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  snapshot() {
    this.db.exec("BEGIN");
    try {
      const versions = Object.fromEntries(
        Object.keys(this.definitions).map((id) => [id, this.version(id)]),
      );
      return {
        rendering_policy: PROMPT_RENDER_POLICY,
        context_policy: TASK_CONTEXT_POLICY,
        versions,
        fingerprint: digest(
          fingerprintInput(
            { rendering_policy: PROMPT_RENDER_POLICY, context_policy: TASK_CONTEXT_POLICY },
            Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, v.id])),
          ),
        ),
      };
    } finally {
      this.db.exec("COMMIT");
    }
  }
  preview(id, variables, { snapshot, variant = {} } = {}) {
    const bundle = structuredClone(snapshot ?? this.snapshot());
    const plan = bundle.rendering_policy === PROMPT_RENDER_POLICY ? compositionFor(id, variables) : null;
    for (const [key, override] of Object.entries({ [id]: variant, ...variant.overrides })) {
      let target = key;
      let templates = override.templates;
      // Workbench variants using a legacy entry point still target its current
      // language-specific equivalent. Frozen legacy snapshots use the old path.
      if (plan && !this.definition(key).language) {
        if (key === id) target = plan.task;
        else if (key === 'paper-radar.terminology') target = sharedId(plan.language);
        else if (key === 'paper-radar.strictness' && plan.rule) target = ruleId(plan.language, plan.screening_rule);
        if (target !== key && (templates || override.version)) {
          templates ??= this.version(key, override.version).templates;
          templates = key === 'paper-radar.strictness' ? { text: templates[plan.screening_rule] } : stripSharedReferences(templates);
        }
      }
      if (templates) bundle.versions[target] = this.makeVersion(target, templates);
      else if (override.version) bundle.versions[target] = this.version(target, override.version);
    }
    const root = plan?.task ?? id;
    const d = this.definition(root);
    if (!variables || typeof variables !== "object" || Array.isArray(variables))
      throw new PromptError("变量必须是 JSON 对象。");
    for (const v of d.variables)
      if (v.required !== false && !(v.name in variables))
        throw new PromptError("缺少变量：" + v.name);
    const used = {};
    const render = (key, field, chain = []) => {
      if (chain.length && skipPromptDependency(bundle, key, variables)) return '';
      if (chain.includes(key) || chain.length > 12) throw new PromptError("共用规则出现循环引用。");
      const v = bundle.versions[key];
      if (!v) throw new PromptError('任务缺少提示词快照，请重新发起。', 'incompatible', 409);
      this.compatible(key, v);
      used[key] = v.id;
      if (typeof v.templates[field] !== "string") throw new PromptError("共用规则选项无效。");
      return v.templates[field].replace(tokens, (_, name) => {
        if (name.startsWith("@"))
          return render(
            name.slice(1),
            this.definition(name.slice(1)).kind === "choice"
              ? (variables.recommendation_strictness ?? "balanced")
              : "text",
            [...chain, key],
          );
        if (!(name in variables)) throw new PromptError("缺少变量：" + name);
        return typeof variables[name] === "string"
          ? variables[name]
          : JSON.stringify(variables[name]);
      });
    };
    const rendered = Object.fromEntries(
      Object.keys(d.templates).map((field) => [field, render(root, field)]),
    );
    const blocks = [];
    if (plan) {
      const block = (key, kind, text) => ({ kind, source: { prompt_id: key, version: bundle.versions[key].id, language: plan.language, ...(kind === 'screening_rule' ? { rule: plan.screening_rule } : {}) }, text });
      const shared = bundle.versions[plan.shared];
      if (!shared) throw new PromptError('任务缺少共用规则快照，请重新发起。', 'incompatible', 409);
      if (shared.templates.text.trim()) blocks.push(block(plan.shared, 'shared_rules', render(plan.shared, 'text')));
      blocks.push(block(root, plan.rule ? 'screening_common' : 'task_prompt', rendered.system));
      if (plan.rule) blocks.push(block(plan.rule, 'screening_rule', render(plan.rule, 'text')));
      rendered.system = JSON.stringify({ instructions: blocks });
    }
    if ((rendered.system?.length ?? 0) > 10000 || (rendered.user?.length ?? 0) > 300000)
      throw new PromptError("论文与个人材料组成的完整提示词超过当前接口长度上限；原样重试无法解决，请缩小材料范围。已完成的部分仍可查看。", "context_length");
    return {
      prompt_id: id,
      rendering_policy: bundle.rendering_policy ?? null,
      variables,
      rendered,
      blocks,
      versions: used,
      version_snapshots: Object.fromEntries(Object.keys(used).map(key=>[key,bundle.versions[key]])),
      templates: bundle.versions[root].templates,
    };
  }
  text(id, variables, snapshot) {
    return this.preview(id, variables, { snapshot }).rendered.text;
  }
  putRecord(kind, raw) {
    if (!["samples", "captures", "experiments"].includes(kind))
      throw new PromptError("记录类型无效。");
    this.definition(raw.prompt_id);
    const value = { id: kind.slice(0, -1) + "-" + randomUUID(), created_at: now(), ...raw };
    if (encode(value).length > 1200000) throw new PromptError("记录过大，请缩小样例。");
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(value.id, kind, value.prompt_id, encode(value));
    if (kind === "captures")
      this.db.exec(
        "DELETE FROM records WHERE kind='captures' AND id NOT IN (SELECT id FROM records WHERE kind='captures' ORDER BY rowid DESC LIMIT 30)",
      );
    return value;
  }
  record(kind, id) {
    const row = this.db.prepare("SELECT data FROM records WHERE kind=? AND id=?").get(kind, id);
    if (!row) throw new PromptError("记录不存在。", "not_found", 404);
    return JSON.parse(row.data);
  }
  records(kind, promptId = null, limit = 100) {
    return this.db
      .prepare(
        "SELECT data FROM records WHERE kind=? AND (? IS NULL OR prompt_id=?) ORDER BY rowid DESC LIMIT ?",
      )
      .all(kind, promptId, promptId, limit)
      .map((v) => JSON.parse(v.data));
  }
  delete(kind, id) {
    const v = this.record(kind, id);
    if (kind === "experiments" && ["running", "queued"].includes(v.status))
      throw new PromptError("请先取消实验。", "busy", 409);
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
    return { deleted: id };
  }
  capture(id, variables, snapshot, context = {}, origin = null) {
    return this.putRecord("captures", {
      prompt_id: id,
      name: this.definition(id).name,
      variables,
      snapshot,
      context,
      origin,
    });
  }
  startContextRun(raw) {
    const value = { ...raw, id: 'context-' + randomUUID(), created_at: now(), status: 'prepared' };
    this.db.prepare('INSERT INTO context_runs VALUES (?,?,?)').run(value.id, value.created_at, encode(value));
    this.db.exec(`DELETE FROM context_runs WHERE id NOT IN (SELECT id FROM context_runs ORDER BY rowid DESC LIMIT 30);
      DELETE FROM context_events WHERE run_id NOT IN (SELECT id FROM context_runs);`);
    return value;
  }
  contextRun(id, { after = 0, limit = 100 } = {}) {
    const row = this.db.prepare('SELECT data FROM context_runs WHERE id=?').get(id);
    if (!row) throw new PromptError('运行输入记录不存在或已过期。', 'not_found', 404);
    const run = JSON.parse(row.data);
    const events = this.db.prepare('SELECT seq,data FROM context_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit).map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
    const last = this.db.prepare('SELECT MAX(seq) AS total FROM context_events WHERE run_id=?').get(id).total ?? 0;
    return { ...run, events, next_after: (events.at(-1)?.seq ?? after) < last ? events.at(-1)?.seq ?? after : null, event_count: last };
  }
  contextRuns() {
    return this.db.prepare('SELECT data FROM context_runs ORDER BY rowid DESC').all().map((r) => {
      const v = JSON.parse(r.data);
      return { id: v.id, created_at: v.created_at, status: v.status, task: v.context.task, language: v.context.language, origin: v.origin, capture_id: v.capture_id, experiment: v.experiment, backend: v.context.runtime.backend, title: v.context.sections.find(s => s.id === 'paper')?.content?.title ?? null, recording: 'application_boundary' };
    });
  }
  appendContextEvent(id, raw) {
    const row = this.db.prepare('SELECT data FROM context_runs WHERE id=?').get(id);
    if (!row) return; // Retention may expire a very long-running task's record.
    const seq = (this.db.prepare('SELECT MAX(seq) AS seq FROM context_events WHERE run_id=?').get(id).seq ?? 0) + 1;
    const bytes = this.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS bytes FROM context_events WHERE run_id=?').get(id).bytes;
    let value = { ...raw, at: now() }, encoded = encode(value);
    if (encoded.length > 26000000 || bytes + encoded.length > 50000000) {
      const run = JSON.parse(row.data);
      if (run.recording_limited) return;
      run.recording_limited = true;
      this.db.prepare('UPDATE context_runs SET data=? WHERE id=?').run(encode(run), id);
      value = { kind: 'recording_limit', at: now(), source: 'paper-radar:context-recorder', content: '记录达到存储上限；后续内容未保存，不能视为完整记录。' };
      encoded = encode(value);
    }
    this.db.prepare('INSERT INTO context_events VALUES (?,?,?)').run(id, seq, encoded);
  }
  finishContextRun(id, status, error = null) {
    const row = this.db.prepare('SELECT data FROM context_runs WHERE id=?').get(id);
    if (!row) return;
    this.db.prepare('UPDATE context_runs SET data=? WHERE id=?').run(encode({ ...JSON.parse(row.data), status, error, finished_at: now() }), id);
  }
}
