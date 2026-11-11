# 设计还原执行手册

> 来源：frontend-workflow v1.4.0 / `references/figma-design-constraint.md`（第二、三、四、五、六、七、八、十章），已裁剪适配 fsflow：移除 Figma 数据获取章（由 `figma-to-component-map` 单入口承载）、移除阶段编号与 `fw_dev_spec` 路径、"设计稿唯一真理"类禁止条款降级为判定优先级（见 `design.md`）。

## 何时读本手册

任务同时满足两条才读：

- 任务带 `figmaRefs` / `figmaNodeId`，或用户明确要求像素级还原；
- 本次变更涉及视觉落地（新建页面/组件，或改动布局、Token、组件库覆盖）。

只改逻辑、只调文案、只修数据问题时读 `engineering.md` 即可，不要为局部改动加载整本手册。设计未画状态的判定仍以 `design.md` 为准，本手册不重复。

---

## 一、Design Token 体系

### 1.1 提取原则

1. 只提取设计中**实际出现**的值，不自创色阶、间距档位。
2. 命名反映用途不反映数值：`--color-primary` 而非 `--color-blue-500`。
3. 按类别分组：颜色、间距、字号、行高、圆角、阴影。
4. 设计使用了 Variables / Styles 时沿用其命名，减少中英对照成本。

### 1.2 定义位置与单一来源

| 规则 | 判定 | 后果 |
|---|---|---|
| 全局 Token 只在项目既有全局样式入口声明一次 | 组件只 `var(--token)` 消费 | 无重复来源 |
| 组件 `<style scoped>` 内写 `:root { }` | 编译为 `:root[data-v-xxx]`，`<html>` 不带该属性 | **Token 静默失效** |
| 本次任务复制整张 Token 表进组件 | 与既有入口形成双源 | 后续改一处漏一处 |
| 缺失值就地声明 | 应补进全局入口 | 同类值散落 |

> 例外：项目本身采用 CSS-in-JS、主题 Provider 或设计系统封装时，按项目既有机制注入，不强求 `:root`。判定依据是"是否存在单一来源"，不是"是否写了 `:root`"。

### 1.3 使用规范

- 新增样式引用 Token，不在同一文件内混用硬编码色值与 Token。
- Token 表里没有的值，先确认设计是否真的用了该值，再决定补 Token。
- 局部主题覆盖（如暗色容器内改文字色）允许存在，不要求所有值都来自全局表。

### 1.4 先查后定义（防蔓延）

新增共用样式（Token、工具类、mixin）前按顺序检索：

1. 项目全局 Token / 样式入口及其 `@import` 链；
2. 同模块、同目录已有样式文件；
3. 组件库或设计系统既有变量与工具类。

命名、用途、取值任一匹配即复用，不新建近似重复（已有 `.text-ellipsis` 又建 `.ellipsis-1`）。

### 1.5 可执行的 lint 项

以下规则读模式执行，只用于本轮新增/改动文件，不追溯整改存量代码。项目已有等价检查时用项目的。

| 编号 | 级别 | 判定 |
|---|---|---|
| TOKEN-01 | error | 组件样式内声明 `:root` 或 `--token`（全局入口除外） |
| TOKEN-02 | error | 同一 Token 名在本轮改动文件间重复定义 |
| TOKEN-03 | error | 组件内新声明了全局入口已有的同名 Token（应引用） |
| TOKEN-04 | warn | 新增工具类/mixin 前未检索等价实现 |
| UI-01 | error | 已识别到项目 UI 库却手写 `<table>` 结构 |
| UI-02 | warn | 已识别到 UI 库却用裸 `button`/`input`/`select` 实现标准组件 |
| UI-03 | error | 跨栈组件混用（Vue 项目出现 `a-`/`nz-`，React 项目出现 `el-`） |

```bash
# TOKEN-01 初筛
rg -n -P '(:root\s*\{|^\s*--[A-Za-z0-9-]+\s*:)' --glob '!**/tokens.css' --glob '*.{vue,scss,css}' <本次改动目录>
# UI-01/02 初筛
rg -n -P '<(table|thead|tbody|tr|td|th|button|input|textarea|select)\b' --glob '*.{vue,tsx,jsx}' <本次改动目录>
```

