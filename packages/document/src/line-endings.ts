export type LineEnding = 'lf' | 'crlf' | 'cr' | 'ff' | 'nel';

type EndingCode = 0 | 1 | 2 | 3 | 4;
type Root = Node | null;

const MAX_BLOCK_LENGTH = 8192;

interface EolBlock {
  readonly length: number;
  readonly uniformCode: EndingCode | null;
  readonly packed: Uint8Array | null;
}

interface Node {
  readonly block: EolBlock;
  readonly priority: number;
  readonly left: Root;
  readonly right: Root;
  readonly size: number;
}

export interface LineEndingStorageMetrics {
  readonly lineBreaks: number;
  readonly blockCount: number;
  readonly uniformBlocks: number;
  readonly packedBlocks: number;
  readonly packedBytes: number;
  readonly structuralNodes: number;
  /** Approximate private metadata bytes, excluding the packed payload. */
  readonly structuralBytes: number;
  readonly retainedBytes: number;
}

export interface LineEndingReader {
  next(): LineEnding | undefined;
}

/**
 * Mutable only while constructing a sequence. It stores each three-bit ending
 * code densely, so normalization never creates one object or string record per line.
 */
export class LineEndingSequenceBuilder {
  #packed = new Uint8Array(0);
  #length = 0;
  #lfCount = 0;
  #crlfCount = 0;
  #crCount = 0;
  #ffCount = 0;
  #nelCount = 0;
  #firstCode: EndingCode | undefined;

