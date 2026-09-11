# <域名> — 后端架构

## 分层结构

| 层 | 关键类/文件 | 职责 |
|----|-------------|------|

## 调用链

```text
Controller/Consumer/Job
  -> Service/Manager
  -> Mapper/Repository/Client
  -> DB/Cache/External Service
```

## 事务与一致性

- 事务边界:
- 幂等策略:
- 并发控制:
- 缓存一致性:

## 外部依赖

| 依赖 | 调用点 | 失败处理 | 说明 |
|------|--------|----------|------|

## 已知风险与注意事项

<TODO>