判定边界：原生标签本身合法（纯展示、自定义交互、设计确有而库无对应组件），UI-02 只提示、由人裁决；UI-01 在项目无表格组件时豁免。

---

## 二、布局与结构映射

### 2.1 Auto Layout → Flex / Grid

| 设计属性 | CSS |
|---|---|
| Horizontal / Vertical direction | `flex-direction: row` / `column` |
| Gap | `gap` |
| Padding（统一 / 分向） | `padding` / `padding-left` 等 |
| Align top·left / center / bottom·right | `align-items: flex-start` / `center` / `flex-end` |
| Space between / Packed start·center·end | `justify-content: space-between` / `flex-start` / `center` / `flex-end` |
| Fill container | `flex: 1` 或 `width: 100%` |
| Fixed width / height | 精确值 + `flex-shrink: 0` |
| Wrap | `flex-wrap: wrap` |
| Min / Max constraints | `min-width` / `max-width` / `min-height` / `max-height` |

两列以上且列宽有对齐要求时用 `grid`；一维排列用 `flex`。不为"看起来更现代"改布局模型。

### 2.2 绝对定位

- 只有设计中确实是绝对定位的节点才用 `position: absolute`，不为省事替代 Flex。
- 父容器需 `position: relative`，偏移量相对父容器边缘计算。
- 浮层（下拉、气泡、抽屉）优先用组件库的定位机制，不自建坐标体系。

### 2.3 节点 → 语义标签

| 节点 | 标签 | 说明 |
|---|---|---|
| Frame（页面/区块） | `main` / `section` / `article` | 按语义选 |
| Frame（布局容器） | `div` | 无额外语义 |
| Frame（可点击） | `button` / `a` | 按交互意图 |
| Group | `div` | 纯分组 |
| Text | `h1`~`h6` / `p` / `span` / `label` | 按层级与用途 |
| Image / Icon | `img` / 内联 `svg` | 矢量图标优先 svg |
| Rectangle（纯装饰） | CSS `background` / `border` | 不新增 DOM |
| 列表 / 表格 | `ul`+`li` / `table` 结构 | 有 UI 库时用库表格 |

语义标签与组件库冲突时，组件库优先；库组件内部已含语义时不重复包裹。

---

## 三、精确测量与单位

### 3.1 取值来源优先级

1. 任务绑定的 `figmaRefs` 对应设计数据（尺寸、变量、状态）；
2. 设计工具 Dev Mode 的检查面板；
3. "复制为 CSS"结果（需人工复核冗余与单位）；
4. 截图目测（仅兜底，须在交付说明中标注为估值）。

截图只用于视觉核对，不作为尺寸依据。

### 3.2 精度与单位

| 场景 | 处理 |
|---|---|
| 整数 px | 直接使用 |
| 小数 ≤ .5 | 向下取整 |
| 小数 > .5 | 向上取整 |
| 设计明确给出 12.5px 这类值 | 保留原值 |
| 字号 | 用 px，不自行换算 rem |
| 行高百分比 150% | `line-height: 1.5` |
| 行高 px | 直接用 px |
| 颜色 alpha | 最多保留 2 位小数 |

- 项目已有 rem / vw 方案时按项目方案换算，并在交付说明写明基准；不混用两套单位。
- 不引入设计中不存在的视口单位或断点。
- 1px 发丝线、0.5px 边框按项目既有做法，不因"看起来更细"擅改。

---

## 四、可访问性最小约束

设计未标注也必须保证（与 `design.md` 的护栏一致）：

