# 团队后端规范档案（team-standard）

本档案是 SKILL.md「条件规则」的团队确认版本。命中条件（满足其一即可）：

- 任务属于公司/团队 Java Spring Boot 技术栈（MyBatis-Plus + Nacos + Feign + MySQL，如 vzan 系项目）；
- 项目知识库或用户明确指定采用团队规范。

命中后，SKILL.md「条件规则」中列出的条目（`/v1` 路径、`zbId`/`userId`、字段注入、`java.util.Date`、`operateType` 合并、PO/DTO/VO 包结构等）即为强制规则，按本档案执行。用户本次明确要求与知识库人工批注仍可覆盖本档案；本档案未覆盖的事项继续按 SKILL.md 的规范优先级处理，并回退到 [java-spring-boot.md](java-spring-boot.md) 的默认值。

完整可运行的代码模板见 [code-templates.md](code-templates.md)。

---

# Backend Technology Specification

This profile defines mandatory coding standards and technical specifications for the team's Java SpringBoot backend projects. All AI-generated code, technical design documents, and code reviews MUST comply with these rules when this profile is active.

## 1. Control Flow Braces (Mandatory)

- **`if` / `else if` / `else` / `for` / `while` / `do` statements MUST always use curly braces `{}` to enclose the body, even when the body contains only a single statement or is empty.**
- **Omitting braces is FORBIDDEN.** This rule applies to every control flow statement, including nested ones, single-line `if`, early-return guards, and `switch` `case` labels.
- **Rationale:** Braces prevent bugs when statements are added later, improve readability, and align with the Alibaba Java Development Manual. They also silence IDE warnings such as `"if statement without braces"`.

```java
// CORRECT: Always use braces, even for single-statement bodies
if (user == null) {
    return null;
}

if (flag) {
    doSomething();
} else {
    doOther();
}

for (String item : items) {
    process(item);
}

while (iterator.hasNext()) {
    handle(iterator.next());
}

// Early-return guard with braces
public OrderVO getDetail(Long id) {
    if (id == null) {
        throw new IllegalArgumentException("id cannot be null");
    }
    Order order = orderMapper.selectById(id);
    if (order == null) {
        return null;
    }
    return toVO(order);
}

// switch case bodies also enclosed in braces
switch (operateType) {
    case "save": {
        doSave(dto);
        break;
    }
    case "update": {
        doUpdate(dto);
        break;
    }
    case "delete": {
        doDelete(dto);
        break;
    }
    default: {
        throw new IllegalArgumentException("Unknown operateType: " + operateType);
    }
}

// WRONG: Missing braces — FORBIDDEN
if (user == null) return null;                    // forbidden
if (flag) doSomething();                          // forbidden
if (flag)
    doSomething();                                // forbidden
else
    doOther();                                     // forbidden
for (String item : items) process(item);          // forbidden
while (it.hasNext()) handle(it.next());           // forbidden
switch (t) {
    case "save": doSave(dto); break;              // forbidden
    default: throw new IllegalArgumentException(); // forbidden
}
```

## 2. Database Query Standards (MyBatis-Plus)

- Use MyBatis-Plus `Wrappers` to construct query conditions for all database operations.
- **For simple single-table queries, DO NOT write raw SQL statements.** Use lambda wrappers instead.
- Only write custom SQL via XML mapper files for complex multi-table joins or reporting queries. **DO NOT use SQL annotations** (such as `@Select`, `@Update`, `@Insert`, `@Delete`).

```java
// CORRECT: Use Wrappers for simple queries
List<User> users = userMapper.selectList(
    Wrappers.<User>lambdaQuery()
        .eq(User::getStatus, 1)
        .like(User::getName, keyword)
        .orderByDesc(User::getCreateTime)
);

// CORRECT: Use Wrappers for updates
userMapper.update(null,
    Wrappers.<User>lambdaUpdate()
        .set(User::getStatus, 0)
        .eq(User::getId, userId)
);

// WRONG: Do NOT write raw SQL for simple single-table queries
@Select("SELECT * FROM user WHERE status = #{status}")
List<User> selectByStatus(@Param("status") int status);
```

## 3. API URL Naming Convention

- Controller class-level `@RequestMapping` MUST use `/v1/{feature-name}` format.
- Method-level paths MUST use hyphen-separated lowercase names (kebab-case), e.g., `/list`, `/batch-update`, `/export-data`.
- **DO NOT use underscores** in URL paths.
- **DO NOT use RESTful style** path parameters for resource IDs (e.g., `/v1/user/{id}` is forbidden).
- When parameters are few (e.g., only an ID), use GET request with query parameters.
- When parameters are many, use POST request with `@RequestBody`.

```java
// CORRECT: Controller-level prefix with /v1/{feature-name}
@RestController
@RequestMapping("/v1/user-management")
public class UserController {

    // Few params → GET
    @GetMapping("/detail")
    public Result<UserVO> detail(@RequestParam Long id) { ... }

    // Many params → POST
    @PostMapping("/list")
    public Result<PageVO<UserVO>> list(@RequestBody UserQueryDTO query) { ... }

    // Batch operation → POST
    @PostMapping("/batch-update")
    public Result<Void> batchUpdate(@RequestBody List<UserUpdateDTO> updates) { ... }
}

// WRONG: RESTful style
@GetMapping("/{id}")                    // forbidden
@PostMapping("/user_list")              // forbidden (underscore)
```

