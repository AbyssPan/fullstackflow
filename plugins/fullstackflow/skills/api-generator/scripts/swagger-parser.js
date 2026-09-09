const fs = require('fs');
const path = require('path');

class SwaggerToJSDoc {
  constructor(source) {
    if (typeof source === 'string') {
      this.swaggerFilePath = path.resolve(source);
      this.doc = JSON.parse(fs.readFileSync(this.swaggerFilePath, 'utf8'));
    } else {
      this.doc = source;
    }
    this.defs = {};
    // TypeScript 模式下已输出的 interface 缓存，避免重复生成同名 interface
    this._tsEmittedInterfaces = {};
  }

  // 辅助方法：解析 ref 路径，获取真实的名称
  getRefName(ref) {
    if (!ref) return null;
    return ref.replace('#/definitions/', '').replace('#/components/schemas/', '');
  }

  // 递归解析 definitions 依赖
  resolveDefinition(refName) {
    if (!refName || this.defs[refName]) return;

    const defs = this.doc.definitions || (this.doc.components && this.doc.components.schemas) || {};
    const def = defs[refName];
    if (!def) return;

    this.defs[refName] = def;

    if (def.properties) {
      for (const [k, v] of Object.entries(def.properties)) {
        if (v.$ref) {
          this.resolveDefinition(this.getRefName(v.$ref));
        } else if (v.items && v.items.$ref) {
          this.resolveDefinition(this.getRefName(v.items.$ref));
        }
      }
    }
  }

  // 将 definition 展开为内联对象类型字符串
  formatDefinitionToJSDoc(refName, indentLevel = 1, _visitingRefs = new Set()) {
    // 防止循环引用导致无限递归
    if (_visitingRefs.has(refName)) return 'object';
    _visitingRefs.add(refName);

    const indent = ' '.repeat(indentLevel * 2);
    const defs = this.doc.definitions || (this.doc.components && this.doc.components.schemas) || {};

    // 过滤掉 ApiResponse 包装层，直接取内部的 data 类型
    if (refName && refName.startsWith('ApiResponse')) {
      const def = defs[refName];
      if (def && def.properties && def.properties.data) {
        let dataType = 'any';
        if (def.properties.data.$ref) {
          dataType = this.formatDefinitionToJSDoc(this.getRefName(def.properties.data.$ref), indentLevel + 1, _visitingRefs);
        } else if (def.properties.data.type === 'array' && def.properties.data.items && def.properties.data.items.$ref) {
           dataType = `${this.formatDefinitionToJSDoc(this.getRefName(def.properties.data.items.$ref), indentLevel + 1, _visitingRefs)}[]`;
        } else {
           dataType = def.properties.data.type || 'any';
        }

        return `{\n *  code: number,\n *  data: ${dataType},\n *  msg: string\n * }`;
      }
      return '{ code: number, data: any, msg: string }';
    }

    const def = defs[refName];
    if (!def || !def.properties) return 'object';

    const props = [];
    for (const [key, prop] of Object.entries(def.properties)) {
      let typeStr = this.formatType(prop, indentLevel, _visitingRefs);
      let descStr = prop.description ? ` // ${prop.description.replace(/\n/g, ' ')}` : '';
      props.push(`${indent}${key}: ${typeStr},${descStr}`);
    }

    if (props.length === 0) return 'object';
    const closeIndent = ' '.repeat((indentLevel - 1) * 2);
    return `{\n *  ${props.join('\n *  ')}\n *  ${closeIndent}}`;
  }

  // 将类型转换为 JSDoc 格式的字符串
  formatType(schema, indentLevel = 1, _visitingRefs = new Set()) {
    if (!schema) return 'any';

    if (schema.$ref) {
      const refName = this.getRefName(schema.$ref);
      return this.formatDefinitionToJSDoc(refName, indentLevel, _visitingRefs);
    }

    if (schema.type === 'array') {
      if (schema.items && schema.items.$ref) {
        const refName = this.getRefName(schema.items.$ref);
        return `${this.formatDefinitionToJSDoc(refName, indentLevel, _visitingRefs)}[]`;
      }
      return `${schema.items ? schema.items.type : 'any'}[]`;
    }

    if (schema.type === 'integer' || schema.type === 'number') return 'number';
    if (schema.type === 'string') return 'string';
    if (schema.type === 'boolean') return 'boolean';

    return 'object';
  }

