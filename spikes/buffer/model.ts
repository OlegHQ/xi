export type Affinity = 'left' | 'right';

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface TextAnchor {
  readonly id: number;
  readonly offset: number;
  readonly affinity: Affinity;
}

export interface MappedAnchor extends TextAnchor {
  readonly mappedOffset: number;
}

export interface ModelSnapshot<Item> {
  readonly root: TreeNode<Item> | null;
  readonly version: number;
}

export interface ModelMetrics {
  readonly utf16Length: number;
  readonly lineBreaks: number;
  readonly currentNodes: number;
  readonly treeHeight: number;
  readonly historyEntries: number;
  readonly retainedNodes: number;
  readonly currentPayloadUnits: number;
  readonly retainedPayloadUnits: number;
  readonly version: number;
}

export interface TreeNode<Item> {
  readonly item: Item;
  readonly priority: number;
  readonly left: TreeNode<Item> | null;
  readonly right: TreeNode<Item> | null;
  readonly utf16Length: number;
  readonly lineBreaks: number;
  readonly nodeCount: number;
  readonly height: number;
}

export interface ItemOps<Item> {
  readonly itemLength: (item: Item) => number;
  readonly lineBreakCount: (item: Item) => number;
  readonly lineBreaksBefore: (item: Item, offset: number) => number;
  readonly splitItem: (item: Item, offset: number) => readonly [Item, Item];
  readonly fromText: (text: string) => readonly Item[];
  readonly render: (item: Item) => string;
  readonly codeUnitAt: (item: Item, offset: number) => number;
  readonly canCoalesce: (left: Item, right: Item) => boolean;
  readonly coalesce: (left: Item, right: Item) => Item;
  readonly storageIdentity: (item: Item) => object;
  readonly storageUnits: (item: Item) => number;
}

export class BatchCancelledError extends Error {
  constructor(readonly completedEdits: number) {
    super(`batch-cancelled-after-${completedEdits}-edits`);
    this.name = 'BatchCancelledError';
  }
}

export class PersistentTextModel<Item> {
  private root: TreeNode<Item> | null = null;
  private readonly undoRoots: (TreeNode<Item> | null)[] = [];
  private currentVersion = 1;
  private priorityState: number;

  constructor(
    initialText: string,
    private readonly operations: ItemOps<Item>,
    seed: number,
  ) {
    this.priorityState = seed >>> 0;
    if (!isWellFormedUtf16(initialText)) throw new Error('ill-formed-utf16-input');
    for (const item of operations.fromText(initialText)) {
      this.root = this.merge(this.root, this.createNode(item));
    }
  }

  get version(): number {
    return this.currentVersion;
  }

  get length(): number {
    return nodeLength(this.root);
  }

  fork(): PersistentTextModel<Item> {
    const copy = new PersistentTextModel<Item>('', this.operations, this.priorityState);
    copy.root = this.root;
    copy.currentVersion = this.currentVersion;
    copy.priorityState = this.priorityState;
    return copy;
  }

  snapshot(): ModelSnapshot<Item> {
    return { root: this.root, version: this.currentVersion };
  }

  text(): string {
    return renderTree(this.root, this.operations);
  }

  snapshotText(snapshot: ModelSnapshot<Item>): string {
    return renderTree(snapshot.root, this.operations);
  }

  lineIndexAt(offset: number): number {
    validateOffset(offset, this.length);
    return countLineBreaksBefore(this.root, offset, this.operations);
  }

  replace(start: number, end: number, text: string, retainUndo = false): void {
    this.replaceBatch([{ start, end, text }], this.currentVersion, retainUndo);
  }