### 3.1 Controller Organization

- **PRIMARY GOAL: create as few files as possible.** When adding any interface or functionality, FIRST check whether it can be added to an existing Controller / Service / DTO / VO. The default answer is to extend an existing file, NOT to create a new one. Only create a new file when the functionality belongs to a genuinely different business domain.
- **Group similar functions into one Controller.** Functionally-similar or same-domain interfaces MUST be placed in a single Controller class. **DO NOT** create separate Controller files for each CRUD operation or minor sub-feature.
- **Consolidate similar operations into one endpoint.** When multiple interfaces perform structurally similar operations (e.g., create, update, delete on the same resource), prefer using **a single endpoint** with an `operateType` (or similar) field in the request DTO to distinguish the operation type, rather than creating one endpoint per operation. This reduces the number of API definitions while keeping the logic clean and maintainable.

```java
// CORRECT: One Controller for the entire user-management feature
@RestController
@RequestMapping("/v1/user-management")
public class UserController {

    @Autowired
    private UserService userService;

    // Query endpoints remain separate (different param patterns)
    @PostMapping("/list")
    public Result<PageVO<UserVO>> list(@RequestBody @Valid UserQueryDTO query) { ... }

    @GetMapping("/detail")
    public Result<UserVO> detail(@RequestParam Long id) { ... }

    // Similar write operations consolidated into ONE endpoint with operateType
    @PostMapping("/operate")
    public Result<Void> operate(@RequestBody @Valid UserOperateDTO dto) {
        userService.operate(dto);
        return Result.success();
    }
}

// DTO with operation type field to distinguish create / update / delete
@ApiModel(value = "UserOperateDTO", description = "用户操作请求")
@Data
public class UserOperateDTO {

    @NotNull(message = "操作类型不能为空")
    @ApiModelProperty(value = "操作类型: save-新增 update-修改 delete-删除", required = true, example = "save")
    private String operateType;

    @ApiModelProperty(value = "用户ID(修改/删除时必填)", example = "1")
    private Long id;

    @ApiModelProperty(value = "用户名", example = "张三")
    private String userName;

    @ApiModelProperty(value = "状态: 1-启用 0-禁用", example = "1")
    private Integer status;
}

// WRONG: Creating separate controllers for minor sub-features
// UserController.java, UserQueryController.java, UserOperateController.java  ← too many files

// WRONG: One endpoint per write operation when they are structurally similar
// @PostMapping("/save")  @PostMapping("/update")  @PostMapping("/delete")
// ← prefer a single /operate endpoint with operateType field
```

### 3.2 Pagination Query Specification

- **Create a shared pagination base DTO** (e.g., `BasePageDTO` in `entity/dto/` package) containing `pageNum` (default `1`, `@Min(1)`) and `pageSize` (default `20`, `@Min(1)` + `@Max(200)`).
- **Every request DTO that requires pagination MUST extend the base DTO.** Do NOT re-declare `pageNum`/`pageSize` fields in each query DTO.
- **Multi-parameter query endpoints (including paginated lists) MUST use POST with a `@RequestBody` DTO object.** Using GET with multiple `@RequestParam` in place of POST is FORBIDDEN, even for read-only list queries.
- The Service layer `list` method signature MUST receive the query DTO directly (e.g., `Page<XxxVO> list(XxxQueryDTO dto)`), NOT scattered `int pageNum, int pageSize, ...` parameters.

```java
// CORRECT: Shared pagination base DTO
@Data
@Schema(description = "分页查询基础请求")
public class BasePageDTO {

    /**
     * 页码
     */
    @Min(value = 1, message = "页码最小为1")
    @Schema(description = "页码", example = "1")
    private Integer pageNum = 1;

    /**
     * 每页条数
     */
    @Min(value = 1, message = "每页条数最小为1")
    @Max(value = 200, message = "每页条数最大为200")
    @Schema(description = "每页条数", example = "20")
    private Integer pageSize = 20;
}

// CORRECT: Query DTO extends the base, adds only business filter fields
@Data
@EqualsAndHashCode(callSuper = true)
@Schema(description = "审核列表分页查询请求")
public class KbReviewListDTO extends BasePageDTO {

    /**
     * 状态过滤（可空=全部）
     */
    @Schema(description = "状态过滤: PENDING(待审核)/APPROVED(已通过)/REJECTED(已退回)", example = "PENDING")
    private String status;
}

// CORRECT: Multi-param (paginated) query endpoint → POST + @RequestBody DTO
@PostMapping("/review-list")
@Operation(summary = "审核列表")
public Result<Page<KbReviewVO>> reviewList(@Valid @RequestBody KbReviewListDTO dto) {
    return Result.success(reviewService.list(dto));
}

// WRONG: GET with multiple @RequestParam for a paginated query — FORBIDDEN
@GetMapping("/review-list")
public Result<Page<KbReviewVO>> reviewList(@RequestParam(defaultValue = "1") int pageNum,
                                           @RequestParam(defaultValue = "10") int pageSize,
                                           @RequestParam(required = false) String status) { ... }
// ↑ forbidden: must be POST + @RequestBody DTO extending BasePageDTO

// WRONG: Re-declaring pagination fields in every query DTO
@Data
public class KbReviewListDTO {
    private Integer pageNum = 1;     // forbidden: must extend BasePageDTO
    private Integer pageSize = 20;   // forbidden: must extend BasePageDTO
    private String status;
}
```

