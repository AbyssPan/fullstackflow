#!/usr/bin/env node
/**
 * 跨平台断言辅助。
 *
 * 仅用于测试侧，不改变产品行为。抽出的原因：产品输出中存在两类“平台差异”输入——
 * 1. 路径分隔符：同一个路径在 Windows 是 `a\b`，在 POSIX 是 `a/b`，直接
 *    `endsWith('a/b')` / `includes('a/b')` 断言会只在某个平台成立；
 * 2. 换行符：`git` 与子进程输出在 Windows 带 `\r`，按行解析出的路径会尾随回车，
 *    拼成文件路径后表现为 ENOENT。
 *
 * 断言前统一归一，测试才真正在验证逻辑而不是验证操作系统。
 */

/** 路径分隔符统一为 POSIX。 */
function toPosix(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/')
}

/** 换行统一为 LF，去掉 CRLF 的回车。 */
function stripEol(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n')
}

/** 子进程输出归一：换行与路径分隔符同时统一。 */
function normalizeOutput(value) {
  return toPosix(stripEol(value))
}

/**
 * Windows 文件名不允许包含换行等控制字符，相关夹具只能有条件执行。
 * 用法：POSIX 下创建并断言，Windows 下打印 SKIP 保留可追溯性。
 */
const supportsNewlineInFileName = process.platform !== 'win32'

module.exports = { toPosix, stripEol, normalizeOutput, supportsNewlineInFileName }
