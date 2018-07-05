import Native from './Native.js';
import CustomElementInternals from '../CustomElementInternals.js';
import * as Utilities from '../Utilities.js';

/**
 * @param {!CustomElementInternals} internals
 */
export default function(internals) {
  Utilities.setPropertyUnchecked(Range.prototype, 'cloneContents',
    /**
     * @this {Range}
     * @return {!DocumentFragment}
     */
    function() {
      const clone = /** @type {!DocumentFragment} */(Native.Range_cloneContents.call(this));
      // Only create custom elements if this range's owner document is
      // associated with the registry.
      if (!this.startContainer.ownerDocument.__CE_hasRegistry) {
        internals.patchTree(clone);
      } else {
        internals.patchAndUpgradeTree(clone);
      }
      return clone;
    });
  
  Utilities.setPropertyUnchecked(Range.prototype, 'createContextualFragment',
    /**
     * @this {Range}
     * @param {string} tagString
     * @return {!DocumentFragment}
     */
    function(tagString) {
      const nativeResult =  /** @type {!DocumentFragment} */(Native.Range_createContextualFragment.call(this, tagString));
      // Only create custom elements if this range's owner document is
      // associated with the registry.
      if (!this.startContainer.ownerDocument.__CE_hasRegistry) {
        internals.patchTree(nativeResult);
      } else {
        internals.patchAndUpgradeTree(nativeResult);
      }
      return nativeResult;
    });
  
  Utilities.setPropertyUnchecked(Range.prototype, 'deleteContents',
    /**
     * @this {Range}
     */
    function() {
      this.extractContents();
    });

  Utilities.setPropertyUnchecked(Range.prototype, 'extractContents',
    /**
     * @this {Range}
     * @return {!DocumentFragment}
     */
    function() {
      const originalStartContainer = getContainerNode(this.startContainer, this.startOffset);
      const originalEndContainer = getContainerNode(this.endContainer, this.endOffset);

      const wasConnected = this.startContainer && Utilities.isConnected(this.startContainer);
      const nativeResult = /** @type {!DocumentFragment} */(Native.Range_extractContents.call(this));

      const extractedNodes = Array.prototype.slice.apply(nativeResult.childNodes);
      const extractedNodeCount = extractedNodes.length;
      const clonedNodes = [];

      // Detect split elements
      if (extractedNodes[0] !== originalStartContainer) {
        clonedNodes.push(extractedNodes.shift());
      }
      if (extractedNodeCount > 1 && extractedNodes[extractedNodes.length - 1] !== originalEndContainer) {
        clonedNodes.push(extractedNodes.pop());
      }

      // Only create custom elements if this range's owner document is
      // associated with the registry.
      const doUpgrade = this.startContainer.ownerDocument.__CE_hasRegistry;
      for (const clone of clonedNodes) {
        if (!doUpgrade) {
          internals.patchTree(clone);
        } else {
          internals.patchAndUpgradeTree(clone);
        }
        // Any children of these nodes were removed from the document.
        for (const child of clone.childNodes) {
          extractedNodes.push(child);
        }
      }

      if (wasConnected) {
        for (const node of extractedNodes) {
          internals.disconnectTree(node);
        }
      }

      return nativeResult;
    });

  Utilities.setPropertyUnchecked(Range.prototype, 'insertNode',
    /**
     * @this {Range}
     * @param {!Node} node
     */
    function(node) {
      if (node instanceof DocumentFragment) {
        const insertedNodes = Array.prototype.slice.apply(node.childNodes);
        Native.Range_insertNode.call(this, node);

        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (this.startContainer && Utilities.isConnected(this.startContainer)) {
          for (let i = 0; i < insertedNodes.length; i++) {
            internals.connectTree(insertedNodes[i]);
          }
        }

        return;
      }

      const nodeWasConnected = Utilities.isConnected(node);
      Native.Range_insertNode.call(this, node);

      if (nodeWasConnected) {
        internals.disconnectTree(node);
      }

      if (this.startContainer && Utilities.isConnected(this.startContainer)) {
        internals.connectTree(node);
      }

      return;
    });

  Utilities.setPropertyUnchecked(Range.prototype, 'surroundContents',
    /**
     * @this {Range}
     * @param {!Node} newParent
     */
    function(newParent) {
      // 1. If a non-Text node is partially contained in the context object,
      // then throw an "InvalidStateError" DOMException.
      if (getPartiallyContainedNodes(this).some((/** Node */n)=> n.nodeType !== Node.TEXT_NODE)) {
        // Run the native method, since we can't construct a DOMException.
        return Native.Range_surroundContents.call(this, newParent);
      }
      // 2. If newParent is a Document, DocumentType, or DocumentFragment node,
      //  then throw an "InvalidNodeTypeError" DOMException.
      if ([Node.DOCUMENT_NODE, Node.DOCUMENT_TYPE_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(newParent.nodeType)) {
        // Run the native method, since we can't construct a DOMException.
        return Native.Range_surroundContents.call(this, newParent);
      }

      // insertNode doesn't work after extractContents in Firefox,
      // so insert a placeholder first.
      const placeholder = document.createElement('span');
      this.insertNode(placeholder);
      this.setStartAfter(placeholder);

      // 3. Let fragment be the result of extracting the context object.
      const fragment = this.extractContents();

      // 4. If newParent has children, then replace all with null within newParent.
      for (let child = newParent.firstChild; child; child = newParent.firstChild) {
        newParent.removeChild(child);
      }

      // 5. Insert newParent into the context object.
      placeholder.parentNode.replaceChild(newParent, placeholder);

      // 6. Append fragment to newParent.
      newParent.appendChild(fragment);
      // 7. Select newParent within the context object.
      this.selectNode(newParent);
    });
};

/**
 * @param {Node} container 
 * @param {number} offset 
 * @return {Node}
 */
function getContainerNode(container, offset) {
  if ([Node.COMMENT_NODE, Node.TEXT_NODE, Node.CDATA_SECTION_NODE].includes(container.nodeType)) {
    return container;
  }
  if (offset < container.childNodes.length) {
    return container.childNodes[offset];
  }
  return container.lastChild;
}

/**
 * @param {!Range} range
 * @return {!Array<!Node>}
 */
function getPartiallyContainedNodes(range) {
  const startParents = new Set();
  const partiallyContained = [];
  for (let node = range.startContainer; node != range.commonAncestorContainer; node = node.parentNode){
    startParents.add(node);
  }

  for (let node = range.endContainer; node != range.commonAncestorContainer; node = node.parentNode) {
    if (startParents.has(node)) {
      startParents.delete(node);
    } else {
      partiallyContained.push(node);
    }
  }
  for (const node of startParents) {
    partiallyContained.push(node);
  }
  return partiallyContained;
}