### 3.3 Response VO Specification (No Map Returns)

- **Interface return values MUST NOT use `Map` (e.g., `Map<String, Object>`).** Returning loose key-value structures from Controller or Service methods is FORBIDDEN.
- **Every interface that returns data MUST define a dedicated VO class** in the `entity/vo/` package, with Javadoc comments and `@Schema` annotations on each field (enum-effect fields list all possible values per rule 8.2).
- This applies to all layers: Controller return type (`Result<XxxVO>`), Service interface method signatures, and Service implementations. Returning `Map` internally and converting only at the Controller is also forbidden.
- Rationale: Map returns lose type safety, cannot be documented in Swagger, are error-prone on key names, and force front-end developers to read backend source code.

```java
// CORRECT: Dedicated VO with typed fields
@Data
@Schema(description = "编辑锁操作结果")
public class KbLockVO {

    /**
     * 操作后是否持有锁
     */
    @Schema(description = "操作后是否持有锁: true(当前用户持有)/false(未持有或他人持有)")
    private Boolean locked;

    /**
     * 当前锁持有者姓名（无锁时为空）
     */
    @Schema(description = "当前锁持有者姓名（无锁时为空）")
    private String holder;
}

@PostMapping("/lock")
public Result<KbLockVO> lock(@Valid @RequestBody KbLockDTO dto) {
    return Result.success(documentService.lock(dto));
}

// WRONG: Map as return value — FORBIDDEN
@PostMapping("/lock")
public Result<Map<String, Object>> lock(@Valid @RequestBody KbLockDTO dto) { ... }
// ↑ forbidden

// WRONG: Building HashMap inside the Service
@Override
public Map<String, Object> lock(KbLockDTO dto) {
    Map<String, Object> result = new HashMap<>();
    result.put("locked", true);
    result.put("holder", userName);
    return result;                  // forbidden: must build and return a VO
}
```

## 4. Parameter Naming Conventions

- **Merchant/Tenant ID**: Always use `zbId` (type `int`), representing the merchant or tenant identifier in the system.
- **User ID**: Always use `userId` (type `long`).

```java
// CORRECT
public class QueryDTO {
    private int zbId;       // merchant/tenant ID
    private long userId;    // user ID
}

// Controller example
@PostMapping("/list")
public Result<List<UserVO>> list(@RequestBody QueryDTO query) {
    // query.getZbId()  - merchant context
    // query.getUserId() - user context
}
```

## 5. Performance & Async Processing

- Design code with performance and response time in mind.
- Non-critical steps MUST use multi-threaded async processing.
- **Priority**: Use existing thread pools in the project. If none exists, create a configurable thread pool.
- **Thread pool creation MUST be centralized in a utility class or configuration class** (e.g., `util/AsyncUtil.java` or `config/AsyncConfig.java`). **DO NOT** create thread pools directly inside Service classes (e.g., `new ThreadPoolExecutor(...)` in a Service). This ensures thread pools are managed consistently and avoid resource leaks.
- Thread pool parameters (core size, max size, queue capacity, thread name prefix) MUST be configurable via Nacos or application.yml.
- Async tasks MUST run on a named, project-managed executor. Calling `CompletableFuture.runAsync(...)` without an explicit executor is FORBIDDEN.

```java
// CORRECT: Thread pool created in a centralized config/utility class
@Configuration
@EnableAsync
public class AsyncConfig {
    @Bean("taskExecutor")
    public ThreadPoolTaskExecutor taskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(5);          // read from Nacos/yml in real projects
        executor.setMaxPoolSize(20);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("async-");
        executor.initialize();
        return executor;
    }
}

// CORRECT: Service uses the centralized thread pool via injection
@Service
public class OrderService {

    @Autowired
    private ThreadPoolTaskExecutor taskExecutor;

    public OrderVO createOrder(OrderDTO dto) {
        // Core logic: create order synchronously
        Order order = saveOrder(dto);

        // Non-critical: send notification asynchronously
        CompletableFuture.runAsync(() -> {
            sendNotification(order);
            writeAuditLog(order);
        }, taskExecutor);

        return convertToVO(order);
    }
}

// WRONG: Creating thread pool directly inside a Service
@Service
public class CwxChatService {
    // forbidden: thread pool should be in a centralized config/util class, not here
    private final ExecutorService executor = new ThreadPoolExecutor(
        2, 5, 60L, TimeUnit.SECONDS, new LinkedBlockingQueue<>(100)
    );
    // ... using this executor ...
}

// WRONG: runAsync without an explicit executor — FORBIDDEN
CompletableFuture.runAsync(() -> sendNotification(order));   // forbidden: no executor
```

## 6. Nacos Configuration with Hot Refresh

- All configuration parameters read from Nacos MUST include the `@RefreshScope` annotation.
- This enables hot-update of configuration without service restart.

```java
// CORRECT: @RefreshScope enables hot refresh
@RestController
@RefreshScope
@RequestMapping("/v1/config-demo")
public class ConfigController {

    @Value("${app.feature.enabled:false}")
    private boolean featureEnabled;

    @Value("${app.limit.max-count:100}")
    private int maxCount;
}

// Also apply on @ConfigurationProperties classes
@Component
@ConfigurationProperties(prefix = "app.payment")
@RefreshScope
public class PaymentConfig {
    private int timeout;
    private String callbackUrl;
}
```

