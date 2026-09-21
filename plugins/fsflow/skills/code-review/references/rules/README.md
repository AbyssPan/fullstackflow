# 内置审查规则索引

按范围快照的 rules 选择语言规则，再叠加项目规范与场景复核；未覆盖的维度使用 default.md。

| 文件 | 适用范围 |
|---|---|
| [default.md](default.md) | 正确性、安全、性能、可维护性、测试覆盖 |
| [java.md](java.md) | Java 逻辑、空值、性能、线程安全及误报边界 |
| [mapper_dao_xml.md](mapper_dao_xml.md) | Mapper/DAO XML 的动态 SQL、绑定、性能与注入 |
| [ts_js_tsx_jsx.md](ts_js_tsx_jsx.md) | JS/TS 通用项；React 条款仅适用于 React |
| [前端复核](../frontend.md) | 浏览器组件、交互、集成入口和契约消费 |
| [配置与数据](../config-and-data.md) | 构建、环境、依赖、配置和数据迁移 |

每个文件独立审查，相关文件可共同查证上下文。规则中的风险描述不是缺陷已成立的证据：先确认触发条件、现有防护和实际影响，再按 code-review 的严重级别输出。
现有项目明确约定优先；默认风格不能覆盖合理例外，无法证实的猜测不进入问题清单。
