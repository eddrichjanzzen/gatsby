const _ = require(`lodash`)
const { getOptions } = require(`loader-utils`)
const grayMatter = require(`gray-matter`)
const path = require(`path`)
const unified = require(`unified`)
const babel = require(`@babel/core`)
const { createRequireFromPath, slash } = require(`gatsby-core-utils`)

const {
  isImport,
  isExport,
  isExportDefault,
  BLOCKS_REGEX,
  EMPTY_NEWLINE,
} = require(`@mdx-js/mdx/util`)

// Some packages are required implicitly from @mdx-js/mdx (not listed in package.json).
// To support yarn PnP, we need them to be required from their direct parent.
const requireFromMDX = createRequireFromPath(require.resolve(`@mdx-js/mdx`))

const toMDAST = requireFromMDX(`remark-parse`)
const squeeze = requireFromMDX(`remark-squeeze-paragraphs`)
const debug = require(`debug`)(`gatsby-plugin-mdx:mdx-loader`)
const debugMore = require(`debug`)(`gatsby-plugin-mdx-info:mdx-loader`)

const genMdx = require(`../utils/gen-mdx`)
const withDefaultOptions = require(`../utils/default-options`)
const {
  createMdxNodeExtraBabel,
  createMdxNodeLessBabel,
} = require(`../utils/create-mdx-node`)
const { createFileNode } = require(`../utils/create-fake-file-node`)

const DEFAULT_OPTIONS = {
  footnotes: true,
  remarkPlugins: [],
  rehypePlugins: [],
  compilers: [],
  blocks: [BLOCKS_REGEX],
}

/**
 * TODO: Find a way to PR all of this code that was lifted
 * from @mdx-js/mdx back into mdx with the modifications. We
 * don't want to maintain subtly different parsing code if we
 * can avoid it.
 */
const hasDefaultExport = (str, options) => {
  let hasDefaultExportBool = false

  function getDefaultExportBlock(subvalue) {
    const isDefault = isExportDefault(subvalue)
    hasDefaultExportBool = hasDefaultExportBool || isDefault
    return isDefault
  }
  const tokenizeEsSyntax = (eat, value) => {
    const index = value.indexOf(EMPTY_NEWLINE)
    const subvalue = value.slice(0, index)

    if (isExport(subvalue) || isImport(subvalue)) {
      return eat(subvalue)({
        type: isExport(subvalue) ? `export` : `import`,
        default: getDefaultExportBlock(subvalue),
        value: subvalue,
      })
    }

    return undefined
  }

  tokenizeEsSyntax.locator = value =>
    isExport(value) || isImport(value) ? -1 : 1

  function esSyntax() {
    // eslint-disable-next-line @babel/no-invalid-this
    const Parser = this.Parser
    const tokenizers = Parser.prototype.blockTokenizers
    const methods = Parser.prototype.blockMethods

    tokenizers.esSyntax = tokenizeEsSyntax

    methods.splice(methods.indexOf(`paragraph`), 0, `esSyntax`)
  }

  const { content } = grayMatter(str, options)
  unified()
    .use(toMDAST, options)
    .use(esSyntax)
    .use(squeeze, options)
    .parse(content)
    .toString()

  return hasDefaultExportBool
}