## 7. Entity Class & Database Field Annotations

### 7.1 Package Structure

All model classes related to database entities MUST follow this package structure:

- **Entity (PO — Persistent Object)**: `com.xxx.base.entity.po.Xxx` — database-mapped entity classes with MyBatis-Plus annotations.
- **DTO (Data Transfer Object)**: `com.xxx.base.entity.dto.XxxDTO` — request body objects passed from Controller to Service.
- **VO (View Object)**: `com.xxx.base.entity.vo.XxxVO` — response objects returned from Controller to the caller.

```java
// CORRECT: Package structure
// com.vzan.ai.base.entity.po.TicketInfo          ← Entity / PO
// com.vzan.ai.base.entity.dto.TicketQueryDTO       ← DTO
// com.vzan.ai.base.entity.vo.TicketVO              ← VO

// WRONG: Placing entity, DTO, and VO in the same flat package
// com.vzan.ai.base.entity.TicketInfo
// com.vzan.ai.base.entity.TicketQueryDTO
// com.vzan.ai.base.entity.TicketVO
// ↑ should be separated into po/dto/vo sub-packages
```

### 7.2 Annotations on Entity Classes

- Entity classes MUST use MyBatis-Plus annotations to explicitly map Java fields to database columns.
- **Required class-level annotation**: `@TableName("table_name")`.
- **Required field-level annotations**:
  - `@TableId(type = IdType.AUTO)` — primary key field.
  - `@TableField(value = "column_name")` — explicit column mapping for every business field.
  - `@TableField(fill = FieldFill.INSERT)` / `@TableField(fill = FieldFill.INSERT_UPDATE)` — auto-fill fields (`create_time`, `update_time`).
  - `@TableLogic` — logical delete flag field (e.g., `deleted_flag`).
- **Every entity field MUST have a Javadoc comment (`/** ... */`) placed on the line ABOVE the annotation(s).** Single-line `/** ... */` is acceptable for short descriptions. Inline `//` comments or comments placed after the annotation are forbidden. The comment describes the business meaning of the field.
- **All database time fields MUST use `java.util.Date` as the Java type** (not `LocalDateTime`, `LocalDate`, `Instant`, or `Timestamp`). This applies to `create_time`, `update_time`, and any other temporal column in entity classes.
- **DO NOT use `@JSONField`** (FastJSON) annotation on entity class fields.
- **DO NOT use `@JsonProperty`** (Jackson) annotation on entity class fields.
- This prevents case-inconsistency issues when exposing remote API interfaces.

```java
// CORRECT: Entity with database field annotations + Javadoc comments + Date type for time fields
@Data
@TableName("user_info")
public class User {

    /**
     * 主键 ID
     */
    @TableId(type = IdType.AUTO)
    private Long id;

    /**
     * 用户名
     */
    @TableField(value = "user_name")
    private String userName;

    /**
     * 商户 ID
     */
    @TableField(value = "zb_id")
    private Integer zbId;

    /**
     * 状态: 1-启用 0-禁用
     */
    @TableField(value = "status")
    private Integer status;

    /**
     * 删除标记: 0-未删除 1-已删除
     */
    @TableField(value = "deleted_flag")
    @TableLogic
    private Integer deletedFlag;

    /**
     * 创建时间
     */
    @TableField(value = "create_time", fill = FieldFill.INSERT)
    private Date createTime;

    /**
     * 更新时间
     */
    @TableField(value = "update_time", fill = FieldFill.INSERT_UPDATE)
    private Date updateTime;
}

// WRONG: Missing Javadoc comments on fields
@Data
@TableName("user_info")
public class User {
    @TableId(type = IdType.AUTO)
    private Long id;                        // forbidden: no /** comment */

    @TableField(value = "user_name")
    private String userName;                // forbidden: no /** comment */
}

// WRONG: Using LocalDateTime instead of Date for time fields
@TableField(value = "create_time", fill = FieldFill.INSERT)
private LocalDateTime createTime;           // forbidden: must use java.util.Date

// WRONG: Adding @JSONField or @JsonProperty
@Data
@TableName("user_info")
public class User {
    @TableId(type = IdType.AUTO)
    @JSONField(name = "Id")     // forbidden
    private Long id;

    @JsonProperty("UserName")   // forbidden
    private String userName;
}
```

## 8. DTO & VO Swagger Annotations

- All DTO (Data Transfer Object) and VO (View Object) classes MUST include Swagger annotations for API documentation.
- **The annotation style depends on the Swagger version used by the project.** Follow the project's existing Swagger dependency:
  - **Swagger v2 (SpringFox)**: Use `@ApiModel` / `@ApiModelProperty` annotations (package `io.swagger.annotations`).
  - **Swagger v3 / OpenAPI 3 (SpringDoc / knife4j-openapi3)**: Use `@Schema` annotation (package `io.swagger.v3.oas.annotations.media.Schema`).
- Fields with `@NotNull` / `@NotBlank` validation MUST set `required = true`.
- Use the `example` attribute to provide sample values for better API documentation.
- **Do not mix v2 and v3 annotations** in the same project. Follow the existing convention.

