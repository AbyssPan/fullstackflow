# 内置代码审查规则库

本目录规则提炼自 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)
（Apache-2.0 许可）的内置规则集，**零工具依赖、零 LLM Key 配置**——审查推理由
代码审查师 agent（模型自身）按规则逐项执行，替代调用 `ocr` CLI 的外部依赖模式。

## 规则文件与适用范围

| 规则文件 | 适用变更文件 |
|---------|-------------|
| `default.md` | 通用兜底：正确性 / 安全 / 性能 / 可维护性 / 测试覆盖五维度（任何未被专项规则覆盖的文件） |
| `java.md` | `.java`：死代码 / 逻辑错误（NPE、switch 贯穿、边界） / 严重性能（循环内查库、N+1） / 线程安全（含「不报告」护栏） |
| `ts_js_tsx_jsx.md` | `.ts/.js/.tsx/.jsx/.mjs/.cjs`：代码质量（var/==/any 禁令） / React 最佳实践 / 异步规范 / 安全（XSS、eval、原型链） |
| `mapper_dao_xml.md` | `*mapper*.xml` / `*dao*.xml`：SQL 逻辑错误 / 全表扫描 / 大查询无分页 / `${}` 注入风险（含「不报告」护栏） |

## 使用方式（代码审查师 agent）

1. 按 `system_rules.json` 同款映射为每个变更文件选定规则文件（前端堆走
   `ts_js_tsx_jsx.md`，后端堆按文件类型走 `java.md` / `mapper_dao_xml.md` / `default.md`）
2. **逐文件**过规则条目，每个文件独立完成一轮（不允许「审了主文件就算过了它的接口/配置对应物」）
3. 上下文不清时用 Read / Grep 查证调用链再定级，**禁止凭假设报告**
4. 严重级映射：规则中可致生产故障 / 数据损坏 / 安全风险的 → BLOCKER；
   潜在问题与性能隐患 → WARNING；风格与优化建议 → SUGGESTION

## 归属声明

规则内容版权归 alibaba/open-code-review 原作者所有，按 Apache-2.0 许可复用；
本插件仅做目录组织与中文使用说明的补充。