module.exports = async function mdxLoader(content) {
  const callback = this.async()

  const {
    isolateMDXComponent,
    getNode: rawGetNode,
    getNodes,
    getNodesByType,
    reporter,
    cache,
    pathPrefix,
    pluginOptions,
    ...helpers
  } = getOptions(this)

  const resourceQuery = this.resourceQuery || ``
  if (isolateMDXComponent && !resourceQuery.includes(`type=component`)) {
    const { data } = grayMatter(content, pluginOptions)

    const requestPath = slash(
      `/${path.relative(this.rootContext, this.resourcePath)}?type=component`
    )

    return callback(
      null,
      `import MDXContent from "${requestPath}";
export default MDXContent;
export * from "${requestPath}"

export const _frontmatter = ${JSON.stringify(data)};`
    )
  }

  const options = withDefaultOptions(pluginOptions)

  let fileNode = getNodes().find(
    node =>
      node.internal.type === `File` &&
      node.absolutePath === slash(this.resourcePath)
  )
  let isFakeFileNode = false
  if (!fileNode) {
    fileNode = await createFileNode(
      this.resourcePath,
      pth => `fakeFileNodeMDX${pth}`
    )
    isFakeFileNode = true
  }

  const source = fileNode && fileNode.sourceInstanceName

  let mdxNode
  try {
    // This fakeNodeIdMDXFileABugIfYouSeeThis node object attempts to break the chicken-egg problem,
    // where parsing mdx allows for custom plugins, which can receive a mdx node.
    if (options.lessBabel) {
      ;({ mdxNode } = await createMdxNodeLessBabel({
        id: `fakeNodeIdMDXFileABugIfYouSeeThis`,
        node: fileNode,
        content,
        options,
        getNodesByType,
        getNode: rawGetNode,
      }))
    } else {
      mdxNode = await createMdxNodeExtraBabel({
        id: `fakeNodeIdMDXFileABugIfYouSeeThis`,
        node: fileNode,
        content,
        options,
      })
    }
  } catch (e) {
    return callback(e)
  }

  // get the default layout for the file source group, or if it doesn't
  // exist, the overall default layout
  const defaultLayout = _.get(
    options.defaultLayouts,
    source,
    _.get(options.defaultLayouts, `default`)
  )

  let code = content
  // after running mdx, the code *always* has a default export, so this
  // check needs to happen first.
  if (!hasDefaultExport(content, options) && !!defaultLayout) {
    debug(`inserting default layout`, defaultLayout)
    const { content: contentWithoutFrontmatter, matter } = grayMatter(
      content,
      options
    )

    code = `${matter ? matter : ``}

import DefaultLayout from "${slash(defaultLayout)}"

export default DefaultLayout

${contentWithoutFrontmatter}`
  }

  const getNode = id => {
    if (isFakeFileNode && id === fileNode.id) {
      return fileNode
    } else {
      return rawGetNode(id)
    }
  }

  /**
   * Support gatsby-remark parser plugins
   */
  for (const plugin of options.gatsbyRemarkPlugins) {
    debug(`requiring`, plugin.resolve)
    const requiredPlugin = plugin.module
    debug(`required`, plugin)
    if (_.isFunction(requiredPlugin.setParserPlugins)) {
      for (const parserPlugin of requiredPlugin.setParserPlugins(
        plugin.pluginOptions || {}
      )) {
        if (_.isArray(parserPlugin)) {
          const [parser, parserPluginOptions] = parserPlugin
          debug(`adding remarkPlugin with options`, plugin, parserPluginOptions)
          options.remarkPlugins.push([parser, parserPluginOptions])
        } else {
          debug(`adding remarkPlugin`, plugin)
          options.remarkPlugins.push(parserPlugin)
        }
      }
    }
  }

  const { rawMDXOutput } = await genMdx({
    ...helpers,
    isLoader: true,
    options,
    node: { ...mdxNode, rawBody: code },
    getNode,
    getNodes,
    getNodesByType,
    reporter,
    cache,
    pathPrefix,
    isolateMDXComponent,
  })

  try {
    const result = babel.transform(rawMDXOutput, {
      configFile: false,
      plugins: [
        requireFromMDX(`@babel/plugin-syntax-jsx`),
        requireFromMDX(`@babel/plugin-syntax-object-rest-spread`),
        require(`../utils/babel-plugin-html-attr-to-jsx-attr`),
      ],
    })
    debugMore(`transformed code`, result.code)
    return callback(
      null,
      `import * as React from 'react'
  ${result.code}
      `
    )
  } catch (e) {
    return callback(e)
  }
}
