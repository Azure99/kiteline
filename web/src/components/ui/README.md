# 本地 UI 组件

本目录的组件改编自 MIT 许可的 [shadcn/ui Base UI registry](https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/bases/base/ui)，取自 2026-09-17，只保留工作台用到的变体和封装。

- `button.tsx`、`dialog.tsx`、`menu.tsx`、`tooltip.tsx` 基于 `@base-ui/react`。
- `input.tsx`、`textarea.tsx` 是加了样式的原生 `<input>` 和 `<textarea>`。

这些文件是工作台源码，不是自动升级的依赖包。仓库没有 `components.json`，不使用 shadcn CLI 生成或覆盖它们。升级 `@base-ui/react` 或采用上游改动时，手工对比上游差异后合入，并重新检查键盘操作、焦点、手机视口和第三方组件的样式。

样式约定见[前端约定](../../../../docs/design/architecture.md#前端约定)，交互和视觉规则见[界面交互](../../../../docs/design/interaction.md)。
