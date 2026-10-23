# CI/CD 已停用

本 fork 已在仓库设置中关闭 GitHub Actions，测试、构建、发布、GitHub Pages 部署和 Issue/PR 机器人工作流均已停用。

原有 12 份工作流以 `*.yml.disabled` 保存，文件内容保持原样。GitHub Actions 识别 `.yml` 和 `.yaml` 工作流文件，详见[官方工作流说明](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#about-yaml-syntax-for-workflows)。

恢复时移除这些文件名末尾的 `.disabled`，再到仓库 **Settings → Actions → General** 启用 GitHub Actions。

本地开发与验证继续遵循 [AGENTS.md](../../AGENTS.md)。