  // 获取某个 Tag 下的所有接口
  getApisByTag(tagName) {
    const results = [];
    for (const [apiPath, methods] of Object.entries(this.doc.paths)) {
      for (const [method, details] of Object.entries(methods)) {
        if (details.tags && details.tags.includes(tagName)) {
          results.push(this.parseApi(apiPath, method, details));
        }
      }
    }
    return results;
  }

  // 获取指定的单个接口
  getApiByPath(apiPath, method = 'post') {
    const methods = this.doc.paths[apiPath];
    if (!methods || !methods[method]) return null;
    return this.parseApi(apiPath, method, methods[method]);
  }

  // 解析单个接口信息
  parseApi(apiPath, method, details) {
    let reqRef = null;
    let parameters = details.parameters || [];

    // Swagger v2
    if (parameters && parameters[0] && parameters[0].schema) {
      reqRef = this.getRefName(parameters[0].schema.$ref);
      this.resolveDefinition(reqRef);
    } 
    // OpenAPI v3 (Swagger v3)
    else if (details.requestBody && details.requestBody.content && details.requestBody.content['application/json'] && details.requestBody.content['application/json'].schema) {
      reqRef = this.getRefName(details.requestBody.content['application/json'].schema.$ref);
      this.resolveDefinition(reqRef);
      // Mock parameter to maintain compatibility with downstream generateJSDoc
      parameters.push({
        in: 'body',
        name: 'body',
        required: details.requestBody.required || false,
        schema: details.requestBody.content['application/json'].schema
      });
    }

    let resRef = null;
    // Swagger v2
    if (details.responses && details.responses['200'] && details.responses['200'].schema) {
      resRef = this.getRefName(details.responses['200'].schema.$ref);
      this.resolveDefinition(resRef);
    } 
    // OpenAPI v3
    else if (details.responses && details.responses['200'] && details.responses['200'].content && details.responses['200'].content['application/json'] && details.responses['200'].content['application/json'].schema) {
      resRef = this.getRefName(details.responses['200'].content['application/json'].schema.$ref);
      this.resolveDefinition(resRef);
    }

    return {
      path: apiPath,
      method: method,
      summary: details.summary || '',
      operationId: details.operationId || '',
      parameters: parameters,
      reqRef: reqRef,
      resRef: resRef
    };
  }

  // 生成 JSDoc 注释块
  generateJSDoc(apiInfo) {
    const lines = [];
    lines.push(`/**`);
    lines.push(` * ${apiInfo.summary}`);

    // 解析请求参数
    if (apiInfo.parameters && apiInfo.parameters.length > 0) {
      const isBody = apiInfo.parameters.some(p => p.in === 'body');
      const paramName = isBody ? 'data' : 'params';
      lines.push(` * @param {object} ${paramName}`);

      if (apiInfo.reqRef && this.defs[apiInfo.reqRef]) {
        const def = this.defs[apiInfo.reqRef];
        if (def.properties) {
          for (const [key, prop] of Object.entries(def.properties)) {
            const isRequired = def.required && def.required.includes(key);
            const propName = isRequired ? `${paramName}.${key}` : `[${paramName}.${key}]`;
            const propType = this.formatType(prop).replace(/\n \*/g, '').replace(/\n/g, ' ');
            const desc = prop.description ? ` - ${prop.description.replace(/\n/g, ' ')}` : '';
            lines.push(` * @param {${propType}} ${propName}${desc}`);
          }
        }
      } else {
        // 处理非 body 的 Query 参数
        for (const p of apiInfo.parameters) {
          if (p.in === 'query' || p.in === 'path') {
            const isRequired = p.required;
            const propName = isRequired ? `${paramName}.${p.name}` : `[${paramName}.${p.name}]`;
            let pType = p.type || (p.schema && p.schema.type) || 'any';
            if (pType === 'integer') pType = 'number';
            const desc = p.description ? ` - ${p.description.replace(/\n/g, ' ')}` : '';
            lines.push(` * @param {${pType}} ${propName}${desc}`);
          }
        }
      }
    }

    // 解析返回值
    if (apiInfo.resRef) {
      const returnTypeStr = this.formatDefinitionToJSDoc(apiInfo.resRef);
      // 处理多行缩进对齐
      let formattedReturn = returnTypeStr.replace(/\n \*/g, '\n *');

      lines.push(` * @returns {Promise<${formattedReturn}>}`);
    } else {
      lines.push(` * @returns {Promise<any>}`);
    }

    lines.push(` */`);

    // 生成对应的请求函数代码
    const cleanedName = apiInfo.operationId
      ? apiInfo.operationId.replace(/_(\d+)$/, '').replace(/Using(POST|GET|PUT|DELETE)$/i, '')
      : 'apiMethod';
    const methodName = cleanedName;
    const paramStr = apiInfo.parameters.some(p => p.in === 'body') ? 'data' : 'params';
    lines.push(`export const ${methodName} = ${paramStr} => ${apiInfo.method}(\`\${ai_url}${apiInfo.path}\`, ${paramStr});`);

    return lines.join('\n');
  }
  // ==================== TypeScript 生成方法 ====================