  replaceBatch(
    edits: readonly TextEdit[],
    expectedVersion: number,
    retainUndo = false,
    shouldCancel?: () => boolean,
  ): void {
    if (expectedVersion !== this.currentVersion) {
      throw new Error(`stale-version: expected=${expectedVersion}; observed=${this.currentVersion}`);
    }
    const sorted = [...edits].sort(compareEdits);
    validateBatch(this.root, sorted, this.operations);
    let candidateRoot = this.root;
    let completed = 0;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (shouldCancel?.() === true) throw new BatchCancelledError(completed);
      const edit = sorted[index];
      if (edit === undefined) throw new Error('edit-index-unreachable');
      candidateRoot = this.replaceRoot(candidateRoot, edit.start, edit.end, edit.text);
      completed += 1;
    }
    if (shouldCancel?.() === true) throw new BatchCancelledError(completed);
    if (retainUndo) this.undoRoots.push(this.root);
    this.root = candidateRoot;
    this.currentVersion += 1;
  }

  undo(): boolean {
    const previousRoot = this.undoRoots.pop();
    if (previousRoot === undefined) return false;
    this.root = previousRoot;
    this.currentVersion += 1;
    return true;
  }

  metrics(): ModelMetrics {
    const roots = [this.root, ...this.undoRoots];
    const retainedNodes = new Set<TreeNode<Item>>();
    const countAndCollect = (root: TreeNode<Item> | null, unique: Set<TreeNode<Item>>): void => {
      const pending: TreeNode<Item>[] = root === null ? [] : [root];
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || unique.has(current)) continue;
        unique.add(current);
        if (current.left !== null) pending.push(current.left);
        if (current.right !== null) pending.push(current.right);
      }
    };
    for (const root of roots) countAndCollect(root, retainedNodes);
    const currentPayloadUnits = sumPayloadUnits(this.root, this.operations);
    const retainedPayloadUnits = sumUniquePayloadUnits(roots, this.operations);
    return {
      utf16Length: this.length,
      lineBreaks: nodeBreaks(this.root),
      currentNodes: nodeCount(this.root),
      treeHeight: nodeHeight(this.root),
      historyEntries: this.undoRoots.length,
      retainedNodes: retainedNodes.size,
      currentPayloadUnits,
      retainedPayloadUnits,
      version: this.currentVersion,
    };
  }

  private replaceRoot(root: TreeNode<Item> | null, start: number, end: number, text: string): TreeNode<Item> | null {
    const [before, remainder] = this.split(root, start);
    const [, after] = this.split(remainder, end - start);
    let inserted: TreeNode<Item> | null = null;
    for (const item of this.operations.fromText(text)) inserted = this.merge(inserted, this.createNode(item));
    return this.concat(this.concat(before, inserted), after);
  }

  private split(root: TreeNode<Item> | null, offset: number): readonly [TreeNode<Item> | null, TreeNode<Item> | null] {
    if (root === null) {
      if (offset !== 0) throw new Error(`split-out-of-range: offset=${offset}`);
      return [null, null];
    }
    const leftLength = nodeLength(root.left);
    const itemLength = this.operations.itemLength(root.item);
    const itemEnd = leftLength + itemLength;
    if (offset < leftLength) {
      const [before, remainder] = this.split(root.left, offset);
      return [before, this.cloneNode(root, remainder, root.right)];
    }
    if (offset > itemEnd) {
      const [remainder, after] = this.split(root.right, offset - itemEnd);
      return [this.cloneNode(root, root.left, remainder), after];
    }
    if (offset === leftLength) {
      return [root.left, this.cloneNode(root, null, root.right)];
    }
    if (offset === itemEnd) {
      return [this.cloneNode(root, root.left, null), root.right];
    }
    const [leftItem, rightItem] = this.operations.splitItem(root.item, offset - leftLength);
    const before = this.merge(root.left, this.createNode(leftItem));
    const after = this.merge(this.createNode(rightItem), root.right);
    return [before, after];
  }

  private concat(left: TreeNode<Item> | null, right: TreeNode<Item> | null): TreeNode<Item> | null {
    if (left === null || right === null) return left ?? right;
    const last = rightmost(left);
    const first = leftmost(right);
    if (last === undefined || first === undefined || !this.operations.canCoalesce(last.item, first.item)) {
      return this.merge(left, right);
    }
    const [leftRest, leftItem] = this.popRight(left);
    const [rightItem, rightRest] = this.popLeft(right);
    return this.merge(this.merge(leftRest, this.createNode(this.operations.coalesce(leftItem.item, rightItem.item))), rightRest);
  }

  private popRight(root: TreeNode<Item>): readonly [TreeNode<Item> | null, TreeNode<Item>] {
    if (root.right === null) return [root.left, this.cloneNode(root, null, null)];
    const [remainder, item] = this.popRight(root.right);
    return [this.cloneNode(root, root.left, remainder), item];
  }

  private popLeft(root: TreeNode<Item>): readonly [TreeNode<Item>, TreeNode<Item> | null] {
    if (root.left === null) return [this.cloneNode(root, null, null), root.right];
    const [item, remainder] = this.popLeft(root.left);
    return [item, this.cloneNode(root, remainder, root.right)];
  }

  private merge(left: TreeNode<Item> | null, right: TreeNode<Item> | null): TreeNode<Item> | null {
    if (left === null) return right;
    if (right === null) return left;
    if (left.priority < right.priority) {
      return this.cloneNode(left, left.left, this.merge(left.right, right));
    }
    return this.cloneNode(right, this.merge(left, right.left), right.right);
  }

  private createNode(item: Item): TreeNode<Item> {
    return makeNode(item, this.nextPriority(), null, null, this.operations);
  }

  private cloneNode(source: TreeNode<Item>, left: TreeNode<Item> | null, right: TreeNode<Item> | null): TreeNode<Item> {
    return makeNode(source.item, source.priority, left, right, this.operations);
  }

  private nextPriority(): number {
    this.priorityState ^= this.priorityState << 13;
    this.priorityState ^= this.priorityState >>> 17;
    this.priorityState ^= this.priorityState << 5;
    return this.priorityState >>> 0;
  }
}