```java
// CORRECT: Swagger v2 (SpringFox) — @ApiModel / @ApiModelProperty
@ApiModel(value = "UserQueryDTO", description = "用户查询请求")
@Data
public class UserQueryDTO {

    @NotNull(message = "商户ID不能为空")
    @ApiModelProperty(value = "商户ID", required = true, example = "1001")
    private Integer zbId;

    @ApiModelProperty(value = "用户ID", example = "123456")
    private Long userId;

    @ApiModelProperty(value = "状态: 1-启用 0-禁用", example = "1")
    private Integer status;

    @ApiModelProperty(value = "用户名(模糊查询)", example = "张三")
    private String userName;

    @ApiModelProperty(value = "页码", example = "1")
    private Integer pageNum = 1;

    @ApiModelProperty(value = "每页条数", example = "20")
    private Integer pageSize = 20;
}

// CORRECT: Swagger v3 / OpenAPI 3 (SpringDoc / knife4j) — @Schema
@Schema(description = "用户查询请求")
@Data
public class UserQueryDTO {

    @NotNull(message = "商户ID不能为空")
    @Schema(description = "商户ID", requiredMode = Schema.RequiredMode.REQUIRED, example = "1001")
    private Integer zbId;

    @Schema(description = "用户ID", example = "123456")
    private Long userId;

    @Schema(description = "状态: 1-启用 0-禁用", example = "1")
    private Integer status;

    @Schema(description = "用户名(模糊查询)", example = "张三")
    private String userName;

    @Schema(description = "页码", example = "1")
    private Integer pageNum = 1;

    @Schema(description = "每页条数", example = "20")
    private Integer pageSize = 20;
}

// WRONG: Mixing v2 and v3 annotations in the same project
@ApiModel(value = "UserVO", description = "用户信息视图")
@Data
public class UserVO {
    @Schema(description = "用户ID")        // mixed v2 and v3 — forbidden
    private Long id;
}
```

### 8.1 Date Field JSON Formatting

- **All `java.util.Date` fields in DTO and VO classes MUST use `@JsonFormat`** to ensure consistent date/time serialization in API responses.
- The standard format is `pattern = "yyyy-MM-dd HH:mm:ss"` with `timezone = "GMT+8"`.
- This applies to both request DTO fields and response VO fields that contain time values (e.g., `createTime`, `updateTime`, `firstProcessTime`, `completeTime`, etc.).

```java
// CORRECT: Date fields with @JsonFormat in VO
@Schema(description = "用户信息视图")
@Data
public class UserVO {

    @Schema(description = "用户ID", example = "1")
    private Long id;

    @Schema(description = "用户名", example = "张三")
    private String userName;

    @Schema(description = "创建时间")
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date createTime;

    @Schema(description = "更新时间")
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date updateTime;

    @Schema(description = "首次处理时间")
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date firstProcessTime;

    @Schema(description = "完结时间")
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date completeTime;
}

// WRONG: Date field without @JsonFormat — inconsistent serialization
@Schema(description = "用户信息视图")
@Data
public class UserVO {
    @Schema(description = "创建时间")
    private Date createTime;  // forbidden: missing @JsonFormat, output format unpredictable
}
```

### 8.2 Enum-Effect Fields in Swagger Description

- **Fields whose value is a limited enum set MUST document all possible values with their meanings** in the `@Schema(description = "...")` or `@ApiModelProperty(value = "...")` attribute.
- Use the format `fieldName: value1(meaning1)/value2(meaning2)/...` to make it self-documenting in Swagger UI.
- This applies to both DTO (request) and VO (response) enum fields so that front-end developers can see all available options directly in the API docs without reading backend source code.

```java
// CORRECT: Enum field lists all possible values and meanings
@Schema(description = "状态筛选: pending(待处理)/processing(处理中)/completed(已完结)/cancelled(已取消)", example = "pending")
private String status;

@Schema(description = "排序方向: asc(升序)/desc(降序)", example = "desc")
private String orderDirection;

@Schema(description = "工单类型: bug(缺陷)/feature(需求)/task(任务)/improvement(优化)", example = "bug")
private String ticketType;

// Swagger v2 equivalent
@ApiModelProperty(value = "状态筛选: pending(待处理)/processing(处理中)/completed(已完结)/cancelled(已取消)", example = "pending")
private String status;

// WRONG: Enum field without listing all possible values
@Schema(description = "状态筛选", example = "pending")
private String status;
// ↑ forbidden: front-end developers cannot know which values are valid by looking at Swagger UI alone

@Schema(description = "排序方向")
private String orderDirection;
// ↑ forbidden: no hint about what values this field accepts
```

## 9. Database Field & Table Naming

- All projects use **MySQL** database.
- Time fields MUST use standard names: `create_time`, `update_time`.
- **DO NOT use `is_xxx`** prefix for boolean/flag fields. Use descriptive names instead (e.g., `status`, `deleted_flag`, `enabled`).
- Table names SHOULD include a feature prefix to distinguish modules (e.g., `user_info`, `order_payment`, `report_daily_summary`).

```sql
-- CORRECT: Table design
CREATE TABLE `user_info` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_name` VARCHAR(64) NOT NULL COMMENT '用户名',
    `status` TINYINT DEFAULT 1 COMMENT '状态: 1-启用 0-禁用',
    `deleted_flag` TINYINT DEFAULT 0 COMMENT '删除标记: 0-未删除 1-已删除',
    `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `update_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户信息表';

