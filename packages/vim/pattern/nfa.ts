import { PatternEvaluationError, type PatternNode, type PatternProgram } from './types';

export type NfaInstruction =
  | { kind: 'jump'; next: number; source: PatternNode['source'] }
  | { kind: 'split'; first: number; second: number; source: PatternNode['source'] }
  | { kind: 'character'; atom: Extract<PatternNode, { kind: 'literal' | 'dot' | 'character-class' }>; next: number; source: PatternNode['source'] }
  | { kind: 'anchor'; atom: Extract<PatternNode, { kind: 'anchor' }>; next: number; source: PatternNode['source'] }
  | { kind: 'capture-start'; group: number; next: number; source: PatternNode['source'] }
  | { kind: 'capture-end'; group: number; next: number; source: PatternNode['source'] }
  | { kind: 'reported-start'; next: number; source: PatternNode['source'] }
  | { kind: 'reported-end'; next: number; source: PatternNode['source'] }
  | { kind: 'match'; source: PatternNode['source'] };

export interface NfaProgram {
  readonly instructions: readonly NfaInstruction[];
  readonly start: number;
}

interface PatchPoint {
  readonly instruction: number;
  readonly slot: 'next' | 'first' | 'second';
}

interface Fragment {
  readonly start: number;
  readonly out: readonly PatchPoint[];
}

const maximumNfaInstructions = 100_000;
const maximumExpandedRepetitions = 4_096;

/** Compile the regular AST to an ordered Thompson NFA. */
export function compileNfa(program: PatternProgram): NfaProgram {
  const compiler = new NfaCompiler(program);
  return compiler.compile();
}

class NfaCompiler {
  private readonly instructions: NfaInstruction[] = [];

  constructor(private readonly program: PatternProgram) {}

  compile(): NfaProgram {
    const fragment = this.node(this.program.root);
    const match = this.emit({ kind: 'match', source: this.program.root.source });
    this.patch(fragment.out, match);
    return Object.freeze({ instructions: Object.freeze(this.instructions.map((instruction) => Object.freeze(instruction))), start: fragment.start });
  }

  private node(node: PatternNode): Fragment {
    switch (node.kind) {
      case 'empty':
        return this.unconditional(node.source);
      case 'literal':
      case 'dot':
      case 'character-class': {
        const index = this.emit({ kind: 'character', atom: node, next: -1, source: node.source });
        return { start: index, out: [{ instruction: index, slot: 'next' }] };
      }
      case 'anchor': {
        const index = this.emit({ kind: 'anchor', atom: node, next: -1, source: node.source });
        return { start: index, out: [{ instruction: index, slot: 'next' }] };
      }
      case 'capture': {
        const first = this.emit({ kind: 'capture-start', group: node.group, next: -1, source: node.source });
        const child = this.node(node.child);
        this.patch([{ instruction: first, slot: 'next' }], child.start);
        const last = this.emit({ kind: 'capture-end', group: node.group, next: -1, source: node.source });
        this.patch(child.out, last);
        return { start: first, out: [{ instruction: last, slot: 'next' }] };
      }
      case 'sequence': {
        if (node.terms.length === 0) return this.unconditional(node.source);
        let result = this.node(node.terms[0] ?? { kind: 'empty', source: node.source });
        for (let index = 1; index < node.terms.length; index += 1) {
          const nextNode = node.terms[index];
          if (nextNode === undefined) continue;
          const next = this.node(nextNode);
          this.patch(result.out, next.start);
          result = { start: result.start, out: next.out };
        }
        return result;
      }
      case 'alternate': {
        const branches = node.branches.map((branch) => this.node(branch));
        let result = branches.at(-1);
        if (result === undefined) return this.unconditional(node.source);
        for (let index = branches.length - 2; index >= 0; index -= 1) {
          const first = branches[index];
          if (first === undefined) continue;
          const split = this.emit({ kind: 'split', first: first.start, second: result.start, source: node.source });
          result = { start: split, out: [...first.out, ...result.out] };
        }
        return result;
      }
      case 'repeat':
        return this.repeat(node);
      case 'set-start': {
        const index = this.emit({ kind: 'reported-start', next: -1, source: node.source });
        return { start: index, out: [{ instruction: index, slot: 'next' }] };
      }
      case 'set-end': {
        const index = this.emit({ kind: 'reported-end', next: -1, source: node.source });
        return { start: index, out: [{ instruction: index, slot: 'next' }] };
      }
      case 'backreference':
      case 'assertion':
      case 'intersection':
      case 'optional-sequence':
      case 'skip-combining':
        throw new PatternEvaluationError('unsupported-construct', `nfa-received-nonregular-node: ${node.kind}`, 0, node.source);
      default:
        return unreachable(node);
    }
  }