  /**
   * 将字符串转换为 PascalCase
   * @param {string} str - 输入字符串，如 "selectRef" 或 "zbKnowledge"
   * @returns {string} PascalCase 字符串，如 "SelectRef" 或 "ZbKnowledge"
   */
  toPascalCase(str) {
    if (!str) return '';
    // 先按常见分隔符拆分，再逐词首字母大写
    return str
      .replace(/[-_./]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  /**
   * 从 operationId 或接口路径派生 interface 名称
   * @param {object} apiInfo - parseApi 返回的接口信息
   * @param {string} suffix - 后缀，如 "Request" 或 "Response"
   * @returns {string} interface 名称，如 "SelectRefRequest"
   */
  deriveInterfaceName(apiInfo, suffix) {
    const cleanedName = apiInfo.operationId
      ? apiInfo.operationId.replace(/_(\d+)$/, '').replace(/Using(POST|GET|PUT|DELETE)$/i, '')
      : '';
    if (cleanedName) {
      return this.toPascalCase(cleanedName) + suffix;
    }
    // 从路径派生：/api/v1/zbKnowledge/select_ref → ZbKnowledgeSelectRef
    const segments = apiInfo.path
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean);
    return this.toPascalCase(segments.join(' ')) + suffix;
  }

  /**
   * 将 Swagger schema 转为 TypeScript 类型字符串
   * @param {object} schema - Swagger schema 对象
   * @returns {string} TS 类型字符串，如 "number"、"string[]"、"User"
   */
  formatTypeToTS(schema) {
    if (!schema) return 'unknown';

    if (schema.$ref) {
      return this.getRefName(schema.$ref);
    }

    if (schema.type === 'array') {
      if (schema.items && schema.items.$ref) {
        return `${this.getRefName(schema.items.$ref)}[]`;
      }
      if (schema.items && schema.items.type) {
        const itemType = schema.items.type === 'integer' ? 'number' : schema.items.type;
        return `${itemType}[]`;
      }
      return 'unknown[]';
    }

    if (schema.type === 'integer' || schema.type === 'number') return 'number';
    if (schema.type === 'string') return 'string';
    if (schema.type === 'boolean') return 'boolean';

    return 'unknown';
  }

  /**
   * 将 definition 格式化为 TypeScript interface 字符串，并递归收集嵌套引用的 interface 定义
   * @param {string} refName - definition 名称
   * @param {string} interfaceName - interface 名称
   * @param {string[]} [collector] - 递归收集嵌套 interface 定义的数组
   * @returns {string} 当前 interface 的定义字符串，嵌套的定义通过 collector 返回
   */
  formatDefinitionToTS(refName, interfaceName, collector) {
    const def = this.defs[refName];
    if (!def || !def.properties) return '';

    // 标记已输出，避免重复
    this._tsEmittedInterfaces[refName] = interfaceName;
    if (!collector) collector = [];

    const requiredFields = def.required || [];
    const lines = [];

    // interface 上的 JSDoc 注释
    if (def.description) {
      lines.push(`/** ${def.description.replace(/\n/g, ' ')} */`);
    }
    lines.push(`interface ${interfaceName} {`);

    for (const [key, prop] of Object.entries(def.properties)) {
      const isRequired = requiredFields.includes(key);
      const optionalMark = isRequired ? '' : '?';
      let tsType = this.formatTypeToTS(prop);

      // 递归处理 $ref 引用，生成嵌套 interface 定义
      if (prop.$ref) {
        const nestedRef = this.getRefName(prop.$ref);
        if (!this._tsEmittedInterfaces[nestedRef]) {
          const nestedDef = this.formatDefinitionToTS(nestedRef, nestedRef, collector);
          if (nestedDef) collector.push(nestedDef);
        }
        tsType = this._tsEmittedInterfaces[nestedRef];
      } else if (prop.type === 'array' && prop.items && prop.items.$ref) {
        const nestedRef = this.getRefName(prop.items.$ref);
        if (!this._tsEmittedInterfaces[nestedRef]) {
          const nestedDef = this.formatDefinitionToTS(nestedRef, nestedRef, collector);
          if (nestedDef) collector.push(nestedDef);
        }
        tsType = `${this._tsEmittedInterfaces[nestedRef]}[]`;
      }

      const desc = prop.description ? ` /** ${prop.description.replace(/\n/g, ' ')} */` : '';
      lines.push(`  ${key}${optionalMark}: ${tsType};${desc}`);
    }

    lines.push('}');
    return lines.join('\n');
  }

  /**
   * 处理 ApiResponse 包装层，提取内部 data 类型并生成 Response interface
   * @param {string} resRef - 响应 definition 名称（通常是 ApiResponse 开头）
   * @param {object} apiInfo - parseApi 返回的接口信息，用于派生 interface 名称
   * @returns {{ responseInterface: string, returnTypeName: string }} responseInterface 是 interface 定义（首次生成），returnTypeName 是返回类型名
   */
  formatResponseToTS(resRef, apiInfo) {
    const defs = this.doc.definitions || (this.doc.components && this.doc.components.schemas) || {};
    const def = defs[resRef];
    if (!def || !def.properties || !def.properties.data) {
      return { responseInterface: '', returnTypeName: 'unknown' };
    }

    const dataProp = def.properties.data;
    let dataTypeName;
    let responseInterface = '';
    let nestedInterfaces = null;

    if (dataProp.$ref) {
      // data 引用了另一个 definition，用 operationId 派生英文化 interface 名
      const dataRefName = this.getRefName(dataProp.$ref);
      const derivedName = this.deriveInterfaceName(apiInfo, 'Response');
      // 如果该 interface 已输出过，不再重复生成
      if (!this._tsEmittedInterfaces[dataRefName]) {
        const collector = [];
        responseInterface = this.formatDefinitionToTS(dataRefName, derivedName, collector);
        nestedInterfaces = collector;
        this._tsEmittedInterfaces[dataRefName] = derivedName;
      }
      dataTypeName = this._tsEmittedInterfaces[dataRefName];
    } else if (dataProp.type === 'array' && dataProp.items && dataProp.items.$ref) {
      // data 是引用类型的数组
      const itemRefName = this.getRefName(dataProp.items.$ref);
      const derivedName = this.deriveInterfaceName(apiInfo, 'Response');
      if (!this._tsEmittedInterfaces[itemRefName]) {
        const collector = [];
        responseInterface = this.formatDefinitionToTS(itemRefName, derivedName, collector);
        nestedInterfaces = collector;
        this._tsEmittedInterfaces[itemRefName] = derivedName;
      }
      dataTypeName = `${this._tsEmittedInterfaces[itemRefName]}[]`;
    } else if (dataProp.type === 'array' && dataProp.items) {
      // data 是基本类型的数组
      const itemType = dataProp.items.type === 'integer' ? 'number' : (dataProp.items.type || 'unknown');
      dataTypeName = `${itemType}[]`;
    } else {
      dataTypeName = dataProp.type === 'integer' ? 'number' : (dataProp.type || 'unknown');
    }

    return {
      nestedInterfaces,
      responseInterface,
      returnTypeName: `ApiResponse<${dataTypeName}>`
    };
  }

  /**
   * 生成 TypeScript 格式的接口代码（interface 定义 + export const 请求函数）
   * @param {object} apiInfo - parseApi 返回的接口信息
   * @returns {string} 完整的 TS 代码块
   */
  generateTypeScript(apiInfo) {
    const lines = [];
    const interfaces = [];

    // 清理 operationId 作为方法名
    const cleanedName = apiInfo.operationId
      ? apiInfo.operationId.replace(/_(\d+)$/, '').replace(/Using(POST|GET|PUT|DELETE)$/i, '')
      : 'apiMethod';
    const isBody = apiInfo.parameters && apiInfo.parameters.some(p => p.in === 'body');
    const paramStr = isBody ? 'data' : 'params';
    const paramName = isBody ? 'data' : 'params';

    // 生成 Request interface（仅 body 参数且有 definition）
    let paramTypeName = 'unknown';
    if (isBody && apiInfo.reqRef && this.defs[apiInfo.reqRef] && this.defs[apiInfo.reqRef].properties) {
      const reqCollector = [];
      const reqInterfaceName = this.deriveInterfaceName(apiInfo, 'Request');
      const reqInterface = this.formatDefinitionToTS(apiInfo.reqRef, reqInterfaceName, reqCollector);
      // 嵌套 interface 放在前面
      reqCollector.forEach(i => interfaces.push(i));
      if (reqInterface) interfaces.push(reqInterface);
      paramTypeName = reqInterfaceName;
    } else if (!isBody && apiInfo.parameters && apiInfo.parameters.length > 0) {
      // Query/Path 参数用内联类型
      const queryFields = apiInfo.parameters
        .filter(p => p.in === 'query' || p.in === 'path')
        .map(p => {
          const optional = p.required ? '' : '?';
          const pType = (p.type || 'unknown') === 'integer' ? 'number' : (p.type || 'unknown');
          const desc = p.description ? ` /** ${p.description.replace(/\n/g, ' ')} */` : '';
          return `  ${p.name}${optional}: ${pType};${desc}`;
        });
      if (queryFields.length > 0) {
        paramTypeName = `{ ${queryFields.join(' ')} }`;
      }
    }

    // 生成 Response interface 和返回类型
    let returnType = 'Promise<unknown>';
    if (apiInfo.resRef) {
      const { nestedInterfaces, responseInterface, returnTypeName } = this.formatResponseToTS(apiInfo.resRef, apiInfo);
      // 嵌套 interface 放在前面
      if (nestedInterfaces) nestedInterfaces.forEach(i => interfaces.push(i));
      if (responseInterface) interfaces.push(responseInterface);
      returnType = `Promise<${returnTypeName}>`;
    }

    // 输出 interface 定义
    if (interfaces.length > 0) {
      lines.push(interfaces.join('\n\n'));
      lines.push('');
    }

    // 输出函数定义
    lines.push(`/** ${apiInfo.summary} */`);
    lines.push(`export const ${cleanedName} = (${paramStr}: ${paramTypeName}): ${returnType} =>`);
    lines.push(`  ${apiInfo.method}(\`\${ai_url}${apiInfo.path}\`, ${paramStr});`);

    return lines.join('\n');
  }

  /**
   * 生成 ApiResponse<T> 泛型定义（仅 TypeScript 模式使用）
   * @returns {string} ApiResponse<T> 的 interface 定义
   */
  static apiResponseGeneric() {
    return `/** API 通用响应结构 */\ninterface ApiResponse<T> {\n  code: number;\n  data: T;\n  msg: string;\n}`;
  }
}

module.exports = SwaggerToJSDoc;