| 项 | 要求 |
|---|---|
| 可点击 | 用 `button` / `a`，不用 `div` + 点击事件 |
| 图标按钮 | 有可访问名称（`aria-label` 或可见文本） |
| 装饰元素 | `aria-hidden="true"`，图片 `alt=""` |
| 弹窗 | `role="dialog"` + `aria-modal="true"` + 标题关联 |
| 标题层级 | `h1`→`h6` 不跳级 |
| 焦点 | 弹窗打开焦点进入、关闭回到触发元素；不无理由移除 `outline` |
| Tab 顺序 | 与视觉顺序一致 |
| 对比度 | 正文 ≥ 4.5:1，大文本 ≥ 3:1；不足时**报告不擅改色值** |

组件库已内置焦点与键盘行为时，覆盖样式不得破坏（见 6.2）。

---

## 五、命名与声明顺序

### 5.1 目录约定

按项目既有结构组织，不新造层级。无既有约定时参考：

```
src/components/<ComponentName>/
├── index.vue | index.tsx
├── <component>.module.css | <component>.scss
└── assets/
```

### 5.2 类名

- BEM 或项目既有方案，二选一，不混用。
- 命名描述用途：`.user-card__name` 而非 `.text-bold-blue`。
- 不为设计中不存在的变体创建 Modifier。

### 5.3 CSS 声明顺序

1. 定位：`position` / `top` / `right` / `bottom` / `left` / `z-index`
2. 盒模型：`display` / `flex-*` / `width` / `height` / `margin` / `padding` / `border` / `border-radius`
3. 排版：`font-*` / `line-height` / `letter-spacing` / `text-align` / `color`
4. 视觉：`background` / `box-shadow` / `opacity`
5. 其他：`cursor` / `overflow` / `transition`

项目接入 stylelint 时以其 `order` 规则为准。

---

## 六、资源与组件库

### 6.1 资源

| 类型 | 首选 | 说明 |
|---|---|---|
| 单色图标 | SVG | 可改色、体积小 |
| 多色图标 | SVG，其次 PNG@2x | 复杂图标优先 SVG |
| 照片 / 渐变位图 | PNG@2x，WebP 视兼容性 | |
| 插画 / Logo | SVG，其次 PNG@2x | |

- 优先使用设计交付或项目已有资源；取不到时保留占位结构并在交付说明写明缺口。
- 不用第三方图标库或占位图服务冒充完成还原。
- SVG 导出后去掉冗余命名空间与注释；位图按需压缩，不无差别上 @2x。

### 6.2 与组件库共存

判定优先级：

| 情形 | 处理 |
|---|---|
| 设计使用了库中的组件 | 用库组件，按设计 props 配置 |
| 设计与库组件高度相似 | 用库组件 + 最小样式覆盖 |
| 库中不存在 | 按设计自建 |
| 库有但设计未用 | 不引入（不为"库里正好有这个功能"新增） |

覆盖原则：只覆盖与设计不同的属性，保留库组件的 hover / focus / disabled / loading / 校验行为。禁止 `all: unset` 这类整体重置。

冲突无法调和时（库行为与设计差异过大）自建组件，并在交付说明写明原因与影响面。

### 6.3 标准组件映射（以项目实际依赖为准）

先读 `package.json` 确认实际 UI 库，再取对应列；同一节点只用本栈组件，不跨栈混用。