export function mapAnchors(anchors: readonly TextAnchor[], edits: readonly TextEdit[]): {
  readonly anchors: readonly MappedAnchor[];
  readonly anchorSorts: number;
  readonly editSorts: number;
  readonly scannedAnchors: number;
  readonly scannedEdits: number;
} {
  const editsAreSorted = isSorted(edits, (left, right) => left.start - right.start || left.end - right.end);
  const sortedEdits = editsAreSorted ? edits : [...edits].sort(compareEdits);
  const anchorsAreSorted = isSorted(anchors, (left, right) => left.offset - right.offset || left.id - right.id);
  const orderedAnchors = anchors.map((anchor, index) => ({ anchor, index }));
  if (!anchorsAreSorted) orderedAnchors.sort((left, right) => left.anchor.offset - right.anchor.offset || left.anchor.id - right.anchor.id);
  const mapped: (MappedAnchor | undefined)[] = Array.from({ length: anchors.length });
  let editIndex = 0;
  let delta = 0;
  let scannedEdits = 0;
  let scannedAnchors = 0;
  for (const entry of orderedAnchors) {
    scannedAnchors += 1;
    const anchor = entry.anchor;
    while (editIndex < sortedEdits.length) {
      const edit = sortedEdits[editIndex];
      if (edit === undefined) break;
      if (anchor.offset > edit.end || (anchor.offset === edit.end && edit.start < edit.end)) {
        delta += edit.text.length - (edit.end - edit.start);
        editIndex += 1;
        scannedEdits += 1;
        continue;
      }
      break;
    }
    const active = sortedEdits[editIndex];
    let mappedOffset = anchor.offset + delta;
    if (active !== undefined && anchor.offset >= active.start && anchor.offset <= active.end) {
      const newStart = active.start + delta;
      if (active.start === active.end) {
        mappedOffset = newStart + (anchor.affinity === 'right' ? active.text.length : 0);
      } else if (anchor.offset === active.end) {
        mappedOffset = newStart + active.text.length;
      } else {
        mappedOffset = newStart + (anchor.affinity === 'right' ? active.text.length : 0);
      }
    }
    mapped[entry.index] = { ...anchor, mappedOffset };
  }
  return {
    anchors: mapped.map((anchor) => {
      if (anchor === undefined) throw new Error('anchor-mapping-result-missing');
      return anchor;
    }),
    anchorSorts: anchorsAreSorted ? 0 : 1,
    editSorts: editsAreSorted ? 0 : 1,
    scannedAnchors,
    scannedEdits,
  };
}

