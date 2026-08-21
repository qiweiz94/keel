// src/plugin.ts
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ../core/src/home.ts
import { homedir } from "node:os";
function resolveHome() {
  return process.env.KEEL_HOME || process.env.HOME || homedir();
}

// ../core/src/enforce/pipeline.ts
import { existsSync as existsSync4, readFileSync as readFileSync5, rmSync, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";

// ../core/src/enforce/path-normalize.ts
import { win32, posix } from "node:path";
function currentFlavor() {
  return process.platform === "win32" ? "win32" : "posix";
}
function impl(flavor) {
  return flavor === "win32" ? win32 : posix;
}
function isAbsolutePath(p, flavor = currentFlavor()) {
  return !!p && impl(flavor).isAbsolute(p);
}
function resolveMaybeRelative(rawPath, cwd, flavor = currentFlavor()) {
  if (!rawPath) return rawPath;
  return isAbsolutePath(rawPath, flavor) ? rawPath : impl(flavor).resolve(cwd, rawPath);
}
function canonicalizePath(p, flavor = currentFlavor()) {
  if (!p) return p;
  const isUnc = flavor === "win32" && /^[\\/]{2}/.test(p);
  let s = p.replace(/\\/g, "/");
  if (isUnc) {
    s = "//" + s.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  } else {
    s = s.replace(/\/{2,}/g, "/");
  }
  s = s.replace(/^([a-zA-Z]):/, (_m, d) => `${d.toUpperCase()}:`);
  return s;
}
function foldCase(p, flavor = currentFlavor()) {
  return flavor === "win32" ? p.toLowerCase() : p;
}
function normalizeForMatch(p, flavor = currentFlavor()) {
  return foldCase(canonicalizePath(p, flavor), flavor);
}

// ../core/src/enforce/rule-parser.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ../../node_modules/yaml/browser/dist/nodes/identity.js
var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
function isCollection(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return true;
    }
  return false;
}
var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;

// ../../node_modules/yaml/browser/dist/visit.js
var BREAK = /* @__PURE__ */ Symbol("break visit");
var SKIP = /* @__PURE__ */ Symbol("skip children");
var REMOVE = /* @__PURE__ */ Symbol("remove node");
function visit(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path2) {
  const ctrl = callVisitor(key, node, visitor, path2);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path2, ctrl);
    return visit_(key, ctrl, visitor, path2);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path2 = Object.freeze(path2.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path2);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path2 = Object.freeze(path2.concat(node));
      const ck = visit_("key", node.key, visitor, path2);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path2);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path2) {
  const ctrl = await callVisitor(key, node, visitor, path2);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path2, ctrl);
    return visitAsync_(key, ctrl, visitor, path2);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path2 = Object.freeze(path2.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path2);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path2 = Object.freeze(path2.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path2);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path2);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
function callVisitor(key, node, visitor, path2) {
  if (typeof visitor === "function")
    return visitor(key, node, path2);
  if (isMap(node))
    return visitor.Map?.(key, node, path2);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path2);
  if (isPair(node))
    return visitor.Pair?.(key, node, path2);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path2);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path2);
  return void 0;
}
function replaceNode(key, path2, node) {
  const parent = path2[path2.length - 1];
  if (isCollection(parent)) {
    parent.items[key] = node;
  } else if (isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}

// ../../node_modules/yaml/browser/dist/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
var Directives = class _Directives {
  constructor(yaml, tags) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, _Directives.defaultTags, tags);
  }
  clone() {
    const copy = new _Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  /**
   * During parsing, get a Directives instance for the current document and
   * update the stream state according to the current version's spec.
   */
  atDocument() {
    const res = new _Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: _Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, _Directives.defaultTags);
        break;
    }
    return res;
  }
  /**
   * @param onError - May be called even if the action was successful
   * @returns `true` on success
   */
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, _Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  /**
   * Resolves a tag, matching handles to those defined in %TAG directives.
   *
   * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
   *   `'!local'` tag, or `null` if unresolvable.
   */
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  /**
   * Given a fully resolved tag, returns its printable string form,
   * taking into account current tag prefixes and defaults.
   */
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines2 = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      const tags = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags[node.tag] = true;
      });
      tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines2.push(`%TAG ${handle} ${prefix}`);
    }
    return lines2.join("\n");
  }
};
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// ../../node_modules/yaml/browser/dist/doc/anchors.js
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
function anchorNames(root) {
  const anchors = /* @__PURE__ */ new Set();
  visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors.add(node.anchor);
    }
  });
  return anchors;
}
function findNewAnchor(prefix, exclude) {
  for (let i = 1; true; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = /* @__PURE__ */ new Map();
  let prevAnchors = null;
  return {
    onAnchor: (source) => {
      aliasObjects.push(source);
      prevAnchors ?? (prevAnchors = anchorNames(doc));
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    },
    /**
     * With circular references, the source node is only resolved after all
     * of its child nodes are. This is why anchors are set only after all of
     * the nodes have been created.
     */
    setAnchors: () => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (isScalar(ref.node) || isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    },
    sourceObjects
  };
}

// ../../node_modules/yaml/browser/dist/doc/applyReviver.js
function applyReviver(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length; i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver(reviver, val, String(i), v0);
        if (v1 === void 0)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver(reviver, val, v0, v0);
        if (v1 === void 0)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}

// ../../node_modules/yaml/browser/dist/nodes/toJS.js
function toJS(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: void 0 };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res2) => {
      data.res = res2;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}

// ../../node_modules/yaml/browser/dist/nodes/Node.js
var NodeBase = class {
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
  /** Create a copy of this node.  */
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** A plain JavaScript representation of this node. */
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
};

// ../../node_modules/yaml/browser/dist/nodes/Alias.js
var Alias = class extends NodeBase {
  constructor(source) {
    super(ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  /**
   * Resolve the value of this alias within `doc`, finding the last
   * instance of the `source` anchor before this node.
   */
  resolve(doc, ctx) {
    if (ctx?.maxAliasCount === 0)
      throw new ReferenceError("Alias resolution is disabled");
    let nodes;
    if (ctx?.aliasResolveCache) {
      nodes = ctx.aliasResolveCache;
    } else {
      nodes = [];
      visit(doc, {
        Node: (_key, node) => {
          if (isAlias(node) || hasAnchor(node))
            nodes.push(node);
        }
      });
      if (ctx)
        ctx.aliasResolveCache = nodes;
    }
    let found = void 0;
    for (const node of nodes) {
      if (node === this)
        break;
      if (node.anchor === this.source)
        found = node;
    }
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const { anchors, doc, maxAliasCount } = ctx;
    const source = this.resolve(doc, ctx);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    let data = anchors.get(source);
    if (!data) {
      toJS(source, null, ctx);
      data = anchors.get(source);
    }
    if (data?.res === void 0) {
      const msg = "This should not happen: Alias anchor was not resolved?";
      throw new ReferenceError(msg);
    }
    if (maxAliasCount >= 0) {
      data.count += 1;
      if (data.aliasCount === 0)
        data.aliasCount = getAliasCount(doc, source, anchors);
      if (data.count * data.aliasCount > maxAliasCount) {
        const msg = "Excessive alias count indicates a resource exhaustion attack";
        throw new ReferenceError(msg);
      }
    }
    return data.res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
};
function getAliasCount(doc, node, anchors) {
  if (isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors && source && anchors.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (isCollection(node)) {
    let count = 0;
    for (const item of node.items) {
      const c = getAliasCount(doc, item, anchors);
      if (c > count)
        count = c;
    }
    return count;
  } else if (isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors);
    const vc = getAliasCount(doc, node.value, anchors);
    return Math.max(kc, vc);
  }
  return 1;
}

// ../../node_modules/yaml/browser/dist/nodes/Scalar.js
var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
var Scalar = class extends NodeBase {
  constructor(value) {
    super(SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
};
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// ../../node_modules/yaml/browser/dist/doc/createNode.js
var defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags) {
  if (tagName) {
    const match = tags.filter((t) => t.tag === tagName);
    const tagObj = match.find((t) => !t.format) ?? match[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags.find((t) => t.identify?.(value) && !t.format);
}
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map2 = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map2.items.push(value);
    return map2;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema: schema4, sourceObjects } = ctx;
  let ref = void 0;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      ref.anchor ?? (ref.anchor = onAnchor(value));
      return new Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema4.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node2 = new Scalar(value);
      if (ref)
        ref.node = node2;
      return node2;
    }
    tagObj = value instanceof Map ? schema4[MAP] : Symbol.iterator in Object(value) ? schema4[SEQ] : schema4[MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}

// ../../node_modules/yaml/browser/dist/nodes/Collection.js
function collectionFromPath(schema4, path2, value) {
  let v = value;
  for (let i = path2.length - 1; i >= 0; --i) {
    const k = path2[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = /* @__PURE__ */ new Map([[k, v]]);
    }
  }
  return createNode(v, void 0, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema: schema4,
    sourceObjects: /* @__PURE__ */ new Map()
  });
}
var isEmptyPath = (path2) => path2 == null || typeof path2 === "object" && !!path2[Symbol.iterator]().next().done;
var Collection = class extends NodeBase {
  constructor(type, schema4) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema4,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  /**
   * Create a copy of this collection.
   *
   * @param schema - If defined, overwrites the original's schema
   */
  clone(schema4) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema4)
      copy.schema = schema4;
    copy.items = copy.items.map((it) => isNode(it) || isPair(it) ? it.clone(schema4) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /**
   * Adds a value to the collection. For `!!map` and `!!omap` the value must
   * be a Pair instance or a `{ key, value }` object, which may not have a key
   * that already exists in the map.
   */
  addIn(path2, value) {
    if (isEmptyPath(path2))
      this.add(value);
    else {
      const [key, ...rest] = path2;
      const node = this.get(key, true);
      if (isCollection(node))
        node.addIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  /**
   * Removes a value from the collection.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path2) {
    const [key, ...rest] = path2;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path2, keepScalar) {
    const [key, ...rest] = path2;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && isScalar(node) ? node.value : node;
    else
      return isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   */
  hasIn(path2) {
    const [key, ...rest] = path2;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return isCollection(node) ? node.hasIn(rest) : false;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path2, value) {
    const [key, ...rest] = path2;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (isCollection(node))
        node.setIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyComment.js
var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;

// ../../node_modules/yaml/browser/dist/stringify/foldFlowLines.js
var FOLD_FLOW = "flow";
var FOLD_BLOCK = "block";
var FOLD_QUOTED = "quoted";
function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text.length <= endStep)
    return text;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = void 0;
  let prev = void 0;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch; ch = text[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === "\n") {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = void 0;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
        const next = text[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "	")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = void 0;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "	") {
            prev = ch;
            ch = text[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = void 0;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text;
  if (onFold)
    onFold();
  let res = text.slice(0, folds[0]);
  for (let i2 = 0; i2 < folds.length; ++i2) {
    const fold = folds[i2];
    const end2 = folds[i2 + 1] || text.length;
    if (fold === 0)
      res = `
${indent}${text.slice(0, end2)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text[fold]}\\`;
      res += `
${indent}${text.slice(fold + 1, end2)}`;
    }
  }
  return res;
}
function consumeMoreIndentedLines(text, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text[start];
  while (ch === " " || ch === "	") {
    if (i < start + indent) {
      ch = text[++i];
    } else {
      do {
        ch = text[++i];
      } while (ch && ch !== "\n");
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}

// ../../node_modules/yaml/browser/dist/stringify/stringifyString.js
var getFoldOptions = (ctx, isBlock2) => ({
  indentAtStart: isBlock2 ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
});
var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
function lineLengthOverLimit(str, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0; i < strLen; ++i) {
    if (str[i] === "\n") {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
function doubleQuotedString(value, ctx) {
  const json = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      str += json.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u":
          {
            str += json.slice(start, i);
            const code = json.substr(i + 2, 4);
            switch (code) {
              case "0000":
                str += "\\0";
                break;
              case "0007":
                str += "\\a";
                break;
              case "000b":
                str += "\\v";
                break;
              case "001b":
                str += "\\e";
                break;
              case "0085":
                str += "\\N";
                break;
              case "00a0":
                str += "\\_";
                break;
              case "2028":
                str += "\\L";
                break;
              case "2029":
                str += "\\P";
                break;
              default:
                if (code.substr(0, 2) === "00")
                  str += "\\x" + code.substr(2);
                else
                  str += json.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json.slice(start, i) + "\n\n";
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += "\n";
              i += 2;
            }
            str += indent;
            if (json[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_QUOTED, getFoldOptions(ctx, false));
}
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines(res, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
var blockEndNewlines;
try {
  blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.BLOCK_FOLDED ? false : type === Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? "|\n" : ">\n";
  let chomp;
  let endStart;
  for (endStart = value.length; endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== "\n" && ch !== "	" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf("\n");
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === "\n")
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0; startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === "\n")
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines(`${start}${foldedValue}${end}`, indent, FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
function plainString(item, ctx, onComment, onChompKeep) {
  const { type, value } = item;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar.PLAIN && value.includes("\n")) {
    return blockString(item, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
    const { compat, tags } = ctx.doc.schema;
    if (tags.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function stringifyString(item, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
  let { type } = item;
  if (type !== Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar.QUOTE_DOUBLE;
  }
  const _stringify = (_type) => {
    switch (_type) {
      case Scalar.BLOCK_FOLDED:
      case Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  };
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}

// ../../node_modules/yaml/browser/dist/stringify/stringify.js
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trailingComma: false,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: /* @__PURE__ */ new Set(),
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
function getTagObject(tags, item) {
  if (item.tag) {
    const match = tags.filter((t) => t.tag === item.tag);
    if (match.length > 0)
      return match.find((t) => t.format === item.format) ?? match[0];
  }
  let tagObj = void 0;
  let obj;
  if (isScalar(item)) {
    obj = item.value;
    let match = tags.filter((t) => t.identify?.(obj));
    if (match.length > 1) {
      const testMatch = match.filter((t) => t.test);
      if (testMatch.length > 0)
        match = testMatch;
    }
    tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
function stringifyProps(node, tagObj, { anchors, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (isScalar(node) || isCollection(node)) && node.anchor;
  if (anchor && anchorIsValid(anchor)) {
    anchors.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
function stringify(item, ctx, onComment, onChompKeep) {
  if (isPair(item))
    return item.toString(ctx, onComment, onChompKeep);
  if (isAlias(item)) {
    if (ctx.doc.directives)
      return item.toString(ctx);
    if (ctx.resolvedAliases?.has(item)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item);
      else
        ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
      item = item.resolve(ctx.doc);
    }
  }
  let tagObj = void 0;
  const node = isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
  tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : isScalar(node) ? stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str;
  return isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
}

// ../../node_modules/yaml/browser/dist/stringify/stringifyPair.js
function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (isCollection(key) || !isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || isCollection(key) || (isScalar(key) ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str = stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str === "" ? "?" : explicitKey ? `? ${str}` : str;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str = `? ${str}`;
    if (keyComment && !keyCommentDone) {
      str += lineComment(str, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
    str = `? ${str}
${indent}:`;
  } else {
    str = `${str}:`;
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? "\n" : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === "\n" && valueComment)
        ws = "\n\n";
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf("\n");
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === "\n") {
    ws = "";
  }
  str += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str += lineComment(str, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str;
}

// ../../node_modules/yaml/browser/dist/log.js
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    console.warn(warning);
  }
}

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<";
var merge = {
  identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }),
  stringify: () => MERGE_KEY
};
var isMergeKey = (ctx, key) => (merge.identify(key) || isScalar(key) && (!key.type || key.type === Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
function addMergeToJSMap(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (isSeq(source))
    for (const it of source.items)
      mergeValue(ctx, map2, it);
  else if (Array.isArray(source))
    for (const it of source)
      mergeValue(ctx, map2, it);
  else
    mergeValue(ctx, map2, source);
}
function mergeValue(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value2] of srcMap) {
    if (map2 instanceof Map) {
      if (!map2.has(key))
        map2.set(key, value2);
    } else if (map2 instanceof Set) {
      map2.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map2, key)) {
      Object.defineProperty(map2, key, {
        value: value2,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map2;
}
function resolveAliasValue(ctx, value) {
  return ctx && isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
}

// ../../node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map2, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map2, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map2, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map2 instanceof Map) {
      map2.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map2 instanceof Set) {
      map2.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map2)
        Object.defineProperty(map2, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map2[stringKey] = jsValue;
    }
  }
  return map2;
}
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (isNode(key) && ctx?.doc) {
    const strCtx = createStringifyContext(ctx.doc, {});
    strCtx.anchors = /* @__PURE__ */ new Set();
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}

// ../../node_modules/yaml/browser/dist/nodes/Pair.js
function createPair(key, value, ctx) {
  const k = createNode(key, void 0, ctx);
  const v = createNode(value, void 0, ctx);
  return new Pair(k, v);
}
var Pair = class _Pair {
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema4) {
    let { key, value } = this;
    if (isNode(key))
      key = key.clone(schema4);
    if (isNode(value))
      value = value.clone(schema4);
    return new _Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    return addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyCollection.js
function stringifyCollection(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify4(collection, ctx, options);
}
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines2 = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment2 = null;
    if (isNode(item)) {
      if (!chompKeep && item.spaceBefore)
        lines2.push("");
      addCommentBefore(ctx, lines2, item.commentBefore, chompKeep);
      if (item.comment)
        comment2 = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines2.push("");
        addCommentBefore(ctx, lines2, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str2 = stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
    if (comment2)
      str2 += lineComment(str2, itemIndent, commentString(comment2));
    if (chompKeep && comment2)
      chompKeep = false;
    lines2.push(blockItemPrefix + str2);
  }
  let str;
  if (lines2.length === 0) {
    str = flowChars.start + flowChars.end;
  } else {
    str = lines2[0];
    for (let i = 1; i < lines2.length; ++i) {
      const line = lines2[i];
      str += line ? `
${indent}${line}` : "\n";
    }
  }
  if (comment) {
    str += "\n" + indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str;
}
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines2 = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (item.spaceBefore)
        lines2.push("");
      addCommentBefore(ctx, lines2, item.commentBefore, false);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines2.push("");
        addCommentBefore(ctx, lines2, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = isNode(item.value) ? item.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str = stringify(item, itemCtx, () => comment = null);
    reqNewline || (reqNewline = lines2.length > linesAtValue || str.includes("\n"));
    if (i < items.length - 1) {
      str += ",";
    } else if (ctx.options.trailingComma) {
      if (ctx.options.lineWidth > 0) {
        reqNewline || (reqNewline = lines2.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
      }
      if (reqNewline) {
        str += ",";
      }
    }
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    lines2.push(str);
    linesAtValue = lines2.length;
  }
  const { start, end } = flowChars;
  if (lines2.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines2.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str = start;
      for (const line of lines2)
        str += line ? `
${indentStep}${indent}${line}` : "\n";
      return `${str}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines2.join(" ")}${fcPadding}${end}`;
    }
  }
}
function addCommentBefore({ indent, options: { commentString } }, lines2, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = indentComment(commentString(comment), indent);
    lines2.push(ic.trimStart());
  }
}

// ../../node_modules/yaml/browser/dist/nodes/YAMLMap.js
function findPair(items, key) {
  const k = isScalar(key) ? key.value : key;
  for (const it of items) {
    if (isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return void 0;
}
var YAMLMap = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema4) {
    super(MAP, schema4);
    this.items = [];
  }
  /**
   * A generic collection parsing method that can be extended
   * to other node classes that inherit from YAMLMap
   */
  static from(schema4, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map2 = new this(schema4);
    const add = (key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== void 0 || keepUndefined)
        map2.items.push(createPair(key, value, ctx));
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema4.sortMapEntries === "function") {
      map2.items.sort(schema4.sortMapEntries);
    }
    return map2;
  }
  /**
   * Adds a value to the collection.
   *
   * @param overwrite - If not set `true`, using a key that is already in the
   *   collection will throw. Otherwise, overwrites the previous value.
   */
  add(pair, overwrite) {
    let _pair;
    if (isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair(pair, pair?.value);
    } else
      _pair = new Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (isScalar(prev.value) && isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && isScalar(node) ? node.value : node) ?? void 0;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair(key, value), true);
  }
  /**
   * @param ctx - Conversion context, originally set in Document#toJS()
   * @param {Class} Type - If set, forces the returned collection type
   * @returns Instance of Type, Map, or Object
   */
  toJSON(_, ctx, Type) {
    const map2 = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const item of this.items)
      addPairToJSMap(ctx, map2, item);
    return map2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item of this.items) {
      if (!isPair(item))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
};

// ../../node_modules/yaml/browser/dist/schema/common/map.js
var map = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map2, onError) {
    if (!isMap(map2))
      onError("Expected a mapping for this tag");
    return map2;
  },
  createNode: (schema4, obj, ctx) => YAMLMap.from(schema4, obj, ctx)
};

// ../../node_modules/yaml/browser/dist/nodes/YAMLSeq.js
var YAMLSeq = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema4) {
    super(SEQ, schema4);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  /**
   * Removes a value from the collection.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   *
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return void 0;
    const it = this.items[idx];
    return !keepScalar && isScalar(it) ? it.value : it;
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   */
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   *
   * If `key` does not contain a representation of an integer, this will throw.
   * It may be wrapped in a `Scalar`.
   */
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (isScalar(prev) && isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq2 = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq2);
    let i = 0;
    for (const item of this.items)
      seq2.push(toJS(item, String(i++), ctx));
    return seq2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema4, obj, ctx) {
    const { replacer } = ctx;
    const seq2 = new this(schema4);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq2.items.push(createNode(it, void 0, ctx));
      }
    }
    return seq2;
  }
};
function asItemIndex(key) {
  let idx = isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

// ../../node_modules/yaml/browser/dist/schema/common/seq.js
var seq = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq2, onError) {
    if (!isSeq(seq2))
      onError("Expected a sequence for this tag");
    return seq2;
  },
  createNode: (schema4, obj, ctx) => YAMLSeq.from(schema4, obj, ctx)
};

// ../../node_modules/yaml/browser/dist/schema/common/string.js
var string = {
  identify: (value) => typeof value === "string",
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str,
  stringify(item, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString(item, ctx, onComment, onChompKeep);
  }
};

// ../../node_modules/yaml/browser/dist/schema/common/null.js
var nullTag = {
  identify: (value) => value == null,
  createNode: () => new Scalar(null),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar(null),
  stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
};

// ../../node_modules/yaml/browser/dist/schema/core/bool.js
var boolTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str) => new Scalar(str[0] === "t" || str[0] === "T"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyNumber.js
function stringifyNumber({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}

// ../../node_modules/yaml/browser/dist/schema/core/float.js
var floatNaN = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str));
    const dot = str.indexOf(".");
    if (dot !== -1 && str[str.length - 1] === "0")
      node.minFractionDigits = str.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber
};

// ../../node_modules/yaml/browser/dist/schema/core/int.js
var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber(node);
}
var intOct = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
  stringify: (node) => intStringify(node, 8, "0o")
};
var int = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
  stringify: (node) => intStringify(node, 16, "0x")
};

// ../../node_modules/yaml/browser/dist/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// ../../node_modules/yaml/browser/dist/schema/json/schema.js
function intIdentify2(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
var stringifyJSON = ({ value }) => JSON.stringify(value);
var jsonScalars = [
  {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify: stringifyJSON
  },
  {
    identify: (value) => value == null,
    createNode: () => new Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null,
    stringify: stringifyJSON
  },
  {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str) => str === "true",
    stringify: stringifyJSON
  },
  {
    identify: intIdentify2,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
    stringify: ({ value }) => intIdentify2(value) ? value.toString() : JSON.stringify(value)
  },
  {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str) => parseFloat(str),
    stringify: stringifyJSON
  }
];
var jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
    return str;
  }
};
var schema2 = [map, seq].concat(jsonScalars, jsonError);

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/binary.js
var binary = {
  identify: (value) => value instanceof Uint8Array,
  // Buffer inherits from Uint8Array
  default: false,
  tag: "tag:yaml.org,2002:binary",
  /**
   * Returns a Buffer in node and an Uint8Array in browsers
   *
   * To use the resulting buffer as an image, you'll want to do something like:
   *
   *   const blob = new Blob([buffer], { type: 'image/jpeg' })
   *   document.querySelector('#photo').src = URL.createObjectURL(blob)
   */
  resolve(src, onError) {
    if (typeof atob === "function") {
      const str = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str.length);
      for (let i = 0; i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str;
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0; i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    type ?? (type = Scalar.BLOCK_LITERAL);
    if (type !== Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str.length / lineWidth);
      const lines2 = new Array(n);
      for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
        lines2[i] = str.substr(o, lineWidth);
      }
      str = lines2.join(type === Scalar.BLOCK_LITERAL ? "\n" : " ");
    }
    return stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
  }
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/pairs.js
function resolvePairs(seq2, onError) {
  if (isSeq(seq2)) {
    for (let i = 0; i < seq2.items.length; ++i) {
      let item = seq2.items[i];
      if (isPair(item))
        continue;
      else if (isMap(item)) {
        if (item.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item.items[0] || new Pair(new Scalar(null));
        if (item.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
        if (item.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
        }
        item = pair;
      }
      seq2.items[i] = isPair(item) ? item : new Pair(item);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq2;
}
function createPairs(schema4, iterable, ctx) {
  const { replacer } = ctx;
  const pairs2 = new YAMLSeq(schema4);
  pairs2.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs2.items.push(createPair(key, value, ctx));
    }
  return pairs2;
}
var pairs = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/omap.js
var YAMLOMap = class _YAMLOMap extends YAMLSeq {
  constructor() {
    super();
    this.add = YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap.prototype.set.bind(this);
    this.tag = _YAMLOMap.tag;
  }
  /**
   * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
   * but TypeScript won't allow widening the signature of a child method.
   */
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map2 = /* @__PURE__ */ new Map();
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map2.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map2.set(key, value);
    }
    return map2;
  }
  static from(schema4, iterable, ctx) {
    const pairs2 = createPairs(schema4, iterable, ctx);
    const omap2 = new this();
    omap2.items = pairs2.items;
    return omap2;
  }
};
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  identify: (value) => value instanceof Map,
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq2, onError) {
    const pairs2 = resolvePairs(seq2, onError);
    const seenKeys = [];
    for (const { key } of pairs2.items) {
      if (isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap(), pairs2);
  },
  createNode: (schema4, iterable, ctx) => YAMLOMap.from(schema4, iterable, ctx)
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/bool.js
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
var trueTag = {
  identify: (value) => value === true,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar(true),
  stringify: boolStringify
};
var falseTag = {
  identify: (value) => value === false,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar(false),
  stringify: boolStringify
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/float.js
var floatNaN2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str.replace(/_/g, "")),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str.replace(/_/g, "")));
    const dot = str.indexOf(".");
    if (dot !== -1) {
      const f = str.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/int.js
var intIdentify3 = (value) => typeof value === "bigint" || Number.isInteger(value);
function intResolve2(str, offset, radix, { intAsBigInt }) {
  const sign2 = str[0];
  if (sign2 === "-" || sign2 === "+")
    offset += 1;
  str = str.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    const n2 = BigInt(str);
    return sign2 === "-" ? BigInt(-1) * n2 : n2;
  }
  const n = parseInt(str, radix);
  return sign2 === "-" ? -1 * n : n;
}
function intStringify2(node, radix, prefix) {
  const { value } = node;
  if (intIdentify3(value)) {
    const str = value.toString(radix);
    return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
  }
  return stringifyNumber(node);
}
var intBin = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 2, opt),
  stringify: (node) => intStringify2(node, 2, "0b")
};
var intOct2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 1, 8, opt),
  stringify: (node) => intStringify2(node, 8, "0")
};
var int2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str, _onError, opt) => intResolve2(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 16, opt),
  stringify: (node) => intStringify2(node, 16, "0x")
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/set.js
var YAMLSet = class _YAMLSet extends YAMLMap {
  constructor(schema4) {
    super(schema4);
    this.tag = _YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair(key.key, null);
    else
      pair = new Pair(key, null);
    const prev = findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  /**
   * If `keepPair` is `true`, returns the Pair matching `key`.
   * Otherwise, returns the value of that Pair's key.
   */
  get(key, keepPair) {
    const pair = findPair(this.items, key);
    return !keepPair && isPair(pair) ? isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema4, iterable, ctx) {
    const { replacer } = ctx;
    const set2 = new this(schema4);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set2.items.push(createPair(value, null, ctx));
      }
    return set2;
  }
};
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  identify: (value) => value instanceof Set,
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: (schema4, iterable, ctx) => YAMLSet.from(schema4, iterable, ctx),
  resolve(map2, onError) {
    if (isMap(map2)) {
      if (map2.hasAllNullValues(true))
        return Object.assign(new YAMLSet(), map2);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map2;
  }
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str, asBigInt) {
  const sign2 = str[0];
  const parts = sign2 === "-" || sign2 === "+" ? str.substring(1) : str;
  const num = (n) => asBigInt ? BigInt(n) : Number(n);
  const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
  return sign2 === "-" ? num(-1) * res : res;
}
function stringifySexagesimal(node) {
  let { value } = node;
  let num = (n) => n;
  if (typeof value === "bigint")
    num = (n) => BigInt(n);
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber(node);
  let sign2 = "";
  if (value < 0) {
    sign2 = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign2 + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
var intTime = {
  identify: (value) => typeof value === "bigint" || Number.isInteger(value),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
  stringify: stringifySexagesimal
};
var floatTime = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str) => parseSexagesimal(str, false),
  stringify: stringifySexagesimal
};
var timestamp = {
  identify: (value) => value instanceof Date,
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
  // may be omitted altogether, resulting in a date format. In such a case, the time part is
  // assumed to be 00:00:00Z (start of day, UTC).
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
  resolve(str) {
    const match = str.match(timestamp.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 6e4 * d;
    }
    return new Date(date);
  },
  stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp
];

// ../../node_modules/yaml/browser/dist/schema/tags.js
var schemas = /* @__PURE__ */ new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]);
var tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp
};
var coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  }
  let tags = schemaTags;
  if (!tags) {
    if (Array.isArray(customTags))
      tags = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags = tags.concat(tag);
  } else if (typeof customTags === "function") {
    tags = customTags(tags.slice());
  }
  if (addMergeTag)
    tags = tags.concat(merge);
  return tags.reduce((tags2, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags2.includes(tagObj))
      tags2.push(tagObj);
    return tags2;
  }, []);
}

// ../../node_modules/yaml/browser/dist/schema/Schema.js
var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
var Schema = class _Schema {
  constructor({ compat, customTags, merge: merge2, resolveKnownTags, schema: schema4, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null;
    this.name = typeof schema4 === "string" && schema4 || "core";
    this.knownTags = resolveKnownTags ? coreKnownTags : {};
    this.tags = getTags(customTags, this.name, merge2);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, MAP, { value: map });
    Object.defineProperty(this, SCALAR, { value: string });
    Object.defineProperty(this, SEQ, { value: seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyDocument.js
function stringifyDocument(doc, options) {
  const lines2 = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines2.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines2.push("---");
  const ctx = createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines2.length !== 1)
      lines2.unshift("");
    const cs = commentString(doc.commentBefore);
    lines2.unshift(indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines2.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines2.push(indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
    let body = stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines2[lines2.length - 1] === "---") {
      lines2[lines2.length - 1] = `--- ${body}`;
    } else
      lines2.push(body);
  } else {
    lines2.push(stringify(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes("\n")) {
        lines2.push("...");
        lines2.push(indentComment(cs, ""));
      } else {
        lines2.push(`... ${cs}`);
      }
    } else {
      lines2.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines2[lines2.length - 1] !== "")
        lines2.push("");
      lines2.push(indentComment(commentString(dc), ""));
    }
  }
  return lines2.join("\n") + "\n";
}

// ../../node_modules/yaml/browser/dist/doc/Document.js
var Document = class _Document {
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new Directives({ version });
    this.setSchema(version, options);
    this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
  }
  /**
   * Create a deep copy of this Document and its contents.
   *
   * Custom Node values that inherit from `Object` still refer to their original instances.
   */
  clone() {
    const copy = Object.create(_Document.prototype, {
      [NODE_TYPE]: { value: DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** Adds a value to the document. */
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  /** Adds a value to the document. */
  addIn(path2, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path2, value);
  }
  /**
   * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
   *
   * If `node` already has an anchor, `name` is ignored.
   * Otherwise, the `node.anchor` value will be set to `name`,
   * or if an anchor with that name is already present in the document,
   * `name` will be used as a prefix for a new unique anchor.
   * If `name` is undefined, the generated anchor will use 'a' as a prefix.
   */
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchorNames(this);
      node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      !name || prev.has(name) ? findNewAnchor(name || "a", prev) : name;
    }
    return new Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = void 0;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = createNodeAnchors(
      this,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      anchorPrefix || "a"
    );
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode(value, tag, ctx);
    if (flow && isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  /**
   * Convert a key and a value into a `Pair` using the current schema,
   * recursively wrapping all values as `Scalar` or `Collection` nodes.
   */
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair(k, v);
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path2) {
    if (isEmptyPath(path2)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path2) : false;
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  get(key, keepScalar) {
    return isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
  }
  /**
   * Returns item at `path`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path2, keepScalar) {
    if (isEmptyPath(path2))
      return !keepScalar && isScalar(this.contents) ? this.contents.value : this.contents;
    return isCollection(this.contents) ? this.contents.getIn(path2, keepScalar) : void 0;
  }
  /**
   * Checks if the document includes a value with the key `key`.
   */
  has(key) {
    return isCollection(this.contents) ? this.contents.has(key) : false;
  }
  /**
   * Checks if the document includes a value at `path`.
   */
  hasIn(path2) {
    if (isEmptyPath(path2))
      return this.contents !== void 0;
    return isCollection(this.contents) ? this.contents.hasIn(path2) : false;
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  set(key, value) {
    if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path2, value) {
    if (isEmptyPath(path2)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, Array.from(path2), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path2, value);
    }
  }
  /**
   * Change the YAML version and schema used by the document.
   * A `null` version disables support for directives, explicit tags, anchors, and aliases.
   * It also requires the `schema` option to be given as a `Schema` instance value.
   *
   * Overrides all previously set schema options.
   */
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  // json & jsonArg are only used from toJSON()
  toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc: this,
      keep: !json,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
  /**
   * A JSON representation of the document `contents`.
   *
   * @param jsonArg Used by `JSON.stringify` to indicate the array index or
   *   property name.
   */
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  /** A YAML representation of the document. */
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument(this, options);
  }
};
function assertCollection(contents) {
  if (isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}

// ../../node_modules/yaml/browser/dist/errors.js
var YAMLError = class extends Error {
  constructor(name, pos, code, message) {
    super();
    this.name = name;
    this.code = code;
    this.message = message;
    this.pos = pos;
  }
};
var YAMLParseError = class extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLParseError", pos, code, message);
  }
};
var YAMLWarning = class extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLWarning", pos, code, message);
  }
};
var prettifyError = (src, lc) => (error) => {
  if (error.pos[0] === -1)
    return;
  error.linePos = error.pos.map((pos) => lc.linePos(pos));
  const { line, col } = error.linePos[0];
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = "\u2026" + lineStr.substring(trimStart);
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80)
    lineStr = lineStr.substring(0, 79) + "\u2026";
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
    if (prev.length > 80)
      prev = prev.substring(0, 79) + "\u2026\n";
    lineStr = prev + lineStr;
  }
  if (/[^ ]/.test(lineStr)) {
    let count = 1;
    const end = error.linePos[1];
    if (end?.line === line && end.col > col) {
      count = Math.max(1, Math.min(end.col - col, 80 - ci));
    }
    const pointer = " ".repeat(ci) + "^".repeat(count);
    error.message += `:

${lineStr}
${pointer}
`;
  }
};

// ../../node_modules/yaml/browser/dist/compose/resolve-props.js
function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = false;
  let atNewline = startOnNewline;
  let hasSpace = startOnNewline;
  let comment = "";
  let commentSep = "";
  let hasNewline = false;
  let reqSpace = false;
  let tab = null;
  let anchor = null;
  let tag = null;
  let newlineAfterProp = null;
  let comma = null;
  let found = null;
  let start = null;
  for (const token of tokens) {
    if (reqSpace) {
      if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
        onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      reqSpace = false;
    }
    if (tab) {
      if (atNewline && token.type !== "comment" && token.type !== "newline") {
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      }
      tab = null;
    }
    switch (token.type) {
      case "space":
        if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
          tab = token;
        }
        hasSpace = true;
        break;
      case "comment": {
        if (!hasSpace)
          onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        const cb = token.source.substring(1) || " ";
        if (!comment)
          comment = cb;
        else
          comment += commentSep + cb;
        commentSep = "";
        atNewline = false;
        break;
      }
      case "newline":
        if (atNewline) {
          if (comment)
            comment += token.source;
          else if (!found || indicator !== "seq-item-ind")
            spaceBefore = true;
        } else
          commentSep += token.source;
        atNewline = true;
        hasNewline = true;
        if (anchor || tag)
          newlineAfterProp = token;
        hasSpace = true;
        break;
      case "anchor":
        if (anchor)
          onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
        if (token.source.endsWith(":"))
          onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
        anchor = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      case "tag": {
        if (tag)
          onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
        tag = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      }
      case indicator:
        if (anchor || tag)
          onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
        if (found)
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
        found = token;
        atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
        hasSpace = false;
        break;
      case "comma":
        if (flow) {
          if (comma)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
          comma = token;
          atNewline = false;
          hasSpace = false;
          break;
        }
      // else fallthrough
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
        atNewline = false;
        hasSpace = false;
    }
  }
  const last = tokens[tokens.length - 1];
  const end = last ? last.offset + last.source.length : offset;
  if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
    onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
  }
  if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
    onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
  return {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}

// ../../node_modules/yaml/browser/dist/compose/util-contains-newline.js
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes("\n"))
        return true;
      if (key.end) {
        for (const st of key.end)
          if (st.type === "newline")
            return true;
      }
      return false;
    case "flow-collection":
      for (const it of key.items) {
        for (const st of it.start)
          if (st.type === "newline")
            return true;
        if (it.sep) {
          for (const st of it.sep)
            if (st.type === "newline")
              return true;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return true;
      }
      return false;
    default:
      return true;
  }
}

// ../../node_modules/yaml/browser/dist/compose/util-flow-indent-check.js
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    const end = fc.end[0];
    if (end.indent === indent && (end.source === "]" || end.source === "}") && containsNewline(fc)) {
      const msg = "Flow end indicator should be more indented than parent";
      onError(end, "BAD_INDENT", msg, true);
    }
  }
}

// ../../node_modules/yaml/browser/dist/compose/util-map-includes.js
function mapIncludes(ctx, items, search) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}

// ../../node_modules/yaml/browser/dist/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap;
  const map2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep, value } = collItem;
    const keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map2.comment)
            map2.comment += "\n" + keyProps.comment;
          else
            map2.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode2(ctx, key, keyProps, onError) : composeEmptyNode2(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (mapIncludes(ctx, map2.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps(sep ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : composeEmptyNode2(ctx, offset, sep, null, valueProps, onError);
      if (ctx.schema.compat)
        flowIndentCheck(bm.indent, value, onError);
      offset = valueNode.range[2];
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    } else {
      if (implicitKey)
        onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
      if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map2.range = [bm.offset, offset, commentEnd ?? offset];
  return map2;
}

// ../../node_modules/yaml/browser/dist/compose/resolve-block-seq.js
function resolveBlockSeq({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bs, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLSeq;
  const seq2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value?.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      } else {
        commentEnd = props.end;
        if (props.comment)
          seq2.comment = props.comment;
        continue;
      }
    }
    const node = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, start, null, props, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bs.indent, value, onError);
    offset = node.range[2];
    seq2.items.push(node);
  }
  seq2.range = [bs.offset, offset, commentEnd ?? offset];
  return seq2;
}

// ../../node_modules/yaml/browser/dist/compose/resolve-end.js
function resolveEnd(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep = "";
    for (const token of end) {
      const { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = true;
          break;
        case "comment": {
          if (reqSpace && !hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += sep + cb;
          sep = "";
          break;
        }
        case "newline":
          if (comment)
            sep += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}

// ../../node_modules/yaml/browser/dist/compose/resolve-flow-collection.js
var blockMsg = "Block collections are not allowed within flow collections";
var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
function resolveFlowCollection({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, fc, onError, tag) {
  const isMap2 = fc.start.source === "{";
  const fcName = isMap2 ? "flow map" : "flow sequence";
  const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap : YAMLSeq);
  const coll = new NodeClass(ctx.schema);
  coll.flow = true;
  const atRoot = ctx.atRoot;
  if (atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0; i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep, value } = collItem;
    const props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep && !value) {
        if (i === 0 && props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        else if (i < fc.items.length - 1)
          onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
        if (props.comment) {
          if (coll.comment)
            coll.comment += "\n" + props.comment;
          else
            coll.comment = props.comment;
        }
        offset = props.end;
        continue;
      }
      if (!isMap2 && ctx.options.strict && containsNewline(key))
        onError(
          key,
          // checked by containsNewline()
          "MULTILINE_IMPLICIT_KEY",
          "Implicit keys of flow sequence pairs need to be on a single line"
        );
    }
    if (i === 0) {
      if (props.comma)
        onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    } else {
      if (!props.comma)
        onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
      if (props.comment) {
        let prevItemComment = "";
        loop: for (const st of start) {
          switch (st.type) {
            case "comma":
            case "space":
              break;
            case "comment":
              prevItemComment = st.source.substring(1);
              break loop;
            default:
              break loop;
          }
        }
        if (prevItemComment) {
          let prev = coll.items[coll.items.length - 1];
          if (isPair(prev))
            prev = prev.value ?? prev.key;
          if (prev.comment)
            prev.comment += "\n" + prevItemComment;
          else
            prev.comment = prevItemComment;
          props.comment = props.comment.substring(prevItemComment.length + 1);
        }
      }
    }
    if (!isMap2 && !sep && !props.found) {
      const valueNode = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, sep, null, props, onError);
      coll.items.push(valueNode);
      offset = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode2(ctx, key, props, onError) : composeEmptyNode2(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps(sep ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (valueProps.found) {
        if (!isMap2 && !props.found && ctx.options.strict) {
          if (sep)
            for (const st of sep) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          if (props.start < valueProps.found.offset - 1024)
            onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else if (value) {
        if ("source" in value && value.source?.[0] === ":")
          onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
        else
          onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode2(ctx, valueProps.end, sep, null, valueProps, onError) : null;
      if (valueNode) {
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      if (isMap2) {
        const map2 = coll;
        if (mapIncludes(ctx, map2.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map2.items.push(pair);
      } else {
        const map2 = new YAMLMap(ctx.schema);
        map2.flow = true;
        map2.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map2.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map2);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap2 ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset;
  if (ce?.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
    if (ce && ce.source.length !== 1)
      ee.unshift(ce);
  }
  if (ee.length > 0) {
    const end = resolveEnd(ee, cePos, ctx.options.strict, onError);
    if (end.comment) {
      if (coll.comment)
        coll.comment += "\n" + end.comment;
      else
        coll.comment = end.comment;
    }
    coll.range = [fc.offset, cePos, end.offset];
  } else {
    coll.range = [fc.offset, cePos, cePos];
  }
  return coll;
}

// ../../node_modules/yaml/browser/dist/compose/compose-collection.js
function resolveCollection(CN2, ctx, token, onError, tagName, tag) {
  const coll = token.type === "block-map" ? resolveBlockMap(CN2, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq(CN2, ctx, token, onError, tag) : resolveFlowCollection(CN2, ctx, token, onError, tag);
  const Coll = coll.constructor;
  if (tagName === "!" || tagName === Coll.tagName) {
    coll.tag = Coll.tagName;
    return coll;
  }
  if (tagName)
    coll.tag = tagName;
  return coll;
}
function composeCollection(CN2, ctx, token, props, onError) {
  const tagToken = props.tag;
  const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
  if (token.type === "block-seq") {
    const { anchor, newlineAfterProp: nl } = props;
    const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    if (lastProp && (!nl || nl.offset < lastProp.offset)) {
      const message = "Missing newline after block sequence props";
      onError(lastProp, "MISSING_CHAR", message);
    }
  }
  const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.tagName && expType === "seq") {
    return resolveCollection(CN2, ctx, token, onError, tagName);
  }
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    const kt = ctx.schema.knownTags[tagName];
    if (kt?.collection === expType) {
      ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
      tag = kt;
    } else {
      if (kt) {
        onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
      } else {
        onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
      }
      return resolveCollection(CN2, ctx, token, onError, tagName);
    }
  }
  const coll = resolveCollection(CN2, ctx, token, onError, tagName, tag);
  const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
  const node = isNode(res) ? res : new Scalar(res);
  node.range = coll.range;
  node.tag = tagName;
  if (tag?.format)
    node.format = tag.format;
  return node;
}

// ../../node_modules/yaml/browser/dist/compose/resolve-block-scalar.js
function resolveBlockScalar(ctx, scalar, onError) {
  const start = scalar.offset;
  const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  const type = header.mode === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
  const lines2 = scalar.source ? splitLines(scalar.source) : [];
  let chompStart = lines2.length;
  for (let i = lines2.length - 1; i >= 0; --i) {
    const content = lines2[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    const value2 = header.chomp === "+" && lines2.length > 0 ? "\n".repeat(Math.max(1, lines2.length - 1)) : "";
    let end2 = start + header.length;
    if (scalar.source)
      end2 += scalar.source.length;
    return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
  }
  let trimIndent = scalar.indent + header.indent;
  let offset = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0; i < chompStart; ++i) {
    const [indent, content] = lines2[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset, "BAD_INDENT", message);
      }
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines2.length - 1; i >= chompStart; --i) {
    if (lines2[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep = "";
  let prevMoreIndented = false;
  for (let i = 0; i < contentStart; ++i)
    value += lines2[i][0].slice(trimIndent) + "\n";
  for (let i = contentStart; i < chompStart; ++i) {
    let [indent, content] = lines2[i];
    offset += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar.BLOCK_LITERAL) {
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
    } else if (indent.length > trimIndent || content[0] === "	") {
      if (sep === " ")
        sep = "\n";
      else if (!prevMoreIndented && sep === "\n")
        sep = "\n\n";
      value += sep + indent.slice(trimIndent) + content;
      sep = "\n";
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep === "\n")
        value += "\n";
      else
        sep = "\n";
    } else {
      value += sep + content;
      sep = " ";
      prevMoreIndented = false;
    }
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart; i < lines2.length; ++i)
        value += "\n" + lines2[i][0].slice(trimIndent);
      if (value[value.length - 1] !== "\n")
        value += "\n";
      break;
    default:
      value += "\n";
  }
  const end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header") {
    onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
    return null;
  }
  const { source } = props[0];
  const mode = source[0];
  let indent = 0;
  let chomp = "";
  let error = -1;
  for (let i = 1; i < source.length; ++i) {
    const ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      const n = Number(ch);
      if (!indent && n)
        indent = n;
      else if (error === -1)
        error = offset + i;
    }
  }
  if (error !== -1)
    onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = false;
  let comment = "";
  let length = source.length;
  for (let i = 1; i < props.length; ++i) {
    const token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = true;
      // fallthrough
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        if (strict && !hasSpace) {
          const message = "Comments must be separated from other tokens by white space characters";
          onError(token, "MISSING_CHAR", message);
        }
        length += token.source.length;
        comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message);
        length += token.source.length;
        break;
      /* istanbul ignore next should not happen */
      default: {
        const message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        const ts = token.source;
        if (ts && typeof ts === "string")
          length += ts.length;
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
function splitLines(source) {
  const split = source.split(/\n( *)/);
  const first = split[0];
  const m = first.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
  const lines2 = [line0];
  for (let i = 1; i < split.length; i += 2)
    lines2.push([split[i], split[i + 1]]);
  return lines2;
}

// ../../node_modules/yaml/browser/dist/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  const { offset, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
  switch (type) {
    case "scalar":
      _type = Scalar.PLAIN;
      value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar.QUOTE_SINGLE;
      value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar.QUOTE_DOUBLE;
      value = doubleQuotedValue(source, _onError);
      break;
    /* istanbul ignore next should not happen */
    default:
      onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
      return {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    /* istanbul ignore next should not happen */
    case "	":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  if (badChar)
    onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
  return foldLines(source);
}
function singleQuotedValue(source, onError) {
  if (source[source.length - 1] !== "'" || source.length === 1)
    onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
  return foldLines(source.slice(1, -1)).replace(/''/g, "'");
}
function foldLines(source) {
  let first, line;
  try {
    first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
    line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
  } catch {
    first = /(.*?)[ \t]*\r?\n/sy;
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
  }
  let match = first.exec(source);
  if (!match)
    return source;
  let res = match[1];
  let sep = " ";
  let pos = first.lastIndex;
  line.lastIndex = pos;
  while (match = line.exec(source)) {
    if (match[1] === "") {
      if (sep === "\n")
        res += sep;
      else
        sep = "\n";
    } else {
      res += sep + match[1];
      sep = " ";
    }
    pos = line.lastIndex;
  }
  const last = /[ \t]*(.*)/sy;
  last.lastIndex = pos;
  match = last.exec(source);
  return res + sep + (match?.[1] ?? "");
}
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1; i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === "\n")
      continue;
    if (ch === "\n") {
      const { fold, offset } = foldNewline(source, i);
      res += fold;
      i = offset;
    } else if (ch === "\\") {
      let next = source[++i];
      const cc = escapeCodes[next];
      if (cc)
        res += cc;
      else if (next === "\n") {
        next = source[i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "\r" && source[i + 1] === "\n") {
        next = source[++i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "x" || next === "u" || next === "U") {
        const length = next === "x" ? 2 : next === "u" ? 4 : 8;
        res += parseCharCode(source, i + 1, length, onError);
        i += length;
      } else {
        const raw = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        res += raw;
      }
    } else if (ch === " " || ch === "	") {
      const wsStart = i;
      let next = source[i + 1];
      while (next === " " || next === "	")
        next = source[++i + 1];
      if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
        res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
    } else {
      res += ch;
    }
  }
  if (source[source.length - 1] !== '"' || source.length === 1)
    onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
  return res;
}
function foldNewline(source, offset) {
  let fold = "";
  let ch = source[offset + 1];
  while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
    if (ch === "\r" && source[offset + 2] !== "\n")
      break;
    if (ch === "\n")
      fold += "\n";
    offset += 1;
    ch = source[offset + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset };
}
var escapeCodes = {
  "0": "\0",
  // null character
  a: "\x07",
  // bell character
  b: "\b",
  // backspace
  e: "\x1B",
  // escape character
  f: "\f",
  // form feed
  n: "\n",
  // line feed
  r: "\r",
  // carriage return
  t: "	",
  // horizontal tab
  v: "\v",
  // vertical tab
  N: "\x85",
  // Unicode next line
  _: "\xA0",
  // Unicode non-breaking space
  L: "\u2028",
  // Unicode line separator
  P: "\u2029",
  // Unicode paragraph separator
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "	": "	"
};
function parseCharCode(source, offset, length, onError) {
  const cc = source.substr(offset, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code = ok ? parseInt(cc, 16) : NaN;
  try {
    return String.fromCodePoint(code);
  } catch {
    const raw = source.substr(offset - 2, length + 2);
    onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
    return raw;
  }
}

// ../../node_modules/yaml/browser/dist/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError);
  const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  let tag;
  if (ctx.options.stringKeys && ctx.atKey) {
    tag = ctx.schema[SCALAR];
  } else if (tagName)
    tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
  else if (token.type === "scalar")
    tag = findScalarTagByTest(ctx, value, token, onError);
  else
    tag = ctx.schema[SCALAR];
  let scalar;
  try {
    const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = isScalar(res) ? res : new Scalar(res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
    scalar = new Scalar(value);
  }
  scalar.range = range;
  scalar.source = value;
  if (type)
    scalar.type = type;
  if (tagName)
    scalar.tag = tagName;
  if (tag.format)
    scalar.format = tag.format;
  if (comment)
    scalar.comment = comment;
  return scalar;
}
function findScalarTagByName(schema4, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema4[SCALAR];
  const matchWithTest = [];
  for (const tag of schema4.tags) {
    if (!tag.collection && tag.tag === tagName) {
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
    }
  }
  for (const tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  const kt = schema4.knownTags[tagName];
  if (kt && !kt.collection) {
    schema4.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
    return kt;
  }
  onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
  return schema4[SCALAR];
}
function findScalarTagByTest({ atKey, directives, schema: schema4 }, value, token, onError) {
  const tag = schema4.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema4[SCALAR];
  if (schema4.compat) {
    const compat = schema4.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema4[SCALAR];
    if (tag.tag !== compat.tag) {
      const ts = directives.tagString(tag.tag);
      const cs = directives.tagString(compat.tag);
      const msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, true);
    }
  }
  return tag;
}

// ../../node_modules/yaml/browser/dist/compose/util-empty-scalar-position.js
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    pos ?? (pos = before.length);
    for (let i = pos - 1; i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset;
}

// ../../node_modules/yaml/browser/dist/compose/compose-node.js
var CN = { composeNode, composeEmptyNode };
function composeNode(ctx, token, props, onError) {
  const atKey = ctx.atKey;
  const { spaceBefore, comment, anchor, tag } = props;
  let node;
  let isSrcToken = true;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError);
      if (anchor || tag)
        onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar(ctx, token, tag, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      try {
        node = composeCollection(CN, ctx, token, props, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(token, "RESOURCE_EXHAUSTION", message);
      }
      break;
    default: {
      const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message);
      isSrcToken = false;
    }
  }
  node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
  if (anchor && node.anchor === "")
    onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  if (atKey && ctx.options.stringKeys && (!isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
    const msg = "With stringKeys, all keys must be strings";
    onError(tag ?? token, "NON_STRING_KEY", msg);
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    if (token.type === "scalar" && token.source === "")
      node.comment = comment;
    else
      node.commentBefore = comment;
  }
  if (ctx.options.keepSourceTokens && isSrcToken)
    node.srcToken = token;
  return node;
}
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  };
  const node = composeScalar(ctx, token, tag, onError);
  if (anchor) {
    node.anchor = anchor.source.substring(1);
    if (node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    node.comment = comment;
    node.range[2] = end;
  }
  return node;
}
function composeAlias({ options }, { offset, source, end }, onError) {
  const alias = new Alias(source.substring(1));
  if (alias.source === "")
    onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}

// ../../node_modules/yaml/browser/dist/compose/compose-doc.js
function composeDoc(options, directives, { offset, start, value, end }, onError) {
  const opts = Object.assign({ _directives: directives }, options);
  const doc = new Document(void 0, opts);
  const ctx = {
    atKey: false,
    atRoot: true,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  };
  const props = resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: true
  });
  if (props.found) {
    doc.directives.docStart = true;
    if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
      onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
  }
  doc.contents = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
  const contentEnd = doc.contents.range[2];
  const re = resolveEnd(end, contentEnd, false, onError);
  if (re.comment)
    doc.comment = re.comment;
  doc.range = [offset, contentEnd, re.offset];
  return doc;
}

// ../../node_modules/yaml/browser/dist/compose/composer.js
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset, source } = src;
  return [offset, offset + (typeof source === "string" ? source.length : 1)];
}
function parsePrelude(prelude) {
  let comment = "";
  let atComment = false;
  let afterEmptyLine = false;
  for (let i = 0; i < prelude.length; ++i) {
    const source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
        atComment = true;
        afterEmptyLine = false;
        break;
      case "%":
        if (prelude[i + 1]?.[0] !== "#")
          i += 1;
        atComment = false;
        break;
      default:
        if (!atComment)
          afterEmptyLine = true;
        atComment = false;
    }
  }
  return { comment, afterEmptyLine };
}
var Composer = class {
  constructor(options = {}) {
    this.doc = null;
    this.atDirectives = false;
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
    this.onError = (source, code, message, warning) => {
      const pos = getErrorPos(source);
      if (warning)
        this.warnings.push(new YAMLWarning(pos, code, message));
      else
        this.errors.push(new YAMLParseError(pos, code, message));
    };
    this.directives = new Directives({ version: options.version || "1.2" });
    this.options = options;
  }
  decorate(doc, afterDoc) {
    const { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      const dc = doc.contents;
      if (afterDoc) {
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      } else if (afterEmptyLine || doc.directives.docStart || !dc) {
        doc.commentBefore = comment;
      } else if (isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        if (isPair(it))
          it = it.key;
        const cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        const cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      for (let i = 0; i < this.errors.length; ++i)
        doc.errors.push(this.errors[i]);
      for (let i = 0; i < this.warnings.length; ++i)
        doc.warnings.push(this.warnings[i]);
    } else {
      doc.errors = this.errors;
      doc.warnings = this.warnings;
    }
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
  }
  /**
   * Current stream status information.
   *
   * Mostly useful at the end of input for an empty stream.
   */
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  /**
   * Compose tokens into documents.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *compose(tokens, forceDoc = false, endOffset = -1) {
    for (const token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  /** Advance the composer by one CST token. */
  *next(token) {
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset;
          this.onError(pos, "BAD_DIRECTIVE", message, warning);
        });
        this.prelude.push(token.source);
        this.atDirectives = true;
        break;
      case "document": {
        const doc = composeDoc(this.options, this.directives, token, this.onError);
        if (this.atDirectives && !doc.directives.docStart)
          this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
        this.decorate(doc, false);
        if (this.doc)
          yield this.doc;
        this.doc = doc;
        this.atDirectives = false;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
        const error = new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        if (this.atDirectives || !this.doc)
          this.errors.push(error);
        else
          this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          const msg = "Unexpected doc-end without preceding document";
          this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = true;
        const end = resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        this.decorate(this.doc, true);
        if (end.comment) {
          const dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  /**
   * Call at end of input to yield any remaining document.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *end(forceDoc = false, endOffset = -1) {
    if (this.doc) {
      this.decorate(this.doc, true);
      yield this.doc;
      this.doc = null;
    } else if (forceDoc) {
      const opts = Object.assign({ _directives: this.directives }, this.options);
      const doc = new Document(void 0, opts);
      if (this.atDirectives)
        this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
      doc.range = [0, endOffset, endOffset];
      this.decorate(doc, false);
      yield doc;
    }
  }
};

// ../../node_modules/yaml/browser/dist/parse/cst-visit.js
var BREAK2 = /* @__PURE__ */ Symbol("break visit");
var SKIP2 = /* @__PURE__ */ Symbol("skip children");
var REMOVE2 = /* @__PURE__ */ Symbol("remove item");
function visit2(cst, visitor) {
  if ("type" in cst && cst.type === "document")
    cst = { start: cst.start, value: cst.value };
  _visit(Object.freeze([]), cst, visitor);
}
visit2.BREAK = BREAK2;
visit2.SKIP = SKIP2;
visit2.REMOVE = REMOVE2;
visit2.itemAtPath = (cst, path2) => {
  let item = cst;
  for (const [field, index] of path2) {
    const tok = item?.[field];
    if (tok && "items" in tok) {
      item = tok.items[index];
    } else
      return void 0;
  }
  return item;
};
visit2.parentCollection = (cst, path2) => {
  const parent = visit2.itemAtPath(cst, path2.slice(0, -1));
  const field = path2[path2.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path2, item, visitor) {
  let ctrl = visitor(item, path2);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item[field];
    if (token && "items" in token) {
      for (let i = 0; i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path2.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK2)
          return BREAK2;
        else if (ci === REMOVE2) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item, path2);
    }
  }
  return typeof ctrl === "function" ? ctrl(item, path2) : ctrl;
}

// ../../node_modules/yaml/browser/dist/parse/cst.js
var BOM = "\uFEFF";
var DOCUMENT = "";
var FLOW_END = "";
var SCALAR2 = "";
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR2:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case "\n":
    case "\r\n":
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "	":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}

// ../../node_modules/yaml/browser/dist/parse/lexer.js
function isEmpty(ch) {
  switch (ch) {
    case void 0:
    case " ":
    case "\n":
    case "\r":
    case "	":
      return true;
    default:
      return false;
  }
}
var hexDigits = new Set("0123456789ABCDEFabcdef");
var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
var flowIndicatorChars = new Set(",[]{}");
var invalidAnchorChars = new Set(" ,[]{}\n\r	");
var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
var Lexer = class {
  constructor() {
    this.atEnd = false;
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    this.buffer = "";
    this.flowKey = false;
    this.flowLevel = 0;
    this.indentNext = 0;
    this.indentValue = 0;
    this.lineEndPos = null;
    this.next = null;
    this.pos = 0;
  }
  /**
   * Generate YAML tokens from the `source` string. If `incomplete`,
   * a part of the last line may be left as a buffer for the next call.
   *
   * @returns A generator of lexical tokens
   */
  *lex(source, incomplete = false) {
    if (source) {
      if (typeof source !== "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source;
      this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    while (next && (incomplete || this.hasChars(1)))
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos;
    let ch = this.buffer[i];
    while (ch === " " || ch === "	")
      ch = this.buffer[++i];
    if (!ch || ch === "#" || ch === "\n")
      return true;
    if (ch === "\r")
      return this.buffer[i + 1] === "\n";
    return false;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        const next = this.buffer[indent + offset + 1];
        if (next === "\n" || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    if (typeof end !== "number" || end !== -1 && end < this.pos) {
      end = this.buffer.indexOf("\n", this.pos);
      this.lineEndPos = end;
    }
    if (end === -1)
      return this.atEnd ? this.buffer.substring(this.pos) : null;
    if (this.buffer[end - 1] === "\r")
      end -= 1;
    return this.buffer.substring(this.pos, end);
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    this.buffer = this.buffer.substring(this.pos);
    this.pos = 0;
    this.lineEndPos = null;
    this.next = state;
    return null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === BOM) {
      yield* this.pushCount(1);
      line = line.substring(1);
    }
    if (line[0] === "%") {
      let dirEnd = line.length;
      let cs = line.indexOf("#");
      while (cs !== -1) {
        const ch = line[cs - 1];
        if (ch === " " || ch === "	") {
          dirEnd = cs - 1;
          break;
        } else {
          cs = line.indexOf("#", cs + 1);
        }
      }
      while (true) {
        const ch = line[dirEnd - 1];
        if (ch === " " || ch === "	")
          dirEnd -= 1;
        else
          break;
      }
      const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
      yield* this.pushCount(line.length - n);
      this.pushNewline();
      return "stream";
    }
    if (this.atLineEnd()) {
      const sp = yield* this.pushSpaces(true);
      yield* this.pushCount(line.length - sp);
      yield* this.pushNewline();
      return "stream";
    }
    yield DOCUMENT;
    return yield* this.parseLineStart();
  }
  *parseLineStart() {
    const ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      const s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
        yield* this.pushCount(3);
        this.indentValue = 0;
        this.indentNext = 0;
        return s === "---" ? "doc" : "stream";
      }
    }
    this.indentValue = yield* this.pushSpaces(false);
    if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
      this.indentNext = this.indentValue;
    return yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    const [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
      this.indentNext = this.indentValue + 1;
      this.indentValue += n;
      return "block-start";
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(true);
    const line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      // fallthrough
      case void 0:
        yield* this.pushNewline();
        return yield* this.parseLineStart();
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel = 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        return "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        n += yield* this.parseBlockScalarHeader();
        n += yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - n);
        yield* this.pushNewline();
        return yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp;
    let indent = -1;
    do {
      nl = yield* this.pushNewline();
      if (nl > 0) {
        sp = yield* this.pushSpaces(false);
        this.indentValue = indent = sp;
      } else {
        sp = 0;
      }
      sp += yield* this.pushSpaces(true);
    } while (nl + sp > 0);
    const line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
      const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
      if (!atFlowEndMarker) {
        this.flowLevel = 0;
        yield FLOW_END;
        return yield* this.parseLineStart();
      }
    }
    let n = 0;
    while (line[n] === ",") {
      n += yield* this.pushCount(1);
      n += yield* this.pushSpaces(true);
      this.flowKey = false;
    }
    n += yield* this.pushIndicators();
    switch (line[n]) {
      case void 0:
        return "flow";
      case "#":
        yield* this.pushCount(line.length - n);
        return "flow";
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel += 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        this.flowKey = true;
        this.flowLevel -= 1;
        return this.flowLevel ? "flow" : "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "flow";
      case '"':
      case "'":
        this.flowKey = true;
        return yield* this.parseQuotedScalar();
      case ":": {
        const next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",") {
          this.flowKey = false;
          yield* this.pushCount(1);
          yield* this.pushSpaces(true);
          return "flow";
        }
      }
      // fallthrough
      default:
        this.flowKey = false;
        return yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    const quote = this.charAt(0);
    let end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'") {
      while (end !== -1 && this.buffer[end + 1] === "'")
        end = this.buffer.indexOf("'", end + 2);
    } else {
      while (end !== -1) {
        let n = 0;
        while (this.buffer[end - 1 - n] === "\\")
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    }
    const qb = this.buffer.substring(0, end);
    let nl = qb.indexOf("\n", this.pos);
    if (nl !== -1) {
      while (nl !== -1) {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf("\n", cs);
      }
      if (nl !== -1) {
        end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
      }
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    yield* this.pushToIndex(end + 1, false);
    return this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    let i = this.pos;
    while (true) {
      const ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = true;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1;
    let indent = 0;
    let ch;
    loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
      switch (ch) {
        case " ":
          indent += 1;
          break;
        case "\n":
          nl = i2;
          indent = 0;
          break;
        case "\r": {
          const next = this.buffer[i2 + 1];
          if (!next && !this.atEnd)
            return this.setNext("block-scalar");
          if (next === "\n")
            break;
        }
        // fallthrough
        default:
          break loop;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      if (this.blockScalarIndent === -1)
        this.indentNext = indent;
      else {
        this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      }
      do {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf("\n", cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    ch = this.buffer[i];
    while (ch === " ")
      ch = this.buffer[++i];
    if (ch === "	") {
      while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep) {
      do {
        let i2 = nl - 1;
        let ch2 = this.buffer[i2];
        if (ch2 === "\r")
          ch2 = this.buffer[--i2];
        const lastChar = i2;
        while (ch2 === " ")
          ch2 = this.buffer[--i2];
        if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
          nl = i2;
        else
          break;
      } while (true);
    }
    yield SCALAR2;
    yield* this.pushToIndex(nl + 1, true);
    return yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    const inFlow = this.flowLevel > 0;
    let end = this.pos - 1;
    let i = this.pos - 1;
    let ch;
    while (ch = this.buffer[++i]) {
      if (ch === ":") {
        const next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r") {
          if (next === "\n") {
            i += 1;
            ch = "\n";
            next = this.buffer[i + 1];
          } else
            end = i;
        }
        if (next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === "\n") {
          const cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("plain-scalar");
    yield SCALAR2;
    yield* this.pushToIndex(end + 1, true);
    return inFlow ? "flow" : "doc";
  }
  *pushCount(n) {
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos += n;
      return n;
    }
    return 0;
  }
  *pushToIndex(i, allowEmpty) {
    const s = this.buffer.slice(this.pos, i);
    if (s) {
      yield s;
      this.pos += s.length;
      return s.length;
    } else if (allowEmpty)
      yield "";
    return 0;
  }
  *pushIndicators() {
    let n = 0;
    loop: while (true) {
      switch (this.charAt(0)) {
        case "!":
          n += yield* this.pushTag();
          n += yield* this.pushSpaces(true);
          continue loop;
        case "&":
          n += yield* this.pushUntil(isNotAnchorChar);
          n += yield* this.pushSpaces(true);
          continue loop;
        case "-":
        // this is an error
        case "?":
        // this is an error outside flow collections
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            n += yield* this.pushCount(1);
            n += yield* this.pushSpaces(true);
            continue loop;
          }
        }
      }
      break loop;
    }
    return n;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2;
      let ch = this.buffer[i];
      while (!isEmpty(ch) && ch !== ">")
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
    } else {
      let i = this.pos + 1;
      let ch = this.buffer[i];
      while (ch) {
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
          ch = this.buffer[i += 3];
        } else
          break;
      }
      return yield* this.pushToIndex(i, false);
    }
  }
  *pushNewline() {
    const ch = this.buffer[this.pos];
    if (ch === "\n")
      return yield* this.pushCount(1);
    else if (ch === "\r" && this.charAt(1) === "\n")
      return yield* this.pushCount(2);
    else
      return 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1;
    let ch;
    do {
      ch = this.buffer[++i];
    } while (ch === " " || allowTabs && ch === "	");
    const n = i - this.pos;
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos = i;
    }
    return n;
  }
  *pushUntil(test) {
    let i = this.pos;
    let ch = this.buffer[i];
    while (!test(ch))
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, false);
  }
};

// ../../node_modules/yaml/browser/dist/parse/line-counter.js
var LineCounter = class {
  constructor() {
    this.lineStarts = [];
    this.addNewLine = (offset) => this.lineStarts.push(offset);
    this.linePos = (offset) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset - start + 1 };
    };
  }
};

// ../../node_modules/yaml/browser/dist/parse/parser.js
function includesToken(list, type) {
  for (let i = 0; i < list.length; ++i)
    if (list[i].type === type)
      return true;
  return false;
}
function findNonEmptyIndex(list) {
  for (let i = 0; i < list.length; ++i) {
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  }
  return -1;
}
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return true;
    default:
      return false;
  }
}
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      const it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    /* istanbul ignore next should not happen */
    default:
      return [];
  }
}
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop: while (--i >= 0) {
    switch (prev[i].type) {
      case "doc-start":
      case "explicit-key-ind":
      case "map-value-ind":
      case "seq-item-ind":
      case "newline":
        break loop;
    }
  }
  while (prev[++i]?.type === "space") {
  }
  return prev.splice(i, prev.length);
}
function arrayPushArray(target, source) {
  if (source.length < 1e5)
    Array.prototype.push.apply(target, source);
  else
    for (let i = 0; i < source.length; ++i)
      target.push(source[i]);
}
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start") {
    for (const it of fc.items) {
      if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
        if (it.key)
          it.value = it.key;
        delete it.key;
        if (isFlowToken(it.value)) {
          if (it.value.end)
            arrayPushArray(it.value.end, it.sep);
          else
            it.value.end = it.sep;
        } else
          arrayPushArray(it.start, it.sep);
        delete it.sep;
      }
    }
  }
}
var Parser = class {
  /**
   * @param onNewLine - If defined, called separately with the start position of
   *   each new line (in `parse()`, including the start of input).
   */
  constructor(onNewLine) {
    this.atNewLine = true;
    this.atScalar = false;
    this.indent = 0;
    this.offset = 0;
    this.onKeyLine = false;
    this.stack = [];
    this.source = "";
    this.type = "";
    this.lexer = new Lexer();
    this.onNewLine = onNewLine;
  }
  /**
   * Parse `source` as a YAML stream.
   * If `incomplete`, a part of the last line may be left as a buffer for the next call.
   *
   * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
   *
   * @returns A generator of tokens representing each directive, document, and other structure.
   */
  *parse(source, incomplete = false) {
    if (this.onNewLine && this.offset === 0)
      this.onNewLine(0);
    for (const lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    if (!incomplete)
      yield* this.end();
  }
  /**
   * Advance the parser by the `source` of one lexical token.
   */
  *next(source) {
    this.source = source;
    if (this.atScalar) {
      this.atScalar = false;
      yield* this.step();
      this.offset += source.length;
      return;
    }
    const type = tokenType(source);
    if (!type) {
      const message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source });
      this.offset += source.length;
    } else if (type === "scalar") {
      this.atNewLine = false;
      this.atScalar = true;
      this.type = "scalar";
    } else {
      this.type = type;
      yield* this.step();
      switch (type) {
        case "newline":
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine)
            this.onNewLine(this.offset + source.length);
          break;
        case "space":
          if (this.atNewLine && source[0] === " ")
            this.indent += source.length;
          break;
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
          if (this.atNewLine)
            this.indent += source.length;
          break;
        case "doc-mode":
        case "flow-error-end":
          return;
        default:
          this.atNewLine = false;
      }
      this.offset += source.length;
    }
  }
  /** Call at end of input to push out any remaining constructions */
  *end() {
    while (this.stack.length > 0)
      yield* this.pop();
  }
  get sourceToken() {
    const st = {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
    return st;
  }
  *step() {
    const top = this.peek(1);
    if (this.type === "doc-end" && top?.type !== "doc-end") {
      while (this.stack.length > 0)
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    const token = error ?? this.stack.pop();
    if (!token) {
      const message = "Tried to pop an empty stack";
      yield { type: "error", offset: this.offset, source: "", message };
    } else if (this.stack.length === 0) {
      yield token;
    } else {
      const top = this.peek(1);
      if (token.type === "block-scalar") {
        token.indent = "indent" in top ? top.indent : 0;
      } else if (token.type === "flow-collection" && top.type === "document") {
        token.indent = 0;
      }
      if (token.type === "flow-collection")
        fixFlowSeqItems(token);
      switch (top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          const it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] });
            this.onKeyLine = true;
            return;
          } else if (it.sep) {
            it.value = token;
          } else {
            Object.assign(it, { key: token, sep: [] });
            this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          const it = top.items[top.items.length - 1];
          if (it.value)
            top.items.push({ start: [], value: token });
          else
            it.value = token;
          break;
        }
        case "flow-collection": {
          const it = top.items[top.items.length - 1];
          if (!it || it.value)
            top.items.push({ start: [], key: token, sep: [] });
          else if (it.sep)
            it.value = token;
          else
            Object.assign(it, { key: token, sep: [] });
          return;
        }
        /* istanbul ignore next should not happen */
        default:
          yield* this.pop();
          yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        const last = token.items[token.items.length - 1];
        if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last.start;
          else
            top.items.push({ start: last.start });
          token.items.splice(-1, 1);
        }
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        const doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        if (this.type === "doc-start")
          doc.start.push(this.sourceToken);
        this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        if (findNonEmptyIndex(doc.start) !== -1) {
          yield* this.pop();
          yield* this.step();
        } else
          doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    const bv = this.startBlockValue(doc);
    if (bv)
      this.stack.push(bv);
    else {
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML document`,
        source: this.source
      };
    }
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      const prev = getPrevProps(this.peek(2));
      const start = getFirstKeyStartProps(prev);
      let sep;
      if (scalar.end) {
        sep = scalar.end;
        sep.push(this.sourceToken);
        delete scalar.end;
      } else
        sep = [this.sourceToken];
      const map2 = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map2;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        scalar.source = this.source;
        this.atNewLine = true;
        this.indent = 0;
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        yield* this.pop();
        break;
      /* istanbul ignore next should not happen */
      default:
        yield* this.pop();
        yield* this.step();
    }
  }
  *blockMap(map2) {
    const it = map2.items[map2.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map2.indent)) {
            const prev = map2.items[map2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              map2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map2.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map2.indent;
      const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
      let start = [];
      if (atNextItem && it.sep && !it.value) {
        const nl = [];
        for (let i = 0; i < it.sep.length; ++i) {
          const st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              if (st.indent > map2.indent)
                nl.length = 0;
              break;
            default:
              nl.length = 0;
          }
        }
        if (nl.length >= 2)
          start = it.sep.splice(nl[1]);
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start });
            this.onKeyLine = true;
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "explicit-key-ind":
          if (!it.sep && !it.explicitKey) {
            it.start.push(this.sourceToken);
            it.explicitKey = true;
          } else if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start, explicitKey: true });
          } else {
            this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken], explicitKey: true }]
            });
          }
          this.onKeyLine = true;
          return;
        case "map-value-ind":
          if (it.explicitKey) {
            if (!it.sep) {
              if (includesToken(it.start, "newline")) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else {
                const start2 = getFirstKeyStartProps(it.start);
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                });
              }
            } else if (it.value) {
              map2.items.push({ start: [], key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key: null, sep: [this.sourceToken] }]
              });
            } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
              const start2 = getFirstKeyStartProps(it.start);
              const key = it.key;
              const sep = it.sep;
              sep.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: start2, key, sep }]
              });
            } else if (start.length > 0) {
              it.sep = it.sep.concat(start, this.sourceToken);
            } else {
              it.sep.push(this.sourceToken);
            }
          } else {
            if (!it.sep) {
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            } else if (it.value || atNextItem) {
              map2.items.push({ start, key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [], key: null, sep: [this.sourceToken] }]
              });
            } else {
              it.sep.push(this.sourceToken);
            }
          }
          this.onKeyLine = true;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs2 = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map2.items.push({ start, key: fs2, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs2);
          } else {
            Object.assign(it, { key: fs2, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map2);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else if (atMapIndent) {
              map2.items.push({ start });
            }
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *blockSequence(seq2) {
    const it = seq2.items[seq2.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            seq2.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq2.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq2.indent)) {
            const prev = seq2.items[seq2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              seq2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq2.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq2.indent)
          break;
        if (it.value || includesToken(it.start, "seq-item-ind"))
          seq2.items.push({ start: [this.sourceToken] });
        else
          it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq2.indent) {
      const bv = this.startBlockValue(seq2);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *flowCollection(fc) {
    const it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do {
        yield* this.pop();
        top = this.peek(1);
      } while (top?.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          if (!it || it.sep)
            fc.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          if (!it || it.value)
            fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          if (!it || it.value)
            fc.items.push({ start: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs2 = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs2, sep: [] });
          else if (it.sep)
            this.stack.push(fs2);
          else
            Object.assign(it, { key: fs2, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(fc);
      if (bv)
        this.stack.push(bv);
      else {
        yield* this.pop();
        yield* this.step();
      }
    } else {
      const parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
        yield* this.pop();
        yield* this.step();
      } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        const sep = fc.end.splice(1, fc.end.length);
        sep.push(this.sourceToken);
        const map2 = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map2;
      } else {
        yield* this.lineEnd(fc);
      }
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf("\n") + 1;
      while (nl !== 0) {
        this.onNewLine(this.offset + nl);
        nl = this.source.indexOf("\n", nl) + 1;
      }
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        start.push(this.sourceToken);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: true }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    if (this.type !== "comment")
      return false;
    if (this.indent <= indent)
      return false;
    return start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    if (this.type !== "doc-mode") {
      if (docEnd.end)
        docEnd.end.push(this.sourceToken);
      else
        docEnd.end = [this.sourceToken];
      if (this.type === "newline")
        yield* this.pop();
    }
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop();
        yield* this.step();
        break;
      case "newline":
        this.onKeyLine = false;
      // fallthrough
      case "space":
      case "comment":
      default:
        if (token.end)
          token.end.push(this.sourceToken);
        else
          token.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
    }
  }
};

// ../../node_modules/yaml/browser/dist/public-api.js
function parseOptions(options) {
  const prettyErrors = options.prettyErrors !== false;
  const lineCounter = options.lineCounter || prettyErrors && new LineCounter() || null;
  return { lineCounter, prettyErrors };
}
function parseDocument(source, options = {}) {
  const { lineCounter, prettyErrors } = parseOptions(options);
  const parser = new Parser(lineCounter?.addNewLine);
  const composer = new Composer(options);
  let doc = null;
  for (const _doc of composer.compose(parser.parse(source), true, source.length)) {
    if (!doc)
      doc = _doc;
    else if (doc.options.logLevel !== "silent") {
      doc.errors.push(new YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
      break;
    }
  }
  if (prettyErrors && lineCounter) {
    doc.errors.forEach(prettifyError(source, lineCounter));
    doc.warnings.forEach(prettifyError(source, lineCounter));
  }
  return doc;
}
function parse(src, reviver, options) {
  let _reviver = void 0;
  if (typeof reviver === "function") {
    _reviver = reviver;
  } else if (options === void 0 && reviver && typeof reviver === "object") {
    options = reviver;
  }
  const doc = parseDocument(src, options);
  if (!doc)
    return null;
  doc.warnings.forEach((warning) => warn(doc.options.logLevel, warning));
  if (doc.errors.length > 0) {
    if (doc.options.logLevel !== "silent")
      throw doc.errors[0];
    else
      doc.errors = [];
  }
  return doc.toJS(Object.assign({ reviver: _reviver }, options));
}

// ../core/src/enforce/rule-parser.ts
function parseRulesFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  return parseRulesContent(content, filePath);
}
var DEFAULT_SIMPLE_RULE_LEVEL = "sprint";
var DEFAULT_SIMPLE_RULE_CONTEXT = ["both"];
var DEFAULT_SIMPLE_RULE_PRIORITY = -100;
var SIMPLE_RULE_TYPES = /* @__PURE__ */ new Set(["command", "filesystem", "content", "env", "network"]);
var SIMPLE_RULE_VALID_ACTIONS = /* @__PURE__ */ new Set(["block", "deny", "warn", "prompt", "allow", "fix", "report", "research", "redirect"]);
function expandSimpleRule(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { error: "a simple_rules entry must be an object" };
  }
  const r = candidate;
  const label = typeof r.id === "string" && r.id.trim() ? r.id : "<unnamed>";
  if (typeof r.id !== "string" || !r.id.trim()) {
    return { error: `simple rule "${label}": missing a non-empty 'id'` };
  }
  if (typeof r.type !== "string" || !SIMPLE_RULE_TYPES.has(r.type)) {
    return {
      error: `rule '${label}': 'type' must be one of command, filesystem, content, env, network (got: ${JSON.stringify(r.type)}) \u2014 for any other rule type, use the full rule format under 'rules:'`
    };
  }
  if (typeof r.action !== "string" || !r.action.trim()) {
    return { error: `rule '${label}': missing an 'action' (e.g. block, deny, warn, allow, prompt, fix)` };
  }
  if (!SIMPLE_RULE_VALID_ACTIONS.has(r.action)) {
    return { error: `rule '${label}': 'action' must be one of ${[...SIMPLE_RULE_VALID_ACTIONS].join(", ")} (got: ${JSON.stringify(r.action)})` };
  }
  if (typeof r.message !== "string" || !r.message.trim()) {
    return { error: `rule '${label}': missing a non-empty 'message' explaining what this rule does` };
  }
  const type = r.type;
  const base = {
    id: r.id,
    type,
    action: r.action,
    message: r.message,
    level: DEFAULT_SIMPLE_RULE_LEVEL,
    context: DEFAULT_SIMPLE_RULE_CONTEXT,
    priority: DEFAULT_SIMPLE_RULE_PRIORITY
  };
  switch (type) {
    case "command": {
      if (typeof r.match !== "string" && typeof r.match_regex !== "string") {
        return { error: `rule '${label}': type 'command' requires a 'match' or 'match_regex' field (the command text or pattern to catch)` };
      }
      if (typeof r.match === "string" && !r.match.trim()) return { error: `rule '${label}': 'match' cannot be empty` };
      if (typeof r.match_regex === "string" && !r.match_regex.trim()) return { error: `rule '${label}': 'match_regex' cannot be empty` };
      if (typeof r.match === "string") base.match = r.match;
      if (typeof r.match_regex === "string") base.match_regex = r.match_regex;
      return { rule: base };
    }
    case "network": {
      if (typeof r.match !== "string" || !r.match.trim()) {
        return { error: `rule '${label}': type 'network' requires a 'match' field (the domain or pattern to catch)` };
      }
      base.match = r.match;
      return { rule: base };
    }
    case "filesystem": {
      if (!Array.isArray(r.paths) || r.paths.length === 0) {
        return { error: `rule '${label}': type 'filesystem' requires a non-empty 'paths' list (e.g. paths: ["**/.env"])` };
      }
      if (r.paths.some((p) => typeof p !== "string" || !p)) {
        return { error: `rule '${label}': every entry in 'paths' must be a non-empty string` };
      }
      base.paths = r.paths;
      return { rule: base };
    }
    case "content": {
      if (!Array.isArray(r.patterns) || r.patterns.length === 0) {
        return { error: `rule '${label}': type 'content' requires a non-empty 'patterns' list of regex strings (e.g. patterns: ["sk-[a-zA-Z0-9]+"])` };
      }
      if (r.patterns.some((p) => typeof p !== "string" || !p)) {
        return { error: `rule '${label}': every entry in 'patterns' must be a non-empty regex string` };
      }
      base.patterns = r.patterns.map((p) => ({ regex: p }));
      return { rule: base };
    }
    case "env": {
      if (!Array.isArray(r.vars) || r.vars.length === 0) {
        return { error: `rule '${label}': type 'env' requires a non-empty 'vars' list of environment variable names` };
      }
      if (r.vars.some((v) => typeof v !== "string" || !v)) {
        return { error: `rule '${label}': every entry in 'vars' must be a non-empty string` };
      }
      base.vars = r.vars;
      return { rule: base };
    }
  }
}
function parseRulesContent(content, sourcePath) {
  const frontmatter = extractFrontmatter(content);
  const markdown = frontmatter ? content.replace(/---\n[\s\S]*?\n---\n?/, "") : content;
  let config = { version: 1 };
  let yamlSource = frontmatter;
  if (!yamlSource) {
    yamlSource = content;
  }
  const errors = [];
  try {
    const parsed = parse(yamlSource);
    if (parsed && typeof parsed === "object" && "keel" in parsed) {
      const candidate = parsed.keel;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        config = candidate;
      } else {
        errors.push("Keel configuration must be an object");
      }
    } else if (parsed && typeof parsed === "object" && ("rules" in parsed || "simple_rules" in parsed)) {
      config = parsed;
    } else if (parsed && typeof parsed === "object" && Object.keys(parsed).length === 0) {
    }
  } catch (error) {
    errors.push(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.rules !== void 0 && !Array.isArray(config.rules)) {
    errors.push("Rules must be an array");
  }
  if (typeof config.version !== "number") errors.push("Keel version must be a number");
  if (config.level !== void 0 && !["sprint", "balanced", "protect"].includes(String(config.level))) {
    errors.push(`Invalid protection level: ${String(config.level)}`);
  }
  if (config.sprint_expiry_hours !== void 0 && (typeof config.sprint_expiry_hours !== "number" || !Number.isFinite(config.sprint_expiry_hours) || config.sprint_expiry_hours < 0)) {
    errors.push(`sprint_expiry_hours must be a non-negative number (0 disables auto-expiry), got: ${String(config.sprint_expiry_hours)}`);
  }
  if (config.sprint_started_at !== void 0 && (typeof config.sprint_started_at !== "string" || !Number.isFinite(Date.parse(config.sprint_started_at)))) {
    errors.push(`sprint_started_at must be an ISO 8601 timestamp, got: ${String(config.sprint_started_at)}`);
  }
  if (config.promotion_fp_threshold !== void 0 && (typeof config.promotion_fp_threshold !== "number" || !Number.isFinite(config.promotion_fp_threshold) || config.promotion_fp_threshold <= 0 || config.promotion_fp_threshold > 1)) {
    errors.push(`promotion_fp_threshold must be a number in (0, 1] (a fraction of evaluations, e.g. 0.001 for 1 per 1000), got: ${String(config.promotion_fp_threshold)}`);
  }
  const expandedSimpleRules = [];
  if (config.simple_rules !== void 0) {
    if (!Array.isArray(config.simple_rules)) {
      errors.push("simple_rules must be an array");
    } else {
      for (const candidate of config.simple_rules) {
        const { rule, error } = expandSimpleRule(candidate);
        if (error) errors.push(error);
        else if (rule) expandedSimpleRules.push(rule);
      }
    }
  }
  return {
    config,
    rules: [...Array.isArray(config.rules) ? config.rules : [], ...expandedSimpleRules],
    sourcePath,
    version: config.version || 1,
    markdown: markdown.trim(),
    ...errors.length ? { errors } : {}
  };
}
function validateRules(rules) {
  const errors = [];
  if (!Array.isArray(rules)) return ["Rules must be an array"];
  const validTypes = /* @__PURE__ */ new Set([
    "command",
    "filesystem",
    "content",
    "env",
    "network",
    "rate",
    "time",
    "sequence",
    "flow",
    "mcp",
    "session",
    "inheritance",
    "context",
    "verification",
    "meta",
    "research",
    "stuck",
    "diagnosis",
    "claim",
    "oracle",
    "package"
  ]);
  const validActions = /* @__PURE__ */ new Set(["block", "deny", "warn", "prompt", "allow", "fix", "report", "research", "redirect"]);
  const validLevels = /* @__PURE__ */ new Set(["sprint", "balanced", "protect"]);
  const validModes = /* @__PURE__ */ new Set(["observe", "warn", "block"]);
  const validSeverities = /* @__PURE__ */ new Set(["critical", "high", "medium", "low"]);
  const validConfidence = /* @__PURE__ */ new Set(["high", "medium", "low"]);
  const validMaturity = /* @__PURE__ */ new Set(["stable", "incubating", "sandbox", "deprecated"]);
  const validCategories = /* @__PURE__ */ new Set([
    "destructive",
    "exfil",
    "escalation",
    "injection",
    "resource",
    "bypass",
    "discipline",
    "workflow",
    "verification",
    "supply-chain"
  ]);
  const validScopes = /* @__PURE__ */ new Set(["global", "user", "project", "folder", "session"]);
  const validRuleContexts = /* @__PURE__ */ new Set(["local", "ci", "both"]);
  const notImplemented = /* @__PURE__ */ new Set(["mcp", "inheritance", "meta", "session", "context"]);
  for (const candidate of rules) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      errors.push("Rule entries must be objects");
      continue;
    }
    const rule = candidate;
    const label = typeof rule.id === "string" && rule.id ? rule.id : "<unnamed>";
    if (typeof rule.id !== "string" || !rule.id.trim()) errors.push("Rule is missing a non-empty id");
    if (rule.type === "research" && !rule.topics?.length && !rule.trigger) {
      errors.push(`Research rule "${label}" needs topics (freshness form) or a trigger (research-before-solve form)`);
    }
    if (rule.type === "oracle") {
      if (!rule.paths?.length && !rule.match) {
        errors.push(`Oracle rule "${label}" needs paths (content-diff surface) or match (command-surface) \u2014 remove it or add a detection surface`);
      }
      if (!rule.trigger) {
        errors.push(`Oracle rule "${label}" needs a trigger (the failing test-run matcher that arms the recency window) \u2014 without it the rule can never fire`);
      }
    }
    if (typeof rule.type === "string" && notImplemented.has(rule.type)) {
      errors.push(`Rule "${label}" uses type "${rule.type}", which is not implemented by the enforcement engine \u2014 remove it or use a supported type`);
      continue;
    }
    if (typeof rule.type !== "string" || !validTypes.has(rule.type)) errors.push(`Rule "${label}" has an unsupported type: ${String(rule.type)}`);
    if (rule.mode !== void 0 && !validModes.has(String(rule.mode))) {
      errors.push(`Rule "${label}" has an unsupported mode: ${String(rule.mode)} (expected observe, warn, or block)`);
    }
    if (rule.severity !== void 0 && !validSeverities.has(String(rule.severity))) {
      errors.push(`Rule "${label}" has an unsupported severity: ${String(rule.severity)}`);
    }
    if (rule.confidence !== void 0 && !validConfidence.has(String(rule.confidence))) {
      errors.push(`Rule "${label}" has an unsupported confidence: ${String(rule.confidence)}`);
    }
    if (rule.maturity !== void 0 && !validMaturity.has(String(rule.maturity))) {
      errors.push(`Rule "${label}" has an unsupported maturity: ${String(rule.maturity)}`);
    }
    if (rule.category !== void 0 && !validCategories.has(String(rule.category))) {
      errors.push(`Rule "${label}" has an unsupported category: ${String(rule.category)}`);
    }
    const actionOptional = rule.type === "context" || rule.type === "meta";
    if (!actionOptional && typeof rule.action !== "string" || typeof rule.action === "string" && !validActions.has(rule.action)) {
      errors.push(`Rule "${label}" has an unsupported action: ${String(rule.action)}`);
    }
    if (rule.level !== void 0 && (typeof rule.level !== "string" || !validLevels.has(rule.level))) errors.push(`Rule "${label}" has an invalid protection level`);
    if (rule.scope !== void 0 && (typeof rule.scope !== "string" || !validScopes.has(rule.scope))) {
      errors.push(`Rule "${label}" has an unsupported scope: ${String(rule.scope)} (expected one of ${[...validScopes].join(", ")})`);
    }
    if (rule.context !== void 0) {
      if (!Array.isArray(rule.context) || rule.context.length === 0 || rule.context.some((c) => typeof c !== "string" || !validRuleContexts.has(c))) {
        errors.push(`Rule "${label}" has an invalid context: ${JSON.stringify(rule.context)} (expected a non-empty array of local, ci, both)`);
      }
    }
    if (typeof rule.message !== "string" || !rule.message.trim()) errors.push(`Rule "${label}" is missing a non-empty message`);
    if (rule.type === "filesystem" && (!Array.isArray(rule.paths) || rule.paths.length === 0)) errors.push(`Rule "${label}" is a filesystem rule but has no paths`);
    if (rule.type === "content" && (!Array.isArray(rule.patterns) || rule.patterns.length === 0)) errors.push(`Rule "${label}" is a content rule but has no patterns`);
    if (rule.type === "network" && typeof rule.match !== "string") errors.push(`Rule "${label}" is a network rule but has no match`);
    if (rule.type === "command" && !rule.match && !rule.match_regex && !rule.match_prefix) {
      errors.push(`Rule "${label}" is a command rule but has no match, match_regex, or match_prefix`);
    }
    if (rule.type === "package" && rule.age_days !== void 0 && (typeof rule.age_days !== "number" || !Number.isFinite(rule.age_days) || rule.age_days < 0)) {
      errors.push(`Rule "${label}" is a package rule but has an invalid age_days (expected a non-negative number)`);
    }
    if (rule.type === "env" && (!Array.isArray(rule.vars) || rule.vars.length === 0)) errors.push(`Rule "${label}" is an env rule but has no vars`);
    if (rule.type === "flow" && (!Array.isArray(rule.sources) || !Array.isArray(rule.sinks))) errors.push(`Rule "${label}" is a flow rule but is missing sources or sinks`);
    if (rule.type === "sequence" && (!Array.isArray(rule.steps) || rule.steps.length < 2)) {
      errors.push(`Rule "${label}" is a sequence rule but has fewer than two steps`);
    }
    if (rule.type === "verification" || rule.type === "claim") {
      if (!rule.trigger) errors.push(`Rule "${rule.id}" is missing ${rule.type}.trigger`);
      if (!rule.satisfy) errors.push(`Rule "${rule.id}" is missing ${rule.type}.satisfy`);
      if (rule.trigger?.paths !== void 0 && (!Array.isArray(rule.trigger.paths) || rule.trigger.paths.some((p) => typeof p !== "string" || !p))) {
        errors.push(`Rule "${rule.id}" has an invalid ${rule.type}.trigger.paths (expected an array of non-empty strings)`);
      }
      for (const boundary of Object.values(rule.boundaries || {})) {
        if (!boundary.pattern) errors.push(`Rule "${rule.id}" has a boundary without a pattern`);
      }
    }
    for (const pattern of [
      rule.match,
      rule.match_regex,
      rule.unless_reasoning,
      ...(rule.unless || []).map((u) => u.regex),
      // content-rule patterns: a typo'd regex here is worse than unless —
      // matchesRulePattern swallows a bad regex into `false` at eval, so the
      // rule loads clean and SILENTLY never matches (a quiet fail-OPEN: a
      // security rule that stops catching what it should). Reject at load.
      ...(rule.patterns || []).map((p) => p.regex),
      ...(rule.steps || []).map((step) => step.pattern),
      rule.trigger?.pattern,
      rule.satisfy?.pattern,
      ...Object.values(rule.boundaries || {}).map((boundary) => boundary.pattern),
      // `topics` (research rules) is read as regex via
      // matchesRulePattern() in pipeline.ts (~line 1002), and
      // `fallback_pattern` (diagnosis rules) likewise (~line 958). Both
      // were previously missing from this loop: a malformed regex in
      // either field passed validation, then matchesRulePattern() silently
      // caught the construction error and returned false — the exact
      // quiet fail-open this loop's own comment above already warns about
      // for `patterns`.
      ...rule.topics || [],
      rule.fallback_pattern
    ]) {
      if (typeof pattern === "string" && pattern) {
        try {
          new RegExp(pattern);
        } catch {
          errors.push(`Rule "${rule.id}" contains invalid regex: ${pattern}`);
        }
      }
    }
    if (rule.fix && (!Array.isArray(rule.fix) || rule.fix.some((transform) => !transform || typeof transform.pattern !== "string" || typeof transform.replace !== "string"))) {
      errors.push(`Rule "${label}" has an invalid fix transform`);
    }
  }
  const ids = rules.map((rule) => typeof rule?.id === "string" ? rule.id : "");
  const seen = /* @__PURE__ */ new Set();
  const dups = /* @__PURE__ */ new Set();
  for (const id of ids) {
    if (id && seen.has(id)) dups.add(id);
    seen.add(id);
  }
  if (dups.size) errors.push(`Duplicate rule id(s) in the same file: ${[...dups].join(", ")}`);
  return errors;
}
var DEFAULT_SPRINT_EXPIRY_HOURS = 4;
function sprintExpiryStatus(config) {
  if (!config || config.level !== "sprint") return null;
  const expiryHours = config.sprint_expiry_hours ?? DEFAULT_SPRINT_EXPIRY_HOURS;
  if (!(expiryHours > 0)) return null;
  const startedAt = config.sprint_started_at ? Date.parse(config.sprint_started_at) : NaN;
  if (!Number.isFinite(startedAt)) return null;
  const hoursElapsed = (Date.now() - startedAt) / 36e5;
  return { expired: hoursElapsed >= expiryHours, startedAt, expiryHours, hoursElapsed };
}
function resolvedLevel(config, fallback) {
  const level = config?.level;
  if (!level) return fallback;
  if (level === "sprint" && sprintExpiryStatus(config)?.expired) return "balanced";
  return level;
}
function winningLevelConfig(hierarchy) {
  if (hierarchy.project?.config?.level) return hierarchy.project.config;
  if (hierarchy.global?.config?.level) return hierarchy.global.config;
  return void 0;
}
function effectiveHierarchyLevel(hierarchy, fallback) {
  return resolvedLevel(winningLevelConfig(hierarchy), fallback);
}
function dialAction(rule, level) {
  if (rule.level === "protect") return rule.action;
  if (level === "sprint" && (rule.action === "deny" || rule.action === "block")) return "warn";
  return rule.action;
}
function loadRuleHierarchy(projectDir) {
  const home = resolveHome();
  const projectRules = parseRulesFile(join(projectDir, ".keel", "rules.yaml")) || parseRulesFile(join(projectDir, "AGENTS.md")) || parseRulesFile(join(projectDir, "CLAUDE.md"));
  const localRules = parseRulesFile(join(projectDir, ".keel.local.yaml")) || parseRulesFile(join(projectDir, "AGENTS.local.md")) || parseRulesFile(join(projectDir, "CLAUDE.local.md"));
  return {
    global: parseRulesFile(join(home, ".keel", "rules.yaml")) || parseRulesFile(join(home, ".config", "keel", "rules.yaml")),
    user: parseRulesFile(join(home, ".config", "keel", "rules.yaml")) || null,
    project: projectRules,
    local: localRules
  };
}
var ACTION_STRENGTH = {
  deny: 4,
  block: 4,
  prompt: 3,
  fix: 2,
  redirect: 2,
  warn: 1,
  allow: 0,
  report: 0,
  research: 0,
  // `redact` is never a rule's `action:` field (validActions above
  // deliberately excludes it — see that Set's comment) — this entry exists
  // only so `Record<EnforcementAction, number>` type-checks as total.
  // Ranked with fix/redirect for the same reason they are: it actively
  // intervenes (rewrites output) but never stops the turn.
  redact: 2
};
var MODE_STRENGTH = {
  block: 2,
  warn: 1,
  observe: 0
};
function modeStrength(mode) {
  return mode === void 0 ? MODE_STRENGTH.block : MODE_STRENGTH[mode];
}
var OVERRIDE_COSMETIC_FIELDS = /* @__PURE__ */ new Set([
  "message",
  "rationale",
  "remediation",
  "false_positives",
  "review_by",
  "category",
  "severity",
  "confidence",
  "maturity"
]);
var OVERRIDE_STRENGTH_CHECKED_FIELDS = /* @__PURE__ */ new Set(["action", "mode", "level", "scope"]);
function sameEnforcementSurface(existing, candidate) {
  const strip = (rule) => {
    const copy = { ...rule };
    for (const field of OVERRIDE_COSMETIC_FIELDS) delete copy[field];
    for (const field of OVERRIDE_STRENGTH_CHECKED_FIELDS) delete copy[field];
    return copy;
  };
  return JSON.stringify(strip(existing)) === JSON.stringify(strip(candidate));
}
function mergeRules(hierarchy, level, context) {
  const all = [];
  const dialRank = { sprint: 0, balanced: 1, protect: 2 };
  const currentRank = dialRank[level] ?? 1;
  const pushRules = (source, scope) => {
    if (!source) return;
    for (const rule of source.rules) {
      if (rule.level === "protect") {
      } else if (rule.level !== void 0 && (dialRank[rule.level] ?? 0) > currentRank) {
        continue;
      }
      if (rule.context && !rule.context.includes(context) && !rule.context.includes("both")) continue;
      all.push({ ...rule, scope: rule.scope || scope });
    }
  };
  pushRules(hierarchy.global, "global");
  pushRules(hierarchy.user, "user");
  pushRules(hierarchy.project, "project");
  pushRules(hierarchy.local, "folder");
  const scopeOrder = { global: 0, user: 1, project: 2, folder: 3, session: 4 };
  const deduped = /* @__PURE__ */ new Map();
  for (const rule of all) {
    const existing = deduped.get(rule.id);
    if (!existing) {
      deduped.set(rule.id, rule);
      continue;
    }
    const moreSpecific = rule.scope && scopeOrder[rule.scope] > scopeOrder[existing.scope || "global"];
    if (!moreSpecific) continue;
    if (existing.level === "protect") {
      const actionOk = rule.level === "protect" && ACTION_STRENGTH[rule.action] >= ACTION_STRENGTH[existing.action];
      const modeOk = modeStrength(rule.mode) >= modeStrength(existing.mode);
      const surfaceOk = sameEnforcementSurface(existing, rule);
      const tightensOrEqual = actionOk && modeOk && surfaceOk;
      if (!tightensOrEqual) continue;
    }
    deduped.set(rule.id, rule);
  }
  const rank = (rule) => {
    if (rule.mode === "observe") return 0;
    if (rule.level === "protect") return 1;
    return 2;
  };
  return Array.from(deduped.values()).sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return (b.priority || 0) - (a.priority || 0);
  });
}
function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}
function hashRulesFile(filePath) {
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf-8");
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(36);
}

// ../core/src/enforce/package-verifier.ts
import { readFileSync as readFileSync2, writeFileSync, existsSync as existsSync2, mkdirSync, renameSync } from "node:fs";
import { join as join2 } from "node:path";
var MANAGERS = /* @__PURE__ */ new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "go"]);
var MANAGER_ECOSYSTEM = {
  npm: "npm",
  pnpm: "npm",
  yarn: "npm",
  bun: "npm",
  pip: "pypi",
  pip3: "pypi",
  uv: "pypi",
  poetry: "pypi",
  cargo: "crates",
  go: "go"
};
function ecosystemForManager(manager) {
  return MANAGER_ECOSYSTEM[manager];
}
var ADD_SUBCOMMANDS = {
  npm: /* @__PURE__ */ new Set(["install", "i"]),
  pnpm: /* @__PURE__ */ new Set(["add"]),
  yarn: /* @__PURE__ */ new Set(["add"]),
  bun: /* @__PURE__ */ new Set(["add"])
};
function matchAddSubcommand(manager, tokens, i) {
  const tok = tokens[i]?.toLowerCase();
  if (tok === void 0) return null;
  switch (manager) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return ADD_SUBCOMMANDS[manager].has(tok) ? 1 : null;
    case "pip":
    case "pip3":
      return tok === "install" ? 1 : null;
    case "poetry":
    case "cargo":
      return tok === "add" ? 1 : null;
    case "go":
      return tok === "get" || tok === "install" ? 1 : null;
    case "uv":
      if (tok === "add") return 1;
      if (tok === "pip" && tokens[i + 1]?.toLowerCase() === "install") return 2;
      return null;
  }
}
var PIP_GRAMMAR_MANAGERS = /* @__PURE__ */ new Set(["pip", "pip3", "uv"]);
var PIP_FLAG_VALUES = /* @__PURE__ */ new Set([
  "-r",
  "--requirement",
  "-c",
  "--constraint",
  "-e",
  "--editable",
  "-i",
  "--index-url",
  "--extra-index-url",
  "-t",
  "--target",
  "--trusted-host",
  "--platform",
  "--python-version",
  "--implementation",
  "--abi",
  "--prefix",
  "--root",
  "--cache-dir",
  "--proxy",
  "--retries",
  "--timeout",
  "--src",
  "-b",
  "--build",
  "--log"
]);
var FLAG_VALUE_CONSUMING = {
  pip: PIP_FLAG_VALUES,
  pip3: PIP_FLAG_VALUES,
  uv: PIP_FLAG_VALUES,
  cargo: /* @__PURE__ */ new Set(["--vers", "--version", "--registry", "--rename", "--manifest-path", "--target", "--features", "-F", "--config"]),
  poetry: /* @__PURE__ */ new Set(["--source", "--python", "--extras", "-E"]),
  go: /* @__PURE__ */ new Set(["-mod", "-modfile"])
};
var PIP_INDEX_FLAGS = /* @__PURE__ */ new Set(["-i", "--index-url", "--extra-index-url"]);
function isPipIndexFlag(tok) {
  return PIP_INDEX_FLAGS.has(tok.split("=")[0]);
}
var QUICK_PREFILTER = /\b(npm|pnpm|yarn|bun|pip3?|uv|poetry|cargo|go)\b/;
function tokenize(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while (m = re.exec(segment)) {
    const tok = m[1] ?? m[2] ?? m[3];
    if (tok) tokens.push(tok);
  }
  return tokens;
}
function managerFromToken(token) {
  const base = token.split("/").pop() ?? token;
  return MANAGERS.has(base) ? base : null;
}
function isNonRegistrySpec(spec) {
  if (!spec) return true;
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || spec.startsWith("~")) return true;
  if (/^(file|git|git\+ssh|git\+https|git\+http|github|http|https):/i.test(spec)) return true;
  if (/\.(tgz|tar\.gz|tar|txt|cfg|ini|toml|lock|whl)$/i.test(spec)) return true;
  if (!spec.startsWith("@") && /^[^@/\s]+\/[^@/\s]+(#.*)?$/.test(spec)) return true;
  return false;
}
function nameRegexFor(ecosystem) {
  switch (ecosystem) {
    case "npm":
      return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i;
    case "crates":
      return /^[a-z0-9][a-z0-9_-]*$/i;
    // Go import paths are multi-segment (`github.com/user/repo/subpkg`),
    // unlike npm's at-most-one-slash scoped form — each segment may contain
    // letters, digits, `.`/`_`/`~`/`-`.
    case "go":
      return /^[A-Za-z0-9](?:[A-Za-z0-9._~-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._~-]*[A-Za-z0-9])?)*$/;
    case "pypi":
      return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
  }
}
function parseSpec(spec, ecosystem) {
  let name;
  let version;
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    if (secondAt === -1) {
      name = spec;
      version = void 0;
    } else {
      name = spec.slice(0, secondAt);
      version = spec.slice(secondAt + 1);
    }
  } else {
    const at = spec.indexOf("@");
    if (at <= 0) {
      name = spec;
      version = void 0;
    } else {
      name = spec.slice(0, at);
      version = spec.slice(at + 1);
    }
  }
  if (!name) return null;
  if (version && /^(workspace|link|file|git|git\+ssh|git\+https|github):/i.test(version)) return null;
  if (!nameRegexFor(ecosystem).test(name)) return null;
  return { name, requestedVersion: version || void 0 };
}
function parsePipSpec(tok) {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?(.*)$/.exec(tok);
  if (!m) return null;
  const name = m[1];
  const rest = (m[3] || "").trim();
  let version;
  if (rest) {
    const vm = /^(===|~=|==|!=|<=|>=|<|>)\s*(.+)$/.exec(rest);
    if (!vm) return null;
    version = vm[0];
  }
  if (!nameRegexFor("pypi").test(name)) return null;
  return { name, requestedVersion: version || void 0 };
}
function extractSegmentInstalls(segment) {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && (tokens[i] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  if (i >= tokens.length) return [];
  const manager = managerFromToken(tokens[i]);
  if (!manager) return [];
  i++;
  if (i >= tokens.length) return [];
  const consumed = matchAddSubcommand(manager, tokens, i);
  if (consumed === null) return [];
  i += consumed;
  const ecosystem = MANAGER_ECOSYSTEM[manager];
  const grammar = PIP_GRAMMAR_MANAGERS.has(manager) ? "pip" : "default";
  const flagValues = FLAG_VALUE_CONSUMING[manager];
  const privateIndex = grammar === "pip" && tokens.slice(i).some(isPipIndexFlag);
  const specs = [];
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.startsWith("-")) {
      if (flagValues?.has(tok)) i++;
      continue;
    }
    if (grammar === "pip") {
      if (tokens[i + 1] === "@") {
        i += 2;
        continue;
      }
      if (isNonRegistrySpec(tok)) continue;
      const parsed2 = parsePipSpec(tok);
      if (parsed2) specs.push({ ...parsed2, manager, raw: tok, ...privateIndex ? { privateIndex: true } : {} });
      continue;
    }
    if (isNonRegistrySpec(tok)) continue;
    const parsed = parseSpec(tok, ecosystem);
    if (parsed) specs.push({ ...parsed, manager, raw: tok });
  }
  return specs;
}
function extractPackageInstalls(command) {
  if (!command || !QUICK_PREFILTER.test(command)) return [];
  const segments = command.split(/&&|\|\||;|\|/);
  const out = [];
  for (const seg of segments) out.push(...extractSegmentInstalls(seg.trim()));
  return out;
}
function defaultRegistryBaseUrl() {
  if (process.env.KEEL_NPM_REGISTRY) return process.env.KEEL_NPM_REGISTRY;
  if (process.env.VITEST) return "http://127.0.0.1:1";
  return "https://registry.npmjs.org";
}
function defaultPypiBaseUrl() {
  if (process.env.KEEL_PYPI_REGISTRY) return process.env.KEEL_PYPI_REGISTRY;
  if (process.env.VITEST) return "http://127.0.0.1:1";
  return "https://pypi.org/pypi";
}
function defaultCratesBaseUrl() {
  if (process.env.KEEL_CRATES_REGISTRY) return process.env.KEEL_CRATES_REGISTRY;
  if (process.env.VITEST) return "http://127.0.0.1:1";
  return "https://crates.io/api/v1/crates";
}
function defaultGoProxyBaseUrl() {
  if (process.env.KEEL_GO_PROXY) return process.env.KEEL_GO_PROXY;
  if (process.env.VITEST) return "http://127.0.0.1:1";
  return "https://proxy.golang.org";
}
var DEFAULT_MAX_RESPONSE_BYTES = 1e7;
function registryPath(name) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.slice(1).split("/");
    return `@${encodeURIComponent(scope)}/${encodeURIComponent(pkg ?? "")}`;
  }
  return encodeURIComponent(name);
}
async function fetchJsonCapped(url, timeoutMs, fetchImpl, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "keel-package-verifier/0.1" } });
    if (!res.ok) return { ok: false, status: res.status, kind: "http_error" };
    if (!res.body || typeof res.body.getReader !== "function") {
      const json = await res.json();
      return { ok: true, status: res.status, json };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, kind: "too_large" };
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf-8");
    return { ok: true, status: res.status, json: JSON.parse(text) };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, kind: "timeout" };
    return { ok: false, kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
async function fetchStatusCapped(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "keel-package-verifier/0.1" } });
    if (res.body && typeof res.body.cancel === "function") {
      try {
        await res.body.cancel();
      } catch {
      }
    }
    if (!res.ok) return { ok: false, status: res.status, kind: "http_error" };
    return { ok: true, status: res.status };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, kind: "timeout" };
    return { ok: false, kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
async function checkPackageExistence(name, opts, timeoutMs) {
  if (timeoutMs <= 0) return { verdict: "unverified", reason: "budget_exhausted" };
  const url = `${opts.registryBaseUrl}/${registryPath(name)}`;
  const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes);
  if (outcome.ok) {
    const created = outcome.json?.time?.created;
    if (!created) return { verdict: "exists" };
    const createdMs = Date.parse(created);
    if (Number.isNaN(createdMs)) return { verdict: "exists" };
    return { verdict: "exists", createdAt: created, ageDays: (Date.now() - createdMs) / 864e5 };
  }
  if (outcome.kind === "http_error" && outcome.status === 404) {
    if (name.startsWith("@")) return { verdict: "unverified", reason: "scoped_not_public" };
    return { verdict: "not_found" };
  }
  if (outcome.kind === "timeout") return { verdict: "unverified", reason: "timeout" };
  if (outcome.kind === "too_large") return { verdict: "unverified", reason: "too_large" };
  return { verdict: "unverified", reason: "network_error" };
}
async function checkPyPiExistence(name, opts, timeoutMs) {
  if (timeoutMs <= 0) return { verdict: "unverified", reason: "budget_exhausted" };
  const url = `${opts.registryBaseUrl}/${encodeURIComponent(name)}/json`;
  const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes);
  if (outcome.ok) {
    const releases = outcome.json?.releases;
    let earliestMs;
    if (releases) {
      for (const files of Object.values(releases)) {
        if (!Array.isArray(files)) continue;
        for (const f of files) {
          const t = f?.upload_time_iso_8601 ?? f?.upload_time;
          if (!t) continue;
          const ms = Date.parse(t);
          if (Number.isNaN(ms)) continue;
          if (earliestMs === void 0 || ms < earliestMs) earliestMs = ms;
        }
      }
    }
    if (earliestMs === void 0) return { verdict: "exists" };
    return { verdict: "exists", createdAt: new Date(earliestMs).toISOString(), ageDays: (Date.now() - earliestMs) / 864e5 };
  }
  if (outcome.kind === "http_error" && outcome.status === 404) return { verdict: "not_found" };
  if (outcome.kind === "timeout") return { verdict: "unverified", reason: "timeout" };
  if (outcome.kind === "too_large") return { verdict: "unverified", reason: "too_large" };
  return { verdict: "unverified", reason: "network_error" };
}
async function checkCratesExistence(name, opts, timeoutMs) {
  if (timeoutMs <= 0) return { verdict: "unverified", reason: "budget_exhausted" };
  const url = `${opts.registryBaseUrl}/${encodeURIComponent(name)}`;
  const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes);
  if (outcome.ok) {
    const created = outcome.json?.crate?.created_at;
    if (!created) return { verdict: "exists" };
    const ms = Date.parse(created);
    if (Number.isNaN(ms)) return { verdict: "exists" };
    return { verdict: "exists", createdAt: created, ageDays: (Date.now() - ms) / 864e5 };
  }
  if (outcome.kind === "http_error" && outcome.status === 404) return { verdict: "not_found" };
  if (outcome.kind === "timeout") return { verdict: "unverified", reason: "timeout" };
  if (outcome.kind === "too_large") return { verdict: "unverified", reason: "too_large" };
  return { verdict: "unverified", reason: "network_error" };
}
function escapeGoModulePath(p) {
  return p.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
}
function shortenGoModulePath(name) {
  const idx = name.lastIndexOf("/");
  if (idx <= 0) return null;
  return name.slice(0, idx);
}
async function goProxyListLookup(name, opts, timeoutMs) {
  if (timeoutMs <= 0) return { verdict: "unverified", reason: "budget_exhausted" };
  const url = `${opts.registryBaseUrl}/${escapeGoModulePath(name)}/@v/list`;
  const outcome = await fetchStatusCapped(url, timeoutMs, opts.fetchImpl);
  if (outcome.ok) return { verdict: "exists" };
  if (outcome.kind === "http_error" && (outcome.status === 404 || outcome.status === 410)) return { verdict: "not_found" };
  if (outcome.kind === "timeout") return { verdict: "unverified", reason: "timeout" };
  return { verdict: "unverified", reason: "network_error" };
}
async function checkGoExistence(name, opts, timeoutMs) {
  if (timeoutMs <= 0) return { verdict: "unverified", reason: "budget_exhausted" };
  const perAttempt = Math.max(1, Math.floor(timeoutMs / 2));
  const first = await goProxyListLookup(name, opts, perAttempt);
  if (first.verdict === "exists") return { verdict: "exists" };
  if (first.verdict === "unverified") return { verdict: "unverified", reason: first.reason };
  const shorter = shortenGoModulePath(name);
  if (!shorter) return { verdict: "unverified", reason: "go_ambiguous" };
  const second = await goProxyListLookup(shorter, opts, Math.max(1, timeoutMs - perAttempt));
  return { verdict: "unverified", reason: second.reason ?? "go_ambiguous" };
}
async function checkExistenceForEcosystem(ecosystem, name, opts, timeoutMs) {
  const { fetchImpl, maxBytes } = opts;
  switch (ecosystem) {
    case "npm":
      return checkPackageExistence(name, { registryBaseUrl: opts.registryBaseUrl, fetchImpl, maxBytes }, timeoutMs);
    case "pypi":
      return checkPyPiExistence(name, { registryBaseUrl: opts.pypiBaseUrl, fetchImpl, maxBytes }, timeoutMs);
    case "crates":
      return checkCratesExistence(name, { registryBaseUrl: opts.cratesBaseUrl, fetchImpl, maxBytes }, timeoutMs);
    case "go":
      return checkGoExistence(name, { registryBaseUrl: opts.goProxyBaseUrl, fetchImpl, maxBytes }, timeoutMs);
  }
}
async function searchDidYouMean(name, opts, timeoutMs) {
  if (timeoutMs <= 0) return [];
  try {
    const url = `${opts.registryBaseUrl}/-/v1/search?text=${encodeURIComponent(name)}&size=5`;
    const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes);
    if (!outcome.ok) return [];
    const objects = outcome.json?.objects;
    if (!Array.isArray(objects)) return [];
    return objects.map((o) => o?.package?.name).filter((n) => typeof n === "string" && n.length > 0).slice(0, 5);
  } catch {
    return [];
  }
}
var CACHE_TTL_MS = {
  exists: 24 * 60 * 60 * 1e3,
  not_found: 60 * 60 * 1e3,
  unverified: 5 * 60 * 1e3
};
function packageVerifierStateDir() {
  return process.env.KEEL_STATE_DIR || join2(resolveHome(), ".keel", "state");
}
var PackageVerifierCache = class {
  constructor(stateDir2 = packageVerifierStateDir()) {
    this.stateDir = stateDir2;
  }
  stateDir;
  filePath() {
    return join2(this.stateDir, "package-verifier.json");
  }
  load() {
    try {
      const p = this.filePath();
      if (!existsSync2(p)) return {};
      return JSON.parse(readFileSync2(p, "utf-8"));
    } catch {
      return {};
    }
  }
  save(data) {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const p = this.filePath();
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, p);
    } catch {
    }
  }
  expired(entry, now) {
    return now - entry.checkedAt > CACHE_TTL_MS[entry.verdict];
  }
  /**
   * Cache key is namespaced `${ecosystem}:${name}`, not bare name —
   * finding 3c. Four ecosystems now share one cache file; without this
   * namespacing, a PyPI 404 for "foo" would poison the cache and deny an
   * npm package also named "foo" for the cache's TTL, and
   * `npm install foo && cargo add foo` in one command would incorrectly
   * reuse one ecosystem's verdict for the other.
   */
  key(name, ecosystem) {
    return `${ecosystem}:${name}`;
  }
  get(name, now = Date.now(), ecosystem = "npm") {
    const entry = this.load()[this.key(name, ecosystem)];
    if (!entry) return null;
    if (this.expired(entry, now)) return null;
    return entry;
  }
  set(entry, now = Date.now()) {
    const all = this.load();
    all[this.key(entry.name, entry.ecosystem ?? "npm")] = entry;
    for (const [k, v] of Object.entries(all)) {
      if (this.expired(v, now)) delete all[k];
    }
    this.save(all);
  }
};
async function checkPackages(specs, opts = {}) {
  const now = opts.now ?? Date.now;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 2e3;
  const registryBaseUrl = opts.registryBaseUrl ?? defaultRegistryBaseUrl();
  const pypiBaseUrl = opts.pypiBaseUrl ?? defaultPypiBaseUrl();
  const cratesBaseUrl = opts.cratesBaseUrl ?? defaultCratesBaseUrl();
  const goProxyBaseUrl = opts.goProxyBaseUrl ?? defaultGoProxyBaseUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cache = opts.cache ?? new PackageVerifierCache();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const lookupOpts = { registryBaseUrl, pypiBaseUrl, cratesBaseUrl, goProxyBaseUrl, fetchImpl, maxBytes };
  const deadline = now() + totalTimeoutMs;
  const seen = /* @__PURE__ */ new Map();
  const results = [];
  for (const spec of specs) {
    const ecosystem = ecosystemForManager(spec.manager);
    const key = `${ecosystem}:${spec.name}`;
    const already = seen.get(key);
    if (already) {
      results.push({ ...already, requestedVersion: spec.requestedVersion });
      continue;
    }
    let result;
    if (spec.privateIndex) {
      result = { name: spec.name, requestedVersion: spec.requestedVersion, verdict: "unverified", reason: "private_index", fromCache: false };
    } else {
      const cached = cache.get(spec.name, now(), ecosystem);
      if (cached) {
        result = {
          name: spec.name,
          requestedVersion: spec.requestedVersion,
          verdict: cached.verdict,
          reason: cached.reason,
          ageDays: cached.ageDays,
          createdAt: cached.createdAt,
          didYouMean: cached.didYouMean,
          fromCache: true
        };
      } else {
        const remaining = deadline - now();
        const existence = await checkExistenceForEcosystem(ecosystem, spec.name, lookupOpts, remaining);
        let didYouMean;
        if (existence.verdict === "not_found" && ecosystem === "npm") {
          didYouMean = await searchDidYouMean(spec.name, { registryBaseUrl, fetchImpl, maxBytes }, deadline - now());
        }
        result = {
          name: spec.name,
          requestedVersion: spec.requestedVersion,
          verdict: existence.verdict,
          reason: existence.reason,
          ageDays: existence.ageDays,
          createdAt: existence.createdAt,
          didYouMean,
          fromCache: false
        };
        cache.set({
          name: spec.name,
          ecosystem,
          verdict: result.verdict,
          reason: result.reason,
          ageDays: result.ageDays,
          createdAt: result.createdAt,
          didYouMean: result.didYouMean,
          checkedAt: now()
        }, now());
      }
    }
    seen.set(key, result);
    results.push(result);
  }
  return results;
}
function checkPackagesCacheOnly(specs, cache, now = Date.now) {
  const results = [];
  const misses = [];
  const missSeen = /* @__PURE__ */ new Set();
  const t = now();
  for (const spec of specs) {
    const ecosystem = ecosystemForManager(spec.manager);
    if (spec.privateIndex) {
      results.push({ name: spec.name, requestedVersion: spec.requestedVersion, verdict: "unverified", reason: "private_index", fromCache: false });
      continue;
    }
    const cached = cache.get(spec.name, t, ecosystem);
    if (cached) {
      results.push({
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: cached.verdict,
        reason: cached.reason,
        ageDays: cached.ageDays,
        createdAt: cached.createdAt,
        didYouMean: cached.didYouMean,
        fromCache: true
      });
    } else {
      results.push({
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: "unverified",
        reason: "not_yet_checked",
        fromCache: false
      });
      const missKey = `${ecosystem}:${spec.name}`;
      if (!missSeen.has(missKey)) {
        missSeen.add(missKey);
        misses.push(spec);
      }
    }
  }
  return { results, misses };
}
function scheduleBackgroundVerification(misses, opts = {}) {
  if (misses.length === 0) return Promise.resolve();
  return checkPackages(misses, opts).then(() => void 0, () => void 0);
}
function buildNotFoundMessage(r) {
  const suggestion = r.didYouMean?.length ? ` Did you mean: ${r.didYouMean.join(", ")}?` : "";
  return `Package "${r.name}" does not exist on its package registry \u2014 this install is unfulfillable regardless of intent.${suggestion}`;
}
function buildUnverifiedMessage(r) {
  if (r.reason === "scoped_not_public") {
    return `unverified \u2014 "${r.name}" returned 404 from the public npm registry. Scoped names 404 publicly for private/org registry packages too, so this is not proof it doesn't exist \u2014 treating as unverified, not denying.`;
  }
  if (r.reason === "private_index") {
    return `unverified \u2014 "${r.name}" targets a non-default package index (--index-url, --extra-index-url, or -i). PyPI has no scoped-name convention like npm to signal "private" by name alone, and keel does not query agent-supplied index URLs (that would reopen the SSRF surface this module's own registry lookups are otherwise exempt from) \u2014 approve only if you recognize and trust this index.`;
  }
  if (r.reason === "go_ambiguous") {
    return `unverified \u2014 "${r.name}" 404'd at its literal import path on the Go module proxy. This is the routine, expected result for a subpackage of a larger module, not proof of nonexistence \u2014 the Go proxy indexes MODULE roots, not every importable subpackage path. Approve if this looks like a plausible subpackage of a real module.`;
  }
  if (r.reason === "budget_exhausted") {
    return `unverified \u2014 registry lookup budget exhausted before "${r.name}" could be checked`;
  }
  if (r.reason === "too_large") {
    return `unverified \u2014 registry response for "${r.name}" exceeded the size cap before it could be checked`;
  }
  if (r.reason === "not_yet_checked") {
    return `unverified \u2014 registry not yet checked for "${r.name}"; approve to proceed. A background lookup is filling the cache now, so a repeat of this install will get a real verdict.`;
  }
  return `unverified \u2014 registry unreachable (could not verify "${r.name}": ${r.reason ?? "unknown error"})`;
}
function buildAgeGateMessage(r, ageThresholdDays) {
  const days = r.ageDays !== void 0 ? Math.max(0, Math.floor(r.ageDays)) : void 0;
  return `Package "${r.name}" was published ${days ?? "?"} day(s) ago (younger than the ${ageThresholdDays}-day threshold) \u2014 verify this isn't a fresh, potentially attacker-registered release before installing.`;
}
function decidePackageAction(results, ageThresholdDays) {
  const notFound = results.find((r) => r.verdict === "not_found");
  if (notFound) return { reason: "not_found", message: buildNotFoundMessage(notFound), result: notFound };
  const unverified = results.find((r) => r.verdict === "unverified");
  if (unverified) return { reason: "unverified", message: buildUnverifiedMessage(unverified), result: unverified };
  const young = results.find((r) => r.verdict === "exists" && r.ageDays !== void 0 && r.ageDays < ageThresholdDays);
  if (young) return { reason: "age_gate", message: buildAgeGateMessage(young, ageThresholdDays), result: young };
  return { reason: "ok", message: "All installed packages verified against their package registries." };
}

// ../core/src/enforce/command-normalizer.ts
var MAX_INPUT_LEN = 4e3;
var MAX_SUBCOMMANDS = 64;
var MAX_TOKENS_PER_SUBCOMMAND = 256;
var MAX_INTERPRETER_DEPTH = 1;
var SHELL_INTERPRETERS = /* @__PURE__ */ new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "csh", "tcsh", "ash"]);
function classifyInterpreter(basename3) {
  if (SHELL_INTERPRETERS.has(basename3)) return "shell";
  if (/^python[0-9.]*$/.test(basename3)) return "python";
  if (basename3 === "node" || basename3 === "nodejs") return "node";
  if (/^perl[0-9.]*$/.test(basename3)) return "perl";
  return null;
}
function interpreterFlags(kind) {
  switch (kind) {
    case "shell":
      return ["-c"];
    case "python":
      return ["-c"];
    case "node":
      return ["-e", "--eval"];
    case "perl":
      return ["-e", "-E", "-p"];
  }
}
function basename(path2) {
  const parts = path2.split(/[/\\]/);
  return parts[parts.length - 1] || path2;
}
function isQuoteChar(c) {
  return c === '"' || c === "'";
}
function tokenize2(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  let current = null;
  const pushSegment = (seg) => {
    if (!current) current = [];
    current.push(seg);
  };
  const endToken = () => {
    if (current) {
      tokens.push({ segments: current });
      current = null;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "	") {
      endToken();
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      const next = text[i + 1];
      pushSegment({
        text: next,
        quoted: false,
        hasSpace: false,
        quoteChar: "",
        escapedSpace: next === " " || next === "	"
      });
      i += 2;
      continue;
    }
    if (isQuoteChar(c)) {
      const quoteChar = c;
      let j2 = i + 1;
      let inner = "";
      while (j2 < n && text[j2] !== quoteChar) {
        if (quoteChar === '"' && text[j2] === "\\" && j2 + 1 < n && (text[j2 + 1] === '"' || text[j2 + 1] === "\\")) {
          inner += text[j2 + 1];
          j2 += 2;
          continue;
        }
        inner += text[j2];
        j2++;
      }
      const hasSpace = /[ \t]/.test(inner);
      pushSegment({ text: inner, quoted: true, hasSpace, quoteChar });
      i = j2 + 1;
      continue;
    }
    let j = i;
    let buf = "";
    while (j < n && text[j] !== " " && text[j] !== "	" && !isQuoteChar(text[j]) && text[j] !== "\\") {
      buf += text[j];
      j++;
    }
    if (j === i) {
      buf = text[j];
      j++;
    }
    pushSegment({ text: buf, quoted: false, hasSpace: false, quoteChar: "" });
    i = j;
  }
  endToken();
  if (tokens.length > MAX_TOKENS_PER_SUBCOMMAND) tokens.length = MAX_TOKENS_PER_SUBCOMMAND;
  return tokens;
}
var BUILTIN_VAR_DEFAULTS = { IFS: " " };
var VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
function expandVars(text, dict) {
  return text.replace(VAR_RE, (whole, braced, bare) => {
    const name = braced || bare;
    return Object.prototype.hasOwnProperty.call(dict, name) ? dict[name] : whole;
  });
}
var ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
function renderToken(token, dict) {
  let rendered = "";
  let value = "";
  for (const seg of token.segments) {
    if (seg.quoted && seg.hasSpace) {
      rendered += seg.quoteChar + seg.text + seg.quoteChar;
      value += seg.text;
    } else if (seg.quoted) {
      rendered += seg.text;
      value += seg.text;
    } else if (seg.escapedSpace) {
      rendered += "\\" + seg.text;
      value += seg.text;
    } else {
      const expanded = expandVars(seg.text, dict);
      rendered += expanded;
      value += expanded;
    }
  }
  return { rendered, value };
}
var SEPARATORS = [
  { token: "&&", re: /^&&/ },
  { token: "||", re: /^\|\|/ },
  { token: ";", re: /^;/ },
  { token: "|", re: /^\|/ },
  { token: "&", re: /^&/ },
  { token: "\n", re: /^\n/ }
];
function splitTopLevel(raw) {
  const parts = [];
  let buf = "";
  let i = 0;
  const n = raw.length;
  let quote = null;
  while (i < n) {
    const c = raw[i];
    if (quote) {
      buf += c;
      if (c === quote && raw[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (isQuoteChar(c)) {
      quote = c;
      buf += c;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      buf += c + raw[i + 1];
      i += 2;
      continue;
    }
    let matched = null;
    for (const s of SEPARATORS) {
      if (s.re.test(raw.slice(i))) {
        matched = s.token;
        break;
      }
    }
    if (matched) {
      parts.push({ text: buf, sepAfter: matched });
      buf = "";
      i += matched.length;
      if (parts.length >= MAX_SUBCOMMANDS) break;
      continue;
    }
    buf += c;
    i++;
  }
  parts.push({ text: buf, sepAfter: "" });
  return parts;
}
function normalizeSubcommand(rawSub, dict, depth) {
  const rawTrimmed = rawSub.trim();
  const rawTokens = tokenize2(rawSub);
  const rendered = rawTokens.map((t) => renderToken(t, dict));
  let cut = 0;
  const envAssignments = {};
  while (cut < rendered.length) {
    const m = ASSIGNMENT_RE.exec(rendered[cut].value);
    if (!m) break;
    const [, name, valRaw] = m;
    const val = expandVars(valRaw, dict);
    envAssignments[name] = val;
    dict[name] = val;
    cut++;
  }
  const commandTokens = rawTokens.slice(cut).map((t) => renderToken(t, dict));
  const tokens = [...rendered.slice(0, cut), ...commandTokens];
  const normalized = tokens.map((t) => t.rendered).join(" ");
  const normalizedCommand = commandTokens.map((t) => t.rendered).join(" ");
  const sub = {
    raw: rawTrimmed,
    tokens,
    normalized,
    normalizedCommand,
    envAssignments
  };
  if (commandTokens.length > 0) {
    const argv0 = commandTokens[0].value;
    const kind = classifyInterpreter(basename(argv0));
    if (kind) {
      const flags = interpreterFlags(kind);
      for (let k = 1; k < commandTokens.length - 1; k++) {
        const tok = commandTokens[k].value;
        const isCodeFlag = flags.includes(tok) || kind === "shell" && /^-[a-z]*c$/.test(tok);
        if (isCodeFlag) {
          let bodyIndex = k + 1;
          if (kind === "shell" && commandTokens[bodyIndex]?.value === "--") {
            bodyIndex++;
          }
          const bodyToken = commandTokens[bodyIndex];
          if (bodyToken) {
            sub.interpreterBody = bodyToken.value;
            if (kind === "shell" && depth < MAX_INTERPRETER_DEPTH) {
              sub.nested = normalizeCommand(bodyToken.value, depth + 1);
            }
          }
          break;
        }
      }
    }
  }
  return sub;
}
var HEREDOC_START_RE = /(?:^|[;&|\n]|&&|\|\|)[ \t]*([A-Za-z0-9_./\\-]+)(?:[ \t]+-[A-Za-z0-9_-]*)*[ \t]*<<(-)?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;
function extractHeredocs(raw) {
  const results = [];
  HEREDOC_START_RE.lastIndex = 0;
  let m;
  let guard = 0;
  while (guard < MAX_SUBCOMMANDS && (m = HEREDOC_START_RE.exec(raw))) {
    guard++;
    const interpToken = m[1];
    const tabStrip = m[2] === "-";
    const delim = m[3] ?? m[4] ?? m[5];
    const kind = delim ? classifyInterpreter(basename(interpToken)) : null;
    if (!kind) continue;
    const opLineEnd = raw.indexOf("\n", HEREDOC_START_RE.lastIndex);
    if (opLineEnd === -1) continue;
    const bodyStart = opLineEnd + 1;
    const rest = raw.slice(bodyStart);
    const escapedDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const delimLineRe = new RegExp("^" + (tabStrip ? "\\t*" : "") + escapedDelim + "[ \\t]*$", "m");
    const end = delimLineRe.exec(rest);
    if (!end) continue;
    const body = end.index > 0 ? rest.slice(0, end.index - 1) : "";
    results.push({ kind, body });
    HEREDOC_START_RE.lastIndex = bodyStart + end.index + end[0].length;
  }
  return results;
}
function normalizeCommand(raw, depth = 0) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { raw: raw || "", normalized: raw || "", subcommands: [], surfaces: [raw || ""], truncated: false };
  }
  if (raw.length > MAX_INPUT_LEN) {
    return { raw, normalized: raw, subcommands: [], surfaces: [raw], truncated: true };
  }
  try {
    const parts = splitTopLevel(raw);
    const truncated = parts.length >= MAX_SUBCOMMANDS;
    const dict = { ...BUILTIN_VAR_DEFAULTS };
    const subcommands = parts.filter((p) => p.text.trim().length > 0).map((p) => normalizeSubcommand(p.text, dict, depth));
    let normalizedFull = "";
    let si = 0;
    for (const part of parts) {
      if (part.text.trim().length === 0) {
        normalizedFull += part.sepAfter;
        continue;
      }
      normalizedFull += subcommands[si].normalized + part.sepAfter;
      si++;
    }
    const surfaces = [raw];
    if (normalizedFull !== raw) surfaces.push(normalizedFull);
    for (const sub of subcommands) {
      if (sub.normalized && !surfaces.includes(sub.normalized)) surfaces.push(sub.normalized);
      if (sub.normalizedCommand && sub.normalizedCommand !== sub.normalized && !surfaces.includes(sub.normalizedCommand)) {
        surfaces.push(sub.normalizedCommand);
      }
      if (sub.interpreterBody && !surfaces.includes(sub.interpreterBody)) surfaces.push(sub.interpreterBody);
      if (sub.nested) {
        for (const s of sub.nested.surfaces) if (!surfaces.includes(s)) surfaces.push(s);
      }
    }
    for (const hd of extractHeredocs(raw)) {
      if (!surfaces.includes(hd.body)) surfaces.push(hd.body);
      if (hd.kind === "shell" && depth < MAX_INTERPRETER_DEPTH) {
        const nested = normalizeCommand(hd.body, depth + 1);
        for (const s of nested.surfaces) if (!surfaces.includes(s)) surfaces.push(s);
      }
    }
    return { raw, normalized: normalizedFull, subcommands, surfaces, truncated };
  } catch {
    return { raw, normalized: raw, subcommands: [], surfaces: [raw], truncated: true };
  }
}

// ../core/src/enforce/arg-utils.ts
var CONTENT_KEYS = /* @__PURE__ */ new Set([
  "content",
  "text",
  "fileContent",
  "code",
  // Edit and apply_patch carry file content under non-"content" names; an
  // edit whose new text merely mentions a command must not trip command
  // rules, and patch bodies are content, not commands.
  "newString",
  "oldString",
  "patchText",
  "patch"
]);
function isContentKey(key) {
  return CONTENT_KEYS.has(key) || key.toLowerCase().includes("content") || key.toLowerCase().includes("filecontent");
}
var PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Move|Delete|Rename) File: (.+)$/m;
function pathFromPatch(patchText) {
  if (typeof patchText !== "string" || !patchText) return "";
  const m = PATCH_PATH_RE.exec(patchText);
  return m ? m[1].trim() : "";
}
function argPath(args) {
  return String(
    args.path || args.file_path || args.filePath || args.file || args.dest || args.destination || args.target_file || args.notebook_path || pathFromPatch(args.patchText) || ""
  );
}
function stripContentArgs(args) {
  if (typeof args !== "object" || args === null) return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (isContentKey(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.map((item) => item && typeof item === "object" ? stripContentArgs(item) : item);
    } else if (value && typeof value === "object") {
      out[key] = stripContentArgs(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
function isMcpCall(input) {
  return input.tool.toLowerCase().includes("mcp__");
}
function mcpCallString(input) {
  if (!isMcpCall(input)) return null;
  const args = input.args;
  const nested = args.args && typeof args.args === "object" ? JSON.stringify(stripContentArgs(args.args)) : "";
  return `${mcpToolString(input)} ${nested}`.toLowerCase();
}
function mcpToolString(input) {
  if (!isMcpCall(input)) return null;
  const args = input.args;
  const segments = input.tool.split("__").map((seg) => seg.replace(/_/g, " ")).join(" ");
  const toolName = typeof args.tool === "string" ? args.tool : "";
  const direct = commandArrayString(args.command ?? args.cmd);
  return `${segments} ${toolName} ${direct}`.toLowerCase();
}
function commandArrayString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(" ");
  return "";
}
function commandString(input) {
  const args = input.args;
  if (typeof args === "string") return args;
  const mcp = mcpCallString(input);
  if (mcp) return mcp;
  const direct = commandArrayString(args.command ?? args.cmd);
  if (direct) return direct;
  if (args.args && typeof args.args === "object" && !Array.isArray(args.args)) {
    const nestedArgs = args.args;
    const nested = commandArrayString(nestedArgs.command ?? nestedArgs.cmd);
    if (nested) return nested;
  }
  return JSON.stringify(stripContentArgs(args));
}
function commandSurfaces(input) {
  const raw = commandString(input);
  if (!raw) return [""];
  const normalized = normalizeCommand(raw);
  return normalized.surfaces.length ? normalized.surfaces : [raw];
}

// ../core/src/enforce/verification.ts
function isObligationRule(rule) {
  return rule.type === "verification" || rule.type === "claim";
}
var WRITE_TOOL_NAMES = /* @__PURE__ */ new Set(["write", "edit", "apply_patch", "patch", "writefile", "write_file"]);
function matchesToolList(tools, input) {
  if (tools.some((tool) => tool.toLowerCase() === input.tool.toLowerCase())) return true;
  if (!tools.some((tool) => WRITE_TOOL_NAMES.has(tool.toLowerCase()))) return false;
  const args = input.args || {};
  return typeof args.patchText === "string" || (typeof args.filePath === "string" || typeof args.file === "string") && (args.content !== void 0 || args.text !== void 0 || args.newString !== void 0);
}
function matches(matcher, input) {
  if (!matcher) return false;
  const tools = matcher.tools || (matcher.tool ? [matcher.tool] : []);
  if (tools.length && !matchesToolList(tools, input)) return false;
  const args = input.args || {};
  const pathTargets = matcher.paths?.length ? [...matcher.paths, ...matcher.path ? [matcher.path] : []] : matcher.path ? [matcher.path] : [];
  if (pathTargets.length) {
    const value = normalizeForMatch(argPath(args));
    if (!pathTargets.some((target) => value.includes(normalizeForMatch(target)))) return false;
  }
  if (matcher.pattern) {
    let re;
    try {
      re = new RegExp(matcher.pattern, "i");
    } catch {
      return false;
    }
    if (!re.test(JSON.stringify(args)) && !re.test(commandString(input))) return false;
  }
  return true;
}
var VerificationTracker = class {
  constructor(stateManager) {
    this.stateManager = stateManager;
  }
  stateManager;
  pending = /* @__PURE__ */ new Map();
  generations = /* @__PURE__ */ new Map();
  key(rule, input) {
    return `${rule.id}:${input.cwd}`;
  }
  observeTrigger(rule, input) {
    if (!isObligationRule(rule) || !matches(rule.trigger, input)) return;
    const key = this.key(rule, input);
    const previous = this.stateManager?.verification[key];
    const generation = Math.max(this.generations.get(key) || 0, previous?.generation || 0) + 1;
    this.generations.set(key, generation);
    this.pending.set(key, {
      ruleId: rule.id,
      cwd: input.cwd,
      sessionId: input.session_id,
      generation,
      createdAt: Date.now()
    });
    this.stateManager?.setVerification(key, { createdAt: Date.now(), generation });
  }
  markSatisfied(rule, input) {
    if (!isObligationRule(rule) || !matches(rule.satisfy, input)) return;
    if (this.isFakeSatisfy(input)) return;
    this.pending.delete(this.key(rule, input));
    this.stateManager?.clearVerification(this.key(rule, input));
  }
  /**
   * A satisfy command that only prints help or lists tests is not evidence:
   * `npm test --help`, `npm run test -- --list`, `vitest --dry-run`,
   * `vitest --list-files` exit 0 without running the suite, so they must not
   * clear the obligation. Case-insensitive and tolerant of `=json` suffixes;
   * MCP-shaped shells (`mcp__shell__run`) carry the command in nested args.
   *
   * Exit-code swallowing is equally fake: `npm test || true`,
   * `npm test; exit 0`, `npm test | cat` all exit 0 even when the suite
   * failed (or never ran), so they must not count as evidence either. The
   * command string is visible to the hook — the swallow is detectable.
   */
  isFakeSatisfy(input) {
    const args = input.args || {};
    const nested = args.args && typeof args.args === "object" ? args.args.command : void 0;
    const command = String(args.command || args.cmd || nested || "");
    return /--(help|list[a-z-]*|dry[-_]?run|version)(=|\s|$)|(^|\s)-h(\s|$)|(\|\||;)\s*(true|exit(\s+0)?|:)(\s|$)|(^|\s)\|\s*(cat|tee|head|tail|grep|true)(\s|$)/i.test(command);
  }
  isPending(rule, input) {
    if (!isObligationRule(rule)) return false;
    const key = this.key(rule, input);
    const pending = this.pending.get(key) || this.stateManager?.verification[key];
    if (!pending) return false;
    const window = (rule.verification_window_seconds || 300) * 1e3;
    if (Date.now() - pending.createdAt > window) {
      this.pending.delete(key);
      this.stateManager?.clearVerification(key);
      return false;
    }
    return true;
  }
  boundary(rule, input) {
    if (!this.isPending(rule, input) || !rule.boundaries) return null;
    const args = JSON.stringify(stripContentArgs(input.args || {}));
    const cmd = commandString(input);
    const mcp = mcpToolString(input);
    for (const boundary of Object.values(rule.boundaries)) {
      try {
        if (boundary.pattern) {
          const re = new RegExp(boundary.pattern, "i");
          if (re.test(args) || re.test(cmd)) {
            return { message: rule.message, action: boundary.action };
          }
        }
      } catch {
      }
      if (mcp && boundary.pattern) {
        const words = boundary.pattern.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
        const verbs = words.slice(1);
        if (verbs.length && verbs.every((word) => new RegExp(`\\b${word}\\b`, "i").test(mcp))) {
          return { message: rule.message, action: boundary.action };
        }
      }
    }
    return null;
  }
  clear() {
    this.pending.clear();
    this.generations.clear();
  }
};

// ../core/src/enforce/oracle-tracker.ts
var OracleTracker = class {
  constructor(stateManager) {
    this.stateManager = stateManager;
  }
  stateManager;
  failures = /* @__PURE__ */ new Map();
  // Session-scoped (matches ResearchTracker, the closest sibling pattern:
  // arm on a failing trigger, gate a later action) rather than cwd-only
  // (like StuckTracker/VerificationTracker): two different agent sessions
  // working the same repo must not have one session's red run arm the
  // window for the OTHER session's unrelated edit. The cost is the inverse
  // case documented in the shipped rule's false_positives — the SAME
  // session running a monorepo-wide suite that fails in module A can still
  // arm the window for an unrelated edit it makes in module B.
  key(rule, input) {
    return `oracle:${rule.id}:${input.cwd}:${input.session_id}`;
  }
  /**
   * Arm the recency window: called from the after-hook (recordAttemptOutcome)
   * with the exit code of every command. Only a run that matches the rule's
   * `trigger` AND exited nonzero (the trigger's `exit: 'nonzero'`, or — if
   * the rule omits `trigger.exit` — the tracker's own default of "only
   * failures count") records a new failure timestamp. A passing run does
   * NOT clear a prior failure early: the window has its own TTL
   * (`window_seconds`), and a later unrelated passing command (e.g. `npm
   * run lint`) must not reset the clock on a still-fresh red test run.
   */
  observeOutcome(rule, input, exitCode) {
    if (rule.type !== "oracle" || !rule.trigger) return;
    if (!matches(rule.trigger, input)) return;
    if (rule.trigger.exit !== void 0) {
      const want = rule.trigger.exit;
      if (want === "nonzero" && (exitCode === 0 || exitCode === null)) return;
      if (typeof want === "number" && exitCode !== want) return;
    } else if (exitCode === 0 || exitCode === null) {
      return;
    }
    const key = this.key(rule, input);
    const entry = { timestamp: Date.now(), command: commandString(input) || input.tool };
    this.failures.set(key, entry);
    this.stateManager?.setOracleFailure(key, entry);
  }
  /**
   * The most recent qualifying failure for this rule+cwd, if any, within
   * `rule.window_seconds` (default 900s / 15min). Returns null both when
   * there was never a recorded failure AND when there was one but it has
   * aged out — callers cannot and should not distinguish the two; both mean
   * "no recency evidence right now".
   */
  recentFailure(rule, input) {
    const key = this.key(rule, input);
    const windowMs = (rule.window_seconds ?? 900) * 1e3;
    const local = this.failures.get(key);
    const persisted = this.stateManager?.oracleFailures[key];
    const entry = !persisted || local && local.timestamp >= persisted.timestamp ? local : persisted;
    if (!entry) return null;
    const ageMs = Date.now() - entry.timestamp;
    if (ageMs > windowMs) return null;
    return { ...entry, ageMs };
  }
  clear() {
    this.failures.clear();
  }
};

// ../core/src/enforce/oracle-signatures.ts
var SKIP_RE = /\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bxtest\s*\(|@pytest\.mark\.skip\b|@pytest\.mark\.xfail\b|\bpytest\.skip\s*\(|\bpytest\.mark\.skipif\b|\bt\.Skip\s*\(|\bt\.SkipNow\s*\(/g;
var ONLY_RE = /\b(?:it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/g;
var ASSERTION_RE = /\bexpect\s*\(|\bassert[_A-Za-z]*\s*\(|\bself\.assert[A-Za-z]*\s*\(|(^|[^.\w])assert\s+\S/gm;
var TEST_DECL_RE = /\b(?:it|test)\s*\(\s*['"`]|\bdef\s+test_\w+\s*\(/g;
var TIMEOUT_RETRY_RE = /\b(timeout|retries|retry|maxRetries|max_retries)\s*[:=(]\s*(\d+)/gi;
function countMatches(re, text) {
  re.lastIndex = 0;
  return (text.match(re) || []).length;
}
function lines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
var ASSERT_CALL_PREFIX_RE = /^(.*?\b(?:toBe|toEqual|toStrictEqual|toMatchObject|toMatchSnapshot|assertEqual|assertEquals|assert_equal)\s*\()/;
function expectedValueRewrites(oldText, newText) {
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const newSet = new Set(newLines);
  const oldSet = new Set(oldLines);
  const removed = oldLines.filter((l) => !newSet.has(l));
  const added = newLines.filter((l) => !oldSet.has(l));
  let rewrites = 0;
  for (const r of removed) {
    const m = ASSERT_CALL_PREFIX_RE.exec(r);
    if (!m) continue;
    const prefix = m[1];
    if (added.some((a) => a.startsWith(prefix) && a !== r)) rewrites++;
  }
  return rewrites;
}
function timeoutInflations(oldText, newText) {
  const collect = (text) => {
    const out = /* @__PURE__ */ new Map();
    let m;
    TIMEOUT_RETRY_RE.lastIndex = 0;
    while (m = TIMEOUT_RETRY_RE.exec(text)) {
      const name = m[1].toLowerCase();
      const value = Number(m[2]);
      out.set(name, value);
    }
    return out;
  };
  const oldVals = collect(oldText);
  const newVals = collect(newText);
  const flags = [];
  for (const [name, newVal] of newVals) {
    const oldVal = oldVals.get(name);
    if (oldVal === void 0 || oldVal <= 0) continue;
    if (newVal > oldVal && newVal - oldVal >= 5 && newVal / oldVal >= 3) {
      flags.push(`${name} ${oldVal}\u2192${newVal}`);
    }
  }
  return flags;
}
function detectWeakening(oldText, newText, filePath) {
  const signals = [];
  if (filePath && /\.snap$|\/__snapshots__\//.test(filePath)) {
    signals.push({ id: "snapshot-file-rewrite", detail: `snapshot file "${filePath}" rewritten` });
  }
  const skipDelta = countMatches(SKIP_RE, newText) - countMatches(SKIP_RE, oldText);
  if (skipDelta > 0) {
    signals.push({ id: "skip-added", detail: `${skipDelta} skip/xfail directive(s) added` });
  }
  const onlyDelta = countMatches(ONLY_RE, newText) - countMatches(ONLY_RE, oldText);
  if (onlyDelta > 0) {
    signals.push({ id: "only-added", detail: `${onlyDelta} .only/fit/fdescribe directive(s) added (silences the rest of the file)` });
  }
  const assertionDelta = countMatches(ASSERTION_RE, oldText) - countMatches(ASSERTION_RE, newText);
  if (assertionDelta > 0) {
    signals.push({ id: "assertions-removed", detail: `${assertionDelta} assertion(s) removed with no comparable addition` });
  }
  const testBlockDelta = countMatches(TEST_DECL_RE, oldText) - countMatches(TEST_DECL_RE, newText);
  if (testBlockDelta > 0) {
    signals.push({ id: "test-block-deleted", detail: `${testBlockDelta} test block(s) deleted` });
  }
  if (oldText && newText) {
    const rewrites = expectedValueRewrites(oldText, newText);
    if (rewrites > 0) {
      signals.push({ id: "expected-value-rewrite", detail: `${rewrites} expected-value comparison(s) rewritten` });
    }
    const inflations = timeoutInflations(oldText, newText);
    if (inflations.length) {
      signals.push({ id: "timeout-retry-inflation", detail: `timeout/retry inflated: ${inflations.join(", ")}` });
    }
  }
  return signals;
}

// ../core/src/enforce/oracle-glob.ts
var METACHAR_RE = /[.+^${}()|[\]\\]/g;
var TOKEN_LEADING = "\0DSL\0";
var TOKEN_TRAILING = "\0DST\0";
var TOKEN_BARE = "\0DSB\0";
function matchesTestGlob(rawValue, rawPattern) {
  const value = normalizeForMatch(rawValue);
  const pattern = normalizeForMatch(rawPattern);
  const escaped = pattern.replace(METACHAR_RE, "\\$&");
  const withDoubleStarTokens = escaped.replace(/\*\*\//g, TOKEN_LEADING).replace(/\/\*\*/g, TOKEN_TRAILING).replace(/\*\*/g, TOKEN_BARE);
  const withStars = withDoubleStarTokens.replace(/\*/g, "[^/]*");
  const body = withStars.split(TOKEN_LEADING).join("(?:.*/)?").split(TOKEN_TRAILING).join("(?:/.*)?").split(TOKEN_BARE).join(".*");
  try {
    return new RegExp(`^${body}$`).test(value);
  } catch {
    return false;
  }
}
function matchesAnyTestGlob(value, patterns) {
  return patterns.some((p) => matchesTestGlob(value, p));
}

// ../core/src/enforce/overrides.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync4, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";

// ../core/src/enforce/file-lock.ts
import { openSync, writeSync, closeSync, unlinkSync, statSync, readFileSync as readFileSync3 } from "node:fs";
var DEFAULT_TIMEOUT_MS = 5e3;
var DEFAULT_STALE_MS = 8e3;
var INITIAL_BACKOFF_MS = 4;
var MAX_BACKOFF_MS = 60;
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
var tokenCounter = 0;
function makeToken() {
  tokenCounter += 1;
  return `${process.pid}:${Date.now()}:${tokenCounter}:${Math.random().toString(36).slice(2)}`;
}
function classifyLockError(code, flavor = currentFlavor()) {
  if (code === "EEXIST") return "contention";
  if (flavor === "win32" && (code === "EBUSY" || code === "EPERM")) return "contention";
  return "fatal";
}
function unlinkWithRetry(path2, attempts = 5, delayMs = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      unlinkSync(path2);
      return;
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT") return;
      if (i === attempts - 1) throw err;
      sleepSync(delayMs * (i + 1));
    }
  }
}
function acquireLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  let backoff = INITIAL_BACKOFF_MS;
  for (; ; ) {
    try {
      const fd = openSync(lockPath, "wx");
      const token = makeToken();
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (err) {
      if (classifyLockError(err.code) !== "contention") {
        return null;
      }
    }
    try {
      const heldFor = Date.now() - statSync(lockPath).mtimeMs;
      if (heldFor > staleMs) {
        try {
          unlinkWithRetry(lockPath);
        } catch {
        }
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return null;
    const jittered = Math.random() * backoff;
    sleepSync(Math.min(jittered, Math.max(0, deadline - Date.now())));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
function releaseLock(lockPath, token) {
  try {
    if (token !== void 0) {
      const current = readFileSync3(lockPath, "utf-8");
      if (current !== token) return;
    }
    unlinkWithRetry(lockPath);
  } catch {
  }
}
function withFileLock(lockPath, fn, options = {}) {
  const token = acquireLock(lockPath, options);
  try {
    return fn();
  } finally {
    if (token !== null) releaseLock(lockPath, token);
  }
}

// ../core/src/enforce/overrides.ts
var FileRuleOverrideStore = class {
  directory;
  file;
  lock;
  lockOptions;
  /**
   * `lockOptions` overrides file-lock.ts's default wait/stale-reclaim
   * bounds — same purpose as the matching parameter on StateManager and
   * ProblemLedger's constructors: production code never needs this, but
   * a test deliberately creating heavy artificial contention (or one that
   * wants a SHORT bound so an intentionally-held lock fails fast instead
   * of eating the 5s production default) needs a value the production
   * default doesn't have to grow to accommodate.
   */
  constructor(home = resolveHome(), lockOptions = {}) {
    this.directory = process.env.KEEL_OVERRIDES_DIR || join3(home, ".keel");
    this.file = join3(this.directory, "overrides.json");
    this.lock = `${this.file}.lock`;
    this.lockOptions = lockOptions;
  }
  /**
   * `consume`/`grant` share ONE lock (`overrides.json.lock`) via the
   * shared `withFileLock`/`acquireLock` primitive from file-lock.ts —
   * NOT a hand-rolled `openSync(path, 'wx')` + unconditional `unlinkSync`
   * in `finally`, which this class used to do. That hand-rolled version
   * reproduced the exact stale-lock reclaim-cascade file-lock.ts's own
   * header comment warns against: no ownership token written into the
   * lockfile, so a holder that stalls past the 60s staleness check, gets
   * reclaimed by a waiter, then wakes up and reaches its own `finally`,
   * unconditionally unlinks — deleting the RECLAIMER's live lock, not its
   * own, letting a third writer in while the reclaimer still believes it
   * holds it. `withFileLock`/`acquireLock` close this with a per-acquire
   * token: release only unlinks when the lockfile still contains the
   * exact token this call wrote (see file-lock.ts's header for the full
   * mechanism). Same fail-safe contract as StateManager/ProblemLedger: on
   * a timed-out acquire, the callback still runs UNLOCKED rather than the
   * write being silently skipped or the caller hanging — losing an
   * override write is worse than a rare unlocked window.
   */
  ensureDir() {
    try {
      mkdirSync2(this.directory, { recursive: true });
    } catch {
    }
  }
  consume(ruleId, sessionId) {
    try {
      this.ensureDir();
      return withFileLock(this.lock, () => {
        const overrides = this.read();
        const override = overrides[ruleId];
        if (!override || override.expires_at <= Date.now()) {
          if (override) delete overrides[ruleId];
          this.write(overrides);
          return false;
        }
        if (override.mode === "session") {
          return sessionId !== void 0 && override.session_id === sessionId;
        }
        if (override.mode === "window") return true;
        delete overrides[ruleId];
        this.write(overrides);
        return true;
      }, this.lockOptions);
    } catch {
      return false;
    }
  }
  /**
   * Persist a new/updated override for `ruleId` — the only production
   * WRITER of new entries (`keel allow`, packages/cli/src/commands/
   * allow.ts). Locked exactly like `consume()`, against the same file:
   * without this, a concurrent `keel allow` call (two terminals) or a
   * `consume()` mid-violation on another process is a real lost-update
   * race against this read-modify-write, same hazard class as
   * StateManager/ProblemLedger were fixed for.
   */
  grant(ruleId, override) {
    this.ensureDir();
    withFileLock(this.lock, () => {
      const overrides = this.read();
      overrides[ruleId] = override;
      this.write(overrides);
    }, this.lockOptions);
  }
  peek(ruleId) {
    try {
      const override = this.read()[ruleId];
      if (!override || override.expires_at <= Date.now()) return null;
      return override;
    } catch {
      return null;
    }
  }
  list() {
    try {
      return this.read();
    } catch {
      return {};
    }
  }
  read() {
    if (!existsSync3(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync4(this.file, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
  }
  write(overrides) {
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync2(temporary, JSON.stringify(overrides, null, 2));
    renameSync2(temporary, this.file);
  }
};

// ../core/src/enforce/claim.ts
var CODE_FENCE_RE = /```[\s\S]*?```/g;
var INLINE_CODE_RE = /`[^`\n]*`/g;
var URL_RE = /\bhttps?:\/\/\S+/gi;
var PATH_RE = /\b(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\b/g;
function stripNoise(text) {
  return text.replace(CODE_FENCE_RE, " ").replace(INLINE_CODE_RE, " ").replace(URL_RE, " ").replace(PATH_RE, " ");
}
var QUOTED_RE = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g;
function stripQuoted(text) {
  return text.replace(QUOTED_RE, " ");
}
var HEDGE_RE = /\b(wip|w\.i\.p\.|draft|todo|to-do|partial|pending|incomplete|in[- ]progress|not\s+(?:yet\s+)?(?:run|ran|tested|verified|complete[d]?|done|passing|working)|no\s+tests?|untested|unverified|not\s+sure|might|maybe|probably|should\s+(?:now\s+)?(?:be|pass)|still\s+(?:need|broken|failing))\b/i;
var CLAIM_PATTERNS = [
  // "all tests pass", "the test suite is passing", "tests succeeded"
  { name: "tests-pass", re: /\b(?:all |the )?tests?(?:\s+suite)?\s+(?:(?:is|are|now)\s+)?(?:pass(?:ed|ing)?|green|succeed(?:ed|s)?)\b/i },
  // "build is passing/green/successful/clean"
  { name: "build-pass", re: /\bbuild\s+(?:is\s+)?(?:passing|green|successful|clean)\b/i },
  // "verification passed/complete"
  { name: "verification-noun", re: /\bverification\s+(?:passed|complete[d]?)\b/i },
  // "this/it/the fix is done/fixed/complete/tested/verified/working/resolved/ready"
  { name: "linking-verb", re: /\b(?:this|that|it|everything|the\s+(?:fix|bug|issue|feature|change|pr))\s+(?:is|are|was|now)\s+(?:done|complete[d]?|fixed|tested|verified|working|resolved|ready)\b/i },
  // clause-leading past-participle claim: "Fixed and passing.", "Done."
  // The negative lookahead excludes a conventional-commit-style label
  // ("fixed:" as a header) from being read as an assertion.
  { name: "clause-leading", re: /(?:^|[.!;]\s+|,\s*(?:and\s+)?|\band\s+)(done|fixed|complete[d]?|tested|verified|resolved)\b(?!\s*[:\-])/i },
  // bare "verified" is a rarer, stronger signal than "done"/"fixed" — kept
  // as its own pattern so it does not need clause-leading position.
  { name: "verified-explicit", re: /\bverified\b(?!\s*[:\-])/i }
];
function scanUtterance(raw, source) {
  if (!raw) return null;
  let text = stripNoise(raw);
  if (source === "reasoning") text = stripQuoted(text);
  if (HEDGE_RE.test(text)) return null;
  for (const { name, re } of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) return { phrase: m[0].trim(), pattern: name, source };
  }
  return null;
}
var MESSAGE_FLAG_RE = /(?:-m|--message|--body|--title)[\s=]+(?:"([^"]*)"|'([^']*)')/g;
function extractCommandMessages(cmd) {
  const out = [];
  const re = new RegExp(MESSAGE_FLAG_RE);
  let m;
  while (m = re.exec(cmd)) {
    const value = m[1] ?? m[2] ?? "";
    if (value) out.push(value);
  }
  return out;
}
function detectClaim(input) {
  if (input.reasoning) {
    const hit = scanUtterance(input.reasoning, "reasoning");
    if (hit) return hit;
  }
  const cmd = commandString(input);
  for (const message of extractCommandMessages(cmd)) {
    const hit = scanUtterance(message, "command-message");
    if (hit) return hit;
  }
  return null;
}

// ../core/src/enforce/pipeline.ts
var OBSERVE_CONTINUE = /* @__PURE__ */ Symbol("keel:observe-continue");
var MAX_OUTPUT_SCAN_CHARS = 256 * 1024;
var EnforcementPipeline = class {
  config;
  verificationTracker;
  oracleTracker;
  denyFirstTime = /* @__PURE__ */ new Map();
  circuitBreaker = /* @__PURE__ */ new Map();
  rateCounts = /* @__PURE__ */ new Map();
  lastRulesHash = "";
  previousRulesHash = "";
  /**
   * `mode: observe` matches recorded during the CURRENT evaluate() call.
   * Reset at the top of evaluate() and read back at the bottom to decorate
   * the result — see OBSERVE_CONTINUE's header comment for why this is an
   * instance field rather than a threaded parameter. Not concurrency-safe
   * across overlapping evaluate() calls on the same instance, same as
   * every other per-call instance field here (denyFirstTime,
   * circuitBreaker, rateCounts) — this pipeline is built for one call at a
   * time per host process, not concurrent evaluate() calls.
   */
  observedMatches = [];
  overrideStore;
  packageVerifierCache;
  constructor(config) {
    this.config = config;
    this.verificationTracker = config.verificationTracker || new VerificationTracker(config.stateManager);
    this.oracleTracker = config.oracleTracker || new OracleTracker(config.stateManager);
    this.overrideStore = config.overrideStore || new FileRuleOverrideStore();
    this.packageVerifierCache = config.packageVerifierCache || new PackageVerifierCache();
    this.lastRulesHash = this.computeRulesHash();
    this.loadState();
  }
  /** Load persisted state from StateManager into instance maps. */
  loadState() {
    const sm = this.config.stateManager;
    if (!sm) return;
    for (const ruleId of Object.keys(sm.denyFirstTime)) {
      if (!sm.isFirstTime(ruleId, this.lastRulesHash)) this.denyFirstTime.set(ruleId, true);
    }
    for (const [key, val] of Object.entries(sm.circuitBreaker)) {
      this.circuitBreaker.set(key, { count: val.count, startTime: val.startTime });
    }
    for (const [key, val] of Object.entries(sm.rateCounts)) {
      this.rateCounts.set(key, { count: val.count, windowStart: val.windowStart });
    }
  }
  computeRulesHash() {
    if (this.config.ruleFingerprint) return this.config.ruleFingerprint();
    const h = this.config.ruleHierarchy;
    return [
      h.global ? hashRulesFile(h.global.sourcePath) : "",
      h.project ? hashRulesFile(h.project.sourcePath) : "",
      h.local ? hashRulesFile(h.local.sourcePath) : ""
    ].join(":");
  }
  /**
   * Check if rules have changed since last evaluation.
   * If so, flush cache and re-merge rules.
   */
  checkRuleVersion() {
    const currentHash = this.computeRulesHash();
    if (currentHash !== this.lastRulesHash) {
      const reloaded = this.config.reloadRules?.();
      if (reloaded) {
        const errors = [reloaded.global, reloaded.user, reloaded.project, reloaded.local].flatMap((source) => source ? [...source.errors || [], ...validateRules(source.rules)] : []);
        if (errors.length) {
          this.config.onRulesError?.(errors);
          return false;
        }
        this.config.ruleHierarchy = reloaded;
        this.config.onRulesReload?.(reloaded);
      }
      this.previousRulesHash = this.lastRulesHash;
      this.lastRulesHash = this.computeRulesHash();
      this.config.ruleVersion += 1;
      this.config.cache.invalidate(this.config.ruleVersion);
      this.denyFirstTime.clear();
      this.config.contentTracker.clear();
      this.config.sequenceDetector.clear();
      this.config.flowTracker.clear();
      return true;
    }
    return false;
  }
  /**
   * Evaluate an action against all active rules.
   *
   * Thin wrapper around evaluateTiers(): resets the per-call observed-match
   * accumulator, runs the real tiered evaluation, then decorates the
   * result with everything that was observed along the way. Splitting it
   * this way means the many `return this.violation(...)` / `return
   * this.result(...)` sites inside evaluateTiers() need no per-site
   * awareness of observe recording — they just stop short of completing
   * when violation() throws OBSERVE_CONTINUE (see its header comment), and
   * this one place is where the accumulated observations get attached to
   * whatever verdict actually won.
   */
  async evaluate(input) {
    const start = Date.now();
    this.observedMatches = [];
    let result;
    try {
      result = await this.evaluateTiers(input);
    } catch (err) {
      if (err === OBSERVE_CONTINUE) {
        result = this.result("allow", "", "Allowed (observe-only match)", start, false, 0);
      } else {
        throw err;
      }
    }
    if (this.observedMatches.length) {
      result.observed_matches = this.observedMatches.map((m) => ({ ...m }));
      result.observed_action = this.observedMatches[0].observed_action;
      if (result.action === "allow" && !result.rule_id) {
        const first = this.observedMatches[0];
        result.rule_id = first.rule_id;
        result.rule_name = first.rule_id;
        result.message = first.message;
      }
    }
    return result;
  }
  /**
   * Narrow claim-to-evidence check for a channel that carries the agent's
   * own completed output OUTSIDE a real tool call — an OpenCode
   * `experimental.text.complete` segment, a Claude Code `Stop` hook's
   * `last_assistant_message`, or any future per-host equivalent (v0.4
   * Phase 1: "give claim-to-evidence real reach").
   *
   * Deliberately NOT `evaluate(input)`: routing a synthetic per-utterance
   * "tool call" through the full tier stack would feed
   * `flowTracker.record`/`sequenceDetector.record` and the `rate`-type
   * stateful rules (e.g. `runaway-budget-tool-calls`) a phantom call once
   * per assistant utterance — corrupting exactly the trace-derived counters
   * (stuck-loop, runaway-budget, flow) the v0.4 thesis experiment measures
   * off keel's own traces in the guarded arm. It would also newly activate
   * two other `input.reasoning` consumers that have been permanently
   * unpopulated in production until this phase: `unless_reasoning` allow-
   * exceptions (types.ts) and the tier-7 `level: protect` reasoning-anomaly
   * heuristic (evaluateTiers() below) — both are behavior changes with
   * their own review, not a side effect of widening the claim channel's
   * reach. This method only ever touches `type: claim` rules and the
   * `VerificationTracker` state they already share with `type:
   * verification` — nothing else in the pipeline sees this call.
   */
  async evaluateClaim(input) {
    const start = Date.now();
    this.observedMatches = [];
    let result;
    try {
      result = this.evaluateClaimTier(input, start);
    } catch (err) {
      if (err === OBSERVE_CONTINUE) {
        result = this.result("allow", "", "Allowed (observe-only match)", start, false, 0);
      } else {
        throw err;
      }
    }
    if (this.observedMatches.length) {
      result.observed_matches = this.observedMatches.map((m) => ({ ...m }));
      result.observed_action = this.observedMatches[0].observed_action;
      if (result.action === "allow" && !result.rule_id) {
        const first = this.observedMatches[0];
        result.rule_id = first.rule_id;
        result.rule_name = first.rule_id;
        result.message = first.message;
      }
    }
    return result;
  }
  /** The single-rule-type loop evaluateClaim() wraps. See its own header comment. */
  evaluateClaimTier(input, start) {
    const halted = this.checkHalt(start);
    if (halted) return halted;
    this.checkRuleVersion();
    const level = this.effectiveLevel(input);
    const rules = mergeRules(this.config.ruleHierarchy, level, input.context);
    for (const rule of rules) {
      if (rule.type !== "claim") continue;
      try {
        if (this.verificationTracker.isPending(rule, input)) {
          const claim = detectClaim(input);
          if (claim) {
            const message = `${rule.message} (claimed via ${claim.source}: "${claim.phrase}")`;
            return this.violation(input, rule, message, start, 6, rule.id);
          }
        }
      } catch (err) {
        if (err === OBSERVE_CONTINUE) continue;
        throw err;
      }
    }
    return this.result("allow", "", "Allowed (no matching claim rule)", start, false, 0);
  }
  /**
   * Scan a completed tool call's OWN output text (`input.tool_output`) for
   * secret-shaped content, reusing the exact `type: content` regex patterns
   * that already gate what gets WRITTEN to a file (`no-secrets-in-code`,
   * `evaluateTiers()`'s Tier 5 content branch above) — sprint/lane-c2's
   * output-capture-and-redact path, for a host's PostToolUse-equivalent
   * hook. Live-verified (not inferred) to actually change what an OpenCode
   * session's model receives when the caller applies `redacted_output` back
   * onto the host's mutable output object — see
   * session/transcripts/opencode-tool-execute-after-mutation-probe.txt and
   * docs/exfil.md's "Output redaction" section. On every OTHER host this
   * result is, at best, a warning a caller can inject as context (Claude
   * Code's `additionalContext`) — see hook.ts.
   *
   * Deliberately NOT `evaluate()` or `evaluateClaim()`: this is a pure
   * text-in, verdict-and-candidate-replacement-text-out function. It never
   * touches flowTracker/sequenceDetector/rate state, never consults
   * VerificationTracker, and — critically — never mutates anything itself;
   * the caller decides whether and how to apply `redacted_output`.
   *
   * `mode: observe` content rules are deliberately excluded from producing
   * an `action: 'redact'` verdict here, the same restraint `evaluate()`'s
   * OBSERVE_CONTINUE gives every other rule type: a rule the user configured
   * to only WATCH must never itself cause a live mutation of what the agent
   * sees — that would be enforcement from a rule believed to be inert, the
   * failure this codebase's own memory calls the worst shape a guardrail can
   * have. An observe-mode content rule that matches output text is still
   * recorded (`redacted_rule_ids` includes it, `observed_matches` carries
   * it), just never contributes its span to `redacted_output`.
   *
   * Bounded: `tool_output` can be multi-megabyte (a large file read, a
   * verbose test run) and this runs on every call through a host's after-
   * hook, awaited on that hook's own hot path. Text past
   * `MAX_OUTPUT_SCAN_CHARS` is not scanned — the result says so
   * (`truncated: true` is folded into the message) rather than silently
   * returning a clean verdict for content it never looked at.
   *
   * Deliberately does NOT check the halt latch (checkHalt(), below) the way
   * evaluateTiers() and evaluateClaimTier() do. This method never blocks —
   * it only ever returns 'allow' or 'redact' for output that already ran —
   * so skipping it during a halt would not stop anything from executing;
   * it would just make a leaked secret MORE likely to reach the model
   * unredacted, which is the opposite of what a lockdown is for.
   */
  async evaluateOutput(input) {
    const start = Date.now();
    const text = input.tool_output;
    if (!text) return this.result("allow", "", "No tool output to scan", start, false, 5);
    this.checkRuleVersion();
    const level = this.effectiveLevel(input);
    const rules = mergeRules(this.config.ruleHierarchy, level, input.context);
    const truncated = text.length > MAX_OUTPUT_SCAN_CHARS;
    const scanText = truncated ? text.slice(0, MAX_OUTPUT_SCAN_CHARS) : text;
    const matchedRuleIds = [];
    const observeOnlyRuleIds = [];
    const spanUnsafeRuleIds = [];
    let matchedPattern;
    const candidateSpans = [];
    for (const rule of rules) {
      if (rule.type !== "content" || !rule.patterns) continue;
      for (const pattern of rule.patterns) {
        if (!pattern.regex) continue;
        let re;
        try {
          re = new RegExp(pattern.regex, "gi");
        } catch {
          continue;
        }
        if (!re.test(scanText)) continue;
        matchedPattern = matchedPattern || pattern.regex;
        if (rule.mode === "observe") {
          if (!observeOnlyRuleIds.includes(rule.id)) observeOnlyRuleIds.push(rule.id);
          continue;
        }
        if (pattern.redact_span !== true) {
          if (!spanUnsafeRuleIds.includes(rule.id)) spanUnsafeRuleIds.push(rule.id);
          continue;
        }
        const finder = new RegExp(pattern.regex, "gi");
        let occurrence;
        while (occurrence = finder.exec(scanText)) {
          candidateSpans.push({ start: occurrence.index, end: occurrence.index + occurrence[0].length, ruleId: rule.id });
          if (occurrence[0].length === 0) finder.lastIndex++;
        }
      }
    }
    candidateSpans.sort((a, b) => a.start - b.start);
    const mergedSpans = [];
    for (const span of candidateSpans) {
      const current = mergedSpans[mergedSpans.length - 1];
      if (current && span.start <= current.end) {
        current.end = Math.max(current.end, span.end);
        if (!current.ruleIds.includes(span.ruleId)) current.ruleIds.push(span.ruleId);
      } else {
        mergedSpans.push({ start: span.start, end: span.end, ruleIds: [span.ruleId] });
      }
    }
    for (const group of mergedSpans) {
      for (const ruleId of group.ruleIds) {
        if (!matchedRuleIds.includes(ruleId)) matchedRuleIds.push(ruleId);
      }
    }
    let redacted = scanText;
    if (mergedSpans.length) {
      let out = "";
      let cursor = 0;
      for (const group of mergedSpans) {
        out += scanText.slice(cursor, group.start) + `[redacted-by-keel:${group.ruleIds.join("+")}]`;
        cursor = group.end;
      }
      out += scanText.slice(cursor);
      redacted = out;
    }
    const truncNote = truncated ? ` (only the first ${MAX_OUTPUT_SCAN_CHARS} chars were scanned)` : "";
    if (!matchedRuleIds.length) {
      const notes = [];
      if (observeOnlyRuleIds.length) notes.push(`${observeOnlyRuleIds.join(", ")} matched in mode: observe \u2014 recorded, not redacted`);
      if (spanUnsafeRuleIds.length) notes.push(`${spanUnsafeRuleIds.join(", ")} matched a label/signature only (redact_span not set) \u2014 recorded, not redacted, because the match does not bound the secret`);
      const note = notes.length ? ` (${notes.join("; ")})` : "";
      const result2 = this.result("allow", "", `No secret-shaped content in tool output${note}${truncNote}`, start, false, 5);
      const detectedOnly = [...observeOnlyRuleIds, ...spanUnsafeRuleIds];
      if (detectedOnly.length) result2.redacted_rule_ids = detectedOnly;
      if (truncated) result2.scan_truncated = true;
      return result2;
    }
    const allIds = [...matchedRuleIds, ...observeOnlyRuleIds, ...spanUnsafeRuleIds];
    const result = this.result("redact", matchedRuleIds[0], `Tool output contained secret-shaped content (${allIds.join(", ")}) \u2014 redacted before delivery${truncNote}.`, start, false, 5);
    result.matched_pattern = matchedPattern;
    result.redacted_output = truncated ? redacted + text.slice(MAX_OUTPUT_SCAN_CHARS) : redacted;
    result.redacted_rule_ids = allIds;
    if (truncated) result.scan_truncated = true;
    return result;
  }
  /**
   * The halt latch — `keel halt`'s inverse of the DISABLED kill switch
   * below. Where DISABLED ALLOWS every call, HALTED DENIES every call, and
   * it is checked strictly before DISABLED (see evaluateTiers()'s and
   * evaluateClaimTier()'s call sites) so halt wins even when both
   * sentinels are present — an agent that already ran `keel disable`
   * cannot escape a halt set afterward, and `keel disable`'s own purpose
   * (turn keel off) does not extend to a halt's purpose (nothing, not even
   * keel's own controls, should un-stick this without a human).
   *
   * Unlike the DISABLED check, there is no expires_at to consult (a halt
   * never auto-clears) and a corrupt sentinel does not throw — it fails
   * closed the OTHER way: existence of the file is itself sufficient to
   * keep denying, so a damaged JSON body degrades the DISPLAYED reason,
   * never the verdict. Reads the file directly (readFileSync in a single
   * try/catch) rather than existsSync()-then-readFileSync(): a bare
   * existsSync() swallows EACCES/ELOOP identically to ENOENT, so "cannot
   * determine" and "confirmed absent" would both read as "not halted" — a
   * permissions glitch would silently defeat the latch. Only a confirmed
   * ENOENT means genuinely not halted; every other read failure (missing
   * permissions, a symlink loop, a corrupt/unparseable body) fails closed.
   */
  checkHalt(start) {
    const haltPath = this.config.haltFile || join4(resolveHome(), ".keel", "HALTED");
    let raw;
    try {
      raw = readFileSync5(haltPath, "utf-8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return null;
      }
      return this.result("deny", "keel-halted", "Keel is HALTED: unable to confirm halt state. Run 'keel resume' to clear.", start, false, 0);
    }
    let reason = "Manual halt";
    try {
      const state = JSON.parse(raw);
      if (state && typeof state.reason === "string" && state.reason) reason = state.reason;
    } catch {
      reason = "unknown (corrupt sentinel)";
    }
    return this.result("deny", "keel-halted", `Keel is HALTED: ${reason}. Run 'keel resume' to clear.`, start, false, 0);
  }
  async evaluateTiers(input) {
    const start = Date.now();
    const halted = this.checkHalt(start);
    if (halted) return halted;
    this.checkRuleVersion();
    const level = this.effectiveLevel(input);
    const depth = input.depth || (level === "protect" ? "deep" : level === "sprint" ? "fast" : "full");
    const protectFloor = (rules2) => rules2.some((rule) => rule.level === "protect" && (rule.type === "content" || rule.type === "sequence" || rule.type === "flow"));
    const reasoningChecks = depth === "deep";
    const sentinelPath = this.config.disableFile || join4(resolveHome(), ".keel", "DISABLED");
    if (existsSync4(sentinelPath)) {
      try {
        const sentinel = JSON.parse(readFileSync5(sentinelPath, "utf-8"));
        if (sentinel.expires_at && new Date(sentinel.expires_at) < /* @__PURE__ */ new Date()) {
          rmSync(sentinelPath);
        } else {
          return this.result("allow", "", "Enforcement disabled via kill switch", start, false, 0);
        }
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        } else {
          throw new Error("Invalid Keel kill-switch state; run `keel enable` to recover");
        }
      }
    }
    this.config.flowTracker.record(input, "");
    const rules = mergeRules(this.config.ruleHierarchy, level, input.context);
    const deepChecks = depth !== "fast" || protectFloor(rules);
    const statefulRules = rules.filter(
      (rule) => ["verification", "claim", "research", "stuck", "rate", "time"].includes(rule.type) || deepChecks && ["sequence", "flow", "oracle"].includes(rule.type)
    );
    const gatedRules = rules.filter((rule) => this.effectiveAction(rule, input) === "prompt");
    if (statefulRules.length) {
      const maxWindow = Math.max(...statefulRules.map((rule) => rule.sequence_window_seconds || rule.window_seconds || 60));
      this.config.sequenceDetector.setWindow(maxWindow * 1e3);
      this.config.sequenceDetector.record(input);
    }
    const cmdSurfacesBox = {};
    const isStatefulOnlyRuleType = (t) => t === "verification" || t === "claim";
    const floorTieredRules = rules.filter((rule) => (rule.mode === "observe" || rule.level === "protect") && !isStatefulOnlyRuleType(rule.type));
    const floorTieredSet = new Set(floorTieredRules);
    if (floorTieredRules.length) {
      const floorResult = this.runTieredRules(floorTieredRules, input, start, deepChecks, cmdSurfacesBox);
      if (floorResult) return floorResult;
    }
    for (const rule of statefulRules) {
      try {
        if (rule.type === "verification") {
          const boundaryMessage = this.verificationTracker.boundary(rule, input);
          if (boundaryMessage) {
            const stateKey = `${rule.id}:${input.cwd}`;
            const boundaryRule = boundaryMessage.action ? { ...rule, action: boundaryMessage.action } : rule;
            return this.violation(input, boundaryRule, boundaryMessage.message, start, 6, stateKey);
          }
        }
        if (rule.type === "claim" && this.verificationTracker.isPending(rule, input)) {
          const claim = detectClaim(input);
          if (claim) {
            const message = `${rule.message} (claimed via ${claim.source}: "${claim.phrase}")`;
            return this.violation(input, rule, message, start, 6, rule.id);
          }
        }
        if (rule.type === "research" && rule.trigger && this.config.researchTracker) {
          const researchTracker = this.config.researchTracker;
          if (researchTracker.discharge(rule, input)) continue;
          const boundaryMessage = researchTracker.boundary(rule, input);
          if (boundaryMessage) {
            const boundaryRule = boundaryMessage.action ? { ...rule, action: boundaryMessage.action } : { ...rule, action: "redirect" };
            const directive = {
              kind: "research",
              required_tools: rule.satisfy?.tools?.length ? rule.satisfy.tools : ["keel_research"],
              target: `fix action while a failing command still lacks fresh research`,
              rationale: rule.message,
              rule_id: rule.id,
              suggested_call: `keel_research({ query: "<the failing module or error>" })`
            };
            return this.violation(input, boundaryRule, boundaryMessage.message, start, 6, rule.id, directive, true);
          }
        }
      } catch (err) {
        if (err === OBSERVE_CONTINUE) continue;
        throw err;
      }
    }
    const cached = statefulRules.length || gatedRules.length || input.action_override ? null : this.config.cache.get(
      input.tool,
      input.args,
      this.config.ruleVersion,
      this.cacheContext(input, depth)
    );
    if (cached) {
      if (cached.verdict === "deny" || cached.verdict === "block") {
        if (cached.rule_id && this.overrideStore.consume(cached.rule_id, input.session_id)) {
          return this.result("allow", cached.rule_id, this.overrideMessage(cached.rule_id), start, true, 1);
        }
        return this.result("deny", cached.rule_id || "", "Cached deny verdict", start, true, 1);
      }
      if (cached.verdict === "allow") {
        return this.result("allow", "", "Allowed (cached)", start, true, 1);
      }
    }
    const remainingTieredRules = floorTieredRules.length ? rules.filter((rule) => !floorTieredSet.has(rule)) : rules;
    const tieredResult = this.runTieredRules(remainingTieredRules, input, start, deepChecks, cmdSurfacesBox);
    if (tieredResult) return tieredResult;
    if (reasoningChecks && level === "protect" && input.reasoning) {
      const dangerSignals = [
        /ignore.*(rule|policy|restrict)/i,
        /bypass.*(check|guard|protect)/i,
        /disable.*(safety|keel|hook)/i,
        /workaround.*(rule|block)/i,
        /don'?t tell.*(user|human)/i,
        /hid(e|den).*(action|change)/i
      ];
      for (const signal of dangerSignals) {
        if (signal.test(input.reasoning)) {
          return this.result("warn", "reasoning-anomaly", `Suspicious reasoning pattern detected`, start, false, 7);
        }
      }
    }
    if (!statefulRules.length && !gatedRules.length && !this.observedMatches.length) {
      this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
        verdict: "allow",
        rule_id: null,
        count: 0,
        timestamp: Date.now()
      }, this.cacheContext(input, depth));
    }
    return this.result("allow", "", "Allowed (no matching rule)", start, false, 0);
  }
  /**
   * The tiered rule-matching loop (rate/time/command/filesystem/network/
   * package/stuck/diagnosis/research(topics)/env/content/oracle/sequence/
   * flow/session) — Tiers 2 through 6. Extracted out of evaluateTiers() so
   * it can be run TWICE over two different slices of the same rank-ordered
   * `rules` list: once for the `mode: observe` + `level: protect` subset —
   * ranks 0 and 1, in that relative order — (before the statefulRules loop
   * even starts), and once for everything else (in its original position,
   * after statefulRules) — see evaluateTiers()'s "Floor-first pass" comment
   * for why observe rules ride along with the floors instead of only the
   * floors moving. `cmdSurfaces` is boxed so both calls share the same
   * lazily-computed memo instead of recomputing it.
   * Returns the first violation/result produced by any rule in `list`, or
   * `undefined` if none of them produced a verdict.
   */
  runTieredRules(list, input, start, deepChecks, cmdSurfaces) {
    for (const rule of list) {
      try {
        if (rule.type === "rate") {
          const matchPattern = rule.match || input.tool;
          if (rule.match && !this.matchesRulePattern(rule.match, `${input.tool} ${commandString(input)}`) && !this.matchesRulePattern(rule.match, `${input.tool} ${JSON.stringify(input.args)}`)) continue;
          const windowSec = rule.window_seconds || 60;
          const maxCalls = rule.max_calls || 10;
          const rateKey = `rate:${rule.id}:${matchPattern}`;
          const now = Date.now();
          const existing = this.rateCounts.get(rateKey);
          const exceeded = this.config.stateManager ? this.config.stateManager.checkRateLimit(rule.id, matchPattern, windowSec, maxCalls) : (() => {
            if (existing && now - existing.windowStart < windowSec * 1e3) {
              existing.count++;
              return existing.count > maxCalls;
            }
            this.rateCounts.set(rateKey, { count: 1, windowStart: now });
            return false;
          })();
          if (this.config.stateManager) {
            const persisted = this.config.stateManager.rateCounts[rateKey];
            if (persisted) this.rateCounts.set(rateKey, { ...persisted });
          }
          if (exceeded) {
            return this.violation(input, rule, `Rate limit: ${maxCalls} calls per ${windowSec}s for "${matchPattern}"`, start, 2);
          }
          continue;
        }
        if (rule.type === "time" && rule.schedule) {
          const now = /* @__PURE__ */ new Date();
          const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
          const currentDay = dayNames[now.getDay()];
          const currentTime = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
          const { start: windowStart, end: windowEnd, days } = rule.schedule;
          if (rule.match) {
            const cmdStr = commandString(input);
            if (!this.matchesRulePattern(rule.match, cmdStr)) continue;
          }
          if (days && !days.some((d) => d.toLowerCase() === currentDay)) {
            return this.violation(input, rule, `Outside schedule: ${days.join(", ")} ${windowStart}-${windowEnd}`, start, 2);
          }
          if (windowStart && windowEnd) {
            const inside = windowStart <= windowEnd ? currentTime >= windowStart && currentTime <= windowEnd : currentTime >= windowStart || currentTime <= windowEnd;
            if (!inside) {
              return this.violation(input, rule, `Outside schedule window: ${windowStart}-${windowEnd}`, start, 2);
            }
          } else if (windowStart && currentTime < windowStart) {
            return this.violation(input, rule, `Before schedule start: ${windowStart}`, start, 2);
          } else if (windowEnd && currentTime > windowEnd) {
            return this.violation(input, rule, `After schedule end: ${windowEnd}`, start, 2);
          }
          continue;
        }
        if (rule.type === "command" && (rule.match || rule.match_regex || rule.match_prefix)) {
          const cmdStr = commandString(input);
          const isFix = this.effectiveAction(rule, input) === "fix" && !!rule.fix;
          const pattern = rule.match_regex || rule.match;
          let matches2;
          if (isFix) {
            matches2 = rule.match_prefix ? cmdStr.toLowerCase().startsWith(rule.match_prefix.toLowerCase()) : !!pattern && this.matchesRulePattern(pattern, cmdStr);
          } else {
            cmdSurfaces.value ??= commandSurfaces(input);
            matches2 = rule.match_prefix ? cmdSurfaces.value.some((s) => s.toLowerCase().startsWith(rule.match_prefix.toLowerCase())) : !!pattern && cmdSurfaces.value.some((s) => this.matchesRulePattern(pattern, s));
          }
          if (matches2) {
            if (rule.unless_reasoning && input.reasoning) {
              const unlessRegex = new RegExp(rule.unless_reasoning, "i");
              if (unlessRegex.test(input.reasoning)) {
                continue;
              }
            }
            if (rule.unless) {
              let shouldSkip = false;
              for (const u of rule.unless) {
                if (u.regex) {
                  const unlessRegex = new RegExp(u.regex, "i");
                  if (unlessRegex.test(cmdStr)) {
                    shouldSkip = true;
                    break;
                  }
                }
              }
              if (shouldSkip) continue;
            }
            if (isFix) {
              return this.fixAction(input, rule, cmdStr, start);
            }
            return this.violation(input, rule, rule.message, start, 2);
          }
        }
        if (rule.type === "filesystem" && rule.paths && !/^read/i.test(input.tool)) {
          const args = input.args;
          const pathStr = argPath(args);
          const resolvedPath = resolveMaybeRelative(pathStr, input.cwd);
          const operation = String(args.operation || "");
          const excluded = (rule.exclude || []).some((p) => this.pathMatches(resolvedPath, p));
          const positivePatterns = rule.paths.filter((p) => !p.startsWith("!"));
          const negatedPatterns = rule.paths.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
          const positiveMatched = positivePatterns.length === 0 ? true : positivePatterns.some((p) => this.pathMatches(resolvedPath, p));
          const negatedExcluded = negatedPatterns.some((p) => this.pathMatches(resolvedPath, p));
          const pathMatched = positiveMatched && !negatedExcluded;
          const operationMatched = !rule.operations?.length || rule.operations.includes(operation);
          if (pathMatched && operationMatched && !excluded) return this.violation(input, rule, rule.message, start, 3);
        }
        if (rule.type === "network" && rule.match) {
          const url = typeof input.args === "object" && input.args !== null ? input.args.url || input.args.host || "" : "";
          const urlStr = String(url);
          if (rule.except) {
            let isExcepted = false;
            for (const ex of rule.except) {
              if (urlStr.includes(ex)) {
                isExcepted = true;
                break;
              }
            }
            if (isExcepted) continue;
          }
          if (this.matchesRulePattern(rule.match, urlStr)) return this.violation(input, rule, rule.message, start, 3);
        }
        if (rule.type === "package") {
          const cmdStr = commandString(input);
          const specs = extractPackageInstalls(cmdStr);
          if (specs.length === 0) continue;
          const ageThresholdDays = rule.age_days ?? 30;
          const { results, misses } = checkPackagesCacheOnly(specs, this.packageVerifierCache);
          if (misses.length > 0) {
            const settled = scheduleBackgroundVerification(misses, {
              ageThresholdDays,
              totalTimeoutMs: 2e3,
              cache: this.packageVerifierCache,
              fetchImpl: this.config.packageVerifierFetch
            });
            this.config.packageVerifierOnBackgroundStart?.(settled);
          }
          const decision = decidePackageAction(results, ageThresholdDays);
          if (decision.reason === "ok") continue;
          if (decision.reason === "not_found") {
            return this.violation(input, { ...rule, action: "deny" }, decision.message, start, 3, rule.id, void 0, true);
          }
          if (decision.reason === "unverified") {
            return this.violation(input, { ...rule, action: "prompt" }, decision.message, start, 3);
          }
          return this.violation(input, rule, decision.message, start, 3);
        }
        if (rule.type === "stuck" && rule.match && this.config.stuckTracker) {
          const cmdStr = commandString(input);
          if (!this.matchesRulePattern(rule.match, cmdStr)) continue;
          const escalation = this.config.stuckTracker.check(rule, input);
          if (escalation) {
            const directive = {
              kind: "stuck",
              required_tools: ["keel_research", "keel_hypothesis"],
              target: `identical failing command (${escalation.attempts} attempts)`,
              rationale: rule.message,
              rule_id: rule.id,
              attempts: escalation.attempts,
              suggested_call: 'keel_research({ query: "<the exact error text>" })'
            };
            return this.violation(input, { ...rule, action: escalation.action }, escalation.message, start, 2, rule.id, directive, true);
          }
          continue;
        }
        if (rule.type === "diagnosis" && this.config.ledger) {
          const cmdStr = commandString(input);
          if (rule.fallback_tools?.includes(input.tool) && rule.fallback_pattern && this.matchesRulePattern(rule.fallback_pattern, cmdStr)) {
            const activeKey = this.config.ledger.activeProblemKey(input.session_id);
            if (activeKey) this.config.ledger.recordDiagnosis(activeKey, cmdStr);
            continue;
          }
          if (!rule.match) continue;
          const cmdHaystack = `${input.tool} ${cmdStr}`;
          const jsonHaystack = `${input.tool} ${JSON.stringify(input.args)}`;
          if (!this.matchesRulePattern(rule.match, jsonHaystack) && !this.matchesRulePattern(rule.match, cmdHaystack)) continue;
          const windowSec = rule.hypothesis_window_seconds ?? 900;
          const problemKey2 = this.config.ledger.activeProblemKey(input.session_id);
          if (!problemKey2) continue;
          const hasHypothesis = this.config.ledger.hasFreshHypothesis(problemKey2, windowSec);
          const hasDiagnosis = this.config.ledger.hasFreshDiagnosis(problemKey2, windowSec);
          if (hasHypothesis || hasDiagnosis) continue;
          const directive = {
            kind: "diagnosis",
            required_tools: rule.hypothesis_tools ?? ["keel_hypothesis"],
            target: "complex fix without a stated root cause",
            rationale: rule.message,
            rule_id: rule.id,
            suggested_call: 'keel_hypothesis({ statement: "Because X, Y fails. Fix: Z." })'
          };
          return this.violation(input, { ...rule, action: rule.action || "redirect" }, rule.message, start, 2, rule.id, directive, true);
        }
        if (rule.type === "research" && rule.topics?.length) {
          const haystack = `${commandString(input)} ${input.reasoning || ""}`;
          if (!rule.topics.some((t) => this.matchesRulePattern(t, haystack))) continue;
          if (rule.except?.some((d) => haystack.includes(d))) continue;
          if (!this.config.researchCache) continue;
          const maxAgeHours = rule.max_age_hours ?? (Number(process.env.KEEL_RESEARCH_MAX_AGE_HOURS) || 24);
          const probe = this.config.researchCache.probe(input.session_id, rule.topics, maxAgeHours);
          if (probe.hit) continue;
          const topic = rule.topics[0];
          const missing = probe.entries.length === 0;
          const directive = {
            topic,
            missing,
            stalenessHours: probe.stalenessHours,
            maxAgeHours,
            suggestion: `Run keel_research { query: "${topic}" } (or your platform web_search), then re-run this action.`
          };
          return this.result("research", rule.id, `Knowledge freshness gate: ${missing ? "no research" : `research ${probe.stalenessHours?.toFixed(1)}h old (max ${maxAgeHours}h)`} for "${topic}". ${directive.suggestion}`, start, false, 3, void 0, directive);
        }
        if (rule.type === "env" && rule.vars?.length) {
          const cmdStr = commandString(input);
          const varHit = rule.vars.some((v) => cmdStr.toLowerCase().includes(String(v).toLowerCase()));
          if (varHit) return this.violation(input, rule, rule.message, start, 3);
        }
        if (deepChecks && rule.type === "content" && rule.patterns && !/^read/i.test(input.tool)) {
          const args = input.args;
          const pathStr = argPath(args);
          const resolvedPath = resolveMaybeRelative(pathStr, input.cwd);
          const patchText = String(args.patchText || "");
          const inlineContent = String(args.content || args.text || args.newString || args.new_string || patchText || "");
          const isFile = resolvedPath && existsSync4(resolvedPath) && statSync2(resolvedPath).isFile();
          const diskChanged = isFile && this.config.contentTracker.hasChanged(resolvedPath);
          if (inlineContent || diskChanged) {
            for (const pattern of rule.patterns) {
              const content = inlineContent || (isFile ? readFileSync5(resolvedPath, "utf-8") : "");
              if (pattern.regex && this.matchesRulePattern(pattern.regex, content) || pattern.prefix && content.startsWith(pattern.prefix)) {
                return this.violation(input, rule, rule.message, start, 5);
              }
            }
            if (isFile) this.config.contentTracker.markUnchanged(resolvedPath);
          }
        }
        if (deepChecks && rule.type === "oracle") {
          if (rule.match) {
            const cmdStr = commandString(input);
            if (cmdStr && this.matchesRulePattern(rule.match, cmdStr)) {
              const recent = this.oracleTracker.recentFailure(rule, input);
              if (recent) {
                const age = Math.round(recent.ageMs / 1e3);
                return this.violation(input, rule, `${rule.message} [command-surface: "${cmdStr}" ran ${age}s after failing run "${recent.command}"]`, start, 5);
              }
            }
          }
          if (rule.paths && !/^read/i.test(input.tool)) {
            const args = input.args;
            const pathStr = argPath(args);
            const resolvedPath = resolveMaybeRelative(pathStr, input.cwd);
            const pathMatched = !!resolvedPath && matchesAnyTestGlob(resolvedPath, rule.paths);
            if (pathMatched) {
              const patchText = String(args.patchText || "");
              const newText = String(args.content ?? args.text ?? args.newString ?? args.new_string ?? patchText ?? "");
              const explicitOld = typeof args.oldString === "string" ? args.oldString : typeof args.old_string === "string" ? args.old_string : void 0;
              const isFile = explicitOld === void 0 && existsSync4(resolvedPath) && statSync2(resolvedPath).isFile();
              const oldText = explicitOld !== void 0 ? explicitOld : isFile ? readFileSync5(resolvedPath, "utf-8") : "";
              if (newText || oldText) {
                const signals = detectWeakening(oldText, newText, resolvedPath || pathStr);
                if (signals.length) {
                  const recent = this.oracleTracker.recentFailure(rule, input);
                  if (recent) {
                    const age = Math.round(recent.ageMs / 1e3);
                    const detail = signals.map((s) => s.detail).join("; ");
                    return this.violation(input, rule, `${rule.message} [${detail}; ${age}s after failing run "${recent.command}"]`, start, 5);
                  }
                }
              }
            }
          }
        }
        if (deepChecks && rule.type === "sequence" && rule.steps) {
          const seqResult = this.config.sequenceDetector.check(input, rule);
          if (seqResult) {
            return this.violation(input, rule, seqResult, start, 6);
          }
        }
        if (rule.type === "verification" || rule.type === "claim") {
          this.verificationTracker.observeTrigger(rule, input);
        }
        if (deepChecks && rule.type === "flow" && rule.sources && rule.sinks) {
          this.config.flowTracker.record(input, rule);
          if (rule.cross_call) {
            const flowResult = this.config.flowTracker.checkPersisted(input, rule);
            if (flowResult) {
              return this.violation(input, rule, flowResult, start, 6);
            }
          } else {
            const flowResult = this.config.flowTracker.check(input, rule);
            if (flowResult) {
              return this.violation(input, rule, flowResult, start, 6);
            }
          }
        }
        if (rule.type === "session" && rule.max_duration_minutes) {
          continue;
        }
      } catch (err) {
        if (err === OBSERVE_CONTINUE) continue;
        throw err;
      }
    }
    return void 0;
  }
  markVerificationSatisfied(input) {
    const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context);
    for (const rule of rules) {
      if (rule.type === "verification" || rule.type === "claim") this.verificationTracker.markSatisfied(rule, input);
    }
  }
  /**
   * Record an attempt outcome (exit code) from the after-hook. Feeds the
   * stuck-loop detector: only FAILING fingerprints accumulate, an exit-0
   * run resets the loop, and matching rules update their counters.
   */
  recordAttemptOutcome(input, exitCode) {
    const cmd = commandString(input);
    if (this.config.ledger && cmd) {
      this.config.ledger.recordOutcome(input.cwd, cmd, exitCode, input.session_id);
    }
    if (this.config.researchTracker) {
      const rules2 = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context);
      for (const rule of rules2) {
        if (rule.type === "research" && rule.trigger) this.config.researchTracker.observeTrigger(rule, input, exitCode);
      }
    }
    {
      const rules2 = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context);
      for (const rule of rules2) {
        if (rule.type === "oracle") this.oracleTracker.observeOutcome(rule, input, exitCode);
      }
    }
    if (!this.config.stuckTracker) return;
    const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context);
    for (const rule of rules) {
      if (rule.type !== "stuck" || !rule.match) continue;
      if (!this.matchesRulePattern(rule.match, cmd)) continue;
      this.config.stuckTracker.recordOutcome(rule, input, exitCode);
    }
  }
  /**
   * Evaluate a proposed fix/mutation instead of blocking.
   */
  fixAction(input, rule, cmdStr, start) {
    if (!rule.fix) {
      return this.block(input, rule, rule.message, start, 2);
    }
    let fixed = cmdStr;
    for (const t of rule.fix) {
      fixed = fixed.replace(new RegExp(t.pattern, "g"), t.replace);
    }
    return {
      action: "fix",
      rule_id: rule.id,
      rule_name: rule.id,
      message: `${rule.message}
   \u2192 Applied fix: ${cmdStr} \u2192 ${fixed}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      duration_ms: Date.now() - start,
      cache_hit: false,
      tier: 2,
      fix_result: { original: cmdStr, fixed }
    };
  }
  block(input, rule, message, start, tier) {
    const cbKey = `${rule.id}:${input.tool}`;
    const now = Date.now();
    const cb = this.circuitBreaker.get(cbKey) || { count: 0, startTime: now };
    if (now - cb.startTime > 6e4) {
      cb.count = 0;
      cb.startTime = now;
    }
    const sm = this.config.stateManager;
    if (sm) {
      sm.recordCircuitBreaker(rule.id, input.tool);
      const persisted = sm.circuitBreaker[cbKey];
      if (persisted) {
        cb.count = persisted.count;
        cb.startTime = persisted.startTime;
      }
    } else {
      cb.count++;
    }
    this.circuitBreaker.set(cbKey, cb);
    this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
      verdict: "deny",
      rule_id: rule.id,
      count: 0,
      timestamp: Date.now()
    }, this.cacheContext(input, this.effectiveDepth(input)));
    this.config.flowTracker.record(input, rule.id);
    const result = this.result("deny", rule.id, message, start, false, tier);
    if (cb.count >= 3) {
      return { ...result, message: `${message}
   \u26A0 This has been blocked ${cb.count} times in 60s. Approve with \`keel allow ${rule.id} --once\` or investigate.` };
    }
    return result;
  }
  /**
   * The result message for a consumed override, worded for the mode that
   * actually consumed it — `--once` is spent, `--session`/the 24h window
   * form are not, and telling the user "one-time" when it is neither is a
   * control that lies about its own state.
   */
  overrideMessage(ruleId) {
    try {
      const remaining = this.overrideStore.peek(ruleId);
      if (remaining?.mode === "session") return `Session override consumed for "${ruleId}" (this agent session only)`;
      if (remaining?.mode === "window") return `Standing override consumed for "${ruleId}" (active until it expires)`;
    } catch {
    }
    return `One-time override consumed for "${ruleId}"`;
  }
  /**
   * Approval gate (`action: prompt`). Behaves like a deny (blocks, tracks the
   * circuit breaker, caches a deny verdict for override consumption) but is
   * reported as `prompt` and always requires explicit user approval via
   * `keel allow <id> --once`. Never escalates from warn-once — the first
   * violation is already gated.
   */
  gate(input, rule, message, start, tier) {
    const blocked = this.block(input, rule, message, start, tier);
    return {
      ...blocked,
      action: "prompt",
      message: `${blocked.message}
   \u2192 Approval required: run \`keel allow ${rule.id} --once\` to approve this action.`
    };
  }
  violation(input, rule, message, start, tier, warningKey = rule.id, directive, skipFirstWarning = false) {
    if (rule.mode === "observe") {
      const would = this.enforcedAction(rule, input);
      this.observedMatches.push({ rule_id: rule.id, observed_action: would, message: `[observe] would ${would}: ${message}` });
      throw OBSERVE_CONTINUE;
    }
    const action = this.effectiveAction(rule, input);
    if (action === "fix") {
      if (rule.fix && rule.type === "command") {
        const args = input.args;
        const raw = typeof input.args === "string" ? input.args : typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
        if (raw) return this.fixAction(input, rule, raw, start);
      }
      return this.warn(input, rule, `${message} (no automatic fix available)`, start, tier);
    }
    if (action === "redirect") {
      if (this.overrideStore.consume(rule.id, input.session_id)) {
        return this.result("allow", rule.id, this.overrideMessage(rule.id), start, false, tier);
      }
      return this.result("redirect", rule.id, message, start, false, tier, void 0, void 0, directive);
    }
    if (action === "warn" || action === "allow" || action === "report") {
      return action === "warn" ? this.warn(input, rule, message, start, tier) : this.result(action, rule.id, message, start, false, tier);
    }
    if (action === "prompt") {
      if (this.overrideStore.consume(rule.id, input.session_id)) {
        return this.result("allow", rule.id, this.overrideMessage(rule.id), start, false, tier);
      }
      return this.gate(input, rule, message, start, tier);
    }
    if (action === "deny" || action === "block") {
      const first = this.isFirstWarning(warningKey);
      const blockFirst = this.effectiveLevel(input) === "protect" || rule.level === "protect" || skipFirstWarning;
      if (first && !blockFirst && input.action_override !== "deny" && input.action_override !== "block") {
        this.denyFirstTime.set(warningKey, true);
        this.config.stateManager?.markFirstTime(warningKey, this.lastRulesHash);
        return this.warn(input, rule, `First violation of "${rule.id}" \u2014 warning only. Next time will be blocked.`, start, tier);
      }
      this.denyFirstTime.set(warningKey, true);
      if (this.overrideStore.consume(rule.id, input.session_id)) {
        return this.result("allow", rule.id, this.overrideMessage(rule.id), start, false, tier);
      }
      return this.block(input, rule, message, start, tier);
    }
    return this.warn(input, rule, `${message} (action "${action}" is not supported by this integration)`, start, tier);
  }
  effectiveLevel(input) {
    return effectiveHierarchyLevel(this.config.ruleHierarchy, input.level);
  }
  /**
   * What this rule actually does right now.
   *
   * `mode: observe` short-circuits to allow: the rule still evaluates and
   * is still recorded, but never interrupts. Breadth (which rules run) and
   * enforcement (what happens on a match) are separate axes — a new rule
   * burns in under observe and is promoted once its false-positive rate is
   * known, rather than interrupting on its very first hit.
   */
  effectiveAction(rule, input) {
    if (rule.mode === "observe") return "allow";
    return this.enforcedAction(rule, input);
  }
  /** The action a rule would take if it were enforcing (ignores observe). */
  enforcedAction(rule, input) {
    if (input.action_override) return input.action_override;
    return dialAction(rule, this.effectiveLevel(input));
  }
  cacheContext(input, depth) {
    return {
      cwd: input.cwd,
      level: this.effectiveLevel(input),
      context: input.context,
      depth,
      action: input.action_override,
      rules_hash: this.lastRulesHash
    };
  }
  effectiveDepth(input) {
    return input.depth || (this.effectiveLevel(input) === "protect" ? "deep" : this.effectiveLevel(input) === "sprint" ? "fast" : "full");
  }
  matchesRulePattern(pattern, value) {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  }
  isFirstWarning(ruleId) {
    if (this.denyFirstTime.has(ruleId)) return false;
    return this.config.stateManager?.isFirstTime(ruleId, this.lastRulesHash) ?? true;
  }
  pathMatches(rawValue, rawPattern) {
    const value = normalizeForMatch(rawValue);
    const normalized = normalizeForMatch(rawPattern);
    if (normalized.includes("**")) {
      const regex = "^" + normalized.split("**").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, (ch) => ch === "*" ? "[^/]*" : `\\${ch}`)).join(".*") + "$";
      try {
        return new RegExp(regex).test(value);
      } catch {
        return false;
      }
    }
    const prefix = normalized.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\/$/, "");
    return value === prefix || value.startsWith(prefix + "/") || value.includes(normalized.replace(/\*/g, ""));
  }
  warn(input, rule, message, start, tier) {
    this.config.flowTracker.record(input, rule.id);
    return this.result("warn", rule.id, message, start, false, tier);
  }
  result(action, ruleId, message, start, cacheHit, tier, fixResult, directive, redirect) {
    return {
      action,
      rule_id: ruleId || null,
      rule_name: ruleId,
      message,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      duration_ms: Date.now() - start,
      cache_hit: cacheHit,
      tier,
      fix_result: fixResult,
      directive,
      redirect
    };
  }
  getCircuitBreakerState() {
    const state = [];
    for (const [key, val] of this.circuitBreaker) {
      const [ruleId, tool] = key.split(":");
      state.push({ ruleId, tool, count: val.count });
    }
    return state;
  }
  getFirstTimeViolations() {
    return Array.from(this.denyFirstTime.keys());
  }
};

// ../core/src/enforce/cache.ts
import { readFileSync as readFileSync6, existsSync as existsSync5, writeFileSync as writeFileSync3, mkdirSync as mkdirSync3 } from "node:fs";
import { createHash } from "node:crypto";
var ActionCache = class {
  session = /* @__PURE__ */ new Map();
  persistent = /* @__PURE__ */ new Map();
  maxSize;
  persistentPath = null;
  stats = { hits: 0, misses: 0 };
  constructor(opts) {
    this.maxSize = opts?.maxSize || 1e4;
    this.persistentPath = opts?.persistentPath || null;
    if (this.persistentPath && existsSync5(this.persistentPath)) {
      try {
        const data = JSON.parse(readFileSync6(this.persistentPath, "utf-8"));
        if (typeof data === "object") {
          for (const [k, v] of Object.entries(data)) {
            this.persistent.set(k, v);
          }
        }
      } catch {
      }
    }
  }
  hash(tool, args, ruleVersion, context) {
    const raw = `${tool}:${this.canonicalize(args)}:${ruleVersion}:${this.canonicalize(context || {})}`;
    return createHash("sha256").update(raw).digest("hex");
  }
  get(tool, args, ruleVersion, context) {
    const key = this.hash(tool, args, ruleVersion, context);
    const sessionEntry = this.session.get(key);
    if (sessionEntry) {
      this.stats.hits++;
      sessionEntry.count++;
      return sessionEntry;
    }
    const persistentEntry = this.persistent.get(key);
    if (persistentEntry) {
      this.stats.hits++;
      persistentEntry.count++;
      this.session.set(key, persistentEntry);
      return persistentEntry;
    }
    this.stats.misses++;
    return null;
  }
  set(tool, args, ruleVersion, entry, context) {
    const key = this.hash(tool, args, ruleVersion, context);
    this.session.set(key, entry);
    if (this.session.size > this.maxSize) {
      let minKey = "";
      let minCount = Infinity;
      for (const [k, v] of this.session) {
        if (v.count < minCount) {
          minCount = v.count;
          minKey = k;
        }
      }
      if (minKey) this.session.delete(minKey);
    }
  }
  setPersistent(tool, args, ruleVersion, entry, context) {
    const key = this.hash(tool, args, ruleVersion, context);
    this.persistent.set(key, entry);
    this.flush();
  }
  flush() {
    if (!this.persistentPath) return;
    const dir = this.persistentPath.substring(0, this.persistentPath.lastIndexOf("/"));
    if (!existsSync5(dir)) mkdirSync3(dir, { recursive: true });
    const data = {};
    for (const [k, v] of this.persistent) {
      data[k] = v;
    }
    writeFileSync3(this.persistentPath, JSON.stringify(data, null, 0));
  }
  clear() {
    this.session.clear();
    this.persistent.clear();
    this.stats = { hits: 0, misses: 0 };
  }
  clearSession() {
    this.session.clear();
  }
  invalidate(ruleVersion) {
    this.session.clear();
    this.persistent.clear();
    this.flush();
  }
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.session.size + this.persistent.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hit_rate: total > 0 ? this.stats.hits / total : 0
    };
  }
  canonicalize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => this.canonicalize(item)).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${this.canonicalize(value[key])}`).join(",")}}`;
  }
};
var ContentTracker = class {
  hashes = /* @__PURE__ */ new Map();
  hasChanged(filePath) {
    if (!existsSync5(filePath)) return true;
    const content = readFileSync6(filePath, "utf-8");
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = (h << 5) - h + content.charCodeAt(i);
      h |= 0;
    }
    const hash = h.toString(36);
    const prev = this.hashes.get(filePath);
    this.hashes.set(filePath, hash);
    return prev !== hash;
  }
  markUnchanged(filePath) {
    if (!existsSync5(filePath)) return;
    const content = readFileSync6(filePath, "utf-8");
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = (h << 5) - h + content.charCodeAt(i);
      h |= 0;
    }
    this.hashes.set(filePath, h.toString(36));
  }
  clear() {
    this.hashes.clear();
  }
};

// ../core/src/enforce/sequencer.ts
var SequenceDetector = class {
  history = [];
  windowMs;
  constructor(windowMs = 6e4) {
    this.windowMs = windowMs;
  }
  setWindow(windowMs) {
    this.windowMs = Math.max(this.windowMs, windowMs);
    this.prune();
  }
  /**
   * Record an action for sequence tracking.
   */
  record(input) {
    this.history.push({
      input,
      tool: input.tool,
      args: input.args,
      timestamp: Date.now()
    });
    this.prune();
  }
  /**
   * Check if the current action completes a forbidden sequence.
   * Returns a message if violated, null if OK.
   */
  check(input, rule) {
    if (!rule.steps || rule.steps.length < 2) return null;
    this.prune();
    const windowSec = rule.sequence_window_seconds || 60;
    const cutoff = Date.now() - windowSec * 1e3;
    const recent = this.history.filter((r) => r.timestamp >= cutoff && r.input !== input);
    const lastStep = rule.steps[rule.steps.length - 1];
    if (!this.matchesTool(lastStep, input)) return null;
    const precedingSteps = rule.steps.slice(0, -1);
    let historyIdx = recent.length - 1;
    for (let stepIdx = precedingSteps.length - 1; stepIdx >= 0; stepIdx--) {
      const step = precedingSteps[stepIdx];
      let found = false;
      while (historyIdx >= 0) {
        const record2 = recent[historyIdx];
        historyIdx--;
        if (this.matchesTool(step, record2.input)) {
          found = true;
          break;
        }
      }
      if (!found) return null;
    }
    const stepNames = rule.steps.map((s) => s.tool).join(" \u2192 ");
    return `Sequence detected: ${stepNames} (rule: ${rule.id})`;
  }
  matchesTool(step, input) {
    const { tool, args } = input;
    if (step.tool.toLowerCase() !== tool.toLowerCase()) return false;
    if (step.path) {
      const argPath2 = normalizeForMatch(String(args.path || args.filePath || args.file || args.dest || ""));
      if (!argPath2.includes(normalizeForMatch(step.path))) return false;
    }
    if (step.pattern) {
      let regex;
      try {
        regex = new RegExp(step.pattern, "i");
      } catch {
        return false;
      }
      if (!regex.test(commandString(input)) && !regex.test(JSON.stringify(args))) return false;
    }
    return true;
  }
  prune() {
    const cutoff = Date.now() - this.windowMs;
    this.history = this.history.filter((r) => r.timestamp >= cutoff);
  }
  clear() {
    this.history = [];
  }
};

// ../core/src/enforce/flow-tracker.ts
import { existsSync as existsSync6 } from "node:fs";
var FlowTracker = class {
  constructor(persistentStore) {
    this.persistentStore = persistentStore;
  }
  persistentStore;
  taggedValues = /* @__PURE__ */ new Map();
  // tag_key → tool name that created the tag
  tagOrigins = /* @__PURE__ */ new Map();
  /**
   * Track a tool call — check if it reads sensitive data
   * or sends tagged data to a network sink.
   */
  record(input, rule) {
    const args = input.args;
    const rawPath = argPath(args);
    const path2 = resolveMaybeRelative(rawPath, input.cwd);
    if (path2 && existsSync6(path2)) {
      const configuredSources = typeof rule === "object" ? rule.sources : void 0;
      const matchedRule = configuredSources?.find((source) => this.pathMatches(path2, source)) || (!configuredSources ? this.matchesSensitivePath(path2) : null);
      if (matchedRule) {
        const tag = {
          source: matchedRule,
          value: `<redacted: ${path2}>`,
          timestamp: Date.now(),
          sessionId: input.session_id,
          originTool: input.tool,
          path: path2
        };
        const key = `flow:${input.session_id}:${input.turn_number}`;
        const existing = this.taggedValues.get(key) || [];
        existing.push(tag);
        this.taggedValues.set(key, existing);
        this.tagOrigins.set(key, input.tool);
        if (this.persistentStore && typeof rule === "object") {
          this.persistentStore.recordTag(input.session_id, {
            source: matchedRule,
            timestamp: tag.timestamp,
            originTool: input.tool,
            path: path2
          });
        }
      }
    }
    const command = String(args.command || args.cmd || "");
    if (command && /(?:^|[\s;&|(])(?:cat|less|more|head|tail|grep|awk|sed|strings|xxd|base64|tac|tail)\b/.test(command)) {
      const configuredSources = typeof rule === "object" ? rule.sources : void 0;
      const commandSource = configuredSources ? configuredSources.find((source) => this.commandSourceMatches(command, source)) : this.matchesSensitivePath(command);
      if (commandSource) {
        const key = `flow:${input.session_id}:${input.turn_number}`;
        const existing = this.taggedValues.get(key) || [];
        const commandTimestamp = Date.now();
        existing.push({
          source: commandSource,
          value: `<redacted: command read of sensitive path>`,
          timestamp: commandTimestamp,
          sessionId: input.session_id,
          originTool: input.tool
        });
        this.taggedValues.set(key, existing);
        this.tagOrigins.set(key, input.tool);
        if (this.persistentStore && typeof rule === "object") {
          this.persistentStore.recordTag(input.session_id, {
            source: commandSource,
            timestamp: commandTimestamp,
            originTool: input.tool
          });
        }
      }
    }
    if (this.taggedValues.size > 1e3) {
      const oldest = Array.from(this.taggedValues.keys()).sort()[0];
      this.taggedValues.delete(oldest);
      this.tagOrigins.delete(oldest);
    }
  }
  /**
   * Check if a flow/IFC rule is violated by the current action.
   * Returns violation message or null.
   */
  check(input, rule) {
    if (!rule.sources || !rule.sinks) return null;
    const args = input.args;
    const tool = input.tool;
    const isSink = rule.sinks.some((sink) => this.matchesSink(sink, tool, args));
    if (!isSink) return null;
    let hasSourceData = false;
    for (const [key, tags] of this.taggedValues) {
      if (tags.some((tag) => tag.sessionId === input.session_id && rule.sources.some(
        (source) => tag.originTool.toLowerCase().includes(source.toLowerCase()) || !!tag.path && this.pathMatches(tag.path, source) || !!tag.source && this.sourceMatches(source, tag.source)
      ))) {
        hasSourceData = true;
        break;
      }
    }
    if (hasSourceData) {
      const sources = rule.sources.join(", ");
      const sinks = rule.sinks.join(", ");
      return `Data flow violation: data from ${sources} flowing to ${sinks} (rule: ${rule.id})`;
    }
    return null;
  }
  /**
   * Cross-call correlation for hook-invoked hosts (`keel hook <host>` —
   * Claude Code, Gemini CLI, Cursor, Codex, cline, generic): a fresh
   * process per tool call means `check()`'s in-memory `taggedValues` is
   * always empty at the start of a later call, so it can never see a read
   * an EARLIER, already-exited process recorded. This method answers the
   * identical question — "did a source get tagged this session, and is
   * this call a sink" — against the persisted, session-scoped, TTL'd store
   * (flow-store.ts) instead, so that earlier process's tag is still
   * visible here.
   *
   * Deliberately NOT folded into `check()`: `check()` backs the existing
   * `level: protect` `no-exfil-flow` deny, a hard, undialable floor (see
   * docs/exfil.md's "Design choice" section for why that stays a hard
   * deny). Cross-process correlation has a materially wider
   * false-positive shape — it survives an hour (FLOW_TAG_TTL_MS), not one
   * live process/command — and is deliberately shipped at a softer tier
   * instead: see install.ts's `no-exfil-flow-cross-call` (action: warn,
   * level: sprint, cross_call: true). Returns null when no persistent
   * store was supplied to the constructor (every `new FlowTracker()` call
   * site that predates this — the default stays pure in-memory) exactly
   * like `check()` returns null when `rule.sources`/`rule.sinks` are
   * missing.
   */
  checkPersisted(input, rule) {
    if (!this.persistentStore || !rule.sources || !rule.sinks) return null;
    const args = input.args;
    const tool = input.tool;
    const isSink = rule.sinks.some((sink) => this.matchesSink(sink, tool, args));
    if (!isSink) return null;
    const tags = this.persistentStore.getTags(input.session_id);
    const hasSourceData = tags.some((tag) => rule.sources.some(
      (source) => tag.originTool.toLowerCase().includes(source.toLowerCase()) || !!tag.path && this.pathMatches(tag.path, source) || !!tag.source && this.sourceMatches(source, tag.source)
    ));
    if (!hasSourceData) return null;
    const sources = rule.sources.join(", ");
    const sinks = rule.sinks.join(", ");
    return `Cross-call data flow correlation (this session, an earlier hook process): data from ${sources} flowing to ${sinks} (rule: ${rule.id})`;
  }
  /** Does a read command reference a configured source pattern? */
  commandSourceMatches(command, pattern) {
    const stripped = pattern.replace(/\*\*/g, "").replace(/\*/g, "");
    const base = stripped.split("/").filter(Boolean).pop() || stripped;
    return command.includes(stripped) || base.length > 2 && command.includes(base);
  }
  /**
   * Does a tag's recorded source satisfy a rule source pattern? Path patterns
   * match as globs; rule-less eager tags carry pseudo-sources like
   * `sensitive-path:.env` that are compared by basename instead.
   */
  sourceMatches(pattern, value) {
    if (this.pathMatches(value, pattern)) return true;
    const pBase = pattern.replace(/\*\*/g, "").replace(/\*/g, "").split("/").filter(Boolean).pop() || "";
    const vBase = value.replace(/^sensitive-path:/, "").split(/[/.]/).filter(Boolean).pop() || "";
    return pBase.length > 2 && vBase.length > 2 && (pBase === vBase || value.includes(pBase));
  }
  matchesSensitivePath(path2) {
    const normalizedPath = canonicalizePath(path2);
    const sensitivePaths = [
      ".env",
      ".env.local",
      ".env.production",
      ".git-credentials",
      ".ssh/",
      "id_rsa",
      "id_ed25519",
      "credentials",
      "secrets",
      "token",
      "api-key",
      "apikey"
    ];
    for (const s of sensitivePaths) {
      if (normalizedPath.includes(s)) return `sensitive-path:${s}`;
    }
    return null;
  }
  pathMatches(value, pattern) {
    const normalizedValue = canonicalizePath(value);
    const escaped = canonicalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try {
      return new RegExp(`^${escaped}$`, "i").test(normalizedValue) || new RegExp(escaped, "i").test(normalizedValue);
    } catch {
      return false;
    }
  }
  matchesSink(sink, tool, args) {
    const normalized = sink.toLowerCase();
    const toolName = tool.toLowerCase();
    if (toolName === normalized) return true;
    const url = String(args.url || args.uri || args.host || "");
    if (url && (url.toLowerCase().includes(normalized) || normalized === "network")) return true;
    if (normalized !== "network") return false;
    const command = String(args.command || args.cmd || "").toLowerCase();
    return /\b(?:curl|wget|fetch|http|https|nc|netcat|socat|rsync|scp)\b/.test(`${toolName} ${command}`);
  }
  clear() {
    this.taggedValues.clear();
    this.tagOrigins.clear();
  }
};

// ../core/src/enforce/flow-store.ts
import { readFileSync as readFileSync9, writeFileSync as writeFileSync5, existsSync as existsSync8, mkdirSync as mkdirSync5, renameSync as renameSync4 } from "node:fs";
import { join as join6 } from "node:path";

// ../core/src/enforce/state-manager.ts
import { readFileSync as readFileSync8, writeFileSync as writeFileSync4, existsSync as existsSync7, mkdirSync as mkdirSync4, renameSync as renameSync3 } from "node:fs";
import { join as join5 } from "node:path";
function stateDir() {
  return process.env.KEEL_STATE_DIR || join5(resolveHome(), ".keel", "state");
}
var TTL_MS = 24 * 60 * 60 * 1e3;
var StateManager = class {
  denyFirstTime = {};
  circuitBreaker = {};
  rateCounts = {};
  verification = {};
  oracleFailures = {};
  dir;
  lockOptions;
  /**
   * `lockOptions` overrides file-lock.ts's default wait/stale-reclaim
   * bounds — production code should never need this (the defaults are
   * tuned for a hook invocation), but tests that deliberately create
   * heavy artificial contention need a wider wait than the production
   * default without that production default having to grow to
   * accommodate a synthetic worst case it will never see in the field.
   */
  constructor(dir = stateDir(), lockOptions = {}) {
    this.dir = dir;
    this.lockOptions = lockOptions;
    this.load();
  }
  statePath(name) {
    return join5(this.dir, `${name}.json`);
  }
  lockPath(name) {
    return this.statePath(name) + ".lock";
  }
  ensureDir() {
    try {
      mkdirSync4(this.dir, { recursive: true });
    } catch {
    }
  }
  /** Run `fn` holding the lock for state slice `name`, serializing with other processes. */
  withSliceLock(name, fn) {
    this.ensureDir();
    return withFileLock(this.lockPath(name), fn, this.lockOptions);
  }
  /**
   * Parses `<name>.json` and returns it only when it is a genuine
   * dictionary — every `load*` caller immediately does `Object.entries()`
   * on the result, OUTSIDE any try/catch of its own, so a legally-parsing
   * but non-object JSON value (bare `null`, a number, a string, an array)
   * must be caught HERE or it throws an uncaught `TypeError` straight out
   * of the constructor. A syntax error is already caught below by the
   * JSON.parse try/catch; `null`/arrays/primitives parse fine and need
   * their own check. Centralized once so all five state files share the
   * same guard instead of every `load*` method re-deriving it.
   */
  loadFile(name, fallback) {
    const p = this.statePath(name);
    try {
      if (existsSync7(p)) {
        const parsed = JSON.parse(readFileSync8(p, "utf-8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {
    }
    return fallback;
  }
  saveFile(name, data) {
    try {
      mkdirSync4(this.dir, { recursive: true });
      const p = this.statePath(name);
      const tmp = p + ".tmp";
      writeFileSync4(tmp, JSON.stringify(data));
      renameSync3(tmp, p);
    } catch {
    }
  }
  loadDenyFirstTime() {
    const now = Date.now();
    const raw = this.loadFile("deny-first-time", {});
    const cleaned = {};
    for (const [ruleId, value] of Object.entries(raw)) {
      const timestamp2 = typeof value === "number" ? value : value.timestamp;
      if (now - timestamp2 < TTL_MS) cleaned[ruleId] = value;
    }
    return cleaned;
  }
  loadCircuitBreaker() {
    const now = Date.now();
    const raw = this.loadFile("circuit-breaker", {});
    const cleaned = {};
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.startTime < TTL_MS) cleaned[key] = val;
    }
    return cleaned;
  }
  loadRateCounts() {
    const now = Date.now();
    const raw = this.loadFile("rate-counts", {});
    const cleaned = {};
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.windowStart < TTL_MS) cleaned[key] = val;
    }
    return cleaned;
  }
  loadVerificationState() {
    const now = Date.now();
    const raw = this.loadFile("verification", {});
    const cleaned = {};
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.createdAt < TTL_MS) cleaned[key] = val;
    }
    return cleaned;
  }
  loadOracleFailuresState() {
    const now = Date.now();
    const raw = this.loadFile("oracle-failures", {});
    const cleaned = {};
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.timestamp < TTL_MS) cleaned[key] = val;
    }
    return cleaned;
  }
  load() {
    this.denyFirstTime = this.loadDenyFirstTime();
    this.circuitBreaker = this.loadCircuitBreaker();
    this.rateCounts = this.loadRateCounts();
    this.verification = this.loadVerificationState();
    this.oracleFailures = this.loadOracleFailuresState();
  }
  /** Mark a rule as having been violated (first time). */
  markFirstTime(ruleId, version) {
    this.withSliceLock("deny-first-time", () => {
      this.denyFirstTime = this.loadDenyFirstTime();
      this.denyFirstTime[ruleId] = version ? { timestamp: Date.now(), version } : Date.now();
      this.saveFile("deny-first-time", this.denyFirstTime);
    });
  }
  /** Check if a rule has been violated before. */
  isFirstTime(ruleId, version) {
    const value = this.denyFirstTime[ruleId];
    if (value === void 0) return true;
    if (!version) return false;
    return typeof value === "number" || value.version !== version;
  }
  /** Record a circuit breaker event. Returns true if threshold (3+) reached. */
  recordCircuitBreaker(ruleId, tool) {
    const key = `${ruleId}:${tool}`;
    return this.withSliceLock("circuit-breaker", () => {
      this.circuitBreaker = this.loadCircuitBreaker();
      const now = Date.now();
      const existing = this.circuitBreaker[key];
      if (existing && now - existing.startTime < 6e4) {
        existing.count++;
        this.circuitBreaker[key] = existing;
      } else {
        this.circuitBreaker[key] = { count: 1, startTime: now };
      }
      this.saveFile("circuit-breaker", this.circuitBreaker);
      return this.circuitBreaker[key].count >= 3;
    });
  }
  /** Check and increment rate limit. Returns true if over limit. */
  checkRateLimit(ruleId, matchPattern, windowSec, maxCalls) {
    const key = `rate:${ruleId}:${matchPattern}`;
    return this.withSliceLock("rate-counts", () => {
      this.rateCounts = this.loadRateCounts();
      const now = Date.now();
      const existing = this.rateCounts[key];
      let overLimit;
      if (existing && now - existing.windowStart < windowSec * 1e3) {
        existing.count++;
        this.rateCounts[key] = existing;
        overLimit = existing.count > maxCalls;
      } else {
        this.rateCounts[key] = { count: 1, windowStart: now };
        overLimit = false;
      }
      this.saveFile("rate-counts", this.rateCounts);
      return overLimit;
    });
  }
  setVerification(key, value) {
    this.withSliceLock("verification", () => {
      this.verification = this.loadVerificationState();
      this.verification[key] = value;
      this.saveFile("verification", this.verification);
    });
  }
  clearVerification(key) {
    this.withSliceLock("verification", () => {
      this.verification = this.loadVerificationState();
      delete this.verification[key];
      this.saveFile("verification", this.verification);
    });
  }
  /** Record a failing test run for the oracle-tampering detector's recency window. */
  setOracleFailure(key, value) {
    this.withSliceLock("oracle-failures", () => {
      this.oracleFailures = this.loadOracleFailuresState();
      this.oracleFailures[key] = value;
      this.saveFile("oracle-failures", this.oracleFailures);
    });
  }
};

// ../core/src/enforce/flow-store.ts
var FLOW_TAG_TTL_MS = 60 * 60 * 1e3;

// ../core/src/enforce/command-fingerprint.ts
function commandFingerprint(command) {
  let s = command.replace(/\s+/g, " ").trim().replace(/(\/var\/folders\/)[^\s]+/g, "$1<TMP>").replace(/(^|\s)(\/tmp\/|\$TMPDIR\/)[^\s]*/g, "$1<TMP>").replace(/(-m\s+["'])[^"']*(["'])/g, "$1<msg>$2").replace(/"[^"]{12,}"/g, '"<s>"').replace(/'[^']{12,}'/g, "'<s>'").replace(/\b[0-9a-f]{8,}\b/gi, "<H>").replace(/\b\d+\b/g, "<N>").replace(/(--[\w-]+)=[^\s]+/g, "$1").trim();
  if (s.length > 160) s = s.slice(0, 160);
  return s;
}

// ../core/src/enforce/stuck-tracker.ts
var DEFAULT_WINDOW_MS = 15 * 60 * 1e3;
var StuckTracker = class {
  constructor(persistentStore) {
    this.persistentStore = persistentStore;
  }
  persistentStore;
  counts = /* @__PURE__ */ new Map();
  key(ruleId, cwd, fingerprint) {
    return `stuck:${ruleId}:${cwd}:${fingerprint}`;
  }
  fingerprintOf(rule, input) {
    const cmd = commandString(input);
    return rule.fingerprint === "exact" ? cmd : commandFingerprint(cmd);
  }
  recordOutcome(rule, input, exitCode) {
    const cmd = commandString(input);
    if (!cmd) return;
    const fp = this.fingerprintOf(rule, input);
    const key = this.key(rule.id, input.cwd, fp);
    const windowMs = (rule.window_seconds || 60) * 1e3;
    if (exitCode === 0) {
      this.counts.delete(key);
      if (this.persistentStore) this.persistentStore.delete(key);
      return;
    }
    if (rule.require_failure === true && exitCode === null) return;
    if (this.persistentStore) {
      const persisted = this.persistentStore.bump(key, windowMs, exitCode);
      this.counts.set(key, { count: persisted.count, windowStart: persisted.windowStart, lastAttemptAt: persisted.lastAttemptAt, lastExit: persisted.lastExit });
      return;
    }
    const now = Date.now();
    const existing = this.counts.get(key);
    if (!existing || now - existing.windowStart > windowMs) {
      this.counts.set(key, { count: 1, windowStart: now, lastAttemptAt: now, lastExit: exitCode });
      return;
    }
    existing.count += 1;
    existing.lastAttemptAt = now;
    existing.lastExit = exitCode;
  }
  /**
   * Resolve the bucket key for `input` — EXACT fingerprint match only.
   *
   * This used to also scan for a "near-identical" bucket when no exact
   * match existed, using `nearIdentical(cmd, fp)` — comparing the incoming
   * command's OWN fingerprint against itself, not against any existing
   * bucket's stored command. `commandFingerprint` is idempotent (fingerprinting
   * a fingerprint reproduces it), so that comparison was true for almost
   * any input, and the loop then returned the FIRST existing bucket for the
   * same rule+cwd in Map iteration order — attributing a brand-new,
   * unrelated command to whatever fail-streak happened to exist already.
   * `recordOutcome` above only ever writes under the exact-fingerprint key,
   * so a fuzzy read-side match here could never correspond to a real
   * shared write anyway. Fingerprinting already normalizes the retries this
   * was meant to catch (varying commit messages, flag values, temp paths,
   * hex ids, numeric literals — see command-fingerprint.ts), so two really
   * "near-identical" retries already collapse to the same exact fingerprint
   * without this.
   */
  bucketOf(rule, input) {
    const fp = this.fingerprintOf(rule, input);
    return { key: this.key(rule.id, input.cwd, fp), fp };
  }
  check(rule, input) {
    const cmd = commandString(input);
    if (!cmd) return null;
    const { key, fp } = this.bucketOf(rule, input);
    let state = this.counts.get(key);
    const windowMs = (rule.window_seconds || 60) * 1e3;
    if (this.persistentStore) {
      const persisted = this.persistentStore.get(key);
      if (persisted && (!state || persisted.count > state.count)) {
        state = { count: persisted.count, windowStart: persisted.windowStart, lastAttemptAt: persisted.lastAttemptAt, lastExit: persisted.lastExit };
        this.counts.set(key, state);
      }
    }
    if (!state) return null;
    if (Date.now() - state.windowStart > windowMs) {
      this.counts.delete(key);
      if (this.persistentStore) this.persistentStore.delete(key);
      return null;
    }
    const ladder = rule.escalation?.length ? [...rule.escalation].sort((a, b) => b.at - a.at) : [
      { at: rule.block_attempts ?? 5, action: "deny", message: "" },
      { at: rule.max_attempts ?? 3, action: "redirect", message: "" }
    ];
    for (const step of ladder) {
      if (state.count >= step.at) {
        const message = step.message || defaultMessage(rule.id, fp, state.count, step.action);
        return { action: step.action, message, attempts: state.count };
      }
    }
    return null;
  }
  clear(sessionCwd) {
    if (sessionCwd) {
      for (const [key] of this.counts) {
        if (key.includes(`:${sessionCwd}:`)) this.counts.delete(key);
      }
      if (this.persistentStore) this.persistentStore.deleteByCwd(sessionCwd);
    } else {
      this.counts.clear();
      if (this.persistentStore) this.persistentStore.clearAll();
    }
  }
};
function defaultMessage(ruleId, fingerprint, attempts, action) {
  if (action === "redirect") {
    return `"${fingerprint}" has failed ${attempts} times \u2014 this is a stuck loop. Stop retrying. Run keel_research on the exact error text, record a root-cause hypothesis, then attempt once with a new approach.`;
  }
  return `${attempts} identical failures of "${fingerprint}" \u2014 retrying without research is blocked. Record a hypothesis (keel_hypothesis) or ask the user.`;
}

// ../core/src/enforce/stuck-store.ts
import { readFileSync as readFileSync10, writeFileSync as writeFileSync6, existsSync as existsSync9, mkdirSync as mkdirSync6, renameSync as renameSync5 } from "node:fs";
import { join as join7 } from "node:path";
var STUCK_STATE_MAX_WINDOW_MS = 24 * 60 * 60 * 1e3;

// ../core/src/enforce/research-tracker.ts
var ResearchTracker = class {
  constructor(researchCache) {
    this.researchCache = researchCache;
  }
  researchCache;
  pending = /* @__PURE__ */ new Map();
  key(rule, input) {
    return `${rule.id}:${input.cwd}:${input.session_id}`;
  }
  /** Arm the obligation: a FAILING command matched the trigger. */
  observeTrigger(rule, input, exitCode) {
    if (rule.type !== "research" || !rule.trigger) return;
    if (!matches(rule.trigger, input)) return;
    if (rule.trigger.exit !== void 0) {
      const want = rule.trigger.exit;
      if (want === "nonzero" && exitCode === 0) return;
      if (typeof want === "number" && exitCode !== want) return;
    }
    this.pending.set(this.key(rule, input), { createdAt: Date.now() });
  }
  isPending(rule, input) {
    if (rule.type !== "research" || !rule.trigger) return false;
    const pending = this.pending.get(this.key(rule, input));
    if (!pending) return false;
    const window = (rule.research_window_seconds || 600) * 1e3;
    if (Date.now() - pending.createdAt > window) {
      this.pending.delete(this.key(rule, input));
      return false;
    }
    return true;
  }
  /**
   * Fresh research evidence discharges the obligation: either the current
   * action is a satisfying research call, or the session cache holds fresh
   * entries matching the rule's topics.
   */
  discharge(rule, input) {
    if (!this.isPending(rule, input)) return true;
    if (rule.satisfy && matches(rule.satisfy, input)) {
      this.pending.delete(this.key(rule, input));
      return true;
    }
    const freshnessSec = rule.freshness_seconds ?? 1800;
    if (this.researchCache && rule.topics?.length) {
      const probe = this.researchCache.probe(input.session_id, rule.topics, freshnessSec / 3600);
      if (probe.hit) {
        this.pending.delete(this.key(rule, input));
        return true;
      }
    }
    return false;
  }
  /** Boundary check: a fix/commit action while the obligation is pending. */
  boundary(rule, input) {
    if (!this.isPending(rule, input) || !rule.boundaries) return null;
    const args = `${input.tool} ${JSON.stringify(stripContentArgs(input.args || {}))}`;
    const mcp = mcpToolString(input);
    for (const boundary of Object.values(rule.boundaries)) {
      try {
        if (boundary.pattern && new RegExp(boundary.pattern, "i").test(args)) {
          return { message: rule.message, action: boundary.action };
        }
      } catch {
      }
      if (mcp && boundary.pattern) {
        const words = boundary.pattern.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
        const verbs = words.slice(1);
        if (verbs.length && verbs.every((word) => new RegExp(`\\b${word}\\b`, "i").test(mcp))) {
          return { message: rule.message, action: boundary.action };
        }
      }
    }
    return null;
  }
  clear() {
    this.pending.clear();
  }
};

// ../core/src/enforce/problem-ledger.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync7, readFileSync as readFileSync11, writeFileSync as writeFileSync7, renameSync as renameSync6, statSync as statSync3 } from "node:fs";
import { join as join8 } from "node:path";
import { createHash as createHash2 } from "node:crypto";
var TTL_MS2 = 24 * 60 * 60 * 1e3;

// ../core/src/enforce/audit.ts
import { appendFileSync, existsSync as existsSync11, mkdirSync as mkdirSync8, readFileSync as readFileSync12, readdirSync } from "node:fs";
import { join as join9 } from "node:path";

// ../core/src/enforce/audit-redaction.ts
var SENSITIVE_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential)/i;
var SENSITIVE_PATH = /(^|[/\\])(.env(?:\.[^/\\]+)?|credentials?|secrets?|.*token.*|.*api[-_]?key.*|id_(?:rsa|ed25519))$/i;
var SAFE_KEYS = /* @__PURE__ */ new Set(["command", "cmd", "path", "file", "filePath", "url", "uri", "host", "operation", "tool", "oldString", "newString"]);
function sanitizeAuditValue(value, key = "", depth = 0) {
  if (depth > 6) return "[truncated]";
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if ((key === "path" || key === "file" || key === "filePath") && SENSITIVE_PATH.test(value)) return "[redacted path]";
    const redacted = value.replace(/(bearer\s+)[^\s'"`]+/gi, "$1[redacted]").replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[=:]?\s*)[^\s'"`,;]+/gi, "$1[redacted]");
    return redacted.length > 2e3 ? `${redacted.slice(0, 2e3)}...[truncated]` : redacted;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeAuditValue(entryValue, entryKey, depth + 1)
    ]));
  }
  return value;
}
function projectAuditArgs(args) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    SAFE_KEYS.has(key) ? sanitizeAuditValue(value, key) : "[redacted]"
  ]));
}

// ../core/src/receipts.ts
import {
  sign,
  verify,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash as createHash3,
  randomUUID
} from "node:crypto";
import { existsSync as existsSync12, readFileSync as readFileSync13, writeFileSync as writeFileSync9, mkdirSync as mkdirSync9, appendFileSync as appendFileSync2, readdirSync as readdirSync2, renameSync as renameSync7 } from "node:fs";
import { join as join10 } from "node:path";
var signingKey = null;
function keyPath() {
  return join10(resolveHome(), ".keel", "receipt-key.json");
}
function legacyKeyPath() {
  return join10(process.cwd(), ".keel", "receipts", "receipt-key.json");
}
function parseKeyFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync13(filePath, "utf-8"));
    return parsed && parsed.kid ? parsed : null;
  } catch {
    return null;
  }
}
function initReceiptKey() {
  if (signingKey) return signingKey;
  const envKey = process.env.KEEL_RECEIPT_KEY;
  if (envKey) {
    try {
      const parsed = JSON.parse(envKey);
      if (parsed && parsed.kid) {
        signingKey = parsed;
        return parsed;
      }
    } catch {
    }
  }
  const loaded = parseKeyFile(keyPath()) || parseKeyFile(legacyKeyPath());
  if (loaded) {
    signingKey = loaded;
    return loaded;
  }
  const kp = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" }
  });
  const privJwk = createPrivateKey({ key: kp.privateKey, format: "der", type: "pkcs8" }).export({ format: "jwk" });
  const pubJwk = createPublicKey({ key: kp.publicKey, format: "der", type: "spki" }).export({ format: "jwk" });
  const kid = createHash3("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: pubJwk.x })).digest("base64url");
  const newKey = { kid, privateJwk: privJwk, publicJwk: { ...pubJwk, kid } };
  signingKey = newKey;
  try {
    const dir = join10(resolveHome(), ".keel");
    if (!existsSync12(dir)) mkdirSync9(dir, { recursive: true });
    writeFileSync9(keyPath(), JSON.stringify(newKey), { mode: 384 });
  } catch {
  }
  return signingKey;
}
var receiptChain = /* @__PURE__ */ new Map();
function receiptsLogPath() {
  return join10(process.cwd(), ".keel", "receipts", "receipts.log");
}
function loadReceiptChainHead(session) {
  try {
    const lines2 = readFileSync13(receiptsLogPath(), "utf-8").split("\n").filter(Boolean);
    for (let i = lines2.length - 1; i >= 0; i--) {
      const r = JSON.parse(lines2[i]);
      if ((r.session ?? "default") !== session) continue;
      return r.receipt_hash ?? null;
    }
  } catch {
  }
  return null;
}
function createReceipt(agentId, toolName, args, verdict, ruleName, policyName, sessionName) {
  initReceiptKey();
  const session = sessionName || process.env.KEEL_SESSION_ID || "default";
  if (!receiptChain.has(session)) receiptChain.set(session, loadReceiptChainHead(session));
  const argsHash = createHash3("sha256").update(JSON.stringify(args)).digest("hex");
  const receipt = {
    version: "action-receipt/v1",
    id: randomUUID(),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    agent_id: agentId,
    session,
    action: { tool: toolName, args_hash: argsHash },
    decision: { verdict, rule_name: ruleName, policy_name: policyName },
    previous_receipt_hash: receiptChain.get(session),
    receipt_hash: ""
  };
  const { receipt_hash: _, signature: _s, ...toHash } = receipt;
  receipt.receipt_hash = createHash3("sha256").update(JSON.stringify(toHash)).digest("hex");
  const key = signingKey;
  const privateKey = createPrivateKey({ key: key.privateJwk, format: "jwk" });
  receipt.signature = sign(null, Buffer.from(JSON.stringify(toHash), "utf8"), privateKey).toString("base64url");
  receiptChain.set(session, receipt.receipt_hash);
  try {
    const dir = join10(process.cwd(), ".keel", "receipts");
    if (!existsSync12(dir)) mkdirSync9(dir, { recursive: true });
    appendFileSync2(join10(dir, "receipts.log"), JSON.stringify(receipt) + "\n");
  } catch {
  }
  return receipt;
}

// ../core/src/file-verify.ts
import { readFileSync as readFileSync14 } from "node:fs";
import { extname, basename as basename2, dirname, join as join11 } from "node:path";
async function loadTypeScriptFor(filePath) {
  const { createRequire } = await import("node:module");
  for (const root of [join11(dirname(filePath), "noop.js"), import.meta.url]) {
    try {
      const ts = createRequire(root)("typescript");
      const api = ts?.createSourceFile ? ts : ts?.default;
      if (api?.createSourceFile) return api;
    } catch {
    }
  }
  return null;
}
async function verifyFileSyntax(filePath) {
  const { execFileSync } = await import("node:child_process");
  const ext = extname(filePath).toLowerCase();
  const spawn = (cmd, args) => execFileSync(cmd, args, { stdio: "pipe", timeout: 1e4 });
  try {
    switch (ext) {
      case ".py":
        spawn("python3", ["-m", "py_compile", filePath]);
        break;
      case ".sh":
      case ".bash":
        spawn("bash", ["-n", filePath]);
        break;
      case ".js":
      case ".mjs":
      case ".cjs":
        spawn(process.execPath, ["--check", filePath]);
        break;
      case ".ts":
      case ".tsx":
      case ".mts":
      case ".cts": {
        const ts = await loadTypeScriptFor(filePath);
        if (!ts) return null;
        const source = readFileSync14(filePath, "utf-8");
        const kind = ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const parsed = ts.createSourceFile(basename2(filePath), source, ts.ScriptTarget.Latest, false, kind);
        const diagnostics = parsed.parseDiagnostics;
        if (diagnostics?.length) {
          return ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ");
        }
        break;
      }
      case ".json":
        JSON.parse(readFileSync14(filePath, "utf-8"));
        break;
      case ".yaml":
      case ".yml":
        parse(readFileSync14(filePath, "utf-8"));
        break;
      default:
        return null;
    }
  } catch (err) {
    const code = err?.code;
    if (code === "ENOENT" || code === "EACCES") return null;
    return String(err?.message || "").split("\n")[0];
  }
  return null;
}
var VERIFIABLE = /* @__PURE__ */ new Set([
  ".py",
  ".sh",
  ".bash",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
  ".yaml",
  ".yml"
]);
function isVerifiableFile(filePath) {
  return VERIFIABLE.has(extname(filePath).toLowerCase());
}

// src/plugin.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "apply_patch", "writefile", "write_file", "multiedit"]);
var HOME_DIR = resolveHome();
var KEEL_DIR = path.join(HOME_DIR, ".keel");
var RULES_PATH = path.join(KEEL_DIR, "rules.yaml");
var REQUIREMENTS_PATH = path.join(KEEL_DIR, "requirements.md");
var DISABLED_PATH = path.join(KEEL_DIR, "DISABLED");
var sentinelCorrupted = false;
var HALTED_PATH = path.join(KEEL_DIR, "HALTED");
var TRACES_DIR = process.env.KEEL_TRACES_DIR || path.join(KEEL_DIR, "traces");
var DEFAULT_RULES_YAML = `# Keel rules \u2014 enforced OUTSIDE the agent's context window.
# Evaluated before every tool call, so they cannot be forgotten, overridden,
# or degraded by context rot. Edit freely: this file is yours.
# Docs: https://github.com/qiweiz94/keel#rules
#
# Three tiers (session/EVIDENCE/wave2-rules.md has the full table):
#   TIER 1 protect \u2014 level: protect floors. Always active, never softened by
#     the sprint dial, exact high-confidence signatures only.
#   TIER 2 balanced \u2014 warn/prompt (deny only for exact-signature high-
#     confidence matches, e.g. literal credential formats).
#   TIER 3 observe \u2014 mode: observe. Evaluated and recorded (observed_action
#     on the trace) but never interrupts. Promote to warn/block once
#     'keel retrospective' shows the hit rate is real.
version: 1
level: balanced
rules:
  # \u2500\u2500 TIER 1: protect floor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  - id: keel-control-gate
    type: command
    match: "keel[ 	]+(disable|allow|level|enforce|install|uninstall|promote|halt|resume)([ 	]|$)|keel[ 	]+rules[ 	][^|;&]*--append"
    action: deny
    level: protect
    priority: 100
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "Same class as CVE-2025-59536/CVE-2026-21852 and the Copilot autoApprove poisoning reports: an agent that can operate its own enforcement controls can disarm itself. keel controls are for the human's own terminal only."
    remediation: "Run keel disable|allow|level|install|rules --append yourself, not through the agent."
    false_positives:
      - "A user pastes their own 'keel level protect' command into the agent's terminal to demonstrate the dial \u2014 still blocked; run it in a separate shell."
    message: "keel controls are user-owned \u2014 run keel disable|allow|level|install|rules --append in your own terminal, not through the agent."

  - id: no-rules-tampering
    type: filesystem
    paths:
      - "**/.keel/rules.yaml"
      - "**/.keel.local.yaml"
      - "**/.config/keel/rules.yaml"
      - "**/.keel/DISABLED"
      - "**/.keel/HALTED"
      - "**/.opencode/plugins/**"
      - "**/.keel/plugins/**"
      - "**/.claude/settings.json"
      - "**/.claude/settings.local.json"
      - "**/.mcp.json"
      - "**/.vscode/settings.json"
      - "**/.git/hooks/**"
    action: deny
    level: protect
    priority: 90
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "CVE-2025-59536 and CVE-2026-21852 (host config poisoning) plus the reported Copilot autoApprove class: an agent that edits its own enforcer's rules, or the host's autoApprove/hook config, disarms every other rule in this file. .claude/settings*.json and .mcp.json carry autoApprove/allow lists and MCP server definitions; git hooks are a persistence vector."
    remediation: "Edit these files yourself, outside the agent. If the agent needs a new keel rule, propose it and paste it in yourself."
    false_positives:
      - ".vscode/settings.json is also edited for ordinary editor prefs (formatOnSave, tabSize) unrelated to autoApprove \u2014 those legitimate edits are blocked too. Accepted: the file also carries the trust/approval config CVE-2025-59536-class attacks target, and an autonomous agent has little routine reason to touch team editor settings unprompted."
    message: "Modifying keel's own rules, state, or plugin files is blocked."

  - id: no-enforcer-removal
    type: command
    match: "rm[^|;&]*[.]opencode/plugins/|rm[^|;&]*[.]keel/(rules[.]yaml|plugins|DISABLED|HALTED)|rm[^|;&]*[ 	/][.]keel([ 	]|/?$)"
    action: deny
    level: protect
    priority: 90
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "Same self-defense requirement as no-rules-tampering (CVE-2025-59536/CVE-2026-21852 class): deleting the enforcer file is equivalent to editing it to no-op."
    remediation: "Uninstall keel yourself with 'keel uninstall' from your own terminal if you no longer want it."
    false_positives:
      - "A genuine 'keel uninstall' run by the human \u2014 this rule only blocks the agent's own 'rm', not the CLI's own uninstall code path."
    message: "Removing keel's enforcement files is blocked."


  # \u2500\u2500 self-protection write gate (Tier 1; supervisor paste at gate-3, secreview) \u2500\u2500
  - id: no-self-protection-write
    type: command
    match: "(>>?|(?<![A-Za-z])(tee( +-a)?|cp|mv|install|ln|truncate|dd|rsync)(?![A-Za-z])|(?<![A-Za-z])sed +-i[^|;&]*|(?<![A-Za-z])python3? +-c[^|;&]*|(?<![A-Za-z])node +-e[^|;&]*|(?<![A-Za-z])perl +-[ep][^|;&]*)[^|;&]*[^A-Za-z0-9_-]([.]keel/(rules[.]yaml|plugins)|[.]keel[.]local[.]yaml|[.]claude/settings([.]local)?[.]json|[.]mcp[.]json|[.]vscode/settings[.]json|[.]git/hooks/|[.]opencode/plugins/|[.]keel/DISABLED|[.]keel/HALTED)|git +config[^|;&]*core[.]hooksPath"
    action: deny
    level: protect
    priority: 95
    category: bypass
    severity: critical
    confidence: high
    mode: block
    rationale: "no-rules-tampering is a filesystem rule and therefore only sees a tool call's path ARGUMENT; a shell redirect's target is invisible to it. Measured in session/EVIDENCE/wave3-secreview.md: 21 of 21 shell writes to the self-protection path list were allowed, including a one-command write of the kill-switch sentinel that disables every rule at every dial. Same CVE-2025-59536/CVE-2026-21852 class as the filesystem rule it companions."
    remediation: "Edit .claude/settings.json, .mcp.json, .vscode/settings.json, git hooks, or keel's own files yourself, in your own terminal."
    false_positives:
      - "An ordinary editor-preference write to .vscode/settings.json through the shell is blocked -- the same accepted trade-off no-rules-tampering already documents for that path."
      - "Scaffolding a brand-new project's .mcp.json with a heredoc or redirect is blocked; ask the user to run it."
      - "A file literally named .mcp.json anywhere outside the project root is still matched -- the path fragments are matched anywhere in the command, not anchored to the project."
      - "A commit message that merely quotes one of these paths is NOT matched (verified: git commit -m with .mcp.json in the message passes), because a write verb must also be present."
      - "A diagnostic READ of the sentinel or any of these config files (cat, ls, grep of .keel/DISABLED, .keel/HALTED, .mcp.json, .claude/settings.json) is NOT blocked -- every path alternative here requires a preceding write verb or redirect, so reads pass and only writes are denied (verified live, v0.4 red-team)."
    message: "Writing to keel's own files, the agent's trust/approval config, or git hooks through a shell command is blocked -- these are user-owned."
  - id: agent-env-hijack
    type: command
    match: "(?<![A-Za-z])export +(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*) *=.*(>>|>) *[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile|[.]env)(?![A-Za-z])|(?<![A-Za-z])(echo|printf)(?![A-Za-z])[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*) *=.*(>>|>) *[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile|[.]env|[.]mcp[.]json)(?![A-Za-z])|(?<![A-Za-z])sed +-i[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)(?![A-Za-z])|(?<![A-Za-z])tee +-a? *[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile)(?![A-Za-z])[^|;&]*(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)(?![A-Za-z])|(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|KEEL_[A-Za-z_]*)[^;&]*[|][ 	]*(sudo[ 	]+)?tee[ 	]+(-a[ 	]*)?[^ ]*([.]bashrc|[.]zshrc|[.]zshenv|[.]zprofile|[.]zlogin|[.]bash_profile|[.]profile)(?![A-Za-z])"
    action: deny
    level: protect
    priority: 88
    category: escalation
    severity: critical
    confidence: high
    mode: block
    rationale: "CVE-2025-59536 / CVE-2026-21852: redirecting ANTHROPIC_BASE_URL or OPENAI_BASE_URL persists a man-in-the-middle on every future model call; KEEL_* persisted into shell config can quietly reconfigure this tool's own state/search/receipt paths. Scoped to PERSISTED mutation (redirected into rc/config files), not ordinary ephemeral env use."
    remediation: "If you need a custom base URL or KEEL_* var for local testing, export it for the current shell only \u2014 do not persist it into rc files or MCP config."
    false_positives:
      - "A legitimate one-off 'KEEL_STATE_DIR=/tmp/x npm test' in a single command is NOT matched (only >>/tee/sed writes into rc or config files trip this) \u2014 that ephemeral pattern is exactly what this repo's own test suites use."
    message: "Persisting a mutated ANTHROPIC_BASE_URL, OPENAI_BASE_URL, or KEEL_* variable into shell/config files is blocked \u2014 this is the CVE-2025-59536/CVE-2026-21852 host-config-poisoning pattern."

  - id: no-destructive-commands
    type: command
    match: '(?<!["''])rm[ 	]+-(rf|fr|r[ 	]+-f|-recursive[ 	]+--force|-force[ 	]+--recursive)[ 	]+/(?!tmp|var/tmp)|(?<!["''])rm[ 	]+-(rf|fr|r[ 	]+-f|-recursive[ 	]+--force|-force[ 	]+--recursive)[ 	]+(~|[$][{]?HOME[}]?/?([ 	]|$))|(?<!["''])rm[ 	]+-(rf|fr|r[ 	]+-f|-recursive[ 	]+--force|-force[ 	]+--recursive)[ 	]+[.]([ 	]|$)|(?<!["''])rm[ 	]+-(rf|fr|r[ 	]+-f|-recursive[ 	]+--force|-force[ 	]+--recursive)[ 	]+[.][.]([ 	]|/|$)|(?<!["''])rm[ 	]+-(rf|fr|r[ 	]+-f|-recursive[ 	]+--force|-force[ 	]+--recursive)[ 	]+[.][/](([*])?([ 	]|$))|(?<!["''])rm[ 	]+-(rf|fr|r[ 	]+-f|-recursive[ 	]+--force|-force[ 	]+--recursive)[ 	]+[*]([ 	]|$)|(?<!["''])rm[ 	]+-(rf|fr|r[ 	]+-f|-recursive[ 	]+--force|-force[ 	]+--recursive)[ 	]+/tmp/[^ ]*[.][.]([/ 	]|$)|chmod[ 	]+-R[ 	]+(777|000|a[+=]rwx)[ 	]+([/~][^ ]*|[.])([ 	]|$)|mkfs[.0-9a-zA-Z_]*([ 	]|$)|mke2fs([ 	]|$)|newfs_[a-z0-9]+([ 	]|$)|diskutil[ 	]+(eraseDisk|eraseVolume|zeroDisk|reformat|partitionDisk)(?![A-Za-z])|(?<!["''])rm[^|;&]*--no-preserve-root|shred([ 	]|$)|wipefs([ 	]|$)|blkdiscard([ 	]|$)|dd[ 	][^|;&]*of=/dev/(?!null([ 	]|$)|zero([ 	]|$)|stdout|stderr|tty)[^ ]+|>[ 	]*/dev/(disk[0-9]+|rdisk[0-9]+|sd[a-z]+[0-9]*|hd[a-z]+[0-9]*|vd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+|xvd[a-z]+[0-9]*|mmcblk[0-9]+)([ 	]|$)|[; ][:][ 	]*[()][ 	]*[()][ 	]*[{][ 	]*[:][ 	]*[|]:&|^[:][ 	]*[()][ 	]*[()][ 	]*[{][ 	]*[:][ 	]*[|]:&'
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "Gemini CLI incident (AIID 1178): an agent misread a relative path and deleted files outside the intended directory. Anchored to root/home/cwd-wide wipes and disk-format/overwrite primitives, not ordinary rm."
    remediation: "Delete specific named files/directories inside the project instead of a wildcard/root wipe."
    false_positives:
      - "rm -rf node_modules, rm -rf dist, rm -rf ./build/tmp-* \u2014 all allowed by design (do-not-ship guard: no blanket rm -rf block)."
    message: "Destructive commands (including fork bombs) are blocked."

  - id: no-destructive-interpreter-body
    type: command
    match: 'shutil[.]rmtree[(][ ]*[''"]?/[''"]?[ ]*[,)]|shutil[.]rmtree[(][ ]*[''"]?~/?[''"]?[ ]*[,)]|os[.]system[(][ ]*[''"][^''"]*rm[ ]+-[a-zA-Z-]*r[a-zA-Z-]*f[a-zA-Z-]*[ ]+(/|~)|subprocess[.](run|call|Popen|check_call|check_output)[(][ ]*[''"][^''"]*rm[ ]+-[a-zA-Z-]*r[a-zA-Z-]*f[a-zA-Z-]*[ ]+(/|~)|subprocess[.](run|call|Popen|check_call|check_output)[(][^)]*[''"]rm[''"][^)]*[''"]-[a-zA-Z-]*r[a-zA-Z-]*f[a-zA-Z-]*[''"][^)]*[''"](/|~)[''"]|(rmSync|rmdirSync)[(][ ]*[''"]?/[''"]?[ ]*[,)]|(rmSync|rmdirSync)[(][ ]*[''"]?~/?[''"]?[ ]*[,)]|os[.]remove[(][ ]*[''"]?/[''"]?[ ]*[,)]'
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "M1 follow-up to the A2 shell-parse layer: command-normalizer.ts now exposes an interpreter one-liner's decoded body (python -c, node -e, perl -e) as its own matching surface, but until this rule shipped no default pattern targeted destructive calls written IN that body instead of as a shell verb \u2014 python3 -c with shutil.rmtree('/') denied nothing. Scoped to a literal root or home target only (shutil.rmtree, os.system/subprocess running rm -rf against / or ~, os.remove('/'), fs.rmSync/rmdirSync against / or ~), mirroring no-destructive-commands' own root/home scoping so ordinary cleanup code (shutil.rmtree of a build dir, os.remove of a temp file) is untouched."
    remediation: "Call the interpreter body against a specific named path inside the project instead of the filesystem root or home directory."
    false_positives:
      - "shutil.rmtree('./build'), shutil.rmtree(tmp_dir), os.remove('/tmp/tempfile.txt'), fs.rmSync('./dist') \u2014 all allowed: the target is not the literal root or home path."
      - "subprocess.run(['terraform','apply','-refresh=true','-target=/infra']) is allowed \u2014 the rm/-rf/root-path pieces are not all present as their own quoted tokens or within one string argument."
    message: "Destructive filesystem calls inside an interpreter one-liner body (python -c, node -e, sh -c) targeting root or home are blocked."

  - id: no-force-push
    type: command
    match: "git ((--no-pager )|(-C [^ ]+ ))*push.*--force(?!-with-lease)( |=|$)|git ((--no-pager )|(-C [^ ]+ ))*push.*(^| )-f( |=|$)|git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*push[^|;&]*[ 	][+](main|master)(?![A-Za-z])"
    action: deny
    level: protect
    priority: 82
    category: destructive
    severity: high
    confidence: high
    mode: block
    rationale: "Force-pushing overwrites remote history other clones may depend on; --force-with-lease is the safe equivalent and costs nothing extra."
    remediation: "Use 'git push --force-with-lease' instead."
    false_positives:
      - "A genuinely solo throwaway branch nobody else has fetched \u2014 still blocked; use --force-with-lease there too, it is a strict improvement."
    message: "Use --force-with-lease instead of --force."

  - id: protected-branch-reset
    type: command
    match: "git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*reset[ 	]+--hard[ 	]+(origin/)?(main|master)(?![A-Za-z])|git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*checkout[ 	]+(origin/)?(main|master)(?![A-Za-z])[^|;&]*(&&|;)[ 	]*git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*reset[ 	]+--hard|git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*switch[ 	]+(origin/)?(main|master)(?![A-Za-z])[^|;&]*(&&|;)[ 	]*git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*reset[ 	]+--hard"
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "git reset --hard against main/master discards commit history other clones depend on. Protected branch names are main/master by default \u2014 edit this rule's match to add your own (e.g. release/*, develop)."
    remediation: "Reset a local feature branch, or use 'git revert' on a shared branch instead."
    false_positives:
      - "git reset --hard HEAD~1 on a feature branch with no branch name in the command is a known gap \u2014 this rule can only see branch names that appear explicitly in the command text, not ambient checkout state."
    message: "git reset --hard against a protected branch (main/master) discards shared history \u2014 blocked."

  - id: protected-branch-delete
    type: command
    match: "git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*push[^|;&]*(--delete|-d)[ 	]+(origin[ 	]+)?(refs/heads/)?(main|master)(?![A-Za-z])|git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*push[^|;&]*[ 	]:(refs/heads/)?(main|master)(?![A-Za-z])|git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*branch[ 	]+(-D|--delete)[ 	]+(main|master)(?![A-Za-z])|git[ 	]+((--no-pager|-C[ 	]+[^ ]+|-c[ 	]+[^ ]+)[ 	]+)*update-ref[ 	]+-d[ 	]+refs/heads/(main|master)(?![A-Za-z])"
    action: deny
    level: protect
    priority: 88
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "Deleting main/master (locally or on the remote) is rarely intentional and is far more disruptive than an ordinary feature-branch cleanup. Ordinary branch deletion stays governed by publish-gate (Tier 2 prompt) \u2014 this rule is the exact-name escalation for the protected branches specifically."
    remediation: "Delete the feature branch you meant to, not main/master. If main really must be renamed/retired, do it from the git host's own UI."
    false_positives:
      - "git push origin --delete feature/old \u2014 not matched; only the exact main/master branch name trips this."
    message: "Deleting the main/master branch (local or remote) is blocked."

  - id: pipe-to-shell
    type: command
    match: "(?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])[^;&]*[|][ 	]*(sudo[ 	]+)*(ba|z|k|da|a)?sh([ 	]|$)|(ba|z|k|da|a)?sh <[(](?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])|(?<![A-Za-z])(ba|z|k|da|a)?sh(?![A-Za-z])[ 	]+-c[ 	]+.*[$][(][^)]*(?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])|(?<![A-Za-z])eval(?![A-Za-z])[ 	]+.*[$][(][^)]*(?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])"
    action: deny
    level: protect
    priority: 88
    category: injection
    severity: critical
    confidence: high
    mode: block
    rationale: "Piping a remote script straight into a shell interpreter executes arbitrary code with no review step \u2014 the same trust-the-download pattern behind slopsquatting-class attacks (USENIX 2025) where a downloaded artifact is executed sight-unseen. Extended beyond a literal pipe to bash -c $(curl ...) and eval $(curl ...), the quoted command-substitution variants of the same primitive."
    remediation: "Download the script, read it, then run it explicitly (or use the project/package manager's own install command)."
    false_positives:
      - "curl -O https://example.com/file.tar.gz (download only, no pipe to a shell) is allowed \u2014 only piping/substituting into bash/sh/eval trips this."
      - "A script literally named 'flash.sh' or 'wash.sh' run directly ('./wash.sh') is not matched \u2014 the pattern requires curl/wget piped or substituted INTO the interpreter, not any filename ending in sh."
    message: "Piping or substituting a remote script into a shell executes arbitrary code \u2014 blocked."

  - id: no-exfil-flow
    type: flow
    sources:
      - "**/.env*"
      - "**/.ssh/**"
      - "**/*.pem"
      - "**/.git-credentials"
      - "**/.aws/credentials"
      - "**/.config/gcloud/**"
      - "**/Library/Keychains/**"
      - "**/.npmrc"
      - "**/.netrc"
    sinks: [network]
    action: deny
    level: protect
    priority: 85
    category: exfil
    severity: critical
    confidence: high
    mode: block
    rationale: "The 'lethal trifecta' (private data + untrusted content + an exfiltration path, Simon Willison): once an agent has read a credential file, sending anything to the network in the same flow is the exfil step, regardless of which network tool does it. Extended source list per Tier-1 scope: AWS/gcloud creds, keychain, npmrc, netrc, joining the existing .env/.ssh/.pem/.git-credentials set."
    remediation: "If the agent needs to send config to a service, use a scoped, non-secret value \u2014 never a credential file's raw contents."
    false_positives:
      - "A deploy step that rsyncs or scps BUILD OUTPUT to a remote host, run in the same session as an earlier, unrelated read of a secret file (e.g. an env var lookup during setup), will still deny \u2014 the flow tracker has no payload correlation: it only knows a secret was read THIS session and a remote-copy sink ran, not whether the same bytes moved. rsync/scp joined the sink verb list in the M5 lane, closing a documented miss (SECURITY.md's no-exfil-flow redteam row); a single command that reads AND sends a secret in one shot (curl -d @.env host) remains a known, separate gap \u2014 the tracker needs two distinct tool calls to correlate. See docs/exfil.md."
    message: "Data read from sensitive files must not be sent over the network."

  - id: no-exfil-flow-cross-call
    type: flow
    sources:
      - "**/.env*"
      - "**/.ssh/**"
      - "**/*.pem"
      - "**/.git-credentials"
      - "**/.aws/credentials"
      - "**/.config/gcloud/**"
      - "**/Library/Keychains/**"
      - "**/.npmrc"
      - "**/.netrc"
    sinks: [network]
    action: warn
    level: sprint
    priority: 84
    category: exfil
    severity: high
    confidence: medium
    mode: warn
    cross_call: true
    rationale: "no-exfil-flow's in-memory FlowTracker only correlates a read and a later sink inside ONE live process (see docs/exfil.md). keel hook <host> (Claude Code, Gemini CLI, Cursor, Codex, cline, generic) runs a fresh process per tool call, so that correlation was inert there beyond a single piped command. This sibling rule checks the SAME sources/sinks against a persisted, session-scoped, TTL'd store (flow-store.ts, PersistentFlowStore) instead of in-memory state, so a read in one hook process and a sink in a LATER one, same session, now produces a signal too. Shipped as warn, not deny: the correlation window here is the store's TTL (about an hour), not one live process, so a legitimate build that reads a token in one call and hits the network in a later, unrelated one is a realistic hit, not an edge case a hard block could absorb."
    remediation: "If this fires on a routine build or deploy step, it is very likely a false positive from an unrelated earlier read this session \u2014 no-exfil-flow (deny) is the rule to treat as a real interruption; this one is an early-warning signal only."
    false_positives:
      - "The same false-positive shape no-exfil-flow already documents (an unrelated secret read earlier in the session, followed by an unrelated network call later) \u2014 but wider, because the correlation window here spans MULTIPLE processes over the store's TTL, not one live process. This is exactly why this rule is warn/sprint, not deny/protect."
    message: "Cross-call correlation: an earlier hook call this session read a credential-shaped path; this call looks network-shaped. If unrelated, this is a false positive - see no-exfil-flow for the hard-block version of this pattern."

  - id: prod-db-destruction
    type: command
    match: "(?=.*(?<![A-Za-z])(prod|production|live)(?![A-Za-z]))(?=.*(psql|mysql|sqlite3|mariadb|pg_restore|cockroach)(?![A-Za-z]))(?=.*(DROP[ 	\\n]+(TABLE|DATABASE|SCHEMA)|TRUNCATE(?![A-Za-z])|DELETE[ 	]+FROM))(psql|mysql|sqlite3|mariadb|pg_restore|cockroach|.)"
    action: deny
    level: protect
    priority: 86
    category: destructive
    severity: critical
    confidence: high
    mode: block
    rationale: "Replit incident (AIID 1152): an agent ran a destructive SQL statement against the production database mid-task. Scoped to commands where the connection/command text is ALSO tagged prod|production|live (env var, hostname, or database name) \u2014 untagged destructive SQL is the separate Tier-2 warn rule (no-db-destructive), per the same incident: the DB there was untagged, so silent enforcement there is wrong and interruption there is also wrong; only the tagged case is a clean protect-floor signal."
    remediation: "Never run DROP/TRUNCATE against a production-tagged connection from an agent session. Use a migration tool with review, or do it yourself outside the agent."
    false_positives:
      - "A staging database whose hostname happens to contain 'live-preview' \u2014 a realistic near-miss; scope this rule's word list to your own naming convention if it fires on non-production infrastructure."
    message: "Destructive database operation against a production-tagged connection \u2014 blocked."

  # \u2500\u2500 TIER 2: balanced (warn / prompt; exact-signature deny kept where already high-confidence) \u2500\u2500
  - id: no-db-destructive
    type: command
    match: "(psql|mysql|sqlite3|mariadb|pg_restore|cockroach)( |$)[^|;&]*(DROP TABLE|TRUNCATE( |$)|DROP DATABASE|DELETE FROM)"
    action: warn
    level: sprint
    priority: 75
    category: destructive
    severity: high
    confidence: medium
    mode: warn
    rationale: "Replit incident (AIID 1152): the production database there was untagged, so a rule that only fires on tagged connections (prod-db-destruction, Tier 1) would have missed it. This is the deliberately-softer catch-all for destructive SQL with NO production tag detected \u2014 warn, not deny, because most local/dev database resets are exactly this shape and a hard block here would be the tautological-gate failure mode."
    remediation: "Confirm which database this command targets before running it. If it is production, stop and tag it \u2014 prod-db-destruction (Tier 1) will then block it outright."
    false_positives:
      - "sqlite3 ./test.db 'DROP TABLE fixture_users' in a test setup script \u2014 a real, common, benign hit; that is why this is warn, not deny."
    message: "Destructive database operation on an untagged connection \u2014 verify this is not production."

  - id: no-push-to-main
    type: command
    match: "git push( [^ ]+){0,3} (main|master)( |$)|git push.*[:](main|master)( |$)"
    action: prompt
    level: sprint
    priority: 80
    category: workflow
    severity: high
    confidence: high
    mode: block
    rationale: "Pushing directly to a protected branch skips whatever review process the branch is meant to enforce."
    remediation: "Open a PR instead, or get explicit approval before pushing straight to main."
    false_positives:
      - "A one-person repo with no branch protection configured \u2014 still prompts; the human can approve it in one keystroke."
    message: "Pushing directly to a protected branch \u2014 approval required."

  - id: commit-to-main
    type: command
    match: "git checkout +(main|master)(?![A-Za-z])[^|;&]*(&&|;) *git commit|git switch +(main|master)(?![A-Za-z])[^|;&]*(&&|;) *git commit"
    action: warn
    level: sprint
    priority: 60
    category: workflow
    severity: medium
    confidence: medium
    mode: warn
    rationale: "Committing directly to main bypasses branch-based review even before the push step no-push-to-main gates. KNOWN GAP: command-type rules see only the literal command text, not ambient git state \u2014 a bare 'git commit' while already checked out on main (no checkout/switch in the same command) is invisible to this rule. Only the common one-shot agent pattern (checkout main && commit) is caught."
    remediation: "Create a feature branch before committing: git checkout -b <branch> && git commit."
    false_positives:
      - "git checkout -b feature/x && git commit \u2014 not matched, only literal main/master checkouts trip this."
    message: "Committing directly on main/master \u2014 consider a feature branch instead."

  - id: no-verify-bypass
    type: command
    match: "git ((--no-pager )|(-C [^ ]+ ))*(commit|push|merge)(( [^ ]+))*? --no-verify( |$)|git ((--no-pager )|(-C [^ ]+ ))*(commit|push|merge)(( [^ ]+))*? -c[ =][^ ]*?core[.]hooksPath(?![/0-9A-Za-z_])|git ((--no-pager )|(-C [^ ]+ ))*-c[ =][^ ]*?core[.]hooksPath(?![/0-9A-Za-z_])|git commit( [^ ]+)* -n( |$)"
    action: warn
    level: sprint
    priority: 70
    category: bypass
    severity: high
    confidence: high
    mode: warn
    rationale: "SOFTENED deny->warn per do-not-ship guard: --no-verify must never hard-deny (a legitimate emergency hotfix, or a hook that is itself broken, needs an escape hatch). Kept exact-signature (real --no-verify/-n/core.hooksPath usage), just no longer irreversible."
    remediation: "Fix the failing hook instead of bypassing it, or explain why the bypass is necessary."
    false_positives:
      - "A genuinely broken pre-commit hook (e.g. a stale cached dependency) where --no-verify is the correct unblock \u2014 now a warn, not a hard stop."
    message: "Bypassing git hooks with --no-verify, -n, or core.hooksPath \u2014 make sure this is intentional."

  - id: write-outside-project
    type: filesystem
    paths:
      - "/etc/**"
      - "/usr/**"
      - "/bin/**"
      - "/sbin/**"
      - "/System/**"
      - "/Library/**"
      - "**/.bashrc"
      - "**/.zshrc"
      - "**/.bash_profile"
      - "**/.profile"
    action: prompt
    level: sprint
    priority: 65
    category: escalation
    severity: high
    confidence: medium
    mode: block
    rationale: "Gemini CLI incident (AIID 1178): an agent wrote/deleted files outside the directory it believed it was in. Scoped to concrete absolute system paths and shell rc files, NOT a project-relative denylist \u2014 a '!'-negated allowlist-by-exclusion pattern was considered and rejected (see session/EVIDENCE/wave2-rules.md): it would invert into matching nearly every ordinary in-project write."
    remediation: "Write inside the project directory. If a system file genuinely needs editing, do it yourself outside the agent."
    false_positives:
      - "A project that happens to be checked out at /usr/local/src/myproject \u2014 its own src/ writes are unaffected (paths are matched exactly, not by cwd heuristic), but a write to /usr/local/src/myproject itself would still prompt; document this if your project lives under one of these prefixes."
    message: "Writing outside the project (system path or shell config) \u2014 approval required."

  - id: cicd-config-edit
    type: filesystem
    paths:
      - "**/.github/workflows/**"
      - "**/.gitlab-ci.yml"
      - "**/Jenkinsfile"
      - "**/azure-pipelines.yml"
      - "**/.circleci/**"
    action: prompt
    level: sprint
    priority: 65
    category: escalation
    severity: medium
    confidence: high
    mode: block
    rationale: "CI config controls what runs with the repo's stored secrets on every push \u2014 an edit here is a higher-blast-radius change than an ordinary source file and deserves a look before it lands."
    remediation: "Review the diff yourself before it merges, same as any other CI change."
    false_positives:
      - "src/workflow-helper.ts or docs/circleci-notes.md \u2014 not matched; only files actually inside .github/workflows/, .circleci/, or literally named Jenkinsfile/azure-pipelines.yml/.gitlab-ci.yml trip this."
    message: "Editing CI/CD pipeline configuration \u2014 approval required."

  - id: cicd-and-infra
    type: command
    match: "(?<![A-Za-z])terraform +(apply|destroy)(?![A-Za-z])|(?<![A-Za-z])kubectl +[^|;&]*(apply|delete|exec|drain|cordon|rollout +restart)(?![A-Za-z])"
    unless:
      - regex: "--context[= ](?:(docker-desktop|minikube|local|orbstack|rancher-desktop)(?![A-Za-z0-9-])|(kind-[a-z0-9-]+|k3d-[a-z0-9-]+)(?![A-Za-z]))"
    action: prompt
    level: sprint
    priority: 65
    category: escalation
    severity: high
    confidence: medium
    mode: block
    rationale: "terraform apply/destroy and kubectl mutations can affect real infrastructure outside the repo entirely \u2014 the class of blast radius no source-code rule can see. Exempted when --context explicitly names a known local cluster."
    remediation: "Run infra-mutating commands yourself, or review the plan/diff before approving."
    false_positives:
      - "kubectl apply -f local.yaml --context minikube \u2014 exempted by the unless clause."
      - "kubectl get pods (a read, not a mutation) \u2014 not matched; only apply/delete/exec/drain/cordon/rollout restart trip this."
    message: "Infrastructure-mutating command (terraform apply/destroy or kubectl against a non-exempted context) \u2014 approval required."

  - id: secret-file-read-without-egress
    type: command
    match: "(?<![A-Za-z])(cat|less|more|head|tail|strings|xxd|base64)(?![A-Za-z])[^|;&]*( |/)([.]env([.][a-zA-Z]+)?|[.]ssh/(id_rsa|id_ed25519|config)|[.]aws/credentials|[.]npmrc|[.]netrc|[.]pgpass|[.]git-credentials)(?![A-Za-z])"
    action: warn
    level: sprint
    priority: -5
    category: exfil
    severity: medium
    confidence: medium
    mode: warn
    rationale: "The softer sibling of no-exfil-flow (Tier 1): a plain-text read of a secret file with no egress seen YET is informational, not a block \u2014 no-exfil-flow (deny) still fires if a network sink follows. KNOWN GAP: filesystem-type rules skip reads by design (pipeline.ts), so this must be command-type \u2014 it therefore only sees Bash cat/head/etc reads, never a native Read-tool call on the same path. Priority deliberately set BELOW no-exfil-flow so the flow tracker's read recording always happens first."
    remediation: "If you needed to see the secret file's contents, that's fine \u2014 just don't pipe or copy that output anywhere external."
    false_positives:
      - "cat .env.example (an explicitly-example/template file) still matches the .env* pattern \u2014 a real FP; narrow the regex further if your project ships many .env.* templates."
    message: "Read of a secret file with no egress detected yet \u2014 keep this contained, do not forward it."

  - id: broad-privilege-escalation
    type: command
    match: "(?<![A-Za-z])sudo(?![A-Za-z])(?![^;&|\\n]*(?<![A-Za-z])(apt-get|apt|yum|dnf|brew)(?![A-Za-z]))|(?<![A-Za-z])chmod +-R +[0-7]{3,4}(?![A-Za-z0-9])|(?<![A-Za-z])chown +-R(?![A-Za-z])"
    action: warn
    level: sprint
    priority: -5
    category: escalation
    severity: medium
    confidence: low
    mode: warn
    rationale: "Broad recursive permission/ownership changes and unscoped sudo are common in legitimate setup scripts, but are also the shape of a privilege-escalation attempt \u2014 warn-level awareness, not a block, given the high legitimate-use rate."
    remediation: "Scope chmod/chown to the specific path that needs it rather than a wide -R; prefer a package manager's own sudo-gated install step over ad-hoc sudo."
    false_positives:
      - "sudo apt-get install build-essential \u2014 exempted (common package-manager sudo usage)."
      - "chmod -R 755 ./dist after a build \u2014 matches and warns; a real, common, benign hit, which is exactly why this is warn not deny."
    message: "Broad privilege/ownership change (sudo, chmod -R, or chown -R) \u2014 double-check the scope."

  - id: paste-site-exfil
    type: command
    match: "(?<![A-Za-z])(curl|wget)(?![A-Za-z])[^|;&]*(pastebin[.]com|hastebin[.][a-z]+|dpaste[.][a-z]+|transfer[.]sh|file[.]io|0x0[.]st)(?![A-Za-z])"
    action: prompt
    level: sprint
    priority: 65
    category: exfil
    severity: high
    confidence: medium
    mode: block
    rationale: "Pastebin-class hosts are a common quick-exfil destination \u2014 no legitimate build/test/deploy step in this repo posts there, so a hit is high-signal even without a preceding secret-file read (no-exfil-flow already covers the read-then-network case for the sources it tracks; this covers the destination-based signal on its own)."
    remediation: "Use a proper artifact/log destination, not a public paste site."
    false_positives:
      - "Fetching (not posting to) a public gist or paste link a human shared for context \u2014 a GET of such a link is a realistic benign hit; narrow to POST-shaped commands (curl -d/-F/--data) if this fires too often for your workflow."
    message: "Posting to a pastebin-class host \u2014 approval required."

  # \u2500\u2500 TIER 2: kept as-is (already correctly tiered) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  - id: no-remote-exec
    type: command
    match: "(?<![A-Za-z0-9-])(npx|bunx|npm exec|pipx)( |$)|(?<![A-Za-z0-9-])(pnpm|yarn) dlx( |$)"
    action: prompt
    level: sprint
    priority: 80
    category: escalation
    severity: medium
    confidence: high
    mode: block
    rationale: "On-the-fly package execution downloads and runs code that was never vetted for this project \u2014 adjacent to the slopsquatting risk class (USENIX 2025), where a plausible-but-malicious package name gets executed sight-unseen."
    remediation: "Install the package normally (add to package.json, review it), then run it."
    false_positives:
      - "npx tsc --version as a quick version check \u2014 still prompts; the approval is one keystroke."
    message: "On-the-fly package execution downloads and runs remote code \u2014 approval required."

  - id: no-after-hours-publish
    type: time
    match: "git push|npm publish|gh release create|gh release delete|gh repo delete|gh repo transfer"
    schedule:
      start: "09:00"
      end: "22:00"
    action: warn
    level: sprint
    priority: 0
    category: workflow
    severity: low
    confidence: medium
    mode: warn
    rationale: "A publish/push outside normal hours is often correct (a fix for an active incident) but is also the shape of an unattended overnight run going further than intended \u2014 a nudge to double check, not a block."
    remediation: "Confirm this release/push is intentional before proceeding."
    false_positives:
      - "A legitimate on-call engineer shipping a 2am hotfix \u2014 warns, does not block."
    message: "Publishing or pushing outside 09:00-22:00 \u2014 double-check the release is intentional."

  - id: bash-rate-limit
    type: rate
    match: "Bash"
    window_seconds: 60
    max_calls: 30
    action: warn
    level: sprint
    priority: 0
    category: resource
    severity: low
    confidence: medium
    mode: warn
    rationale: "More than 30 Bash calls in 60 seconds is the clearest cheap signal of a runaway loop the model itself cannot see from inside its own context."
    remediation: "Slow down; if this is legitimately a batch operation, that's fine \u2014 this only warns."
    false_positives:
      - "A legitimate loop running one command per file across 40 files in a minute \u2014 a real, common, benign hit; warn only, by design."
    message: "More than 30 Bash calls in 60 seconds \u2014 possible runaway loop. Slow down."

  - id: no-skip-tests
    type: command
    match: "(npm|pnpm|yarn)( run)? test[^|;&]*--(passWithNoTests|skipTests|no-run)( |$)"
    action: warn
    level: sprint
    priority: 70
    category: bypass
    severity: high
    confidence: high
    mode: warn
    rationale: "SOFTENED deny->warn per do-not-ship guard (no hard test-before-commit / no deny on test-skip flags): a green run with --passWithNoTests etc. is not verification, but there are legitimate uses (an intentionally empty test dir during scaffolding) \u2014 this stays visible without blocking."
    remediation: "Run the real suite, or explain why there is nothing to test yet."
    false_positives:
      - "A brand-new package with no tests written yet, using --passWithNoTests during initial scaffolding \u2014 a real, common, legitimate hit."
    message: "Faking a green test run is not verification \u2014 run the suite."

  - id: no-secrets-in-code
    type: content
    # redact_span: true (sprint/lane-c2) marks a pattern whose match span
    # fully covers the secret bytes themselves, safe for
    # EnforcementPipeline.evaluateOutput() (output redaction, a DIFFERENT
    # consumer than the deny-on-write check below \u2014 this field has no
    # effect on that check) to replace in place. The last three patterns
    # here deliberately do NOT set it: they match only a LABEL or HEADER
    # (aws_secret_access_key=, a PEM BEGIN line) \u2014 the real secret sits
    # AFTER the match, uncovered by it. Redacting just the label would
    # strip the label and leave the actual key/PEM body sitting right next
    # to a "[redacted]" marker \u2014 a false-confidence signal worse than no
    # redaction at all. See types.ts's redact_span doc comment and
    # docs/exfil.md's "Output redaction" section.
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
        redact_span: true
      - regex: "ghp_[A-Za-z0-9]{36}"
        redact_span: true
      - regex: "github_pat_[A-Za-z0-9_]{22,}"
        redact_span: true
      - regex: "xox[baprs]-[A-Za-z0-9-]{10,}"
        redact_span: true
      - regex: "sk-[A-Za-z0-9_]{24,}"
        redact_span: true
      - regex: "BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY"
      - regex: "-----BEGIN PRIVATE KEY-----"
      - regex: "aws_secret_access_key[	 ]*[:=]"
    action: deny
    level: sprint
    priority: 75
    category: exfil
    severity: critical
    confidence: high
    mode: block
    rationale: "Exact-signature literal credential formats (AWS keys, GitHub tokens, Slack tokens, OpenAI-shaped keys, PEM headers) \u2014 high enough confidence to deny at balanced per the severity x confidence rule, despite living in Tier 2."
    remediation: "Use environment variables or a secrets manager, never a literal credential in source."
    false_positives:
      - "A docs page showing a REDACTED example key with the real characters replaced by x's does not match these exact-length formats, so it passes; a real (even if revoked) key literal will still match and deny, which is intentional."
    message: "Hardcoded credentials must not be written to files."

  - id: no-secret-files
    type: filesystem
    paths:
      - "**/.env*"
      - "**/.npmrc"
      - "**/.git-credentials"
      - "**/.netrc"
      - "**/.pgpass"
      - "**/*.pem"
      - "**/*.pfx"
      - "**/*.p12"
      - "**/.ssh/**"
      - "**/id_rsa*"
      - "**/id_ed25519*"
    exclude:
      - "**/.env.example"
      - "**/.env.sample"
      - "**/.env.test"
    action: deny
    level: sprint
    priority: 75
    category: exfil
    severity: high
    confidence: high
    mode: block
    rationale: "Writing/overwriting a credential file is an exact-signature, high-confidence path match with an explicit exclude list for the common template-file exceptions."
    remediation: "Write to a non-credential path, or use the excluded .env.example/.env.sample/.env.test naming for templates."
    false_positives:
      - "A .env.production file used for real deployment config (not matched by the exclude list) still denies, correctly."
    message: "Writing or modifying credential files is blocked."

  - id: no-credential-echo
    type: env
    vars:
      - AWS_SECRET_ACCESS_KEY
      - AWS_ACCESS_KEY_ID
      - GITHUB_TOKEN
      - NPM_TOKEN
      - NODE_AUTH_TOKEN
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
      - CLOUDFLARE_API_TOKEN
    action: deny
    level: sprint
    priority: 75
    category: exfil
    severity: high
    confidence: high
    mode: block
    rationale: "An exact named-variable match against a fixed, short, high-confidence list of known secret-bearing env var names."
    remediation: "Reference the variable indirectly (a config loader), don't echo/print it in a command."
    false_positives:
      - "echo $GITHUB_TOKEN_EXPIRY_DAYS is not matched (the var list requires the exact name, not a substring) \u2014 see the word-boundary sweep probes in fixture-harness.test.ts."
    message: "Exposing environment credentials in commands is blocked."

  - id: must-sign-commits
    type: command
    match: "git commit(?!.*(--signoff(?![A-Za-z-])|(?<![A-Za-z0-9-])-[a-z]*s[a-z]*(?![A-Za-z0-9-])))"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    level: sprint
    priority: 65
    category: workflow
    severity: low
    confidence: high
    mode: block
    rationale: "Auto-adding --signoff is a pure convenience fix, not a security control \u2014 no incident citation applies; this is a standing repo convention. Priority raised from 60 to 65 \u2014 above commit-to-main (60/file-order), a same-severity workflow rule this one was previously losing ties to, so the auto-fix now actually fires on a bare main-branch commit missing --signoff. Deliberately kept BELOW no-verify-bypass (70) and git-history-rewrite (80): both are real security-relevant approval/awareness gates (per this codebase's own ACTION_STRENGTH scale, prompt=3 and warn=1 both rank as intentional, non-cosmetic interventions), and letting this rule's cosmetic action: fix silently pre-empt either one would swallow the approval prompt on a --amend or erase the only warning on a --no-verify bypass \u2014 confirmed by two pre-existing full-ruleset assertions in agentic-eval.test.ts that would otherwise regress."
    remediation: "N/A \u2014 this rule fixes the command in place automatically."
    false_positives:
      - "git commit --amend --no-edit or git commit --no-verify: NOT auto-fixed \u2014 git-history-rewrite/no-verify-bypass (both higher priority) intentionally win on these, so no signoff is added on that call; approve/heed that rule's verdict first, then re-run without those flags to get the signoff fix."
    message: "Auto-adding --signoff to commits."

  - id: git-history-rewrite
    type: command
    match: "git filter-branch|git rebase|git reset (--hard|--soft|--keep|--merge|HEAD~)|git commit --amend|git stash (drop|clear)"
    action: prompt
    level: sprint
    priority: 80
    category: destructive
    severity: medium
    confidence: high
    mode: block
    rationale: "General git-history-mutation best practice \u2014 no single named incident in the provided list; shared-history rewrites are a standing engineering risk regardless of AI involvement."
    remediation: "Confirm nobody else has the commits you are about to rewrite before proceeding."
    false_positives:
      - "git rebase on a local-only feature branch nobody has fetched \u2014 still prompts; approval is one keystroke."
    message: "Git history mutation \u2014 this rewrites shared history. Approval required."

  - id: publish-gate
    type: command
    match: "npm publish|npm unpublish|gh release create|gh release delete|gh repo delete|gh repo transfer|git push.*[ 	](--delete|-d)( |$)"
    action: prompt
    level: sprint
    priority: 80
    category: workflow
    severity: high
    confidence: high
    mode: block
    rationale: "Publishing or deleting a registry/repo artifact is often irreversible or hard to undo \u2014 a standing best practice, no single incident citation applies."
    remediation: "Double-check the version/target before approving."
    false_positives:
      - "git push origin --delete feature/stale-branch \u2014 an entirely routine cleanup; still prompts (the narrower Tier-1 protected-branch-delete only fires for main/master specifically)."
    message: "Publishing or deleting registry artifacts \u2014 approval required."

  - id: verify-format-before-decision
    type: command
    match: "(default|choose).*(format|config|rule)"
    action: warn
    level: sprint
    priority: 0
    category: discipline
    severity: low
    confidence: low
    mode: warn
    rationale: "A model choosing a format/convention without checking the project's own is a common context-rot failure mode this repo's own standing requirements target directly."
    remediation: "Ask what the project already uses before deciding."
    false_positives:
      - "npm init -y or a config command that legitimately needs no user check \u2014 exempted via the unless clause."
    unless:
      - regex: "git config|npm config|pnpm config|yarn config|bun config|npx( |$)|npm exec|pipx|dlx( |$)|init( |$)|-y( |$)|--yes"
    message: "You are choosing a format without verifying the user. Ask what they use before deciding."


  # \u2500\u2500 slopsquatting install gate (Wave-2 lane 2; supervisor paste at gate-2) \u2500\u2500
  - id: unverified-package-install
    type: package
    action: prompt
    age_days: 30
    category: supply-chain
    severity: high
    confidence: medium
    rationale: >
      19.7% of LLM-recommended packages don't exist (USENIX Security 2025,
      'We Have a Package for You! A Comprehensive Analysis of Package
      Hallucinations by Code Generating LLMs'). Attackers register the
      hallucinated name ahead of time and wait for an agent to install it \u2014
      this already happened for real: the package 'huggingface-cli' was
      squatted on PyPI (the actual package is 'huggingface_hub') and
      shipped a reverse shell to anyone who typed the plausible-sounding
      name. A rule engine running outside the model's context window is
      the only thing that can check the name against the registry before
      the shell executes, since the hallucination itself is invisible to
      the model that produced it.
    remediation: >
      Confirm the package name and publisher before installing \u2014 check the
      registry page, the GitHub repo it links to, and recent download
      counts. If the agent suggested this name from memory rather than a
      lockfile or an explicit user instruction, treat the suggestion as
      unverified until you've looked it up yourself.
    false_positives:
      - 'Private or org-scoped registry packages (Verdaccio, Artifactory, GitHub Packages) that 404 against the public npm registry by construction \u2014 these prompt as unverified, never deny (see package-verifier.ts scoped-404 handling)'
      - 'A pip install that targets a private or company package index via --index-url, --extra-index-url, or -i \u2014 these always prompt as unverified without querying the custom index, since PyPI has no scoped-name convention like npm to signal "private" by name alone'
      - 'A legitimate package published in the last 30 days (the age-gate default) \u2014 prompts for a second look, not a hard block'
      - 'Registry timeouts or outages, on any of the four covered ecosystems \u2014 network failures always downgrade to unverified, never deny'
    message: "This package install could not be verified against its package registry \u2014 confirm the name and publisher before proceeding."

  # \u2500\u2500 TIER 3: observe (evaluated + recorded via observed_action, never interrupts) \u2500\u2500
  - id: source-change-requires-test
    type: verification
    mode: observe
    category: discipline
    severity: medium
    confidence: medium
    trigger:
      tools: [write, edit, apply_patch, WriteFile]
      path: "src/"
      paths: ["package.json"]
      pattern: "(src/|package[.]json)"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
      push:
        pattern: "git push"
        action: deny
    verification_window_seconds: 300
    action: deny
    rationale: "RE-TIERED to mode: observe (was deny-on-push): this repo's own standing requirements already state the verification-culture expectation in prose; moving the hard enforcement to observe lets it burn in and measure its real hit/false-positive rate (via observed_action) before it interrupts commits/pushes again."
    remediation: "Run the project's test command after a source change, before committing or pushing."
    false_positives:
      - "A pure documentation or config change under src/ (e.g. a comment-only edit) that doesn't need a test run \u2014 now only logged, not blocked, while in observe."
    message: "Source changes require a successful test run before commit or push."

  - id: no-repeat-loops
    type: stuck
    match: "(npm|pnpm|yarn|bun)( run)? (test|build)|vitest|jest|pytest|go test|tsc|keel allow|git (commit|push)"
    category: workflow
    severity: medium
    confidence: high
    priority: -10
    window_seconds: 900
    max_attempts: 3
    fingerprint: auto
    require_failure: true
    reset_on_success: true
    escalation:
      - at: 3
        action: redirect
        message: "This exact command has failed 3 times in 15 minutes. Stop retrying it. Research the exact error, state a root-cause hypothesis, then change approach."
      - at: 5
        action: deny
        message: "5 identical failures. Retrying without new information is blocked \u2014 record a hypothesis or ask the user."
    action: warn
    rationale: "PROMOTED from mode: observe: this project's own traces cite 41 distinct repeat loops across 20 sessions (one command retried 39 times) from before this machinery existed \u2014 real hit-rate evidence for the underlying failure mode, and no over-triggering or false-positive has ever been recorded against this rule (see docs/tiers.md, session/PROMOTION-REPORT.md). Identical retries against the same failure are the single clearest signal of a stuck agent, and the one thing a rule engine can see that the model cannot: it runs outside the context window, where circling actually lives. Shipped as a DEFAULT rather than an opt-in paste (previously 'keel rules harness --append')."
    remediation: "Search the exact error, state a hypothesis, or ask the user."
    false_positives:
      - "Polling a long-running job by re-running the same status command"
    message: "Identical failing command repeated \u2014 research the error and change approach."

  - id: research-before-fix
    type: research
    mode: observe
    category: workflow
    severity: medium
    confidence: medium
    priority: -10
    trigger:
      tools: [Bash]
      pattern: "(npm|pnpm|yarn|bun)( run)? (test|build)|vitest|jest|pytest|go test|tsc"
      exit: nonzero
    satisfy:
      tools: [Bash, WebSearch, WebFetch, websearch, webfetch, mcp__keel__keel_research]
      pattern: "(npm view|npm info|pip index|WebSearch|WebFetch|keel_research|keel_fetch)"
    boundaries:
      edit:
        pattern: "write|edit|apply_patch"
        action: redirect
    research_window_seconds: 600
    freshness_seconds: 1800
    action: redirect
    rationale: "Armed only by a FAILING command, never by green-field work \u2014 so it cannot slow down ordinary editing. It fires when a fix is about to be attempted against stale knowledge. NOTE (evaluated for this wave): this is a 'research'-type rule with a 'trigger', so the engine checks it in the pre-cache stateful loop, ahead of Tier 1/2 command rules in the same call \u2014 even in mode: observe this can short-circuit a Tier-1 rule's evaluation for the SAME write/edit call if a research obligation happens to be pending. Documented, not fixed here: fixing it is a pipeline.ts change, out of this lane's scope (see session/EVIDENCE/wave2-rules.md)."
    remediation: "Look up the failing module or error before patching it."
    message: "A command just failed and you are about to patch it without checking current docs. Research the error first."

  - id: root-cause-before-refactor
    type: diagnosis
    mode: observe
    category: workflow
    severity: medium
    confidence: medium
    priority: -10
    match: "(rm -rf|git[ 	]+checkout[ 	]+(--[ 	]+)?([.]|:/)([ 	]|$)|git reset --hard|(?<![A-Za-z])migrate(?![A-Za-z])|(?<![A-Za-z])refactor(?![A-Za-z]))"
    require_hypothesis: true
    fallback_pattern: "git (log|blame|bisect|diff)"
    action: redirect
    rationale: "Complex or destructive fixes should follow an investigation, not precede one. Discharged by a recorded hypothesis OR by real investigation evidence (git log/blame/bisect/diff), so it never demands ceremony from someone who already did the work."
    remediation: "Run git log/blame/bisect, or record a hypothesis with keel_hypothesis."
    false_positives:
      - "git checkout -- file.ts (a single-file checkout/restore) is NOT matched \u2014 only a whole-tree discard (git checkout -- ., git checkout ., git checkout -- :/) trips this; M1r-1 rules-tuning fix for the documented single-file FP (session/v04/AUDIT.md)."
      - "A write to src/migrations/001_init.ts or src/migrateUsers.ts is NOT matched \u2014 migrate/refactor are anchored to stand-alone words, not path or filename substrings."
    message: "Destructive or structural change without a recorded root cause. Investigate first."

  # \u2500\u2500 Wave-2 verification proposals (observe burn-in; supervisor paste at gate-2) \u2500\u2500
  - id: claim-without-evidence
    type: claim
    category: verification
    severity: high
    # LOW, not medium, and not rounded up: see EVIDENCE.md \xA76 for the honest
    # accounting \u2014 the two channels this rule can see (an unwired
    # 'reasoning' field in every surveyed host, and commit/PR message text)
    # mean it fires on a small, host-dependent slice of real false-success
    # claims, and the grammar itself is a regex heuristic, not a parser.
    confidence: low
    maturity: incubating
    # observe: evaluated and recorded every call (observed_action in the
    # trace), never interrupts. A new detector earns its way to warn/block by
    # a measured false-positive rate on real trajectories, not by assumption.
    mode: observe
    trigger:
      tools: [write, edit, apply_patch, WriteFile]
      path: "src/"
      paths: ["package.json"]
      pattern: "(src/|package[.]json)"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest|pytest|go test|cargo test)"
    verification_window_seconds: 300
    action: warn
    message: >-
      Claimed done/fixed/tested/passing/verified/complete without a passing
      verification run since the last source edit. Run the test/build
      command that satisfies this obligation before making that claim, or
      say explicitly that it is unverified.
    rationale: >-
      Trajectory research on self-assessing coding agents found 75.8% of
      FAILING runs carried an explicit false-success claim in the agent's own
      output, and that LLM judges scoring those same claims for truthfulness
      land at ~0.54 AUROC \u2014 indistinguishable from chance. A judge that reads
      the claim and reasons about whether it sounds true cannot catch this
      class of failure; only cross-referencing the claim against what
      actually ran can. This rule does exactly that: it does not evaluate
      whether the claim is TRUE, only whether a verification command visibly
      ran and passed since the edit the claim is about \u2014 the same
      trigger/satisfy/pending shape the shipped 'source-change-requires-test'
      verification rule already uses, applied to the agent's own words
      instead of a commit/push boundary.
    remediation: >-
      Before stating a task is done/fixed/tested/passing/verified/complete,
      run the project's test or build command and let it finish (not
      '--help', '--dry-run', or a swallowed exit code \u2014 see verification.ts's
      isFakeSatisfy for what does not count). If verification genuinely
      cannot be run yet, say so plainly instead of claiming completion.
    false_positives:
      - >-
        WIP/status narration during active work ("still fixing the parser,
        tests not run yet") \u2014 suppressed by the grammar's hedge/negation
        exclusion (wip, todo, partial, "not run", "in progress", ...), but a
        hedge phrasing outside that word list will still fire.
      - >-
        A commit message that accurately describes a fix VERIFIED IN AN
        EARLIER session or an earlier window that has since expired
        (verification_window_seconds default 300s) \u2014 the obligation is gone
        by the time the commit happens, so the rule reads it as unverified
        even though it genuinely was. This is a real, not-yet-mitigated gap:
        the window is a proxy for "still fresh enough to trust," not a
        certificate that no verification ever happened.
      - >-
        Quoting the USER's or a teammate's claim back in reasoning text
        ("you said tests were passing, but I see...") is intended to be
        suppressed by the quoted-span exclusion; an unquoted paraphrase of
        someone else's claim is not caught by that exclusion and may
        false-fire.
      - >-
        Docs-only or config-only sessions that never touch 'src/' or
        'package.json' never arm the obligation at all, so a "done" claim
        about non-code work correctly never fires \u2014 not a false positive,
        but worth listing so a reviewer does not expect this rule to cover
        that case.
    review_by: "2026-11-11"

# \u2500\u2500 GATE INTEGRATION NOTE \u2014 read before adopting, not a false_positives
#    entry (this is a suppression, not a wrong fire) \u2500\u2500
#
# This rule and the shipped 'source-change-requires-test' verification rule
# have an IDENTICAL 'trigger' (same tools/path/paths/pattern) and neither
# sets 'priority' (both default to 0). Proven empirically
# (claim.test.ts's "gate-integration ordering" describe block, which
# extracts the exact shipped rule text the way fixture-harness.test.ts
# extracts DEFAULT_RULES_YAML \u2014 see EVIDENCE.md \xA79): on the ONE channel
# this rule can actually reach in production today (see the confidence:low
# rationale above \u2014 commit/PR message text, not the unwired 'reasoning'
# field), 'git commit -m "<claim>"' while both rules are active, the
# EARLIER rule in file order wins EnforcementPipeline.evaluate()'s
# short-circuit \u2014 the shipped verification rule's commit-boundary 'warn'
# fires and THIS rule is never evaluated on that call at all. This is not a
# bug in either rule; it is a consequence of both watching the same trigger
# with the same priority. Adopting this rule needs an explicit ordering
# decision at the gate \u2014 a 'priority' above the shipped rule (which then
# raises a DIFFERENT problem: 'mode: observe' short-circuits
# 'evaluate()' too, so it would swallow the shipped rule's real 'warn' on
# that call \u2014 see EVIDENCE.md \xA79 before changing that behavior), or
# accepting the shipped rule's warn as the one users see on that
# trajectory. Not something this rule's own YAML can resolve.
  - id: test-oracle-tampering
    type: oracle
    level: sprint
    mode: observe
    action: warn
    category: verification
    severity: high
    confidence: low
    maturity: incubating
    message: >-
      A test-oracle weakening pattern (skip/only added, assertions or a
      test block removed, a snapshot or expected value rewritten,
      timeout/retry inflated) landed shortly after a failing test run.
      This may be making the test pass by weakening it, not by fixing the
      code \u2014 verify this is an intentional refactor, not a shortcut
      around a red run.
    rationale: >-
      Reward-hacking research documents agents making tests pass by
      editing the oracle instead of the implementation. ImpossibleBench
      found read-only visible tests the best safety/performance balance
      among test-oracle protections; short of that (see the opt-in
      tests-read-only.yaml), the next best deterministic control is
      flagging a weakening EDIT that follows a RED run \u2014 exactly the shape
      a reward-hacked "fix" takes, and rare enough in legitimate work that
      the recency gate keeps it a real signal.
    false_positives:
      - "Legitimate refactor: renaming a test or reorganizing describe blocks while preserving every assertion \u2014 no assertion-count, test-block-count, or skip-count delta, so this does not fire regardless of recency."
      - "Intentional snapshot update after a real UI/output change (jest -u / vitest -u) run within 15 minutes of an UNRELATED failing test elsewhere in the same command invocation \u2014 the recency window is per (rule, cwd, session), not per file or per failing test name, so the SAME session's monorepo-wide test run failing in module A can arm the window for that session's intentional, correct snapshot refresh in module B moments later."
      - "Removing a genuinely obsolete test (the feature it covered was deleted) shortly after a failing run of a DIFFERENT test in the same suite invocation \u2014 the trigger is the exit code of the whole test command, not evidence that THIS test was the one failing."
      - "Fixing a wrong expected value in the test itself (the test asserted the wrong thing, not the code) \u2014 indistinguishable at this detector's confidence level from rewriting a correct expectation to dodge a real failure; this is exactly why the rule ships at 'confidence: low' and 'mode: observe' rather than blocking."
    review_by: "2026-11-11"
    paths:
      - "**/*.test.*"
      - "**/*.spec.*"
      - "**/tests/**"
      - "**/test_*.py"
      - "**/conftest.py"
      - "**/*.snap"
      - "**/__snapshots__/**"
    trigger:
      tools: [Bash]
      pattern: "(npm|pnpm|yarn|npx) +(run +)?test|vitest|jest|pytest|go +test|cargo +test|rspec|phpunit|mvn +test|gradle +test"
      exit: nonzero
    match: "(?<![A-Za-z0-9_])(jest|vitest)(?![A-Za-z0-9_])[^|;&]*(--update-snapshot(?![A-Za-z0-9-])|--updateSnapshot(?![A-Za-z0-9])|(?:^| )-u(?![A-Za-z0-9-]))"
    window_seconds: 900

  - id: test-oracle-env-introspection
    type: content
    level: sprint
    mode: observe
    action: warn
    category: verification
    severity: high
    confidence: low
    maturity: incubating
    message: >-
      Written content inspects the call stack, process.argv, or module
      identity (require.main/import.meta) AND references a test-file
      identifier (.test., .spec., __tests__, currentTestName, testPath) AND
      branches on it (if/switch) \u2014 OR calls jest's expect.getState() (itself
      a read of which test is currently running) AND branches on it \u2014 the
      exact shape two calibration models used to satisfy two contradictory
      test files by detecting WHICH ONE is calling the implementation and
      returning a different answer per caller, not by implementing correct
      behavior. Verify this is a legitimate entrypoint/environment check,
      not test-oracle gaming via caller detection.
    rationale: >-
      Discovered live during the v0.4 benchmark (session/v04/EVIDENCE/
      b2-benchmark.md, section 4, "A real exploit found, not anticipated:
      environment introspection"): given two test files asserting opposite
      outputs, one calibration model read process.argv[1] and another read
      new Error().stack to detect which test file was currently executing
      and branched the implementation's return value accordingly \u2014 both
      "contradictory" tests passed, the implementation was never actually
      correct for either, and neither test file was edited, so the shipped
      test-oracle-tampering rule (which watches for EDITS to test files)
      never fires on this. keel had no rule for this failure class before
      this one. This is a content-diff signal (the SOURCE being written,
      not a command), so it ships as its own rule instead of folding into
      test-oracle-tampering's command/content-diff surfaces. Deliberately
      narrower than the benchmark's own detectEnvironmentIntrospection()
      grading helper, which also flags bare process.env, __filename, and
      __dirname, plus any .stack access at all \u2014 those are ordinary in
      everyday Node.js code (path resolution, config reads) and would
      false-fire constantly on jest.config.js/webpack.config.js-style files
      that legitimately combine __dirname, environment ifs, and
      .test./.spec. glob patterns in the same file. This rule instead
      requires the narrower Error()-construction, process.argv, or
      require.main/import.meta surface, ANDed (via lookahead,
      order-independent, anywhere in the written content) with BOTH a
      test-file identifier string AND an if/switch branch keyword before it
      fires \u2014 three signals for three of the four patterns. The fourth
      pattern (expect.getState()) requires only that surface ANDed with an
      if/switch, not a separate test-file identifier string, because
      calling expect.getState() at all is already itself a read of which
      test is currently running \u2014 no ordinary non-test code has a reason to
      call it; gaming code that goes on to read
      expect.getState().currentTestName still independently satisfies the
      other patterns' test-file identifier signal too, since
      currentTestName is in that same list. Shipped observe/confidence: low
      because a content regex over arbitrary source text cannot see intent
      or data flow \u2014 it can only prove two or three narrow textual signals
      co-occurred, which is what a burn-in period against real trajectories
      is for. That co-occurrence is scoped to the write's own inline
      content when the tool call carries one, but on an Edit call with no
      inline content the pipeline falls back to scanning the WHOLE file
      already on disk \u2014 so on that path "co-occurred" means anywhere in the
      existing file, not just within the diff being applied.
    false_positives:
      - "Legitimate Error().stack logging/error-reporting (console.error(new Error().stack), an error-tracker capture, a custom stack-trace formatter) \u2014 allowed unless the SAME write also mentions a test-file identifier string and an if/switch, which ordinary error-reporting code does not."
      - "Ordinary CLI argument parsing (process.argv.slice(2), an if/switch chain for --verbose/--help) \u2014 allowed unless the same write also references .test./.spec./__tests__/currentTestName/testPath, which a normal CLI parser has no reason to."
      - "The extremely common require.main === module / import.meta.url entrypoint-detection idiom (am I the module Node executed directly, or was I imported) \u2014 allowed unless the same write also carries a test-file identifier string and a branch, which a plain entrypoint check does not."
      - "A legitimate custom jest matcher (expect.extend) reading expect.getState().currentTestName for a diagnostic message, combined with an unrelated if elsewhere in the same matchers file \u2014 this rule cannot distinguish 'branches the assertion logic' (legitimate matcher authoring) from 'branches the return value to satisfy two contradictory tests' (gaming); both match. This is the class's most plausible false-fire and is exactly why the rule ships at confidence: low."
      - "A test-infrastructure or fixtures file that legitimately combines __dirname or import.meta with a __tests__/.test. path constant AND an unrelated if statement anywhere else in the same file for other reasons \u2014 the three signals are ANDed by co-occurrence anywhere in the whole write, not by proximity or causal connection, so an unrelated combination in one file can still fire."
      - "An Edit call that carries no inline content scans the WHOLE existing file on disk, not just the diff being applied \u2014 a large legitimate file that happens to contain all three signals spread across unrelated functions (an error handler with Error().stack elsewhere in the same file as an unrelated __tests__ path constant and an unrelated if) can fire on an edit that touches neither of those regions."
    review_by: "2026-11-11"
    patterns:
      - regex: "^(?=[^]*(?:new[ ]+Error[(][)][.]stack|Error[(][)][.]stack|Error[.]captureStackTrace))(?=[^]*(?:[.]test[.]|[.]spec[.]|__tests__|currentTestName|testPath))(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"
      - regex: "^(?=[^]*process[.]argv)(?=[^]*(?:[.]test[.]|[.]spec[.]|__tests__|currentTestName|testPath))(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"
      - regex: "^(?=[^]*(?:require[.]main|module[.]parent|import[.]meta))(?=[^]*(?:[.]test[.]|[.]spec[.]|__tests__|currentTestName|testPath))(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"
      - regex: "^(?=[^]*expect[.]getState[(][)])(?=[^]*(?:(?<![A-Za-z0-9_])if(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])switch(?![A-Za-z0-9_])))"

  - id: test-before-commit
    type: verification
    mode: observe
    category: verification
    severity: medium
    confidence: medium
    rationale: >
      False-success research and do-not-ship consensus: hard-blocking a
      commit on "no test run since the last src/ edit" also catches WIP
      commits, docs-only commits, and fixture/data-only changes that merely
      happen to touch a path under src/. Observe mode measures this rule's
      real false-positive rate against live commit traffic before anyone
      lets it interrupt a commit.
    false_positives:
      - WIP commits
      - docs-only commits
      - fixture/data-only changes
    trigger:
      tools: [write, edit, apply_patch, WriteFile]
      path: "src/"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
    verification_window_seconds: 300
    action: warn
    message: "Source changes under src/ were committed without a passing test run in this session."
  - id: runaway-budget-tool-calls
    type: rate
    mode: observe
    category: workflow
    severity: low
    confidence: high
    rationale: >
      Budget-model precedent (Cloudflare WAF log mode, OPA Gatekeeper
      dryrun): total tool-call volume in a long window is a coarse proxy for
      a runaway loop or scope-creep session. Observe mode measures the real
      hit rate against legitimate long sessions before this ever interrupts
      anyone. Token budgets are not visible to keel's enforcement hook and
      are intentionally NOT modeled by this rule.
    false_positives:
      - long legitimate refactors
      - batch operations
    match: ".*"
    window_seconds: 14400
    max_calls: 500
    action: warn
    message: "More than 500 tool calls in this session's last 4 hours \u2014 possible runaway loop or scope creep."

  - id: runaway-budget-bash-calls
    type: rate
    mode: observe
    category: workflow
    severity: low
    confidence: high
    rationale: >
      Same budget-model precedent as runaway-budget-tool-calls, scoped to
      Bash specifically: a runaway shell loop can stay under the total
      tool-call ceiling while still hammering the shell. Observe mode
      measures the real hit rate before this interrupts anyone. Token
      budgets are not visible to keel and are intentionally NOT modeled.
    false_positives:
      - long legitimate refactors
      - batch operations
    match: "Bash"
    window_seconds: 14400
    max_calls: 500
    action: warn
    message: "More than 500 Bash calls in this session's last 4 hours \u2014 possible runaway loop or scope creep."

`;
function ensureRules() {
  try {
    if (!fs.existsSync(RULES_PATH)) {
      fs.mkdirSync(KEEL_DIR, { recursive: true });
      fs.writeFileSync(RULES_PATH, DEFAULT_RULES_YAML, "utf8");
    }
  } catch {
  }
}
function isDisabled() {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return false;
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, "utf8"));
    if (state.expires_at && new Date(state.expires_at) < /* @__PURE__ */ new Date()) {
      fs.rmSync(DISABLED_PATH, { force: true });
      return false;
    }
    return true;
  } catch {
    sentinelCorrupted = true;
    try {
      record({ event: "corrupt-kill-switch-fail-closed", message: "Invalid keel kill-switch state; enforcement stays ON until " + DISABLED_PATH + " is fixed or removed" });
    } catch {
    }
    return false;
  }
}
function isHalted() {
  let raw;
  try {
    raw = fs.readFileSync(HALTED_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { halted: false, reason: "" };
    return { halted: true, reason: "unable to confirm halt state" };
  }
  try {
    const state = JSON.parse(raw);
    const reason = typeof state?.reason === "string" && state.reason ? state.reason : "Manual halt";
    return { halted: true, reason };
  } catch {
    return { halted: true, reason: "unknown (corrupt sentinel)" };
  }
}
function consumeRestartDisable() {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return;
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, "utf8"));
    if (state.auto_enable_on_restart && !state.expires_at) fs.rmSync(DISABLED_PATH, { force: true });
  } catch {
  }
}
function record(entry) {
  try {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
    const now = /* @__PURE__ */ new Date();
    fs.appendFileSync(path.join(TRACES_DIR, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({
      t: Date.now(),
      timestamp: now.toISOString(),
      agent: "opencode-plugin",
      ...entry
    })}
`);
  } catch {
  }
}
function requirementLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).filter((line) => line && !line.startsWith("[") && !line.startsWith("<!--"));
  } catch {
    return [];
  }
}
var turnCounters = /* @__PURE__ */ new Map();
var lastActiveSession = "unknown";
function currentTurn(sessionId) {
  return turnCounters.get(sessionId) ?? 0;
}
function advanceTurn(sessionId) {
  turnCounters.set(sessionId, (turnCounters.get(sessionId) ?? 0) + 1);
}
function toEnforceInput(tool, args, hookInput, level, cwd) {
  const sessionId = hookInput?.sessionID || "unknown";
  lastActiveSession = sessionId;
  return {
    tool,
    args,
    cwd,
    session_id: sessionId,
    turn_number: currentTurn(sessionId),
    context_tokens: 0,
    level,
    depth: level === "protect" ? "deep" : level === "sprint" ? "fast" : "full",
    context: "local",
    agent: "opencode",
    subagent_of: null,
    ...hookInput?.reasoning ? { reasoning: String(hookInput.reasoning) } : {}
  };
}
function applyFix(args, result) {
  const fixed = result.fix_result?.fixed;
  if (typeof fixed === "string" && typeof args.command === "string") args.command = fixed;
}
function worktreeFingerprint(directory, sourcePath) {
  if (!sourcePath) return null;
  try {
    const diff = spawnSync("git", ["-C", directory, "diff", "--binary", "HEAD", "--", sourcePath], { encoding: "utf8" });
    const untracked = spawnSync("git", ["-C", directory, "ls-files", "--others", "--exclude-standard", "--", sourcePath], { encoding: "utf8" });
    if (diff.status !== 0 || untracked.status !== 0) return null;
    let content = `${diff.stdout}
${untracked.stdout}`;
    for (const relative of untracked.stdout.split("\n").filter(Boolean)) {
      try {
        content += `
${relative}
${fs.readFileSync(path.join(directory, relative), "utf8")}`;
      } catch {
      }
    }
    return content;
  } catch {
    return null;
  }
}
var plugin_default = {
  id: "keel-enforce",
  server: async (pluginInput) => {
    ensureRules();
    const directory = pluginInput?.directory || process.cwd();
    const client = pluginInput?.client;
    let hierarchy = loadRuleHierarchy(directory);
    let ruleErrors = [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local].flatMap((source) => source ? [...source.errors || [], ...validateRules(source.rules)] : []);
    const logError = (event, errors) => {
      try {
        record({ event, errors, directory });
      } catch {
      }
      try {
        client?.app?.log?.({ body: { service: "keel", level: "error", message: `[Keel] ${event}: ${errors.join("; ")}` } });
      } catch {
      }
    };
    if (ruleErrors.length) {
      if (process.env.KEEL_STRICT === "1") {
        throw new Error(`[Keel] Invalid Keel rules (KEEL_STRICT=1): ${ruleErrors.join("; ")}`);
      }
      logError("invalid-rules-fallback-to-defaults", ruleErrors);
      hierarchy = { global: parseRulesContent(DEFAULT_RULES_YAML, "keel:defaults"), user: null, project: null, local: null };
      ruleErrors = [];
    }
    let level = hierarchy.project?.config.level || hierarchy.global?.config.level || "balanced";
    let activeHierarchy = hierarchy;
    let verificationIds = /* @__PURE__ */ new Set();
    let verificationBaselines = /* @__PURE__ */ new Map();
    const refreshVerificationMetadata = (nextHierarchy) => {
      activeHierarchy = nextHierarchy;
      level = nextHierarchy.project?.config.level || nextHierarchy.global?.config.level || "balanced";
      verificationIds = new Set([
        ...nextHierarchy.global?.rules || [],
        ...nextHierarchy.project?.rules || [],
        ...nextHierarchy.local?.rules || []
      ].filter((rule) => rule.type === "verification").map((rule) => rule.id));
      const nextBaselines = /* @__PURE__ */ new Map();
      for (const rule of [...nextHierarchy.global?.rules || [], ...nextHierarchy.project?.rules || [], ...nextHierarchy.local?.rules || []]) {
        if (rule.type === "verification") nextBaselines.set(rule.id, worktreeFingerprint(directory, rule.trigger?.path));
      }
      verificationBaselines = nextBaselines;
    };
    refreshVerificationMetadata(hierarchy);
    const pipeline = new EnforcementPipeline({
      level,
      context: "local",
      cache: new ActionCache({ maxSize: 1e3 }),
      contentTracker: new ContentTracker(),
      sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(),
      ruleHierarchy: hierarchy,
      ruleVersion: 1,
      allowedFixTransforms: true,
      stateManager: new StateManager(),
      stuckTracker: new StuckTracker(),
      researchTracker: new ResearchTracker(),
      reloadRules: () => loadRuleHierarchy(directory),
      ruleFingerprint: () => [
        path.join(directory, ".keel", "rules.yaml"),
        path.join(directory, "AGENTS.md"),
        path.join(directory, "CLAUDE.md"),
        path.join(directory, ".keel.local.yaml"),
        path.join(directory, "AGENTS.local.md"),
        path.join(directory, "CLAUDE.local.md"),
        RULES_PATH,
        path.join(HOME_DIR, ".config", "keel", "rules.yaml")
      ].map((source) => hashRulesFile(source)).join(":"),
      onRulesReload: refreshVerificationMetadata,
      onRulesError: (errors) => {
        logError("invalid-rules-reload-kept-last-known-good", errors);
      }
    });
    const verificationWarnings = /* @__PURE__ */ new Set();
    const surfacedWarnings = /* @__PURE__ */ new Set();
    const surfaceWarn = (ruleId, message, sessionID, once = true) => {
      const key = `${ruleId}:${sessionID || "unknown"}`;
      if (once) {
        if (surfacedWarnings.has(key)) return;
        surfacedWarnings.add(key);
      }
      try {
        client?.app?.log?.({
          body: {
            service: "keel",
            level: "warn",
            message: `[Keel] ${ruleId}: ${message}`,
            extra: { rule_id: ruleId, session_id: sessionID }
          }
        });
      } catch {
      }
    };
    const refreshExternalChanges = async () => {
      for (const rule of [...activeHierarchy.global?.rules || [], ...activeHierarchy.project?.rules || [], ...activeHierarchy.local?.rules || []]) {
        if (rule.type !== "verification" || !rule.trigger?.path) continue;
        const current = worktreeFingerprint(directory, rule.trigger.path);
        const baseline = verificationBaselines.get(rule.id);
        if (current && baseline && current !== baseline) {
          verificationBaselines.set(rule.id, current);
          const tool = rule.trigger.tools?.[0] || rule.trigger.tool || "WriteFile";
          await pipeline.evaluate(toEnforceInput(tool, { path: rule.trigger.path, content: rule.trigger.path }, pluginInput, level, directory));
        }
      }
    };
    const requirementSources = [REQUIREMENTS_PATH, path.join(directory, ".keel", "requirements.md")].filter((source, index, all) => all.indexOf(source) === index);
    consumeRestartDisable();
    const pendingSyntaxFindings = /* @__PURE__ */ new Map();
    const verifyEdit = async (tool, args, sessionID, turn) => {
      if (!EDIT_TOOLS.has(String(tool).toLowerCase())) return;
      const raw = String(args.filePath || args.path || args.file || "");
      if (!raw) return;
      const target = path.isAbsolute(raw) ? raw : path.join(directory, raw);
      if (!isVerifiableFile(target) || !fs.existsSync(target)) return;
      const detail = await verifyFileSyntax(target);
      if (!detail) return;
      const message = `${path.basename(target)} has a syntax error after your edit: ${detail}`;
      const key = sessionID || "unknown";
      const queue = pendingSyntaxFindings.get(key);
      if (queue) queue.push(message);
      else pendingSyntaxFindings.set(key, [message]);
      record({ session_id: sessionID, turn_number: turn, tool, args: { path: target }, rule_id: "post-edit-syntax", action: "warn", message, hook: "tool.execute.after", cwd: directory });
    };
    const scanForRedaction = async (text, sessionID, tool) => {
      if (!text) return null;
      const scanInput = toEnforceInput(tool || "unknown", {}, { sessionID }, level, directory);
      scanInput.tool_output = text;
      const result = await pipeline.evaluateOutput(scanInput);
      return result.action === "redact" && result.redacted_output ? result : null;
    };
    const recordRedaction = (result, sessionID, turn, tool) => {
      record({
        session_id: sessionID,
        turn_number: turn,
        tool,
        args: {},
        rule_id: result.rule_id,
        action: "redact",
        message: result.message,
        redacted_rule_ids: result.redacted_rule_ids,
        hook: "tool.execute.after",
        cwd: directory
      });
    };
    const recordRedactionScanFailure = (error, sessionID, turn, tool) => {
      record({
        session_id: sessionID,
        turn_number: turn,
        tool,
        args: {},
        rule_id: "redaction-scan-failed",
        action: "redaction-scan-failed",
        message: `Output redaction scan threw and was skipped \u2014 output shipped unredacted (fail-open): ${error instanceof Error ? error.message : String(error)}`,
        hook: "tool.execute.after",
        cwd: directory
      });
    };
    const FIELD_SEP = "\0KEEL-FIELD-SEP\0";
    const redactToolOutput = async (input, output, turn) => {
      if (isDisabled()) return;
      if (!output || typeof output !== "object") return;
      if (typeof output.output === "string" && output.output) {
        const result2 = await scanForRedaction(output.output, input?.sessionID, input?.tool);
        if (result2) {
          output.output = result2.redacted_output;
          recordRedaction(result2, input?.sessionID, turn, input?.tool);
        }
      }
      const smallFields = [];
      const smallValues = [];
      if (typeof output.title === "string" && output.title) {
        smallFields.push({ path: "title" });
        smallValues.push(output.title);
      }
      if (output.metadata && typeof output.metadata === "object") {
        for (const key of Object.keys(output.metadata)) {
          const value = output.metadata[key];
          if (typeof value === "string" && value) {
            smallFields.push({ path: "metadata", key });
            smallValues.push(value);
          }
        }
      }
      if (!smallValues.length) return;
      const joined = smallValues.join(FIELD_SEP);
      const result = await scanForRedaction(joined, input?.sessionID, input?.tool);
      if (!result) return;
      const parts = result.redacted_output.split(FIELD_SEP);
      if (parts.length !== smallFields.length) return;
      smallFields.forEach((field, i) => {
        if (field.path === "title") output.title = parts[i];
        else output.metadata[field.key] = parts[i];
      });
      recordRedaction(result, input?.sessionID, turn, input?.tool);
    };
    const before = async (input, output) => {
      const halt = isHalted();
      if (halt.halted) {
        const haltArgs = projectAuditArgs(output?.args || {});
        const message = `Keel is HALTED: ${halt.reason}. Run 'keel resume' to clear.`;
        record({ session_id: input?.sessionID, turn_number: 0, tool: input?.tool, args: haltArgs, rule_id: "keel-halted", action: "deny", message, hook: "tool.execute.before" });
        try {
          createReceipt("opencode-plugin", input?.tool || "unknown", haltArgs, "deny", "keel-halted", "keel", input?.sessionID);
        } catch {
        }
        throw new Error(`[Keel] keel-halted: ${message}`);
      }
      if (isDisabled()) return;
      if (sentinelCorrupted) {
        sentinelCorrupted = false;
        surfaceWarn("corrupt-kill-switch", "Invalid keel kill-switch state (DISABLED) detected \u2014 enforcement stays ON. Fix or delete ~/.keel/DISABLED to clear this.", input?.sessionID);
      }
      if (level === "sprint") surfaceWarn("dial-sprint", "Sprint dial is active: deny rules warn only. Protect-floor content/sequence/flow checks (e.g. no-exfil-flow) stay fully active regardless of the dial \u2014 only non-floor checks are relaxed.", input?.sessionID);
      await refreshExternalChanges();
      const syntaxKey = input?.sessionID || "unknown";
      const syntaxFindings = pendingSyntaxFindings.get(syntaxKey);
      if (syntaxFindings && syntaxFindings.length) {
        pendingSyntaxFindings.delete(syntaxKey);
        surfaceWarn("post-edit-syntax", syntaxFindings.join(" \xB7 "), input?.sessionID, false);
      }
      const args = output?.args || {};
      if (typeof input?.tool !== "string" || input.tool === "") {
        const message = "No tool identity on this call \u2014 keel could not evaluate it, so it was blocked.";
        record({
          session_id: input?.sessionID,
          turn_number: 0,
          tool: input?.tool,
          args: projectAuditArgs(args),
          rule_id: "fail-closed-degenerate-input",
          action: "deny",
          message,
          hook: "tool.execute.before"
        });
        try {
          createReceipt("opencode-plugin", "unknown", projectAuditArgs(args), "deny", "fail-closed-degenerate-input", "keel", input?.sessionID);
        } catch {
        }
        throw new Error(`[Keel] fail-closed-degenerate-input: ${message}`);
      }
      const enforceInput = toEnforceInput(input.tool, args, input, level, directory);
      const result = await pipeline.evaluate(enforceInput);
      record({ session_id: input?.sessionID, turn_number: enforceInput.turn_number, tool: input?.tool, args: projectAuditArgs(args), rule_id: result.rule_id, action: result.action, observed_action: result.observed_action, observed_matches: result.observed_matches, message: result.message, hook: "tool.execute.before" });
      if (result.action === "warn" && result.rule_id) surfaceWarn(result.rule_id, result.message, input?.sessionID);
      if (result.action === "fix") applyFix(args, result);
      if (result.action === "warn" && result.rule_id && verificationIds.has(result.rule_id)) {
        const key = `${result.rule_id}:${directory}:${input?.sessionID || "unknown"}`;
        if (verificationWarnings.has(key)) {
          throw new Error(`[Keel] ${result.rule_id}: ${result.message}`);
        }
        verificationWarnings.add(key);
      }
      if (result.action === "deny" || result.action === "block" || result.action === "prompt") {
        try {
          createReceipt("opencode-plugin", input?.tool || "unknown", projectAuditArgs(args), result.action, result.rule_id || "unknown", "keel", input?.sessionID);
        } catch {
        }
        throw new Error(`[Keel] ${result.rule_id}: ${result.message}`);
      }
      if (result.action === "redirect") {
        const directive = result.redirect;
        const hint = directive?.suggested_call ? ` Try: ${directive.suggested_call}` : "";
        throw new Error(`[Keel] REDIRECT ${result.rule_id}: ${result.message}${hint}`);
      }
    };
    return {
      "tool.execute.before": async (input, output) => {
        try {
          await before(input, output);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("[Keel]")) throw error;
          throw new Error(`[Keel] Enforcement failed closed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      "tool.execute.after": async (input, output) => {
        try {
          const args = input?.args || {};
          const action = toEnforceInput(input?.tool || "unknown", args, input, level, directory);
          try {
            await redactToolOutput(input, output, action.turn_number);
          } catch (error) {
            recordRedactionScanFailure(error, input?.sessionID, action.turn_number, input?.tool);
          }
          const exit = output?.metadata?.exit === void 0 ? null : Number(output?.metadata?.exit);
          if (exit === 0) pipeline.markVerificationSatisfied(action);
          pipeline.recordAttemptOutcome(action, exit);
          record({ session_id: input?.sessionID, turn_number: action.turn_number, tool: input?.tool, args: projectAuditArgs(args), action: "allow", message: "Tool completed", hook: "tool.execute.after", exit, cwd: directory });
          await verifyEdit(input?.tool, args, input?.sessionID, action.turn_number);
        } catch {
        }
      },
      /**
       * Claim-to-evidence real reach (v0.4 Phase 1). `tool.execute.before`
       * only ever sees a synthetic `reasoning` field IF a host populates
       * `hookInput.reasoning` (toEnforceInput above) — surveyed and found
       * unpopulated by OpenCode's own PreToolUse-shaped `tool.execute.
       * before` input (see claim.ts's module doc). The channel that DOES
       * carry the agent's own completed output is this hook: confirmed by
       * a live probe (`opencode run` against a scratch repo with a logging
       * plugin, free model `opencode/deepseek-v4-flash-free`, see
       * session/v04/EVIDENCE/phase-1.md) that `output.text` on
       * `experimental.text.complete` is the FULL text of one completed
       * assistant text segment — not a delta, not the model's internal
       * `reasoning`-type part (which never triggers this hook), and it
       * fires strictly after any `tool.execute.after` calls already made
       * in the same turn (so a satisfy command that already ran is
       * reflected in the VerificationTracker's pending state by the time
       * this checks it).
       *
       * Routed through `pipeline.evaluateClaim()`, NOT `pipeline.
       * evaluate()`: the latter would treat one call per assistant
       * utterance as a phantom tool call for flow/sequence/rate state —
       * see evaluateClaim()'s own header comment in pipeline.ts for why
       * that would corrupt the exact trace-derived counters (runaway-
       * budget, stuck-loop) the v0.4 thesis experiment measures in the
       * guarded arm. `evaluateClaim()` only ever touches `type: claim`
       * rules and the same VerificationTracker pending state `type:
       * verification` rules already share.
       */
      "experimental.text.complete": async (input, output) => {
        try {
          if (isDisabled()) return;
          const text = typeof output?.text === "string" ? output.text : "";
          if (!text) return;
          const enforceInput = toEnforceInput("assistant-message", {}, input, level, directory);
          enforceInput.reasoning = text;
          const result = await pipeline.evaluateClaim(enforceInput);
          if (result.observed_matches?.length) {
            record({
              session_id: input?.sessionID,
              turn_number: enforceInput.turn_number,
              tool: "assistant-message",
              args: {},
              rule_id: result.rule_id,
              action: result.action,
              observed_action: result.observed_action,
              observed_matches: result.observed_matches,
              message: result.message,
              hook: "experimental.text.complete",
              cwd: directory
            });
          }
        } catch {
        }
      },
      "experimental.chat.system.transform": async (input, output) => {
        try {
          advanceTurn(input?.sessionID || lastActiveSession);
          const blocks = requirementSources.map(requirementLines).filter((lines2) => lines2.length);
          if (blocks.length) {
            output.system ||= [];
            output.system.push(...blocks.map((lines2) => `Standing Requirements (mandatory):
${lines2.map((line) => `- ${line}`).join("\n")}`));
          }
        } catch {
        }
      },
      "experimental.session.compacting": async (_input, output) => {
        try {
          const lines2 = requirementSources.flatMap(requirementLines);
          if (lines2.length) {
            output.context ||= [];
            output.context.push(`## Standing Requirements (survive compaction)
${lines2.map((line) => `- ${line}`).join("\n")}`);
          }
        } catch {
        }
      }
    };
  }
};
export {
  DEFAULT_RULES_YAML,
  plugin_default as default
};
