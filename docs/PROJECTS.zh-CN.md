# 项目与想法

项目入口为 `/projects/`，与想法共用原生 Studio 的侧栏、工作区切换与手机导航。顺序为：知识、课程、材料、偏好、想法、项目。旧 `/research/` 链接继续跳转，旧想法入口转到 `/ideas`。

## 使用与数据

- 项目包含目标、当前进度、探索想法、待办、进展记录和工作入口。支持修订历史、归档恢复、进展置顶、结果复核与上下文预览、复制和下载。
- 项目和想法可手动关联知识、材料，也可在 Markdown 中插入引用；统一表示“与它有关”。项目关联和想法中的关联分别保留。缺失、归档或历史引用不会在编辑时被自动清除。
- “升级为项目”先保存想法，再创建正式项目并关联来源。原想法的正文、判断、附件与历史保留。若项目已保存而来源关联失败，页面明确提示部分完成。
- 目录入口只保存、复制路径；HTTP(S) 仓库链接可直接打开，不执行用户目录中的内容。
- 正式项目、待办与进展保存在 `persona-data/projects/workspace.json`；提交快照在 `persona-data/revisions/projects/`，随整个工作区备份。浏览器只保留项目表单草稿，并按工作区隔离。
- 写入沿用工作区锁与原子替换，以当前文件为提交点。工作区标识和版本号防止切换工作区或多设备并发时覆盖旧数据。
- 想法继续使用 `ai-persona.idea/v1` Markdown 与完整历史。知识、材料及所属项目通过已有资源链接编码，保持旧读取器与备份兼容。

## 历史数据

“导入浏览器项目”的界面与接口已移除。已导入项目、原始来源备份 `persona-data/projects/imports/`、历史及旧想法 ID 映射继续保留。旧浏览器内容不会自动读取、修改或清除；仅旧想法映射用于解析已有关系。正式想法列表仍保留旧浏览器想法的选择导入功能。

引用解析由想法与项目共享，项目的知识目录直接读取当前正式工作区；读取失败时显示错误，不回退到示例数据。

## 验证

```sh
PYTHONPATH=apps/ai-persona/src apps/ai-persona/.venv/bin/python -m pytest \
  apps/ai-persona/tests/test_projects.py \
  apps/ai-persona/tests/test_project_library.py \
  apps/ai-persona/tests/test_project_integration.py \
  apps/ai-persona/tests/test_ideas.py apps/ai-persona/tests/test_idea_links.py \
  apps/ai-persona/tests/test_web_access.py -q
npm run test:project-references
```

浏览器写入验证使用隔离工作区；正式工作区只做读取检查。私有入口的启动方式见 [运行说明](OPERATIONS.zh-CN.md)。
