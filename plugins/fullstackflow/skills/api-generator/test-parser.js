const fs = require('fs');
const https = require('https');
const SwaggerToJSDoc = require('./scripts/swagger-parser');

const url = 'https://ai-dev.vzan.com/platform/v2/api-docs?group=ai-platform';

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const swaggerDoc = JSON.parse(data);
      console.log('Swagger Doc Title:', swaggerDoc.info && swaggerDoc.info.title);
      console.log('First 3 paths:', Object.keys(swaggerDoc.paths).slice(0, 3));
      console.log('First 3 tags:', swaggerDoc.tags && swaggerDoc.tags.slice(0, 3).map(t => t.name));
      
      const parser = new SwaggerToJSDoc(swaggerDoc);
      
      console.log('--- 测试单个接口: /ai-dev/v1/account/export_consume_detail ---');
      const singleApi = parser.getApiByPath('/ai-dev/v1/account/export_consume_detail', 'post');
      if (singleApi) {
         console.log(parser.generateJSDoc(singleApi));
      } else {
         console.log('未找到接口 /ai-dev/v1/account/export_consume_detail');
      }
      
      console.log('\n--- 测试模块: AI共用模块 (获取前两个接口) ---');
      const apis = parser.getApisByTag('AI共用模块');
      if (apis && apis.length > 0) {
         apis.slice(0, 2).forEach(api => {
            console.log(parser.generateJSDoc(api));
            console.log('---------------------------');
         });
      } else {
         console.log('未找到模块');
      }

    } catch (e) {
      console.error('解析错误:', e);
    }
  });
}).on('error', (e) => {
  console.error(e);
});