export function mapAnchorReference(anchor: TextAnchor, edits: readonly TextEdit[]): number {
  let delta = 0;
  const sorted = [...edits].sort(compareEdits);
  for (const edit of sorted) {
    if (anchor.offset > edit.end || (anchor.offset === edit.end && edit.start < edit.end)) {
      delta += edit.text.length - (edit.end - edit.start);
      continue;
    }
    if (anchor.offset < edit.start) break;
    const newStart = edit.start + delta;
    if (edit.start === edit.end) return newStart + (anchor.affinity === 'right' ? edit.text.length : 0);
    if (anchor.offset === edit.end) return newStart + edit.text.length;
    return newStart + (anchor.affinity === 'right' ? edit.text.length : 0);
  }
  return anchor.offset + delta;
}

export function applyReference(text: string, edits: readonly TextEdit[]): string {
  let result = text;
  const descending = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
  for (const edit of descending) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

export function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validateOffset(offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > length) throw new Error(`offset-out-of-range: ${offset}/${length}`);
}

export function countLineBreaksBefore<Item>(
  root: TreeNode<Item> | null,
  offset: number,
  operations: ItemOps<Item>,
): number {
  let node = root;
  let remaining = offset;
  let count = 0;
  while (node !== null) {
    const leftLength = nodeLength(node.left);
    if (remaining <= leftLength) {
      node = node.left;
      continue;
    }
    count += nodeBreaks(node.left);
    remaining -= leftLength;
    const itemLength = operations.itemLength(node.item);
    if (remaining <= itemLength) return count + operations.lineBreaksBefore(node.item, remaining);
    count += operations.lineBreakCount(node.item);
    remaining -= itemLength;
    node = node.right;
  }
  return count;
}

export function renderTree<Item>(root: TreeNode<Item> | null, operations: ItemOps<Item>): string {
  if (root === null) return '';
  const output: string[] = [];
  const stack: TreeNode<Item>[] = [];
  let node: TreeNode<Item> | null = root;
  while (node !== null || stack.length > 0) {
    while (node !== null) {
      stack.push(node);
      node = node.left;
    }
    const current = stack.pop();
    if (current === undefined) throw new Error('tree-traversal-stack-underflow');
    output.push(operations.render(current.item));
    node = current.right;
  }
  return output.join('');
}

export function nodeLength<Item>(node: TreeNode<Item> | null): number {
  return node?.utf16Length ?? 0;
}

export function nodeBreaks<Item>(node: TreeNode<Item> | null): number {
  return node?.lineBreaks ?? 0;
}

export function nodeCount<Item>(node: TreeNode<Item> | null): number {
  return node?.nodeCount ?? 0;
}

export function nodeHeight<Item>(node: TreeNode<Item> | null): number {
  return node?.height ?? 0;
}

function validateBatch<Item>(root: TreeNode<Item> | null, edits: readonly TextEdit[], operations: ItemOps<Item>): void {
  let previous: TextEdit | undefined;
  const length = nodeLength(root);
  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > length) {
      throw new Error(`invalid-edit-range: ${edit.start}..${edit.end}/${length}`);
    }
    if (!isWellFormedUtf16(edit.text)) throw new Error('ill-formed-utf16-edit');
    if (previous !== undefined) {
      if (previous.end > edit.start || (previous.start === previous.end && previous.start === edit.start)) {
        throw new Error(`overlapping-batch-edits: ${previous.start}..${previous.end} and ${edit.start}..${edit.end}`);
      }
      if (previous.end === edit.start && (previous.start === previous.end || edit.start === edit.end)) {
        throw new Error('ambiguous-insertion-at-replacement-boundary');
      }
    }
    assertBoundary(root, edit.start, operations);
    assertBoundary(root, edit.end, operations);
    previous = edit;
  }
}

