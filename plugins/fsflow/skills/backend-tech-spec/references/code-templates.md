# 团队规范代码模板

本模板与 [team-standard.md](team-standard.md) 的规则对齐，提供完整可运行的示例。注意以下关键点：

- Controller / Service 一律 `@Autowired` 字段注入，注入 Service 接口而非实现类；
- Service 接口与实现**不继承** MyBatis-Plus 的 `IService` / `ServiceImpl`，直接注入 `XxxMapper`；
- 异步任务必须使用集中管理的线程池（`taskExecutor`），`CompletableFuture.runAsync(...)` 必须显式传入 executor；
- 相似写操作（save/update/delete）合并为一个 `/operate` 端点，通过 `operateType` 区分。

## Complete Controller Example

```java
package com.example.controller;

import com.example.common.Result;
import com.example.common.PageVO;
import com.example.dto.UserQueryDTO;
import com.example.dto.UserOperateDTO;
import com.example.vo.UserVO;
import com.example.service.UserService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.validation.Valid;

/**
 * 用户管理控制器
 * <p>
 * All user-management endpoints are consolidated into this single Controller.
 * Similar write operations (save/update/delete) use ONE /operate endpoint
 * with an operateType field to distinguish the action.
 */
@RestController
@RequestMapping("/v1/user-management")
public class UserController {

    @Autowired
    private UserService userService;  // inject interface, not impl

    /**
     * 查询用户列表（多参数 → POST）
     */
    @PostMapping("/list")
    public Result<PageVO<UserVO>> list(@RequestBody @Valid UserQueryDTO query) {
        return Result.success(userService.pageQuery(query));
    }

    /**
     * 查询用户详情（少参数 → GET）
     */
    @GetMapping("/detail")
    public Result<UserVO> detail(@RequestParam Long id, @RequestParam Integer zbId) {
        return Result.success(userService.getDetail(id, zbId));
    }

    /**
     * 用户操作（新增/修改/删除 → 统一入口，通过 operateType 区分）
     */
    @PostMapping("/operate")
    public Result<Void> operate(@RequestBody @Valid UserOperateDTO dto) {
        userService.operate(dto);
        return Result.success();
    }

    /**
     * 导出数据
     */
    @PostMapping("/export")
    public Result<String> export(@RequestBody @Valid UserQueryDTO query) {
        String downloadUrl = userService.export(query);
        return Result.success(downloadUrl);
    }
}
```

## Service Interface Example

```java
package com.example.service;

import com.example.common.PageVO;
import com.example.dto.UserOperateDTO;
import com.example.dto.UserQueryDTO;
import com.example.vo.UserVO;

/**
 * 用户服务接口
 * <p>
 * All user-related operations are grouped into this single service interface.
 * Does NOT extend MyBatis-Plus IService — plain interface only.
 */
public interface UserService {

    /** 分页查询 */
    PageVO<UserVO> pageQuery(UserQueryDTO query);

    /** 查询详情 */
    UserVO getDetail(Long id, Integer zbId);

    /** 统一操作（新增/修改/删除，通过 dto.operateType 区分） */
    void operate(UserOperateDTO dto);

    /** 导出 */
    String export(UserQueryDTO query);
}
```

## Complete Service Implementation Example (with async)

```java
package com.example.service.impl;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.example.common.PageVO;
import com.example.dto.UserOperateDTO;
import com.example.dto.UserQueryDTO;
import com.example.entity.User;
import com.example.mapper.UserMapper;
import com.example.service.UserService;
import com.example.vo.UserVO;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

@Slf4j
@Service
public class UserServiceImpl implements UserService {

    @Autowired
    private UserMapper userMapper;

    @Autowired
    private AuditLogService auditLogService;

    @Autowired
    private ThreadPoolTaskExecutor taskExecutor;  // centralized pool from AsyncConfig

    @Override
    public PageVO<UserVO> pageQuery(UserQueryDTO query) {
        // Use Wrappers for query construction - NO raw SQL
        Page<User> page = userMapper.selectPage(
                new Page<>(query.getPageNum(), query.getPageSize()),
                Wrappers.<User>lambdaQuery()
                        .eq(User::getZbId, query.getZbId())
                        .eq(query.getStatus() != null, User::getStatus, query.getStatus())
                        .like(query.getUserName() != null, User::getUserName, query.getUserName())
                        .orderByDesc(User::getCreateTime));

        // Convert to VO via shared helper - no duplicated mapping
        List<UserVO> voList = page.getRecords().stream()
                .map(this::toVO)
                .collect(Collectors.toList());

        // Async: log query operation (non-critical, on managed executor)
        CompletableFuture.runAsync(() ->
                auditLogService.record("user_query", query.getZbId(), query.getUserId()), taskExecutor);

        return new PageVO<>(voList, page.getTotal());
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
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

    private void doSave(UserOperateDTO dto) {
        User user = new User();
        user.setUserName(dto.getUserName());
        user.setStatus(dto.getStatus());
        userMapper.insert(user);

        // Async: send notification (non-critical, on managed executor)
        CompletableFuture.runAsync(() -> notifyNewUser(user), taskExecutor);
    }

    private void doUpdate(UserOperateDTO dto) {
        User user = new User();
        user.setId(dto.getId());
        user.setUserName(dto.getUserName());
        user.setStatus(dto.getStatus());
        userMapper.updateById(user);
    }

    private void doDelete(UserOperateDTO dto) {
        userMapper.deleteById(dto.getId());
    }

    /** Entity → VO 共享转换（DRY） */
    private UserVO toVO(User user) {
        UserVO vo = new UserVO();
        vo.setId(user.getId());
        vo.setUserName(user.getUserName());
        vo.setZbId(user.getZbId());
        vo.setStatus(user.getStatus());
        vo.setCreateTime(user.getCreateTime());
        return vo;
    }
}
```

