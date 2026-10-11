'use strict';

/**
 * @typedef {import('./types').XastNode} XastNode
 * @typedef {import('./types').XastInstruction} XastInstruction
 * @typedef {import('./types').XastDoctype} XastDoctype
 * @typedef {import('./types').XastComment} XastComment
 * @typedef {import('./types').XastRoot} XastRoot
 * @typedef {import('./types').XastElement} XastElement
 * @typedef {import('./types').XastCdata} XastCdata
 * @typedef {import('./types').XastText} XastText
 * @typedef {import('./types').XastParent} XastParent
 */

// @ts-ignore sax will be replaced with something else later
const SAX = require('@trysound/sax');
const JSAPI = require('./svgo/jsAPI.js');
const { textElems } = require('../plugins/_collections.js');

class SvgoParserError extends Error {
  /**
   * @param message {string}
   * @param line {number}
   * @param column {number}
   * @param source {string}
   * @param file {void | string}
   */
  constructor(message, line, column, source, file) {
    super(message);
    this.name = 'SvgoParserError';
    this.message = `${file || '<input>'}:${line}:${column}: ${message}`;
    this.reason = message;
    this.line = line;
    this.column = column;
    this.source = source;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SvgoParserError);
    }
  }
  toString() {
    const lines = this.source.split(/\r?\n/);
    const startLine = Math.max(this.line - 3, 0);
    const endLine = Math.min(this.line + 2, lines.length);
    const lineNumberWidth = String(endLine).length;
    const startColumn = Math.max(this.column - 54, 0);
    const endColumn = Math.max(this.column + 20, 80);
    const code = lines
      .slice(startLine, endLine)
      .map((line, index) => {
        const lineSlice = line.slice(startColumn, endColumn);
        let ellipsisPrefix = '';
        let ellipsisSuffix = '';
        if (startColumn !== 0) {
          ellipsisPrefix = startColumn > line.length - 1 ? ' ' : '…';
        }
        if (endColumn < line.length - 1) {
          ellipsisSuffix = '…';
        }
        const number = startLine + 1 + index;
        const gutter = ` ${number.toString().padStart(lineNumberWidth)} | `;
        if (number === this.line) {
          const gutterSpacing = gutter.replace(/[^|]/g, ' ');
          const lineSpacing = (
            ellipsisPrefix + line.slice(startColumn, this.column - 1)
          ).replace(/[^\t]/g, ' ');
          const spacing = gutterSpacing + lineSpacing;
          return `>${gutter}${ellipsisPrefix}${lineSlice}${ellipsisSuffix}\n ${spacing}^`;
        }
        return ` ${gutter}${ellipsisPrefix}${lineSlice}${ellipsisSuffix}`;
      })
      .join('\n');
    return `${this.name}: ${this.message}\n\n${code}\n`;
  }
}

const entityDeclaration = /<!ENTITY\s+(\S+)\s+(?:'([^']+)'|"([^"]+)")\s*>/g;

const ENTITY_REF_PATTERN = /&([^;]+);/g;
const MAX_ENTITY_DEPTH = 4;
const MAX_ENTITY_COUNT = 512;

/**
 * Statically validate that DOCTYPE entity definitions cannot cause exponential
 * expansion (Billion Laughs / CVE-2026-29074). Checks both nesting depth and
 * total expansion count against conservative limits. Recursive (self or
 * mutually referencing) definitions never stop expanding, so they exceed the
 * depth limit.
 *
 * @param {Record<string, string>} entities
 */
const validateEntityExpansion = (entities) => {
  /** @param {string} value */
  const getDirectEntityRefs = (value) => {
    const refs = [];
    let match;
    ENTITY_REF_PATTERN.lastIndex = 0;
    while ((match = ENTITY_REF_PATTERN.exec(value)) !== null) {
      if (Object.prototype.hasOwnProperty.call(entities, match[1])) {
        refs.push(match[1]);
      }
    }
    return refs;
  };

  /** @type {Map<string, number>} */
  const depthCache = new Map();
  /** @type {Map<string, number>} */
  const countCache = new Map();

  /**
   * Maximum entity nesting depth produced when resolving this entity.
   * The walk stops as soon as it is nested deeper than the limit, which also
   * bounds it on recursive definitions.
   * @param {string} name
   * @param {number} level
   * @returns {number}
   */
  const getMaxDepth = (name, level) => {
    const cached = depthCache.get(name);
    if (cached != null) {
      return cached;
    }
    if (level > MAX_ENTITY_DEPTH) {
      return Infinity;
    }
    let maxChild = 0;
    for (const ref of getDirectEntityRefs(entities[name])) {
      maxChild = Math.max(maxChild, getMaxDepth(ref, level + 1));
    }
    const depth = 1 + maxChild;
    depthCache.set(name, depth);
    return depth;
  };

  /**
   * Total number of entity expansions when fully resolving this entity.
   * Only used once all definitions are known to be within the depth limit,
   * so they cannot be recursive.
   * @param {string} name
   * @returns {number}
   */
  const getExpansionCount = (name) => {
    const cached = countCache.get(name);
    if (cached != null) {
      return cached;
    }
    let count = 1;
    for (const ref of getDirectEntityRefs(entities[name])) {
      count += getExpansionCount(ref);
    }
    countCache.set(name, count);
    return count;
  };

  for (const name of Object.keys(entities)) {
    if (getMaxDepth(name, 1) > MAX_ENTITY_DEPTH) {
      throw new Error('Parsed entity depth exceeds max entity depth');
    }
  }
  for (const name of Object.keys(entities)) {
    if (getExpansionCount(name) > MAX_ENTITY_COUNT) {
      throw new Error('Parsed entity count exceeds max entity count');
    }
  }
};

