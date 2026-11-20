/**
 * happy-dom's `TreeWalker.previousNode` walks past a previous sibling that has children instead of
 * returning it, so anything that moves focus backwards (a toolbar's left arrow, a menu's up arrow)
 * finds nothing.  This replaces it with the algorithm from the DOM standard, which `nextNode`
 * already follows, so keyboard tests see the behavior a browser gives.
 */
export function patchTreeWalkerPreviousNode(): void {
  const filterNode = (walker: TreeWalker, node: Node): number => {
    const { whatToShow, filter } = walker;
    if (whatToShow !== -1 && (whatToShow & (1 << (node.nodeType - 1))) === 0) {
      return NodeFilter.FILTER_SKIP;
    }
    if (typeof filter === 'function') return filter(node);
    if (filter) return filter.acceptNode(node);
    return NodeFilter.FILTER_ACCEPT;
  };

  TreeWalker.prototype.previousNode = function previousNode(this: TreeWalker): Node | null {
    let node: Node | null = this.currentNode;
    while (node !== this.root) {
      while (node?.previousSibling) {
        node = node.previousSibling;
        let result = filterNode(this, node);
        if (result === NodeFilter.FILTER_ACCEPT) {
          this.currentNode = node;
          return node;
        }
        while (result !== NodeFilter.FILTER_REJECT && node.lastChild) {
          node = node.lastChild;
          result = filterNode(this, node);
          if (result === NodeFilter.FILTER_ACCEPT) {
            this.currentNode = node;
            return node;
          }
        }
      }
      if (!node?.parentNode || node.parentNode === this.root) return null;
      node = node.parentNode;
      if (filterNode(this, node) === NodeFilter.FILTER_ACCEPT) {
        this.currentNode = node;
        return node;
      }
    }
    return null;
  };
}
