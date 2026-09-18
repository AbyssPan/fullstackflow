# 后端知识库目录结构说明

适用范围：Java/Kotlin 后端，尤其是 Maven/Spring Boot 项目。前端知识库继续沿用原有生成和查询方式。

## 生成后的目录

下面是包含 chat、document 两个业务域的示例，不代表对目标应用源码的扫描结论。
`kb-init` 生成索引和骨架；业务说明由 `gen-project-docs` 阅读源码后填写。

```text
.docs/llm-knowledge/
|-- .profile.yaml                 # 项目类型、源码根、资源根、Maven 模块
|-- STRUCTURE.md                  # 本目录说明，由 kb-init 复制
|-- backend.config.json           # 可选：显式业务归属、公共路径、基础包
|-- backend-index.json            # 自动代码索引，可重新扫描生成
|-- overview.md                   # 全局入口和业务域地图
|-- meta.yaml                     # 文档索引、业务描述、文档已同步的 Git 版本
|-- common/
|   |-- README.md                 # 公共知识入口
|   |-- conventions.md            # 编码规范
|   |-- architecture.md           # 按需：模块依赖、部署单元、系统边界
|   |-- config.md                 # 按需：配置项含义，不记录实际密钥
|   |-- messaging.md              # 按需：消息消费、重试、幂等约定
|   `-- ai-providers.md           # 按需：模型供应商适配规则
|-- business/
|   |-- chat/
|   |   |-- overview.md           # 首先生成：职责、规则、核心流程、源码入口
|   |   |-- flows.md              # 按需：复杂调用流程、事务和失败处理
|   |   |-- routes.md             # 按需：HTTP、消息、任务等入口
|   |   |-- api.md                # 按需：接口契约和外部依赖
|   |   |-- models.md             # 按需：数据模型、状态与持久化约束
|   |   |-- pitfalls.md           # 按需：实际问题和解决记录
|   |   `-- custom/README.md      # 手工知识，重建时保留
|   `-- document/
|       |-- overview.md           # 小领域可以只保留这一份业务说明
|       `-- custom/README.md
`-- templates/                    # 可用模板，不要求每个领域全部生成
```

首次执行脚本后，实际存在的是 `.profile.yaml`、`STRUCTURE.md`、
`backend-index.json`、`overview.md`、`meta.yaml`、`common/README.md`、
`common/conventions.md`、各域的 `custom/README.md` 和模板。
`backend.config.json` 不自动创建；领域概览和其余业务文档在文档生成阶段创建。

## 各层职责

- `business/` 记录业务语义：功能职责、状态变化、约束、入口到数据的流程。同域的 Controller/Service/Mapper/DTO/XML 聚合说明。
- `common/` 记录系统级架构和跨域技术约定。公共实现文件存入代码索引，不为每个工具类创建文件夹。
- `backend-index.json` 是代码定位依据。保存模块、文件、归属原因、类/接口符号、注解位置、导入及实际使用的同包类型线索、每个文件的 SHA-256、扫描时间和 Git 版本。
- `meta.yaml` 是文档导航和同步状态。新初始化时 `git.hash` 留空，文档生成成功后再填写，避免把骨架误认为已同步的知识。
- `unclassified_files` 是索引里的待归类列表，不生成一个虚假的业务目录，也不会丢弃这些文件。

注解记录是带行号的词法线索，不是完整 Java/Kotlin 语义解析。组合注解、常量拼接路由、反射、动态 SQL、依赖注入的运行时调用需要读取源码核实。导入及同包关系用于保守检查影响范围，不等同于精确调用图。

## 领域识别

1. 显式配置的文件归属优先；一个文件命中两个领域规则时报错，不静默选择。
2. 自动识别优先使用业务包。`chat/controller/MessageController.java` 归属 `chat`。
3. 分层布局没有业务包时，Controller/Endpoint/Resource 类名提供候选入口，同模块中的匹配类名前缀可以聚合；孤立工具类不创建业务域。
4. 公共及技术包进入 `common_files`。低置信度内容保留在 `unclassified_files`，结合源码判断后配置归属。
5. 跨模块同名域默认添加模块前缀，例如 `crm-user` 和 `billing-user`。同一业务跨 `api/core/infra` 时，用一条显式规则合并。
6. Mapper XML 优先通过 namespace 关联代码；其余资源按业务目录关联，不按任意子串匹配。全局 application/bootstrap 配置属于公共知识。

基础包优先使用配置或 `@SpringBootApplication` 所在包；没有这些证据时从共同包路径推断，因此首次 dry-run 仍应核对归属。领域数量没有固定上限。

## 可选配置

在目标项目 `.docs/llm-knowledge/backend.config.json` 中配置：

```json
{
  "auto_discover": true,
  "base_packages": {
    "src/main/java": "com.example.app"
  },
  "domains": [
    {
      "id": "chat",
      "include": [
        "src/main/java/com/example/app/chat/**/*.java",
        "src/main/resources/mapper/chat/**"
      ]
    }
  ],
  "common": ["src/main/java/com/example/app/integration/**"]
}
```

`include` 和 `common` 是相对项目根的路径模式，支持 `*`、`**`。
显式领域规则优先于公共规则。`auto_discover: false` 时，仅显式规则创建业务域，
其余源码进入公共或待归类索引。跨模块合并时，在同一领域的 `include` 中列出各模块路径。
配置通过 JSON 标准解析器读取；不通过修改 `.profile.yaml` 设置领域列表。

## 查询与更新

- 知道类名、路由片段、表名注解或文件路径：先查 `backend-index.json`，读取命中位置及所属业务文档；未索引的信息直接搜索源码。
- 只知道业务问题：从 `overview.md`、`meta.yaml` 找领域，再读取领域概览，按需补充文档和源码。
- `kb-update` 在有后端索引时重新扫描，比较新旧文件哈希与归属，并比较文档同步版本到当前工作区的 Git 变更及未跟踪文件；新增、删除、改名和未提交源码改动都参与分析。重复刷新索引不会抹掉尚未同步的改动；已删除文件仍通过 meta 中的文档来源映射追踪。
- 共享代码变更沿导入及实际使用的同包类型反向扩散；全局资源配置或构建文件变化时，保守列出业务域供检查。
- `gen-docs` 在有后端索引时使用索引的完整文件列表，避免旧 `meta.yaml` 文件列表遗漏新文件。刷新索引使用 `kb-init.cjs --index-only`；该命令不改业务文档。
- 更新成功后按同仓维护规则记录域级回执；只在归属改变时同步 meta.yaml 的领域地图和源码文件，保留手工内容。旧库保留 git.hash 兼容，维护模式不前移全局版本。

索引包含文件状态、内容 hash 与可复用的词法结果，未变化源码不重复读取。`scan_stats` 可核对读取、解析和复用数量。通配导入、Kotlin 顶层/扩展调用等不完整关系在 `dependency_review` 中列明，需按源码复核；不要把同包所有文件当作真实相互依赖。

## 已有知识库迁移

先 dry-run 检查领域，必要时添加配置，再运行初始化和文档生成。
新扫描会替换自动代码索引，但保留已有 `meta.yaml`、总览与手工文档；后端 `--force` 也保留 `common/README.md` 和 `common/conventions.md`。
历史错误目录不会自动删除：先把业务内容和 `custom/` 合并到正确领域，
更新索引和文档链接后再处理旧目录。仅执行初始化不会让旧目录自动消失。
