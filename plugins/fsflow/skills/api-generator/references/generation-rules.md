# 接口定义生成规则

> 来源：frontend-workflow v1.4.0 / `references/api-definition-generation.md`（第三、四、五、七、十章），已裁剪适配 fsflow：移除阶段编号与 `fw_dev_spec` 路径，改为「画像 → 生成 → 确认」三段闭环。

## 核心原则

生成的接口定义必须与**项目已有风格**一致，而不是套用通用模板。脚本 `scripts/index.js` 只负责从 Swagger 机械提取，落到具体文件前必须先画像。

## 一、项目模式探测

| 探测项 | 关注点 | 用途 |
|---|---|---|
| 请求封装层 | 实例位置与导出方法（`get` / `post` / `del` / `request`） | 生成函数必须复用，禁止裸调 axios / fetch |
| 模块组织 | 按业务域分目录、按模块聚单文件、还是单文件汇总 | 决定新接口落哪个文件 |
| 命名约定 | `getUserList` / `fetchUserList` / `userList`；文件名风格 | 函数名与文件名对齐 |
| 注释风格 | JSDoc 字段、是否用 `@typedef`、是否带示例 | 注释格式复用 |
| 类型表达 | TS `interface` 还是 JS JSDoc `@typedef` | 决定类型语法 |
| 响应解包 | 封装层是否已解包，返回到哪一层 | 影响出参类型标注 |
| 鉴权 | 拦截器自动注入还是手动传 header | 避免生成重复鉴权代码 |

探测步骤：

1. 定位请求封装层：优先读项目约定的已知路径，未知时搜索 `**/{http,request,http-client,api-client}.{js,ts}` 并看导出。
2. 枚举既有接口模块：搜索 `**/modules/**/*.{js,ts}` 或 `**/api/**/*.{js,ts}`。
3. 采样 1–2 个与本次同业务域的既有文件，提取函数签名、命名、JSDoc、import 写法、类型位置。
4. 整理为模式画像。

项目首次接入、无任何接口文件时，跳过采样，按封装层导出方法 + 默认规则生成，并在画像中标注「首次接入，无既有样本」。

## 二、模式画像输出

生成前输出画像，供用户确认：

```
📋 项目接口定义模式画像

- 请求封装层：src/utils/http/http.js，导出 get / post / del
- 模块组织：src/utils/http/modules/<Business>/<business>.js
- 命名约定：getUserList（动词+资源+List/Detail）；文件名小驼峰
- 注释风格：JSDoc，@param {Type} name - 说明；@returns {Type} 说明
- 类型方式：JavaScript，@typedef 置文件顶部
- 响应解包：封装层已解包至业务数据
- 鉴权：拦截器自动注入，接口函数无需处理

⚠️ 待确认：
- 模块归类：Swagger tag「用户管理」→ modules/User/user.js？
- 解包层级：样本返回 { list, total }，Swagger 出参为 { code, data: { list, total } }，确认解到哪层。
```

画像中每条「⚠️ 待确认」都必须由用户答复后才能生成，不自行假设。

## 三、生成规则

### 3.1 模块归类

- 有 `tags`：按 tag 归类；中文 tag 映射为英文目录名，映射关系写入画像待确认。
- 无 `tags`：按 path 第一段推断，标注「推断」并请用户确认。
- 多 tag：归入主 tag，其余在注释中 `@see` 标注。

### 3.2 函数命名

按探测到的约定；无样本时用默认：

| HTTP 方法 | 模板 | 示例 |
|---|---|---|
| GET 列表 | `get{Resource}List` | `getUserList` |
| GET 详情 | `get{Resource}Detail` | `getUserDetail` |
| GET 其他 | `get{Resource}{Action}` | `getUserPermissions` |
| POST 创建 | `create{Resource}` | `createUser` |
| POST 其他 | `{action}{Resource}` | `submitOrder` |
| PUT / PATCH | `update{Resource}` | `updateUser` |
| DELETE | `delete{Resource}` | `deleteUser` |

项目既有命名与默认规则冲突时以项目为准，并在画像记录偏离原因。

### 3.3 请求函数

必须复用封装层：

```javascript
import { get, post } from '@/utils/http/http'

/**
 * 获取用户列表
 * @param {Object} params - 查询参数
 * @param {number} params.page - 页码
 * @param {number} params.size - 每页条数
 * @param {string} [params.keyword] - 搜索关键词
 * @returns {Promise<UserListResp>} 用户列表数据
 */
export function getUserList(params) {
  return get('/api/user/list', params)
}
```

### 3.4 注释

- 每个函数必须有 `@param`（可选参数用 `[name]`）与 `@returns`。
- 复杂类型用 `@typedef` 置于文件顶部，不内联重复定义。
- 路径只在函数体内出现一次，注释不重复贴 URL。

### 3.5 类型

- TS：从 `components/schemas` / `definitions` 生成 `interface`，命名 PascalCase，保留项目既有后缀习惯（如统一 `VO`）。
- JS：用 `@typedef` + `@property`，枚举值写成字面量联合（`{0|1}`）并在注释解释含义。
- `$ref` 必须解析为已定义类型名，不保留原文；循环引用（树形 `children`）用自引用 typedef。

### 3.6 无样本时的默认位置

| 技术栈 | 封装复用 | 类型 | 位置 |
|---|---|---|---|
| Vue2 + JS | `import { get, post, del } from '@/utils/http/http'` | JSDoc | `src/utils/http/modules/<Business>/<business>.js` |
| Vue3 + TS | `import { request } from '@/utils/request'` | interface | `src/api/<module>.ts` |
| React + TS | 同上 | interface | `src/api/<module>.ts` |
| 小程序 | 项目 `wxRequest` / `http` | JSDoc / TS | `src/api/<module>.js` |

实际以探测结果为准，上表仅作无样本默认。

## 四、增量与冲突

| 场景 | 处理 |
|---|---|
| 同路径同方法已存在，签名一致 | 跳过，报告「已存在」 |
| 同路径同方法，出入参变化 | 更新类型与注释，函数体不动；在报告中列出字段级差异 |
| 同函数名，路径不同 | 视为冲突，报告并由用户决定改名或加后缀 |
| 已存在但 Swagger 已删除 | 不自动删除，报告为「可能废弃」 |
| 手写过非生成的函数 | 不覆盖、不合并，单独报告 |

只做增量，不批量重写既有文件。

## 五、质量清单

- [ ] 函数全部走项目封装层，无裸 axios / fetch
- [ ] 文件落在探测到的模块目录，未新建平行目录
- [ ] 命名与既有样本一致
- [ ] 每个函数有 `@param` / `@returns`
- [ ] 类型引用已解析，无 `$ref` 原文
- [ ] 空值与可选字段标注正确
- [ ] 未改动无关函数
- [ ] 与 `api-generator` 脚本输出无矛盾（脚本输出为提取结果，落库以画像规则为准）

## 六、生成后确认

生成结果必须由用户确认后才算完成：

- 展示：新增/更新/跳过/冲突的文件与函数清单；
- 展示：模式画像与最终落点是否一致；
- 冲突项与「可能废弃」项单独列出，等用户裁决；
- 未确认前不宣称"接口定义已生成完毕"。