| 设计中的组件 | ElementUI（Vue 2） | Element Plus（Vue 3） | Ant Design（React） | MUI（React） |
|---|---|---|---|---|
| 按钮 | `el-button` | `el-button` | `a-button` | `<Button>` |
| 输入框 | `el-input` | `el-input` | `a-input` | `<TextField>` |
| 多行文本 | `el-input type="textarea"` | 同左 | `a-input.TextArea` | `<TextField multiline>` |
| 选择器 | `el-select` + `el-option` | 同左 | `a-select` | `<Select>` |
| 级联 | `el-cascader` | `el-cascader` | `a-cascader` | — |
| 表格 | `el-table` + `el-table-column` | 同左 | `a-table` | `<Table>` |
| 表单 | `el-form` + `el-form-item` | 同左 | `a-form` | `<FormControl>` |
| 弹窗 | `el-dialog` | `el-dialog` | `a-modal` | `<Modal>` |
| 抽屉 | `el-drawer` | `el-drawer` | `a-drawer` | `<Drawer>` |
| 标签页 | `el-tabs` + `el-tab-pane` | 同左 | `a-tabs` | `<Tabs>` |
| 分页 | `el-pagination` | `el-pagination` | `a-pagination` | `<Pagination>` |
| 日期 / 时间 | `el-date-picker` / `el-time-picker` | 同左 | `a-date-picker` / `a-time-picker` | `<DatePicker>` |
| 标签 / 开关 | `el-tag` / `el-switch` | 同左 | `a-tag` / `a-switch` | `<Chip>` / `<Switch>` |
| 复选 / 单选 | `el-checkbox` / `el-radio` | 同左 | `a-checkbox` / `a-radio` | `<Checkbox>` / `<Radio>` |
| 提示 / 消息 | `el-message` | `ElMessage` | `message` | `<Alert>` |
| 加载态 | `v-loading` | `v-loading` | `a-spin` | `<CircularProgress>` |
| 空态 | `el-empty` | `el-empty` | `a-empty` | — |
| 树 / 下拉菜单 | `el-tree` / `el-dropdown` | 同左 | `a-tree` / `a-dropdown` | `<Menu>` |

其他栈：Angular → NG-ZORRO / Material；UniApp → uni-ui / uView；小程序 → 原生组件（无独立库时按原生实现）。业务定制组件仍按设计自建。

---

## 七、与 fsflow 的边界

| 事项 | 归属 |
|---|---|
| 设计稿读取、Frame 清单、node 绑定 | `figma-to-component-map`（只用 `get_metadata` 扫结构；设计细节由开发阶段按 `figmaRefs` 拉取，不重复调用） |
| 设计未画状态的判定、产品取舍 | `design.md` |
| 类型、请求、状态、安全、性能 | `engineering.md` |
| 浏览器验证与回归判定 | `test-design-and-execution/references/browser.md` |
| 审查定级与误报边界 | `code-review/references/frontend.md` |

三条硬边界：

1. 本手册只对本轮新增或改动的文件生效，不据此批量整改存量代码。
2. 项目既有 Token、组件库、主题机制优先于本手册的默认基线。
3. 手册与项目规范冲突时，记录冲突与影响，按项目规范实现，并在交付说明中标注。

---

## 八、还原核对清单

逐项自检后才可声明还原完成（结论写入任务的 development-notes，按 `harness-conductor/references/verification.md` 提供证据）：

**布局与尺寸**
- [ ] 容器宽高与间距（margin / padding / gap）与设计一致
- [ ] Flex / Grid 方向与对齐一致
- [ ] 绝对定位位置与偏移基准一致

**颜色与视觉**
- [ ] 文字（含 placeholder）、背景、边框色一致
- [ ] 圆角、阴影、渐变参数一致
- [ ] Token 引用而非硬编码（本轮新增样式）

**字体与排版**
- [ ] 字体族、字号、字重、行高一致
- [ ] 长文本截断 / 换行行为符合设计

**资源与图标**
- [ ] 图片与图标来自设计交付或项目已有资源
- [ ] 尺寸正确，未用第三方图标库替代
- [ ] 取不到的资源已保留占位并登记缺口

**内容与文案**
- [ ] 文案与设计一致，未新增设计中没有的说明文字
- [ ] 未新增设计中没有的 DOM 结构

**状态覆盖**
- [ ] 设计中已画的状态全部实现
- [ ] 设计中未画但功能必需的状态（空/失败/禁用/加载）按 `design.md` 处理
- [ ] 库组件的键盘、焦点、禁用、加载行为未被覆盖破坏

**可访问性**
- [ ] 语义标签正确，图标按钮有可访问名称
- [ ] 弹窗有 role / aria-modal，焦点可进入并返回

**对比验证**
- [ ] 固定视口、字体、数据后与设计稿并列对比无明显差异
- [ ] 视觉吻合之外，交互与数据绑定已实际验证（截图不代替行为断言）

> 与 `design.md`「验证清单」互链：本节负责**还原维度**的逐项判定，`design.md` 负责**状态是否该补**的判定，两者不重复维护同一清单。