const config = {
  strict: true,
  trim: false,
  normalize: false,
  lowercase: true,
  xmlns: true,
  position: true,
};

/**
 * Convert SVG (XML) string to SVG-as-JS object.
 *
 * @type {(data: string, from?: string) => XastRoot}
 */
const parseSvg = (data, from) => {
  const sax = SAX.parser(config.strict, config);
  /**
   * @type {XastRoot}
   */
  const root = new JSAPI({ type: 'root', children: [] });
  /**
   * @type {XastParent}
   */
  let current = root;
  /**
   * @type {Array<XastParent>}
   */
  const stack = [root];

  /**
   * @type {<T extends XastNode>(node: T) => T}
   */
  const pushToContent = (node) => {
    const wrapped = new JSAPI(node, current);
    current.children.push(wrapped);
    return wrapped;
  };

  /**
   * sax splices the value of a custom entity back into its input and parses
   * it again without any limit. Every resolution is counted so the total
   * number of entity expansions in a document stays within the limit, also
   * for references only formed while parsing (e.g. through "&#38;") which
   * the static validation of the declarations cannot see.
   */
  let entityCount = 0;
  let lastEntityPosition = -1;

  /**
   * @type {(name: string, value: string) => void}
   */
  const defineEntity = (name, value) => {
    Object.defineProperty(sax.ENTITIES, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        // sax reads the entity twice for a single resolution
        if (sax.position !== lastEntityPosition) {
          lastEntityPosition = sax.position;
          entityCount += 1;
          if (entityCount > MAX_ENTITY_COUNT) {
            throw new Error('Parsed entity count exceeds max entity count');
          }
        }
        return value;
      },
    });
  };

  /**
   * @type {(doctype: string) => void}
   */
  sax.ondoctype = (doctype) => {
    /**
     * @type {XastDoctype}
     */
    const node = {
      type: 'doctype',
      // TODO parse doctype for name, public and system to match xast
      name: 'svg',
      data: {
        doctype,
      },
    };
    pushToContent(node);
    const subsetStart = doctype.indexOf('[');
    if (subsetStart >= 0) {
      /** @type {Record<string, string>} */
      const customEntities = {};
      entityDeclaration.lastIndex = subsetStart;
      let entityMatch = entityDeclaration.exec(data);
      while (entityMatch != null) {
        const entityName = entityMatch[1];
        const entityValue = entityMatch[2] || entityMatch[3];
        defineEntity(entityName, entityValue);
        customEntities[entityName] = entityValue;
        entityMatch = entityDeclaration.exec(data);
      }
      validateEntityExpansion(customEntities);
    }
  };

  /**
   * @type {(data: { name: string, body: string }) => void}
   */
  sax.onprocessinginstruction = (data) => {
    /**
     * @type {XastInstruction}
     */
    const node = {
      type: 'instruction',
      name: data.name,
      value: data.body,
    };
    pushToContent(node);
  };

  /**
   * @type {(comment: string) => void}
   */
  sax.oncomment = (comment) => {
    /**
     * @type {XastComment}
     */
    const node = {
      type: 'comment',
      value: comment.trim(),
    };
    pushToContent(node);
  };

  /**
   * @type {(cdata: string) => void}
   */
  sax.oncdata = (cdata) => {
    /**
     * @type {XastCdata}
     */
    const node = {
      type: 'cdata',
      value: cdata,
    };
    pushToContent(node);
  };

  /**
   * @type {(data: { name: string, attributes: Record<string, { value: string }>}) => void}
   */
  sax.onopentag = (data) => {
    /**
     * @type {XastElement}
     */
    let element = {
      type: 'element',
      name: data.name,
      attributes: {},
      children: [],
    };
    for (const [name, attr] of Object.entries(data.attributes)) {
      element.attributes[name] = attr.value;
    }
    element = pushToContent(element);
    current = element;
    stack.push(element);
  };

  /**
   * @type {(text: string) => void}
   */
  sax.ontext = (text) => {
    if (current.type === 'element') {
      // prevent trimming of meaningful whitespace inside textual tags
      if (textElems.includes(current.name)) {
        /**
         * @type {XastText}
         */
        const node = {
          type: 'text',
          value: text,
        };
        pushToContent(node);
      } else if (/\S/.test(text)) {
        /**
         * @type {XastText}
         */
        const node = {
          type: 'text',
          value: text.trim(),
        };
        pushToContent(node);
      }
    }
  };

  sax.onclosetag = () => {
    stack.pop();
    current = stack[stack.length - 1];
  };

  /**
   * @type {(e: any) => void}
   */
  sax.onerror = (e) => {
    const error = new SvgoParserError(
      e.reason,
      e.line + 1,
      e.column,
      data,
      from
    );
    if (e.message.indexOf('Unexpected end') === -1) {
      throw error;
    }
  };

  sax.write(data).close();
  return root;
};
exports.parseSvg = parseSvg;