-- WRONG: Bad field names
-- is_active     → use `status` instead
-- is_deleted    → use `deleted_flag` instead
-- gmt_create    → use `create_time` instead
-- gmt_modified  → use `update_time` instead
```

## 10. Service Layer Architecture

### 10.1 Dependency Injection

- **Use field injection with `@Autowired` or `@Resource` annotation.** Do NOT use constructor injection (`@RequiredArgsConstructor` + `private final`).
- The annotated field is typically `private` and non-final.

```java
// CORRECT: @Autowired field injection
@RestController
public class UserController {
    @Autowired
    private UserService userService;
}

@Service
public class UserServiceImpl {
    @Autowired
    private UserMapper userMapper;
    @Autowired
    private AuditLogService auditLogService;
}

// CORRECT: @Resource field injection (also acceptable)
@RestController
public class UserController {
    @Resource
    private UserService userService;
}
```

### 10.2 Service Interface vs. Direct Class

- **Services called by Controllers or other external modules SHOULD define an interface** (e.g., `UserService` interface + `UserServiceImpl` implementation). The Controller injects the interface, not the implementation class. This enables easy mocking in tests and future implementation swapping.
- **Handler / processor style services (not called by Controllers) may omit the interface** and be defined directly as a class with `@Service`. For example, services that act as internal event handlers, message processors, or async task runners can be a plain class without a separate interface.
- **Implementation class naming**: When using the interface pattern, `XxxServiceImpl` must `implements XxxService`. **DO NOT extend `ServiceImpl<XxxMapper, Xxx>`** (MyBatis-Plus base class). Instead, inject `XxxMapper` directly and use it for database operations.

```java
// CORRECT: Controller-facing Service — define interface + implementation
public interface UserService {
    PageVO<UserVO> pageQuery(UserQueryDTO query);
    UserVO getDetail(Long id, Integer zbId);
    void operate(UserOperateDTO dto);
    String export(UserQueryDTO query);
}

@Slf4j
@Service
public class UserServiceImpl implements UserService {

    @Autowired
    private UserMapper userMapper;
    @Autowired
    private AuditLogService auditLogService;

    @Override
    public PageVO<UserVO> pageQuery(UserQueryDTO query) { ... }

    @Override
    public void operate(UserOperateDTO dto) {
        switch (dto.getOperateType()) {
            case "save": {
                doSave(dto);
                break;
            }
            case "update": {
                doUpdate(dto);
                break;
            }
            case "delete": {
                doDelete(dto);
                break;
            }
            default: {
                throw new IllegalArgumentException("Unknown operateType: " + dto.getOperateType());
            }
        }
    }
}

// WRONG: Service implementation extends ServiceImpl (MyBatis-Plus base class)
@Slf4j
@Service
public class UserServiceImpl extends ServiceImpl<UserMapper, User> implements UserService {
    // ↑ forbidden: do not extend ServiceImpl; inject Mapper directly instead
}

// WRONG: Service interface extends IService (MyBatis-Plus base interface)
public interface UserService extends IService<User> {
    // ↑ forbidden: do not extend IService
}

// Controller injects the INTERFACE, not the impl
@RestController
public class UserController {
    @Autowired
    private UserService userService;  // ← interface
}

// CORRECT: Handler / processor-style service — plain class, no interface needed
@Slf4j
@Service
public class CwxChatService {

    @Autowired
    private RedisTemplate<String, Object> redisTemplate;
    @Autowired
    private CwxChatConfig chatConfig;

    public void processMessage(String chatId, String message) { ... }
}

// WRONG: Splitting one entity's logic across multiple services
// UserQueryService.java + UserOperateService.java  ← merge into one UserService
```

### 10.3 Service Grouping

- **Group similar methods into one Service.** Methods that operate on the same business entity or belong to the same feature module MUST be placed in a single Service class. **DO NOT** create multiple Service classes for the same entity (e.g., avoid `UserQueryService` + `UserOperateService` + `UserExportService` — use a single `UserService`).

## 11. Remote Call (Feign) Interface Specification

- **All remote HTTP call interfaces MUST be placed under the `feign/` package** (e.g., `com.xxx.base.feign.XxxClient`).
- Feign interface classes should follow the naming convention `XxxClient` (using `@FeignClient`).
- **DO NOT** place Feign interfaces in the `service/`, `controller/`, or `util/` packages.
- Feign interfaces should define clear method contracts using Spring MVC annotations (`@GetMapping`, `@PostMapping`, `@RequestParam`, `@RequestBody`, `@RequestHeader`, etc.).

```java
// CORRECT: Feign client placed in feign/ package
package com.vzan.ai.base.feign;

@FeignClient(name = "account-service", url = "${remote.account.url}")
public interface AccountAuthClient {

    @GetMapping("/v1/account/detail")
    Result<AccountVO> getAccountDetail(@RequestParam("accountId") Long accountId);

    @PostMapping("/v1/account/batch-query")
    Result<List<AccountVO>> batchQuery(@RequestBody AccountQueryDTO query);
}

