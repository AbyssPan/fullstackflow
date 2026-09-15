const fs = require('fs')
const path = require('path')
const { KB_DIR } = require('./kb.cjs')

// Files are affected source/dependency entries, never an entire domain by default.
// Existing document facets get a section-level update; small domains keep overview.
function documentTargets (root, domain, files, type) {
  const facets = new Set()
  for (const file of files) {
    if (type === 'backend') {
      if (/(?:Controller|Endpoint|Listener|Job|Task)\.(?:java|kt)$/.test(file)) { facets.add('routes'); facets.add('api') }
      if (/(?:Mapper|Repository|Entity|DTO|Dto|VO|Vo|Model)\.(?:java|kt)$|\.(?:xml|sql)$/.test(file)) facets.add('models')
      if (/Service.*\.(?:java|kt)$/.test(file)) facets.add('flows')
      if (/config|\.(?:ya?ml|properties)$/.test(file)) facets.add('config')
    } else if (type === 'frontend') {
      if (/(?:views|pages|components)\/|\.(?:vue|tsx|jsx|svelte)$/.test(file)) facets.add('pages')
      if (/(?:api|apis|services)\//.test(file)) facets.add('api')
      if (/(?:store|stores)\//.test(file)) facets.add('store')
    } else if (type === 'plugin') {
      if (/commands\//.test(file)) facets.add('commands')
      if (/schemas\//.test(file)) facets.add('schemas')
      facets.add('entry-files')
    }
  }
  if (!facets.size) facets.add('overview')
  const targets = new Set([...facets].map(facet => fs.existsSync(path.join(root, KB_DIR, domain.path, facet + '.md')) ? facet : 'overview'))
  return [...targets].map(facet => ({ path: path.posix.join(domain.path, facet + '.md'),
    sections: [facet === 'overview' ? '与变更相关的职责、业务规则和源码入口' : '与变更相关的条目和契约'],
    sourceFiles: files }))
}
module.exports = { documentTargets }