  get length(): number { return this.#length; }

  push(value: LineEnding): void {
    const code = endingCode(value);
    if (code === undefined) throw new RangeError('invalid-line-ending');
    const bitOffset = this.#length * 3;
    const byteIndex = bitOffset >>> 3;
    if (byteIndex + ((bitOffset & 7) > 5 ? 1 : 0) >= this.#packed.length) {
      const nextLength = Math.max(byteIndex + ((bitOffset & 7) > 5 ? 2 : 1), Math.max(4, this.#packed.length * 2));
      const next = new Uint8Array(nextLength);
      next.set(this.#packed);
      this.#packed = next;
    }
    setPackedCode(this.#packed, this.#length, code);
    this.#length += 1;
    this.#firstCode ??= code;
    if (code === 0) this.#lfCount += 1;
    else if (code === 1) this.#crlfCount += 1;
    else if (code === 2) this.#crCount += 1;
    else if (code === 3) this.#ffCount += 1;
    else this.#nelCount += 1;
  }

  finish(seed = 0x6d2b79f5): { readonly sequence: LineEndingSequence; readonly defaultLineEnding: LineEnding } {
    const firstCode = this.#firstCode ?? 0;
    const countFor = (code: EndingCode): number => code === 0 ? this.#lfCount : code === 1 ? this.#crlfCount : code === 2 ? this.#crCount : code === 3 ? this.#ffCount : this.#nelCount;
    let defaultCode = firstCode;
    if (countFor(1) > countFor(defaultCode)) defaultCode = 1;
    if (countFor(2) > countFor(defaultCode)) defaultCode = 2;
    if (countFor(3) > countFor(defaultCode)) defaultCode = 3;
    if (countFor(4) > countFor(defaultCode)) defaultCode = 4;
    return {
      sequence: LineEndingSequence.fromPacked(this.#length, this.#packed, seed),
      defaultLineEnding: lineEndingValue(defaultCode),
    };
  }
}

/** Persistent indexed EOL metadata; edits copy only the treap paths and blocks they touch. */
export class LineEndingSequence {
  readonly #root: Root;
  readonly #seed: number;

  private constructor(root: Root, seed: number) {
    this.#root = root;
    this.#seed = seed;
    Object.freeze(this);
  }

  static from(values: readonly LineEnding[], seed = 0x6d2b79f5): LineEndingSequence {
    const blocks: EolBlock[] = [];
    for (let start = 0; start < values.length; start += MAX_BLOCK_LENGTH) {
      blocks.push(makeBlockFromValues(values, start, Math.min(values.length, start + MAX_BLOCK_LENGTH)));
    }
    return LineEndingSequence.fromBlocks(blocks, seed);
  }

  static fromUniform(length: number, value: LineEnding, seed = 0x6d2b79f5): LineEndingSequence {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('invalid-line-ending-length');
    const code = endingCode(value);
    if (code === undefined) throw new RangeError('invalid-line-ending');
    if (length === 0) return new LineEndingSequence(null, seed >>> 0);
    const blocks: EolBlock[] = [];
    for (let remaining = length; remaining > 0; remaining -= MAX_BLOCK_LENGTH) {
      blocks.push(makeUniformBlock(Math.min(remaining, MAX_BLOCK_LENGTH), code));
    }
    return LineEndingSequence.fromBlocks(blocks, seed);
  }

  /** Construct packed metadata from a private builder payload. */
  static fromPacked(length: number, packed: Uint8Array, seed = 0x6d2b79f5): LineEndingSequence {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('invalid-line-ending-length');
    if (!(packed instanceof Uint8Array)) throw new RangeError('invalid-line-ending-packed-payload');
    const byteLength = Math.ceil(length * 3 / 8);
    if (packed.length < byteLength) throw new RangeError('line-ending-packed-length-mismatch');
    if (length === 0) return new LineEndingSequence(null, seed >>> 0);
    // Take ownership of a bounded copy so callers cannot mutate a published sequence.
    const owned = packed.slice(0, byteLength);
    const blocks: EolBlock[] = [];
    for (let start = 0; start < length; start += MAX_BLOCK_LENGTH) {
      const blockLength = Math.min(length - start, MAX_BLOCK_LENGTH);
      blocks.push(makeBlockFromPacked(blockLength, owned, start));
    }
    return LineEndingSequence.fromBlocks(blocks, seed);
  }

  get length(): number { return size(this.#root); }

  /** Read a zero-based normalized line-break metadata index. */
  at(index: number): LineEnding | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) return undefined;
    let root = this.#root;
    let remaining = index;
    while (root !== null) {
      const leftSize = size(root.left);
      if (remaining < leftSize) root = root.left;
      else if (remaining < leftSize + root.block.length) {
        return lineEndingValue(blockAt(root.block, remaining - leftSize));
      } else {
        remaining -= leftSize + root.block.length;
        root = root.right;
      }
    }
    return undefined;
  }

  /** Create a sequential reader so dense saves do not restart a tree lookup per newline. */
  reader(start = 0): LineEndingReader {
    if (!Number.isSafeInteger(start) || start < 0 || start > this.length) throw new RangeError('line-ending-reader-out-of-range');
    const blocks: EolBlock[] = [];
    const stack: Node[] = [];
    let current = this.#root;
    while (current !== null || stack.length > 0) {
      while (current !== null) {
        stack.push(current);
        current = current.left;
      }
      const node = stack.pop();
      if (node === undefined) break;
      blocks.push(node.block);
      current = node.right;
    }
    let blockIndex = 0;
    let offset = start;
    while (blockIndex < blocks.length) {
      const block = blocks[blockIndex];
      if (block === undefined || offset < block.length) break;
      offset -= block.length;
      blockIndex += 1;
    }
    return {
      next(): LineEnding | undefined {
        while (blockIndex < blocks.length) {
          const block = blocks[blockIndex];
          if (block === undefined) return undefined;
          if (offset < block.length) {
            const value = lineEndingValue(blockAt(block, offset));
            offset += 1;
            return value;
          }
          blockIndex += 1;
          offset = 0;
        }
        return undefined;
      },
    };
  }

  /** Check a uniform replacement without materializing an array. */
  rangeEqualsUniform(start: number, length: number, value: LineEnding): boolean {
    const code = endingCode(value);
    if (code === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(length)
      || start < 0 || length < 0 || start + length > this.length) return false;
    return rangeEqualsUniform(this.#root, start, length, code);
  }

  /** Return a persistent metadata view without materializing one value per line. */
  range(start: number, length: number): LineEndingSequence {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length)
      || length < 0 || start + length > this.length) {
      throw new RangeError('line-ending-range-out-of-range');
    }
    if (length === 0) return new LineEndingSequence(null, this.#seed);
    const [, rest] = split(this.#root, start);
    const [middle] = split(rest, length);
    return new LineEndingSequence(middle, this.#seed);
  }

  /** Persistently replace normalized line-break metadata indices. */
  splice(start: number, deleteCount: number, inserted: readonly LineEnding[]): LineEndingSequence {
    const middle = LineEndingSequence.from(inserted, this.#seed);
    return this.spliceSequence(start, deleteCount, middle);
  }

  spliceUniform(start: number, deleteCount: number, insertedCount: number, inserted: LineEnding): LineEndingSequence {
    const middle = LineEndingSequence.fromUniform(insertedCount, inserted, this.#seed);
    return this.spliceSequence(start, deleteCount, middle);
  }

  /** Persistently splice an already-owned metadata view. */
  spliceSequence(start: number, deleteCount: number, inserted: LineEndingSequence): LineEndingSequence {
    if (!(inserted instanceof LineEndingSequence)) throw new TypeError('line-ending-sequence-required');
    return this.spliceSequenceInternal(start, deleteCount, inserted);
  }

  toArray(): readonly LineEnding[] {
    const values: LineEnding[] = new Array(this.length);
    const stack: Node[] = [];
    let current = this.#root;
    let index = 0;
    while (current !== null || stack.length > 0) {
      while (current !== null) {
        stack.push(current);
        current = current.left;
      }
      const node = stack.pop();
      if (node === undefined) break;
      for (let blockIndex = 0; blockIndex < node.block.length; blockIndex += 1) {
        values[index] = lineEndingValue(blockAt(node.block, blockIndex));
        index += 1;
      }
      current = node.right;
    }
    return Object.freeze(values);
  }

  metrics(): LineEndingStorageMetrics {
    let blockCount = 0;
    let uniformBlocks = 0;
    let packedBlocks = 0;
    let packedBytes = 0;
    const visit = (node: Root): void => {
      if (node === null) return;
      visit(node.left);
      blockCount += 1;
      if (node.block.uniformCode === null) {
        packedBlocks += 1;
        packedBytes += node.block.packed?.length ?? 0;
      } else uniformBlocks += 1;
      visit(node.right);
    };
    visit(this.#root);
    return {
      lineBreaks: this.length,
      blockCount,
      uniformBlocks,
      packedBlocks,
      packedBytes,
      structuralNodes: blockCount,
      structuralBytes: blockCount * 88,
      retainedBytes: packedBytes + blockCount * 88,
    };
  }

  private static fromBlocks(blocks: readonly EolBlock[], seed: number): LineEndingSequence {
    let root: Root = null;
    let prioritySeed = seed >>> 0;
    for (const block of blocks) {
      const next = nextPriority(prioritySeed);
      prioritySeed = next.seed;
      root = merge(root, makeNode(block, next.priority, null, null));
    }
    return new LineEndingSequence(root, prioritySeed);
  }

  private spliceSequenceInternal(start: number, deleteCount: number, inserted: LineEndingSequence): LineEndingSequence {
    if (!Number.isSafeInteger(start) || start < 0 || start > this.length
      || !Number.isSafeInteger(deleteCount) || deleteCount < 0 || start + deleteCount > this.length) {
      throw new RangeError('line-ending-splice-out-of-range');
    }
    if (deleteCount === 0 && inserted.length === 0) return this;
    const [before, rest] = split(this.#root, start);
    const [, after] = split(rest, deleteCount);
    return new LineEndingSequence(merge(merge(before, inserted.#root), after), inserted.#seed);
  }
}

function makeNode(block: EolBlock, priority: number, left: Root, right: Root): Node {
  return Object.freeze({ block, priority, left, right, size: size(left) + block.length + size(right) });
}

function makeUniformBlock(length: number, code: EndingCode): EolBlock {
  return Object.freeze({ length, uniformCode: code, packed: null });
}

function makeBlockFromValues(values: readonly LineEnding[], start: number, end: number): EolBlock {
  const length = end - start;
  const first = values[start];
  const firstCode = first === undefined ? undefined : endingCode(first);
  if (firstCode === undefined) throw new RangeError('invalid-line-ending');
  let uniform = true;
  for (let index = start + 1; index < end; index += 1) {
    const code = endingCode(values[index]);
    if (code === undefined) throw new RangeError('invalid-line-ending');
    if (code !== firstCode) uniform = false;
  }
  if (uniform) return makeUniformBlock(length, firstCode);
  const packed = new Uint8Array(Math.ceil(length * 3 / 8));
  for (let index = 0; index < length; index += 1) {
    const code = endingCode(values[start + index]);
    if (code === undefined) throw new RangeError('invalid-line-ending');
    setPackedCode(packed, index, code);
  }
  return Object.freeze({ length, uniformCode: null, packed });
}

function makeBlockFromPacked(length: number, packed: Uint8Array, startIndex: number): EolBlock {
  const firstCode = packedCode(packed, startIndex);
  let uniform = true;
  for (let index = 1; index < length; index += 1) {
    if (packedCode(packed, startIndex + index) !== firstCode) {
      uniform = false;
      break;
    }
  }
  if (uniform) return makeUniformBlock(length, firstCode);
  const blockPacked = new Uint8Array(Math.ceil(length * 3 / 8));
  for (let index = 0; index < length; index += 1) setPackedCode(blockPacked, index, packedCode(packed, startIndex + index));
  return Object.freeze({ length, uniformCode: null, packed: blockPacked });
}

function blockAt(block: EolBlock, index: number): EndingCode {
  if (block.uniformCode !== null) return block.uniformCode;
  const packed = block.packed;
  if (packed === null) throw new Error('line-ending-block-missing-payload');
  return packedCode(packed, index);
}

function packedCode(packed: Uint8Array, index: number): EndingCode {
  const bitOffset = index * 3;
  const shift = bitOffset & 7;
  const first = (packed[bitOffset >>> 3] ?? 0) >>> shift;
  const second = shift > 5 ? (packed[(bitOffset >>> 3) + 1] ?? 0) << (8 - shift) : 0;
  const code = (first | second) & 7;
  if (code > 4) throw new RangeError('invalid-line-ending-code');
  return code as EndingCode;
}

function setPackedCode(packed: Uint8Array, index: number, code: EndingCode): void {
  const bitOffset = index * 3;
  const shift = bitOffset & 7;
  const byteIndex = bitOffset >>> 3;
  packed[byteIndex] = (packed[byteIndex] ?? 0) | ((code << shift) & 0xff);
  if (shift > 5) packed[byteIndex + 1] = (packed[byteIndex + 1] ?? 0) | (code >>> (8 - shift));
}

function rangeEqualsUniform(root: Root, start: number, length: number, code: EndingCode): boolean {
  if (length === 0 || root === null) return length === 0;
  const leftSize = size(root.left);
  const nodeStart = leftSize;
  const nodeEnd = leftSize + root.block.length;
  if (start < nodeStart) {
    const leftLength = Math.min(length, nodeStart - start);
    if (!rangeEqualsUniform(root.left, start, leftLength, code)) return false;
    if (leftLength === length) return true;
    return rangeEqualsUniform(root, nodeStart, length - leftLength, code);
  }
  if (start < nodeEnd) {
    const inBlock = Math.min(length, nodeEnd - start);
    for (let index = 0; index < inBlock; index += 1) {
      if (blockAt(root.block, start - nodeStart + index) !== code) return false;
    }
    if (inBlock === length) return true;
    return rangeEqualsUniform(root.right, 0, length - inBlock, code);
  }
  return rangeEqualsUniform(root.right, start - nodeEnd, length, code);
}

function split(root: Root, count: number): readonly [Root, Root] {
  if (root === null) return [null, null];
  const leftSize = size(root.left);
  const blockEnd = leftSize + root.block.length;
  if (count < leftSize) {
    const [before, remaining] = split(root.left, count);
    return [before, clone(root, remaining, root.right)];
  }
  if (count > blockEnd) {
    const [remaining, after] = split(root.right, count - blockEnd);
    return [clone(root, root.left, remaining), after];
  }
  if (count === leftSize) return [root.left, clone(root, null, root.right)];
  if (count === blockEnd) return [clone(root, root.left, null), root.right];

  const leftLength = count - leftSize;
  const rightLength = root.block.length - leftLength;
  const [leftBlock, rightBlock] = splitBlock(root.block, leftLength);
  const leftNode = makeNode(leftBlock, splitPriority(root.priority, leftLength, 0), null, null);
  const rightNode = makeNode(rightBlock, splitPriority(root.priority, rightLength, 1), null, null);
  return [merge(root.left, leftNode), merge(rightNode, root.right)];
}

function splitBlock(block: EolBlock, leftLength: number): readonly [EolBlock, EolBlock] {
  const rightLength = block.length - leftLength;
  if (block.uniformCode !== null) {
    return [makeUniformBlock(leftLength, block.uniformCode), makeUniformBlock(rightLength, block.uniformCode)];
  }
  const leftPacked = new Uint8Array(Math.ceil(leftLength * 3 / 8));
  const rightPacked = new Uint8Array(Math.ceil(rightLength * 3 / 8));
  for (let index = 0; index < leftLength; index += 1) {
    setPackedCode(leftPacked, index, blockAt(block, index));
  }
  for (let index = 0; index < rightLength; index += 1) {
    setPackedCode(rightPacked, index, blockAt(block, leftLength + index));
  }
  return [makePackedOrUniformBlock(leftLength, leftPacked), makePackedOrUniformBlock(rightLength, rightPacked)];
}

function makePackedOrUniformBlock(length: number, packed: Uint8Array): EolBlock {
  return makeBlockFromPacked(length, packed, 0);
}

function clone(node: Node, left: Root, right: Root): Node {
  return makeNode(node.block, node.priority, left, right);
}

function merge(left: Root, right: Root): Root {
  if (left === null) return right;
  if (right === null) return left;
  if (left.priority < right.priority) return clone(left, left.left, merge(left.right, right));
  return clone(right, merge(left, right.left), right.right);
}

function splitPriority(priority: number, length: number, side: number): number {
  let value = (priority ^ Math.imul(length + 0x9e3779b9, side + 1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) || 0x9e3779b9;
}

function nextPriority(seed: number): { readonly priority: number; readonly seed: number } {
  let next = seed >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  next >>>= 0;
  if (next === 0) next = 0x9e3779b9;
  return { priority: next, seed: next };
}

function size(root: Root): number { return root?.size ?? 0; }

function endingCode(value: LineEnding | undefined): EndingCode | undefined {
  return value === 'lf' ? 0 : value === 'crlf' ? 1 : value === 'cr' ? 2 : value === 'ff' ? 3 : value === 'nel' ? 4 : undefined;
}

function lineEndingValue(code: EndingCode): LineEnding {
  return code === 0 ? 'lf' : code === 1 ? 'crlf' : code === 2 ? 'cr' : code === 3 ? 'ff' : 'nel';
}