function assertBoundary<Item>(root: TreeNode<Item> | null, offset: number, operations: ItemOps<Item>): void {
  const length = nodeLength(root);
  validateOffset(offset, length);
  if (offset === 0 || offset === length) return;
  const before = codeUnitAt(root, offset - 1, operations);
  const after = codeUnitAt(root, offset, operations);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    throw new Error(`edit-splits-surrogate: ${offset}`);
  }
}

function codeUnitAt<Item>(root: TreeNode<Item> | null, offset: number, operations: ItemOps<Item>): number {
  if (root === null || offset < 0 || offset >= root.utf16Length) throw new Error(`code-unit-out-of-range: ${offset}`);
  let node = root;
  let position = offset;
  while (true) {
    const leftLength = nodeLength(node.left);
    if (position < leftLength) {
      if (node.left === null) throw new Error('tree-code-unit-left-missing');
      node = node.left;
    } else if (position < leftLength + operations.itemLength(node.item)) {
      return operations.codeUnitAt(node.item, position - leftLength);
    } else {
      position -= leftLength + operations.itemLength(node.item);
      if (node.right === null) throw new Error('tree-code-unit-right-missing');
      node = node.right;
    }
  }
}

function makeNode<Item>(
  item: Item,
  priority: number,
  left: TreeNode<Item> | null,
  right: TreeNode<Item> | null,
  operations: ItemOps<Item>,
): TreeNode<Item> {
  return {
    item,
    priority,
    left,
    right,
    utf16Length: nodeLength(left) + operations.itemLength(item) + nodeLength(right),
    lineBreaks: nodeBreaks(left) + operations.lineBreakCount(item) + nodeBreaks(right),
    nodeCount: nodeCount(left) + 1 + nodeCount(right),
    height: Math.max(nodeHeight(left), nodeHeight(right)) + 1,
  };
}

function leftmost<Item>(root: TreeNode<Item>): TreeNode<Item> | undefined {
  let node = root;
  while (node.left !== null) node = node.left;
  return node;
}

function rightmost<Item>(root: TreeNode<Item>): TreeNode<Item> | undefined {
  let node = root;
  while (node.right !== null) node = node.right;
  return node;
}

function compareEdits(left: TextEdit, right: TextEdit): number {
  return left.start - right.start || left.end - right.end;
}

function isSorted<T>(items: readonly T[], compare: (left: T, right: T) => number): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const left = items[index - 1];
    const right = items[index];
    if (left === undefined || right === undefined || compare(left, right) > 0) return false;
  }
  return true;
}

function sumPayloadUnits<Item>(root: TreeNode<Item> | null, operations: ItemOps<Item>): number {
  const payload = new Set<object>();
  const stack: TreeNode<Item>[] = root === null ? [] : [root];
  let total = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    const identity = operations.storageIdentity(node.item);
    if (!payload.has(identity)) {
      payload.add(identity);
      total += operations.storageUnits(node.item);
    }
    if (node.left !== null) stack.push(node.left);
    if (node.right !== null) stack.push(node.right);
  }
  return total;
}

function sumUniquePayloadUnits<Item>(roots: readonly (TreeNode<Item> | null)[], operations: ItemOps<Item>): number {
  const payload = new Set<object>();
  let total = 0;
  for (const root of roots) {
    const stack: TreeNode<Item>[] = root === null ? [] : [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      const identity = operations.storageIdentity(node.item);
      if (!payload.has(identity)) {
        payload.add(identity);
        total += operations.storageUnits(node.item);
      }
      if (node.left !== null) stack.push(node.left);
      if (node.right !== null) stack.push(node.right);
    }
  }
  return total;
}
