---
name: api-generator
description: 当用户提供 Swagger JSON 文件路径或 URL 或者 api doc 文档，并希望按模块或接口路径生成接口定义、请求函数和 JSDoc 注释时使用。适用于任意项目，不依赖固定业务目录。
---

# API Generator

从 Swagger JSON 中提取接口定义，支持生成 JSDoc 注释（JavaScript）或 TypeScript interface 定义。

## 适用场景

- 用户给出本地 JSON 文件路径，希望批量生成某个模块下的接口定义
- 用户给出远程 JSON URL，希望快速提取单个或多个接口定义
- 用户希望根据 Tag 或接口 Path 生成带注释的请求函数代码
- 用户希望生成 TypeScript interface 和带类型注解的请求函数
- 用户希望把接口生成能力复用到任意项目，而不是绑定某个业务仓库结构

## 激活信号

当用户出现以下需求时，应优先使用本 skill：

- “根据 swagger json 生成接口定义”
- “根据 json url 读取接口文档并生成注释”
- “按模块生成接口”
- “按接口路径提取请求函数”
- "从 API 文档生成 JSDoc"
- "生成 TypeScript 接口定义"

## 输入要求

优先收集以下信息：

1. API 文档来源
   - 本地 JSON 文件路径
   - 远程 URL
2. 提取方式
   - 一个或多个 Tag/模块名
   - 一个或多个接口路径
3. 输出目标
   - 直接返回生成结果
   - 或插入/更新到用户指定文件

如果用户没有提供 API 文档来源，则提醒需要传入 JSON 文件路径或 URL。然后退出。

## 执行原则

1. 优先将用户输入的文件或者URL 显式传入 `--file`  index.js
2. 面向任意项目使用，不假设当前仓库库存放的 JSON 文件路径
3. 输出以脚本生成结果为准，不擅自改写其解析规则、命名清理规则或返回结构
4. 如果查找不到用户要的内容，则提示用户然后退出

## 运行脚本

[index.js](./scripts/index.js) 处理用户传入的参数，根据参数调用 Swagger 解析脚本生成接口定义。

## 调用方式

脚本入口位于当前 skill 目录下的 `index.js`，调用时应基于当前 skill 根目录拼接脚本路径，而不是基于业务项目目录拼接。

### 命令格式

```bash
node ./scripts/index.js [选项] [参数]
```

### 参数说明

| 参数 | 说明 |
| --- | --- |
| `-m, --module <模块名>` | 提取指定模块下的所有接口 |
| `-p, --path <接口路径>` | 提取指定路径的单个接口 |
| `-f, --file <文件或URL>` | 指定 API JSON 文件路径或远程 URL |
| `-t, --typescript` | 输出 TypeScript 语法的接口定义（默认输出 JavaScript + JSDoc） |
| `-h, --help` | 显示帮助信息 |

### 推荐调用示例

```bash
node ./scripts/index.js -f "./api-docs.json" -m "用户模块"
node ./scripts/index.js -f "./api-docs.json" -p "/api/user/detail"
node ./scripts/index.js -f "https://example.com/api-docs.json" -m "订单模块"
node ./scripts/index.js -f "https://example.com/api-docs.json" -p "/api/order/create"
node ./scripts/index.js -t -f "https://example.com/api-docs.json" -m "订单模块"
node ./scripts/index.js -t -f "https://example.com/api-docs.json" -p "/api/order/create"
```

### 智能推断模式

脚本保留现有智能推断能力：

- 以 `http://` 或 `https://` 开头，或以 `.json` 结尾的参数，会被识别为文件路径或 URL
- 以 `/` 开头的参数，会被识别为接口路径
- 普通字符串，会被识别为模块名

示例：

```bash
node ./scripts/index.js "https://example.com/api-docs.json" "订单模块"
node ./scripts/index.js "./api-docs.json" "/api/order/create"
node ./scripts/index.js "./api-docs.json" "用户模块" "/api/user/detail"
```

## 工作流

1. 判断用户提供的是本地 JSON 路径还是远程 JSON URL
2. 判断用户希望按 Tag/模块提取，还是按接口路径提取
3. 使用当前 skill 目录下的 `index.js` 执行生成命令
4. 返回脚本原始生成结果
5. 如果用户要求落库，再把生成结果按目标项目现有风格整合到指定文件

## 输出要求

- 默认返回生成后的 JSDoc 注释与请求函数代码
- 使用 `-t` 参数时可输出 TypeScript interface 定义与带类型注解的请求函数
- 当用户要求"生成接口定义并注释"时，优先返回完整代码片段，而不是只返回摘要
- 当用户同时提供多个模块或多个路径时，按脚本原有输出顺序返回
- 当未命中接口或模块时，保留脚本原有提示语义

JavaScript 输出示例（默认）：

```javascript
/**
 * 查询知识
 * @param {object} data
 * @param {string} [data.docIds] - 知识id列表
 * @param {number} [data.zbId] - 直播间id
 * @returns {Promise<{
 *  code: number,
 *  data: {
 *      context: string,
 *      name: string,
 *      type: number,
 *    }[],
 *  msg: string
 * }>}
 */
export const selectRef = data => post(`${ai_url}/api/v1/zbKnowledge/select_ref`, data);
```

TypeScript 输出示例（`-t` 参数）：

```typescript
/** API 通用响应结构 */
interface ApiResponse<T> {
  code: number;
  data: T;
  msg: string;
}

/** 查询知识请求参数 */
interface SelectRefRequest {
  /** 知识id列表 */
  docIds?: string;
  /** 直播间id */
  zbId?: number;
}

/** 查询知识响应数据 */
interface SelectRefResponse {
  context: string;
  name: string;
  type: number;
}

/** 查询知识 */
export const selectRef = (data: SelectRefRequest): Promise<ApiResponse<SelectRefResponse[]>> =>
  post(`${ai_url}/api/v1/zbKnowledge/select_ref`, data);
```

## 兼容性说明

- 支持 JavaScript + JSDoc（默认）和 TypeScript（`-t` 参数）两种输出模式
- 支持本地 JSON 文件与远程 URL
- 兼容 Swagger v2 和 OpenAPI v3 文档格式
- 支持按模块与按路径两种提取方式
- 保留 `operationId` 清理逻辑，会移除 `_1`、`_2` 以及 `UsingPOST`、`UsingGET` 等后缀
- 保留 Git Bash 路径兼容处理逻辑
- 保留默认 JSON 兜底行为，但跨项目使用时应显式传入 `--file`

## 资源说明

- `scripts/index.js`：CLI 入口，负责参数解析、文档读取与结果输出
- `scripts/swagger-parser.js`：Swagger 解析、JSDoc 生成与 TypeScript 生成功能实现
