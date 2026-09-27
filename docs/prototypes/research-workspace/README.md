# 项目与想法 · 正式工作区

项目已纳入原生 Studio，默认入口为 `/projects/`，原 `/research/` 入口跳转到新页面并保留浏览器 hash。导航顺序为：知识、课程、材料、偏好、想法、项目。知识、课程、材料、偏好与原想法的编辑工作流继续保留。

正式页面使用 `templates/projects.html`，继承原生 Studio 的 `base.html`，共用侧栏、工作区切换与手机导航。项目组件资源位于 `apps/ai-persona/src/ai_persona/static/projects/`，样式限定在项目内容区域，随 Python 包发布；不加载演示数据。此目录保留历史原型及独立只读知识库演示，其独立页面框架不再用于正式项目页面。普通 Studio 即包含项目模块，不依赖此目录的启动脚本。

## 存储

- `/api/projects` 读取当前 Persona 的项目、待办、进展、版本历史与活动记录。写入需同源 JSON 请求、工作区标识与当前版本号。
- 正式项目保存在 `persona-data/projects/workspace.json`，提交快照保存在 `persona-data/revisions/projects/`。使用已有工作区写锁与原子替换，历史快照先写入，当前文件为提交点。项目数据包含在整个工作区备份中。
- 浏览器只保留未提交的表单草稿。项目、待办、进展、知识关联在手机与电脑访问同一个工作区时共用正式数据。并发保存发生冲突时拒绝覆盖，保留输入并提供读取最新版本的入口。
- 想法继续使用严格兼容的 `ai-persona.idea/v1` Markdown 和完整历史。知识/材料关联及所属项目使用已有 `IdeaResource` 链接编码，旧 Studio、MCP 和备份读取器仍然可读。
- “升级为项目”先保存想法，再创建正式项目并关联来源。原想法正文、判断、附件与历史保留。若项目已保存而来源关联失败，会明确提示，不把部分完成显示为全部成功。
- 项目目录只保存路径并支持复制；HTTP(S) 代码仓库链接可直接打开。不会访问或执行用户目录。

## 浏览器旧记录迁移

正式项目列表不会生成或自动导入虚构示例，也不再提供“导入浏览器项目”入口。已有迁移接口保留兼容性：显式调用时只迁移选中的项目、待办、进展和修订历史。关联旧想法按稳定 ID 导入正式想法，任务与进展中的引用同步映射；重复导入不会覆盖正式记录。

原始浏览器数据与旧草稿不删除，完整导入来源另存于 `persona-data/projects/imports/`。旧想法历史保留在来源备份中，原判断和结束说明附在正式想法正文里，正式想法版本历史从导入开始。独立旧想法仍可在想法列表选择导入。

## 现有私有预览服务

```sh
PYTHONPATH=apps/ai-persona/src apps/ai-persona/.venv/bin/python \
  docs/prototypes/research-workspace/library_server.py \
  --with-studio --workspace /absolute/path/to/my-persona \
  --port 4179 --public-origin https://your-machine.example.ts.net:10000
```

省略 `--workspace` 使用已配置工作区。现有私有反向代理和 loopback 绑定保持不变，保留 Host、Origin 与来源检查，不开放 CORS。

不传 `--with-studio` 时仍可运行历史只读知识库演示；纯静态演示仍使用此目录的 `runtime-config.js` 和虚构种子，只在浏览器保存，不向正式工作区写入。

## 验证

```sh
PYTHONPATH=apps/ai-persona/src apps/ai-persona/.venv/bin/python -m pytest \
  apps/ai-persona/tests/test_projects.py \
  apps/ai-persona/tests/test_ideas.py apps/ai-persona/tests/test_idea_links.py \
  apps/ai-persona/tests/test_web_access.py \
  docs/prototypes/research-workspace/test_library_server.py \
  docs/prototypes/research-workspace/test_studio_integration.py -q
node --test docs/prototypes/research-workspace/references.test.cjs \
  docs/prototypes/research-workspace/library-client.test.cjs \
  docs/prototypes/research-workspace/idea-reference-rules.test.cjs
```

覆盖持久化与重启读取、并发竞争、提交失败保留原记录、选择性迁移及历史保留、来源限制、跨工作区拒绝保存、原模块与导航、想法关联和共享引用规则。浏览器写入验证仅使用隔离工作区；正式数据只做读取检查。