// WRONG: Feign client placed in service/ or other packages
package com.vzan.ai.base.service;
@FeignClient(name = "account-service")
public interface AccountAuthClient { ... }
// ↑ forbidden: must be in feign/ package
```

## 12. Technology Stack

- **Language**: Java (JDK 8+/11+/17+ depending on project)
- **Framework**: SpringBoot ecosystem (Spring MVC, Spring Security, Spring Data)
- **ORM**: MyBatis-Plus (required for database access)
- **Database**: MySQL
- **Configuration Center**: Nacos (with `@RefreshScope`)
- **Build Tool**: Maven or Gradle (follow project convention)

## 13. Utility Package Priority

- When choosing utility classes for string, collection, date, IO, and other common operations, **MUST prioritize the following two packages**:
  1. **Hutool** (`cn.hutool.*`) — preferred first; rich API, chaining-friendly.
  2. **Apache Commons** (`org.apache.commons.*`) — fallback when Hutool lacks the needed utility.
- **DO NOT use** `org.springframework.util.StringUtils` / `CollectionUtils` etc. when Hutool or Apache Commons already provides the equivalent utility.
- When building MyBatis-Plus `Wrappers` conditional queries, use the conditional-capable methods (e.g., `.eq(condition, field, val)`, `.like(condition, field, val)`, `.and(condition, w -> ...)`) to chain all conditions, avoiding a series of separate `if` blocks. The boolean `condition` argument MUST be evaluated via Hutool / Apache Commons utilities (e.g., `StrUtil.isNotBlank(...)`, `StringUtils.isNotBlank(...)`, `CollectionUtil.isNotEmpty(...)`).

### Common utility mapping (preferred → fallback)

| Scenario | Hutool (preferred) | Apache Commons (fallback) |
| --- | --- | --- |
| String not blank | `cn.hutool.core.util.StrUtil.isNotBlank(str)` | `org.apache.commons.lang.StringUtils.isNotBlank(str)` |
| String blank / empty | `StrUtil.isBlank(str)` / `StrUtil.isEmpty(str)` | `StringUtils.isBlank(str)` / `StringUtils.isEmpty(str)` |
| Collection not empty | `cn.hutool.core.collection.CollUtil.isNotEmpty(coll)` | `org.apache.commons.collections.CollectionUtils.isNotEmpty(coll)` |
| Collection empty | `CollUtil.isEmpty(coll)` | `CollectionUtils.isEmpty(coll)` |
| Array not empty | `cn.hutool.core.util.ArrayUtil.isNotEmpty(arr)` | `org.apache.commons.lang.ArrayUtils.isNotEmpty(arr)` |
| Object null | `cn.hutool.core.util.ObjectUtil.isNull(obj)` | `org.apache.commons.lang.ObjectUtils.defaultIfNull(...)` |

```java
// CORRECT: Chain conditions via Wrappers conditional methods, with Hutool / Apache Commons for the boolean check
import cn.hutool.core.util.StrUtil;
import cn.hutool.core.collection.CollUtil;

var wrapper = Wrappers.<User>lambdaQuery()
        .eq(null != query.getZbId(), User::getZbId, query.getZbId())
        .eq(StrUtil.isNotBlank(query.getUserName()), User::getUserName, query.getUserName())
        .like(StrUtil.isNotBlank(query.getKeyword()), User::getNickName, query.getKeyword())
        .in(CollUtil.isNotEmpty(query.getStatusList()), User::getStatus, query.getStatusList())
        .orderByDesc(User::getCreateTime);

// CORRECT: Apache Commons fallback when Hutool is not imported
import org.apache.commons.lang.StringUtils;
import org.apache.commons.collections.CollectionUtils;

var wrapper = Wrappers.<User>lambdaQuery()
        .eq(null != query.getZbId(), User::getZbId, query.getZbId())
        .eq(StringUtils.isNotBlank(query.getUserName()), User::getUserName, query.getUserName())
        .in(CollectionUtils.isNotEmpty(query.getStatusList()), User::getStatus, query.getStatusList());

// WRONG: Using org.springframework.util.StringUtils
import org.springframework.util.StringUtils;
wrapper.eq(StringUtils.hasText(query.getUserName()), User::getUserName, query.getUserName()); // forbidden

// WRONG: Separate if blocks instead of conditional chaining
if (query.getUserName() != null && !query.getUserName().isEmpty()) {
    wrapper.eq(User::getUserName, query.getUserName());
}
if (query.getStatusList() != null && !query.getStatusList().isEmpty()) {
    wrapper.in(User::getStatus, query.getStatusList());
}
```

## 14. Common Code Extraction (DRY)

- **Repeated code MUST be extracted into a shared/common part.** When the same or structurally identical logic appears in 2 or more places (Controllers, Services, DTOs, VOs, utilities), extract it ONCE into a common base class, utility method, shared Service method, or private helper — copy-paste duplication is FORBIDDEN.
- Typical extractions (apply the matching pattern):
  - Repeated pagination fields → shared base DTO (e.g., `BasePageDTO`, rule 3.2)
  - Repeated entity→VO mapping in 2+ methods → private `toVO(...)` helper or shared converter method
  - Repeated permission checks → single `assertPermission(...)` / `myPerm(...)` Service method called by all callers
  - Repeated validation / status-machine transitions → shared method on the owning Service
  - Repeated constants / magic strings → constants class or enum (never hard-code the same literal twice)
  - Repeated async notification logic → one `sendAsync(...)` / `sendBatchAsync(...)` message Service method
- **Minimize file count here too:** prefer extending an existing class or adding a method to an existing Service over creating near-duplicate new files. A new common class is justified only when the shared logic is used by 2+ different classes.
- Rationale: single point of change, no drift between copies, smaller codebase, fewer files.

```java
// CORRECT: shared toVO helper reused by list/detail — no duplicated mapping
@Override
public Page<KbReviewVO> list(KbReviewListDTO dto) {
    // ... query ...
    result.setRecords(page.getRecords().stream().map(this::toVO).collect(Collectors.toList()));
    return result;
}

