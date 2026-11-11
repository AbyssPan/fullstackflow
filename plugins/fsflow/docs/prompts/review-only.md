# 只审查

**适用**：只想审一段改动，不要建 Story、不要走 8 Phase。

## 可粘贴命令

```
/fsflow:only code-review "审查当前工作区未提交改动，范围 src/ 下的前端文件"
```

已提交的改动需要指定比较起点：

```
/fsflow:only code-review "审查 feature/refund 相对 origin/main 的全部改动，两个仓都要"
```

## 范围要写清

| 写法 | 审查范围 |
|---|---|
| 「当前工作区未提交改动」 | 暂存 + 未暂存 + 未跟踪 |
| 「相对 origin/main」 | 从 merge-base 到当前工作区 |
| 「只看 src/views/order/」 | 限定目录 |
| 给具体文件路径 | 只审这些文件 |

不写范围时默认当前工作区未提交改动。

## 注意事项

- 审查**不改代码**，发现问题只出报告；要修就再走 `/fsflow:fixbugs` 或 `--write` 的单段执行。
- 说清「前端 / 后端 / 都要」，否则 TS 规则可能套到不该套的运行端。
- 项目有 `REVIEW.md` 会自动读取；没有不强制创建。
- 结论会区分 BLOCKER / WARNING / SUGGESTION，纯风格问题默认不报；不要要求它「多找几个问题」。
