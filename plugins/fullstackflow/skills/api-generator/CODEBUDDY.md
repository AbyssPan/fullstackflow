# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

这是一个 CodeBuddy Skill 项目，用于从 Swagger/OpenAPI JSON 文档中提取接口定义。支持 JavaScript + JSDoc（默认）和 TypeScript（`-t` 参数）两种输出模式。纯 Node.js CommonJS 项目，无任何第三方依赖。

## 常用命令

```bash
# 按模块提取接口
node ./scripts/index.js -f "./api-docs.json" -m "模块名"
node ./scripts/index.js -f "https://example.com/api-docs.json" -m "模块名"

# 按路径提取单个接口
node ./scripts/index.js -f "./api-docs.json" -p "/api/user/detail"
node ./scripts/index.js -f "https://example.com/api-docs.json" -p "/api/order/create"

# TypeScript 输出模式
node ./scripts/index.js -t -f "./api-docs.json" -m "模块名"
node ./scripts/index.js -t -p "/api/user/detail"

# 智能推断模式（无需显式参数名）
node ./scripts/index.js "https://example.com/api-docs.json" "订单模块"
node ./scripts/index.js "./api-docs.json" "/api/order/create"

# 运行测试脚本（硬编码了测试 URL 和接口，用于开发调试）
node ./test-parser.js

# 查看帮助
node ./scripts/index.js -h
```

## 架构

```
SKILL.md                    -- Skill 清单文件（YAML frontmatter + Markdown），定义激活信号和工作流
scripts/index.js            -- CLI 入口：参数解析、数据源加载（本地文件/远程URL）、调度执行
scripts/swagger-parser.js   -- 核心类 SwaggerToJSDoc：Swagger 解析 + JSDoc 代码生成
test-parser.js              -- 集成测试/调试脚本（硬编码测试数据）
```

### 调用链路

```
用户参数 → index.js（参数解析 + 智能推断）
         → 加载数据源（fetchJson 获取远程 URL，或直接读本地文件）
         → 实例化 SwaggerToJSDoc
         → getApisByTag(tagName) 按模块提取 / getApiByPath(apiPath) 按路径提取
         → parseApi() 解析单个接口（兼容 Swagger v2 和 OpenAPI v3）
         → generateJSDoc() 生成 JS 代码 / generateTypeScript() 生成 TS 代码
```

### 核心类 SwaggerToJSDoc (`scripts/swagger-parser.js`)

- **构造函数**：接受本地文件路径（字符串）或已解析的 JSON 对象
- **`getApisByTag(tagName)`**：按 Tag 遍历 `doc.paths`，返回该模块下所有接口
- **`getApiByPath(apiPath, method)`**：按路径 + HTTP 方法精确匹配
- **`parseApi(apiPath, method, details)`**：统一解析 Swagger v2（body parameters）和 OpenAPI v3（requestBody）两种格式
- **`generateJSDoc(apiInfo)`**：生成 JSDoc 注释 + `export const` 请求函数代码（默认模式）
- **`generateTypeScript(apiInfo)`**：生成 TypeScript interface 定义 + 带类型注解的 `export const` 请求函数（`-t` 模式）
- **`static apiResponseGeneric()`**：生成 `ApiResponse<T>` 泛型定义（TypeScript 模式下首次输出时调用）
- **`resolveDefinition(refName)`**：递归解析 `$ref` 引用，缓存到 `this.defs`
- **`formatDefinitionToJSDoc(refName)`**：将 definition 展开为内联 JSDoc 类型，特殊处理 `ApiResponse` 包装层（直接提取内部 `data` 类型）

### 关键设计决策

1. **operationId 清理**（`swagger-parser.js:222`）：移除 `_1`/`_2` 数字后缀和 `UsingPOST`/`UsingGET` 等方法后缀
2. **Git Bash 路径兼容**（`index.js:34-42`）：`sanitizePath()` 处理 Git Bash 将 `/api/xxx` 转为 `D:/path/to/api/xxx` 的问题
3. **/ai-dev 前缀兜底**（`index.js:131-137`）：路径未命中时自动尝试添加/移除 `/ai-dev` 前缀
4. **生成的函数使用模板变量**：`${ai_url}` 作为 baseURL 前缀，由调用方所在项目提供

## 执行原则（来自 SKILL.md）

- 优先将用户输入的文件或 URL 显式传入 `--file` 参数
- 面向任意项目使用，不假设当前仓库存放的 JSON 文件路径
- 输出以脚本生成结果为准，不擅自改写解析规则、命名清理规则或返回结构
- 脚本调用路径应基于当前 skill 根目录拼接，而非业务项目目录
