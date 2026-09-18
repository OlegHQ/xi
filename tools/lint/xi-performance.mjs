import { readFileSync } from 'node:fs';

const budgets = new Set(JSON.parse(readFileSync(new URL('../../docs/plan/performance-budgets.json', import.meta.url), 'utf8')).budgets.map(row => row.id));
const codes = new Set(['allocation', 'strings', 'sync', 'materialize', 'microtask', 'segmenter']);
const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const loops = new Set(['ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement']);
const iterations = new Set(['map', 'filter', 'flatMap', 'forEach', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex']);
const allocatingMethods = new Set(['map', 'filter', 'flatMap', 'flat', 'slice', 'split', 'concat', 'join', 'substring', 'substr', 'replace', 'replaceAll', 'match', 'matchAll', 'toArray', 'from', 'of', 'entries', 'keys', 'values', 'bind', 'repeat', 'toString', 'fromCharCode', 'fromCodePoint', 'normalize', 'toLowerCase', 'toUpperCase']);
const stringMethods = new Set(['getText', 'readAll', 'getLine', 'lineText', 'slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'toString', 'normalize', 'toLowerCase', 'toUpperCase', 'String']);
const arrayMethods = new Set(['push', 'unshift', 'splice']);
function memberName(node) {
  return node?.type === 'MemberExpression'
    ? node.computed ? node.property.value : node.property.name
    : node?.type === 'Identifier' ? node.name : undefined;
}
function isIntlSegmenterConstructor(callee) {
  return callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier' && callee.object.name === 'Intl'
    && !callee.computed && callee.property?.name === 'Segmenter';
}
function hasGranularityOption(args) {
  return args.some(argument => argument.type === 'ObjectExpression'
    && argument.properties.some(property => property.type === 'Property' && !property.computed
      && (property.key?.name === 'granularity' || property.key?.value === 'granularity')));
}

export default {
  meta: { name: 'xi' },
  rules: {
    performance: {
      meta: { type: 'problem', schema: [{ type: 'object', properties: { class: { enum: ['H0', 'H1', 'B', 'C'] } }, additionalProperties: false }] },
      create(context) {
        const source = context.sourceCode;
        const defaultClass = context.options[0]?.class ?? 'C';
        const classes = [];
        const exceptions = new Map();
        const consumed = new Set();
        const annotations = new Set();
        const knownStrings = new WeakSet();
        const knownArrays = new WeakSet();
        const arrayDeclarationLoops = new WeakMap();
        const growingArrays = new Map();
        const comments = source.getAllComments();
        const report = (node, message) => context.report({ node, message });
        function emit(node, code, message) {
          const key = `${node.loc.start.line}:${code}`;
          if (exceptions.has(key)) { consumed.add(key); return; }
          report(node, `[${code}] ${message}`);
        }
        function currentClass() { return classes.at(-1) ?? defaultClass; }
        function inLoop(node) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (loops.has(parent.type)) return true;
            if (functions.has(parent.type)) return parent.parent?.type === 'CallExpression' && iterations.has(memberName(parent.parent.callee));
          }
          return false;
        }
        function variableAt(node, name) {
          if (typeof name !== 'string') return undefined;
          let scope = source.getScope(node);
          while (scope) {
            const variable = scope.set.get(name);
            if (variable) return variable;
            scope = scope.upper;
          }
          return undefined;
        }
        function typeAnnotation(variable) {
          const definition = variable?.defs?.[0]?.node;
          return definition?.id?.typeAnnotation?.typeAnnotation;
        }
        function stringAnnotation(annotation) {
          if (!annotation) return false;
          if (annotation.type === 'TSStringKeyword') return true;
          if (annotation.type === 'TSParenthesizedType') return stringAnnotation(annotation.typeAnnotation);
          return annotation.type === 'TSUnionType' && annotation.types.every(stringAnnotation);
        }
        function arrayAnnotation(annotation) {
          if (!annotation) return false;
          if (annotation.type === 'TSArrayType') return true;
          if (annotation.type === 'TSTypeReference') {
            const name = annotation.typeName?.name;
            return name === 'Array' || name === 'ReadonlyArray';
          }
          if (annotation.type === 'TSParenthesizedType') return arrayAnnotation(annotation.typeAnnotation);
          return false;
        }
        function expressionIsString(node, seen = new Set()) {
          if (!node) return false;
          if (node.type === 'Literal') return typeof node.value === 'string';
          if (node.type === 'TemplateLiteral') return true;
          if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion') {
            return expressionIsString(node.expression, seen) || stringAnnotation(node.typeAnnotation?.typeAnnotation);
          }
          if (node.type === 'BinaryExpression' && node.operator === '+') {
            return expressionIsString(node.left, seen) || expressionIsString(node.right, seen);
          }
          if (node.type === 'ConditionalExpression') {
            return expressionIsString(node.consequent, seen) && expressionIsString(node.alternate, seen);
          }
          if (node.type === 'LogicalExpression') {
            return expressionIsString(node.left, seen) && expressionIsString(node.right, seen);
          }
          if (node.type === 'CallExpression') {
            return stringMethods.has(memberName(node.callee));
          }
          if (node.type === 'Identifier') {
            const variable = variableAt(node, node.name);
            if (!variable || seen.has(variable)) return knownStrings.has(variable);
            seen.add(variable);
            return knownStrings.has(variable) || stringAnnotation(typeAnnotation(variable))
              || expressionIsString(variable.defs?.[0]?.node?.init, seen);
          }
          return false;
        }
        function markVariableKinds(node) {
          if (node.id?.type !== 'Identifier') return;
          const variable = variableAt(node, node.id.name);
          if (!variable) return;
          if (stringAnnotation(typeAnnotation(variable)) || expressionIsString(node.init)) knownStrings.add(variable);
          if (arrayAnnotation(typeAnnotation(variable)) || node.init?.type === 'ArrayExpression') {
            knownArrays.add(variable);
            arrayDeclarationLoops.set(variable, loopOwner(node));
          }
        }
        function loopOwner(node) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (loops.has(parent.type)) return parent;
            if (functions.has(parent.type)) {
              const call = parent.parent;
              if (call?.type === 'CallExpression' && iterations.has(memberName(call.callee))) return call;
              return undefined;
            }
          }
          return undefined;
        }
        function arrayVariable(node) {
          if (node?.type !== 'MemberExpression' || node.object?.type !== 'Identifier') return undefined;
          return variableAt(node, node.object.name);
        }
        function arrayGrowsInLoop(variable, loop) {
          for (let current = loop; current; current = loopOwner(current)) {
            if (growingArrays.get(current)?.has(variable)) return true;
          }
          return false;
        }
        function returnsBeforeLoop(node, loop) {
          for (let parent = node.parent; parent && parent !== loop; parent = parent.parent) {
            if (parent.type === 'ReturnStatement') return true;
          }
          return false;
        }
        function enterFunction(node) {
          let kind = currentClass();
          if (node.body.type === 'BlockStatement') {
            const start = node.body.range[0] + 1;
            const comment = comments.find(item => item.range[0] >= start && /^\s*$/.test(source.text.slice(start, item.range[0])));
            if (comment?.value.trim().startsWith('@xi-perf ')) {
              annotations.add(comment);
              const match = /^@xi-perf (H0|H1|B|C) ([A-Z0-9-]+) -- (\S[^\n]*\S)$/.exec(comment.value.trim());
              if (!match || !budgets.has(match[2]) || match[3].length < 20) {
                report(comment, 'Use @xi-perf CLASS BUDGET-ID -- concrete reason (at least 20 characters).');
              } else kind = match[1];
            }
          }
          classes.push(kind);
          if (node.async && kind === 'H0') emit(node, 'sync', 'H0 kernels must be synchronous.');
        }
        function allocation(node) {
          if (currentClass() === 'H0' && inLoop(node)) emit(node, 'allocation', 'H0 loop creates temporary storage/closure; use bounded private scratch or justify this allocation.');
        }
        function newExpression(node) {
          allocation(node);
          if (classes.length > 0 && (isIntlSegmenterConstructor(node.callee) || hasGranularityOption(node.arguments))) {
            emit(node, 'segmenter', 'Segmenter-class constructors are expensive to initialize; construct once at module scope and reuse, not per call inside a function body.');
          }
        }
        return {
          Program() {
            for (const comment of comments) {
              if (!comment.value.includes('@xi-perf-allow')) continue;
              const match = /^@xi-perf-allow ([a-z]+) ([A-Z0-9-]+) -- (\S[^\n]*\S)$/.exec(comment.value.trim());
              if (!match || !codes.has(match[1]) || !budgets.has(match[2]) || match[3].length < 20 || comment.type !== 'Line') {
                report(comment, 'Exception requires one known code, catalog budget and concrete reason (20+ characters), in a // comment.');
                continue;
              }
              const key = `${comment.loc.end.line + 1}:${match[1]}`;
              if (exceptions.has(key)) report(comment, 'Duplicate performance exception.');
              exceptions.set(key, comment);
            }
          },
          'Program:exit'() {
            for (const [key, comment] of exceptions) if (!consumed.has(key)) report(comment, 'Unused performance exception; remove it or place it immediately before the offending line.');
            for (const comment of comments) if (comment.value.includes('@xi-perf ') && !annotations.has(comment)) report(comment, 'Place @xi-perf as the first comment inside a function body.');
          },
          FunctionDeclaration(node) { allocation(node); enterFunction(node); },
          FunctionExpression(node) { allocation(node); enterFunction(node); },
          ArrowFunctionExpression(node) { allocation(node); enterFunction(node); },
          VariableDeclarator: markVariableKinds,
          'FunctionDeclaration:exit'() { classes.pop(); },
          'FunctionExpression:exit'() { classes.pop(); },
          'ArrowFunctionExpression:exit'() { classes.pop(); },
          ObjectExpression: allocation,
          ArrayExpression: allocation,
          NewExpression: newExpression,
          SpreadElement: allocation,
          TemplateLiteral(node) { if (node.expressions.length) allocation(node); },
          Literal(node) { if (node.regex) allocation(node); },
          BinaryExpression(node) {
            if (node.operator === '+' && (typeof node.left.value === 'string' || typeof node.right.value === 'string')) allocation(node);
          },
          AwaitExpression(node) { if (currentClass() === 'H0') emit(node, 'sync', 'H0 kernels cannot await.'); },
          CallExpression(node) {
            const name = memberName(node.callee);
            const kind = currentClass();
            if (kind === 'H0' && allocatingMethods.has(name)) {
              if (iterations.has(name)) emit(node, 'allocation', 'H0 collection transforms allocate output per traversal; use bounded scratch or explain the bound.');
              else allocation(node);
            }
            if ((kind === 'H0' || kind === 'H1') && typeof name === 'string' && /Sync$/.test(name)) emit(node, 'sync', 'Synchronous IO/process calls do not belong in interactive operations.');
            if ((kind === 'H0' || kind === 'H1') && ['getText', 'readAll', 'getLine', 'lineText'].includes(name)) emit(node, 'materialize', 'Review allocating text/line materialization; use bounded document windows or explain the bound.');
            if (kind !== 'C' && name === 'queueMicrotask') emit(node, 'microtask', 'Microtasks are not CPU isolation; use budgeted task-queue slices or a worker.');
            const loop = loopOwner(node);
            const variable = arrayVariable(node.callee);
            if (loop && variable && knownArrays.has(variable)) {
              if (arrayMethods.has(name)) {
                for (let current = loop; current; current = loopOwner(current)) {
                  let set = growingArrays.get(current);
                  if (!set) { set = new Set(); growingArrays.set(current, set); }
                  set.add(variable);
                }
              } else if (name === 'join' && ['H0', 'H1'].includes(kind) && arrayGrowsInLoop(variable, loop) && arrayDeclarationLoops.get(variable) !== loop && !returnsBeforeLoop(node, loop)) {
                emit(node, 'strings', 'Repeated join of a loop-grown local array rebuilds the accumulated string; join once after the loop or use a bounded representation.');
              }
            }
          },
          AssignmentExpression(node) {
            if (!['H0', 'H1'].includes(currentClass()) || !inLoop(node)) return;
            // Scope analysis distinguishes string accumulation from ordinary numeric +=.
            const name = node.left.type === 'Identifier' ? node.left.name : undefined;
            const variable = variableAt(node, name);
            const stringLike = variable !== undefined && (knownStrings.has(variable) || expressionIsString(variable.defs?.[0]?.node?.init) || stringAnnotation(typeAnnotation(variable)));
            if (stringLike && (node.operator === '+=' || (node.operator === '=' && ['BinaryExpression', 'TemplateLiteral'].includes(node.right.type)))) emit(node, 'strings', 'Repeated string rebuilding in an interactive loop needs a bounded representation or explicit justification.');
          },
        };
      },
    },
  },
};