  private repeat(node: Extract<PatternNode, { kind: 'repeat' }>): Fragment {
    if (node.minimum > maximumExpandedRepetitions || (node.maximum !== null && node.maximum > maximumExpandedRepetitions)) {
      throw new PatternEvaluationError(
        'program-limit-exceeded',
        `nfa-repeat-expansion-exceeded: ${maximumExpandedRepetitions}`,
        0,
        node.source,
      );
    }

    let result: Fragment | undefined;
    for (let count = 0; count < node.minimum; count += 1) {
      const required = this.node(node.child);
      result = result === undefined ? required : this.concatenate(result, required);
    }

    if (node.maximum === null) {
      const child = this.node(node.child);
      const split = node.greedy
        ? this.emit({ kind: 'split', first: child.start, second: -1, source: node.source })
        : this.emit({ kind: 'split', first: -1, second: child.start, source: node.source });
      this.patch(child.out, split);
      const star: Fragment = {
        start: split,
        out: [{ instruction: split, slot: node.greedy ? 'second' : 'first' }],
      };
      return result === undefined ? star : this.concatenate(result, star);
    }

    for (let count = node.minimum; count < node.maximum; count += 1) {
      const child = this.node(node.child);
      const split = node.greedy
        ? this.emit({ kind: 'split', first: child.start, second: -1, source: node.source })
        : this.emit({ kind: 'split', first: -1, second: child.start, source: node.source });
      const optional: Fragment = {
        start: split,
        out: [...child.out, { instruction: split, slot: node.greedy ? 'second' : 'first' }],
      };
      result = result === undefined ? optional : this.concatenate(result, optional);
    }

    return result ?? this.unconditional(node.source);
  }

  private concatenate(left: Fragment, right: Fragment): Fragment {
    this.patch(left.out, right.start);
    return { start: left.start, out: right.out };
  }

  private unconditional(source: PatternNode['source']): Fragment {
    const index = this.emit({ kind: 'jump', next: -1, source });
    return { start: index, out: [{ instruction: index, slot: 'next' }] };
  }

  private emit(instruction: NfaInstruction): number {
    if (this.instructions.length >= maximumNfaInstructions) {
      throw new PatternEvaluationError(
        'program-limit-exceeded',
        `nfa-instruction-limit-exceeded: ${maximumNfaInstructions}`,
        0,
        instruction.source,
      );
    }
    const index = this.instructions.length;
    this.instructions.push(instruction);
    return index;
  }

  private patch(points: readonly PatchPoint[], target: number): void {
    for (const point of points) {
      const instruction = this.instructions[point.instruction];
      if (instruction === undefined) throw new Error('nfa-patch-target-missing');
      if (instruction.kind === 'split') {
        if (point.slot === 'first') instruction.first = target;
        else if (point.slot === 'second') instruction.second = target;
        else throw new Error('nfa-invalid-split-patch-slot');
      } else if (point.slot === 'next' && instruction.kind !== 'match') {
        instruction.next = target;
      } else {
        throw new Error('nfa-invalid-patch-slot');
      }
    }
  }
}

function unreachable(value: never): never {
  throw new Error(`unreachable-nfa-node: ${String(value)}`);
}
