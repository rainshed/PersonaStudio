# 原型归档

想法 v1.0/v1.1、研究空间原型已由正式 `/ideas` 和 `/projects/` 页面替代。历史实现与设计说明保存在 Git 提交 `fcc2366` 中：

- `docs/prototypes/ideas/README.md`：想法状态、判断依据、结束说明、草稿与资源交互设计。
- `docs/prototypes/research-workspace/README.md`：项目结构、知识引用与正式工作区接入过程。

需要回顾时使用 `git show fcc2366:<path>`；不再维护或随安装包发布这些原型。正式应用不依赖原型启动脚本。旧浏览器数据、已导入记录及历史未清除。

当前行为以 [想法](../IDEAS.zh-CN.md)、[项目](../PROJECTS.zh-CN.md) 和 [运行说明](../OPERATIONS.zh-CN.md) 为准。原型中有效的知识库、来源检查和引用解析测试已迁入 `apps/ai-persona/tests/test_project_*.py` 与 `apps/ai-persona/tests/browser/project-*.test.cjs`。