@Override
public KbReviewVO detail(Long reviewId) {
    return toVO(requireTask(reviewId));
}

private KbReviewVO toVO(KbReviewTask task) {
    KbReviewVO vo = new KbReviewVO();
    vo.setId(task.getId());
    // ... single mapping implementation ...
    return vo;
}

// CORRECT: shared permission assertion reused by submit/approve/reject
permService.assertPermission(SysResourceType.KB_TEAM.getCode(), teamId, SysPermCode.REVIEW, userName);

// WRONG: duplicated VO mapping copy-pasted into list() and detail() — FORBIDDEN
public Page<KbReviewVO> list(KbReviewListDTO dto) {
    // ...
    vo.setId(task.getId()); /* same 15 mapping lines */ // forbidden duplication
}
public KbReviewVO detail(Long reviewId) {
    // ...
    vo.setId(task.getId()); /* same 15 mapping lines again */ // forbidden duplication
}
```

## Code Generation Checklist

Before outputting any backend code, verify:

- [ ] `if` / `else if` / `else` / `for` / `while` / `do` / `switch-case` ALWAYS use curly braces `{}` — no single-line or brace-less bodies, even for one statement or empty body
- [ ] Simple single-table queries use `Wrappers`, no raw SQL; complex SQL only in XML mapper files, no SQL annotations
- [ ] Controller path uses `/v1/{feature-name}` format
- [ ] Method paths use kebab-case, no underscores
- [ ] No RESTful path parameters (like `/{id}`)
- [ ] Few params → GET, many params → POST
- [ ] Paginated query DTOs extend the shared `BasePageDTO` (no re-declared `pageNum`/`pageSize` fields); multi-param/paginated query endpoints use POST + `@RequestBody` DTO (GET with multiple `@RequestParam` is FORBIDDEN); Service `list` methods receive the query DTO directly
- [ ] NO `Map` return values — every data-returning interface (Controller, Service interface, and implementation) uses a dedicated VO class with Javadoc + `@Schema` annotations
- [ ] Similar function interfaces grouped into ONE Controller (avoid creating too many Controller files)
- [ ] PRIMARY GOAL of file creation: as few files as possible — extend existing Controller/Service/DTO/VO first; new file only for a genuinely different business domain
- [ ] Repeated code extracted into shared parts (base DTO / `toVO` helper / `assertPermission` / shared Service method / constants) — no copy-paste duplication across 2+ places
- [ ] Structurally similar operations (save/update/delete) consolidated into one endpoint with `operateType` field
- [ ] Merchant ID named `zbId` (int), user ID named `userId` (long)
- [ ] Non-critical operations use async processing; thread pools are created in centralized `config/` or `util/` classes, NOT inside Service classes; `runAsync` always passes an explicit executor
- [ ] Nacos config beans have `@RefreshScope`
- [ ] Entity classes placed in `entity/po/`, DTO in `entity/dto/`, VO in `entity/vo/` sub-packages
- [ ] Entity classes have `@TableName`, `@TableId`, `@TableField`, `@TableLogic` annotations
- [ ] Every entity field has a Javadoc comment (`/** ... */`) placed above the annotation(s)
- [ ] All database time fields use `java.util.Date` (NOT `LocalDateTime` / `LocalDate` / `Timestamp`)
- [ ] Entity fields have NO `@JSONField` or `@JsonProperty`
- [ ] DTO/VO classes have Swagger annotations (`@ApiModel`/`@ApiModelProperty` for v2, `@Schema` for v3/OpenAPI3), following the project's Swagger version
- [ ] All `java.util.Date` fields in DTO/VO use `@JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")`
- [ ] Enum-effect fields document all possible values with meanings in `description` (format: `"field: value1(meaning1)/value2(meaning2)/..."`)
- [ ] Time fields named `create_time` / `update_time`
- [ ] No `is_xxx` field naming
- [ ] Table names include feature prefix
- [ ] Controller-facing Service defines an interface (`XxxService`) with implementation (`XxxServiceImpl implements XxxService`); handler/processor-style services may omit the interface
- [ ] Service implementation does NOT extend `ServiceImpl<XxxMapper, Xxx>`; inject Mapper directly instead
- [ ] Service interface does NOT extend `IService<Xxx>`
- [ ] Controller uses `@Autowired` / `@Resource` field injection, injects the Service interface (not implementation class)
- [ ] Similar methods grouped into one Service (no splitting one entity's logic across multiple services)
- [ ] Common utilities use Hutool first, then Apache Commons — NOT `org.springframework.util.*`
- [ ] Wrappers conditional queries use conditional chaining (`.eq(condition, ...)`) with `StrUtil`/`StringUtils`/`CollUtil`/`CollectionUtils` for the boolean check, avoiding separate `if` blocks
- [ ] Remote call (Feign) interfaces placed in `feign/` package, named `XxxClient`