## Complete Entity Example

```java
package com.example.entity.po;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.util.Date;

/**
 * 用户信息实体
 */
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
```

## Complete DTO Example

```java
package com.example.entity.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import javax.validation.constraints.NotNull;

/**
 * 用户查询请求
 */
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
```

## Operation DTO Example (operateType pattern)

```java
package com.example.entity.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import javax.validation.constraints.NotNull;

/**
 * 用户操作请求（新增/修改/删除统一入口）
 */
@ApiModel(value = "UserOperateDTO", description = "用户操作请求（新增/修改/删除统一入口）")
@Data
public class UserOperateDTO {

    @NotNull(message = "操作类型不能为空")
    @ApiModelProperty(value = "操作类型: save-新增 update-修改 delete-删除", required = true, example = "save")
    private String operateType;

    @ApiModelProperty(value = "用户ID（修改/删除时必填）", example = "1")
    private Long id;

    @NotNull(message = "商户ID不能为空")
    @ApiModelProperty(value = "商户ID", required = true, example = "1001")
    private Integer zbId;

    @ApiModelProperty(value = "用户名", example = "张三")
    private String userName;

    @ApiModelProperty(value = "状态: 1-启用 0-禁用", example = "1")
    private Integer status;
}
```

## Complete VO Example

```java
package com.example.entity.vo;

import com.fasterxml.jackson.annotation.JsonFormat;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import java.util.Date;

/**
 * 用户信息视图
 */
@ApiModel(value = "UserVO", description = "用户信息视图")
@Data
public class UserVO {

    @ApiModelProperty(value = "用户ID", example = "1")
    private Long id;

    @ApiModelProperty(value = "用户名", example = "张三")
    private String userName;

    @ApiModelProperty(value = "商户ID", example = "1001")
    private Integer zbId;

    @ApiModelProperty(value = "状态: 1-启用 0-禁用", example = "1")
    private Integer status;

    @ApiModelProperty(value = "创建时间", example = "2024-01-01 12:00:00")
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date createTime;
}
```

## Nacos Config with @RefreshScope

```java
package com.example.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.stereotype.Component;

/**
 * 业务配置（Nacos 动态刷新）
 */
@Data
@Component
@RefreshScope
@ConfigurationProperties(prefix = "app.business")
public class BusinessConfig {

    /** 功能开关 */
    private Boolean enabled = false;

    /** 最大导出数量 */
    private Integer maxExportCount = 5000;

    /** 超时时间(秒) */
    private Integer timeoutSeconds = 30;
}
```

## Thread Pool Configuration

```java
package com.example.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.ThreadPoolExecutor;

@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean("taskExecutor")
    public ThreadPoolTaskExecutor taskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(5);
        executor.setMaxPoolSize(20);
        executor.setQueueCapacity(200);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("async-task-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);
        executor.initialize();
        return executor;
    }
}
```

## SQL Table Example

```sql
CREATE TABLE `user_info` (
    `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
    `user_name` VARCHAR(64) NOT NULL COMMENT '用户名',
    `zb_id` INT NOT NULL COMMENT '商户ID',
    `user_id` BIGINT DEFAULT NULL COMMENT '用户ID',
    `status` TINYINT DEFAULT 1 COMMENT '状态: 1-启用 0-禁用',
    `deleted_flag` TINYINT DEFAULT 0 COMMENT '删除标记: 0-未删除 1-已删除',
    `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `update_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (`id`),
    INDEX `idx_zb_id` (`zb_id`),
    INDEX `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户信息表';
```
