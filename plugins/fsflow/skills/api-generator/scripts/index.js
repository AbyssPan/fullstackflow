const path = require('path');
const http = require('http');
const https = require('https');
const SwaggerToJSDoc = require('./swagger-parser');

// 异步获取 URL 数据
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON 解析失败: ' + e.message));
        }
      });
    }).on('error', err => reject(err));
  });
}

(async function main() {
  // ================== 参数解析区 ==================

  // 获取命令行参数
  const args = process.argv.slice(2);
  const targetModules = [];
  const targetPaths = [];
  let sourcePath = '';
  let typescriptMode = false;

  // 处理在 Git Bash 等环境下 / 开头的路径会被转换为本地绝对路径的问题
  function sanitizePath(p) {
    if (p.includes(':/') || p.includes(':\\')) {
      // 假设 Git Bash 转换的路径类似 D:/programfile/Git/v1/api，提取最后的实际接口路径
      // 或者尝试简单的匹配
      const match = p.match(/(\/api\/.*|\/v1\/.*|\/ai-dev\/.*)/);
      if (match) return match[1];
    }
    return p;
  }

  // 解析参数：--module 或 -m 用于指定模块，--path 或 -p 用于指定接口路径
  // 新增 --file 或 -f 指定 api-docs.json 的路径或 URL
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--module' || arg === '-m') && args[i + 1]) {
      targetModules.push(args[i + 1]);
      i++;
    } else if ((arg === '--path' || arg === '-p') && args[i + 1]) {
      targetPaths.push(sanitizePath(args[i + 1]));
      i++;
    } else if ((arg === '--file' || arg === '-f') && args[i + 1]) {
      sourcePath = args[i + 1];
      i++;
    } else if (arg === '--typescript' || arg === '-t') {
      typescriptMode = true;
    } else if (!arg.startsWith('-')) {
      // 如果没有前缀，猜测：
      // 如果以 http:// 或 https:// 开头或者是 .json 结尾，认为是文件路径/URL
      if (arg.startsWith('http://') || arg.startsWith('https://') || arg.endsWith('.json')) {
        sourcePath = arg;
      } else if (arg.startsWith('/') || arg.includes(':') || arg.includes('\\')) {
        // 如果是带有斜杠（处理 windows 路径转换问题）开头认为是接口路径
        targetPaths.push(sanitizePath(arg));
      } else {
        targetModules.push(arg);
      }
    }
  }

  // 打印帮助信息
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`用法:
  node .trae/skills/api-generator/index.js [选项] [参数]

选项:
  -m, --module <模块名>    提取指定模块下的所有接口
  -p, --path <接口路径>    提取指定路径的接口
  -f, --file <文件或URL>   指定 api JSON 文件路径或远程 URL (默认使用本地的 api-docs.json)
  -t, --typescript          输出 TypeScript 语法的接口定义（默认输出 JavaScript + JSDoc）
  -h, --help               显示帮助信息

示例:
  node .trae/skills/api-generator/index.js -m "AI助理模块"
  node .trae/skills/api-generator/index.js -p "/v1/ai_assistant/query_apply_scene"
  node .trae/skills/api-generator/index.js -f "http://example.com/api-docs.json" -m "AI助理模块"
  node .trae/skills/api-generator/index.js -f "./custom.json" -p "/api/test"
  node .trae/skills/api-generator/index.js "直播间知识库模块" "/api/v1/zbKnowledge/select_ref"
  node .trae/skills/api-generator/index.js -t -m "AI助理模块"
  node .trae/skills/api-generator/index.js -t -p "/api/user/detail"
  `);
    process.exit(0);
  }

  console.log('=============== Swagger API 提取工具 ===============\n');

  // ================== 初始化解析器 ==================
  let parser;
  try {
    if (sourcePath.startsWith('http://') || sourcePath.startsWith('https://')) {
      console.log(`正在从 ${sourcePath} 获取 API 文档...`);
      const doc = await fetchJson(sourcePath);
      parser = new SwaggerToJSDoc(doc);
      console.log(`获取成功！\n`);
    } else {
      parser = new SwaggerToJSDoc(sourcePath);
    }
  } catch (err) {
    console.error('初始化 Swagger 解析器失败:', err.message);
    process.exit(1);
  }

  // ================== 执行区 ==================

  // 生成函数：根据模式选择 JSDoc 或 TypeScript
  const generate = typescriptMode ? api => parser.generateTypeScript(api) : api => parser.generateJSDoc(api);

  // 处理模块提取
  if (targetModules.length > 0) {
    targetModules.forEach(moduleName => {
      console.log(`\n========== 【${moduleName}】的所有接口 ==========`);
      const apis = parser.getApisByTag(moduleName);
      if (apis.length === 0) {
        console.log(`未找到属于【${moduleName}】的接口，请检查模块名称。`);
      } else {
        // TypeScript 模式下首次输出 ApiResponse<T> 泛型定义
        if (typescriptMode) {
          console.log('\n' + SwaggerToJSDoc.apiResponseGeneric());
        }
        apis.forEach(api => {
          console.log('\n' + generate(api));
        });
      }
    });
  }

  // 处理具体接口路径提取
  if (targetPaths.length > 0) {
    console.log(`\n========== 指定接口提取 ==========`);
    targetPaths.forEach(apiPath => {
      // 尝试直接匹配或去除/加上 /ai-dev 前缀匹配
      let singleApi = parser.getApiByPath(apiPath, 'post') || parser.getApiByPath(apiPath, 'get');

      if (!singleApi) {
        const altPath = apiPath.startsWith('/ai-dev') ? apiPath.replace('/ai-dev', '') : `/ai-dev${apiPath}`;
        singleApi = parser.getApiByPath(altPath, 'post') || parser.getApiByPath(altPath, 'get');
      }

      if (singleApi) {
        // TypeScript 模式下首次输出 ApiResponse<T> 泛型定义
        if (typescriptMode) {
          console.log(SwaggerToJSDoc.apiResponseGeneric());
        }
        console.log(`\n--- 接口: ${apiPath} ---`);
        console.log(generate(singleApi));
      } else {
        console.log(`\n--- 接口: ${apiPath} ---`);
        console.log(`未在配置的 api json 中找到该接口，请检查路径。`);
      }
    });
  }

  if (targetModules.length === 0 && targetPaths.length === 0) {
    console.log('未传入需要提取的模块或接口参数。');
    console.log('请使用 -h 或 --help 查看用法示例。');
  }
})();
