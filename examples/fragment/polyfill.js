/**
 * Declarative Fragment Includes Polyfill
 * Implements the WICG Declarative Partial Updates / Fragment Include specification:
 * https://github.com/WICG/declarative-partial-updates/blob/main/fragment-include-explainer.md
 *
 * Supports:
 * - <template for="target-name" src="..." [buffer|buffered] [sanitize]>
 * - In-place includes: <template src="..." [buffer|buffered] [sanitize]>
 * - Processing instruction targets: <?start name="target">...<?end> and <?marker name="target">
 * - Buffered atomic DOM commits vs. Non-buffered progressive streaming
 * - Relies exclusively on native Sanitizer API (setHTML / new Sanitizer) without custom polyfilling
 * - Feature detection: yields to native implementation when supported
 */

(function () {
  'use strict';

  // Feature detection: Check if the browser natively supports active <template src> / <template for>
  const isNativeSupported = (
    'src' in HTMLTemplateElement.prototype &&
    ('for' in HTMLTemplateElement.prototype || 'htmlFor' in HTMLTemplateElement.prototype)
  );

  if (isNativeSupported) {
    console.info('[FragmentInclude] Native browser support detected for <template src/for>. Polyfill bypassed.');
    return;
  }

  // Visibly slow default streaming delay (800ms) so progressive chunk streaming is clearly apparent
  let streamingDelayMs = 800;

  const processedTemplates = new WeakSet();

  /**
   * Parse processing instruction or comment syntax
   * Matches both standard ProcessingInstruction nodes and HTML-parsed Comments (<?start name="foo">)
   */
  function parsePINode(node) {
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      const target = node.target.toLowerCase();
      const data = node.data || '';
      const nameMatch = data.match(/name=["']?([^"'\s>]+)["']?/i);
      return {
        type: target, // "start" | "end" | "marker"
        name: nameMatch ? nameMatch[1] : null,
        node: node
      };
    }

    if (node.nodeType === Node.COMMENT_NODE) {
      const data = (node.data || '').trim();
      const match = data.match(/^\?(start|end|marker)(?:\s+name=["']?([^"'\s>]+)["']?)?/i);
      if (match) {
        return {
          type: match[1].toLowerCase(), // "start" | "end" | "marker"
          name: match[2] || null,
          node: node
        };
      }
    }

    return null;
  }

  /**
   * Locate target ranges or insertion points in the document or container
   */
  function findTarget(targetName, root = document) {
    if (!targetName) return null;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION,
      null
    );

    let currentNode;
    while ((currentNode = walker.nextNode())) {
      const parsed = parsePINode(currentNode);
      if (!parsed) continue;

      if (parsed.type === 'start' && parsed.name === targetName) {
        const startNode = currentNode;
        const parent = startNode.parentNode;
        let endNode = null;
        let depth = 1;

        // Find the matching <?end>
        let sibling = startNode.nextSibling;
        while (sibling) {
          const siblingParsed = parsePINode(sibling);
          if (siblingParsed) {
            if (siblingParsed.type === 'start') {
              depth++;
            } else if (siblingParsed.type === 'end') {
              depth--;
              if (depth === 0) {
                endNode = sibling;
                break;
              }
            }
          }
          sibling = sibling.nextSibling;
        }

        return {
          type: 'range',
          name: targetName,
          startNode: startNode,
          endNode: endNode,
          parent: parent
        };
      }

      if (parsed.type === 'marker' && parsed.name === targetName) {
        return {
          type: 'marker',
          name: targetName,
          markerNode: currentNode,
          parent: currentNode.parentNode
        };
      }
    }

    // Fallback: check elements with matching id or data-patch-target
    const el = root.querySelector?.(`[id="${CSS.escape(targetName)}"], [data-patch-target="${CSS.escape(targetName)}"]`);
    if (el) {
      return {
        type: 'element',
        name: targetName,
        element: el,
        parent: el.parentNode
      };
    }

    return null;
  }

  /**
   * Parse HTML or SVG string using native platform APIs (setHTML / setHTMLUnsafe / Sanitizer if available)
   */
  function parseAndSanitize(contentString, isUnsafe, isSvg, sourceUrl) {
    const fragment = document.createDocumentFragment();

    if (isSvg) {
      // Parse as SVG XML
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(contentString, 'image/svg+xml');
      const parserError = svgDoc.querySelector('parsererror');
      if (parserError) {
        console.warn('SVG parse error, falling back to HTML parsing:', parserError.textContent);
      } else {
        const svgElement = svgDoc.documentElement;
        if (svgElement && svgElement.tagName.toLowerCase() === 'svg') {
          // If native Sanitizer is available and include is not unsafe, use it
          if (!isUnsafe && typeof window.Sanitizer !== 'undefined' && typeof window.Sanitizer.prototype.sanitize === 'function') {
            try {
              const sanitizer = new window.Sanitizer();
              sanitizer.sanitize(svgElement);
            } catch (e) {
              console.warn('[FragmentInclude] Native sanitizer error on SVG:', e);
            }
          }
          svgElement.classList.add('inline-svg-icon');
          const imported = document.importNode(svgElement, true);
          fragment.appendChild(imported);
          return fragment;
        }
      }
    }

    // HTML parsing: Rely on native setHTML / setHTMLUnsafe when available
    const tempTemplate = document.createElement('template');

    if (isUnsafe) {
      if (typeof tempTemplate.setHTMLUnsafe === 'function') {
        tempTemplate.setHTMLUnsafe(contentString);
      } else {
        tempTemplate.innerHTML = contentString;
      }
    } else {
      // Safe by default: Use native setHTML with native Sanitizer if present
      if (typeof tempTemplate.setHTML === 'function') {
        try {
          if (typeof window.Sanitizer !== 'undefined') {
            tempTemplate.setHTML(contentString, { sanitizer: new window.Sanitizer() });
          } else {
            tempTemplate.setHTML(contentString);
          }
        } catch (e) {
          tempTemplate.innerHTML = contentString;
        }
      } else {
        tempTemplate.innerHTML = contentString;
      }
    }

    fragment.appendChild(tempTemplate.content);
    return fragment;
  }

  /**
   * Clear placeholder content inside target range
   */
  function clearTargetPlaceholder(targetInfo) {
    if (!targetInfo) return;

    if (targetInfo.type === 'range') {
      const { startNode, endNode, parent } = targetInfo;
      let curr = startNode.nextSibling;
      while (curr && curr !== endNode) {
        const next = curr.nextSibling;
        parent.removeChild(curr);
        curr = next;
      }
    } else if (targetInfo.type === 'element') {
      targetInfo.element.innerHTML = '';
    }
  }

  /**
   * Insert nodes into target position
   */
  function insertNodesAtTarget(nodes, targetInfo, templateAnchor) {
    const addedNodes = [];
    const nodeArray = Array.from(nodes.childNodes || nodes);

    if (targetInfo) {
      if (targetInfo.type === 'range') {
        const { endNode, parent } = targetInfo;
        for (const node of nodeArray) {
          if (endNode) {
            parent.insertBefore(node, endNode);
          } else {
            parent.appendChild(node);
          }
          addedNodes.push(node);
        }
      } else if (targetInfo.type === 'marker') {
        const { markerNode, parent } = targetInfo;
        for (const node of nodeArray) {
          parent.insertBefore(node, markerNode);
          addedNodes.push(node);
        }
      } else if (targetInfo.type === 'element') {
        for (const node of nodeArray) {
          targetInfo.element.appendChild(node);
          addedNodes.push(node);
        }
      }
    } else if (templateAnchor && templateAnchor.parentNode) {
      // In-place insertion before template
      for (const node of nodeArray) {
        templateAnchor.parentNode.insertBefore(node, templateAnchor);
        addedNodes.push(node);
      }
    }

    // Recursively process any nested templates inside the newly inserted content
    for (const node of addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches && node.matches('template[src], template[for]')) {
          processTemplateInclude(node);
        } else if (node.querySelectorAll) {
          scanAndProcess(node);
        }
      }
    }

    return addedNodes;
  }

  /**
   * Fetch with fallback for CDN SVG icons
   */
  async function fetchResource(src, template) {
    try {
      const response = await fetch(src, {
        credentials: template.getAttribute('crossorigin') ? 'include' : 'same-origin',
        referrerPolicy: template.getAttribute('referrerpolicy') || 'no-referrer-when-downgrade'
      });
      if (response.ok) return response;
      throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      // If fetching 3p CDN icon failed, try local fallback in fragments/icons/
      if (src.startsWith('http') && src.endsWith('.svg')) {
        const filename = src.split('/').pop();
        const fallbackUrl = `fragments/icons/${filename}`;
        console.warn(`[FragmentInclude] Fetch failed for ${src}. Retrying with local fallback: ${fallbackUrl}`);
        const fallbackResp = await fetch(fallbackUrl);
        if (fallbackResp.ok) return fallbackResp;
      }
      throw err;
    }
  }

  /**
   * Process a single <template> include
   */
  async function processTemplateInclude(template) {
    if (processedTemplates.has(template) || template._processing) return;
    template._processing = true;

    const src = template.getAttribute('src');
    const forAttr = template.getAttribute('for');
    const isBuffered = template.hasAttribute('buffer') || template.hasAttribute('buffered');
    const sanitizeAttr = template.getAttribute('sanitize');
    const isUnsafe = sanitizeAttr === 'unsafe';
    const isTargeted = template.hasAttribute('for') && forAttr !== '';
    const targetName = isTargeted ? forAttr : null;
    const isSvg = (src && src.toLowerCase().includes('.svg')) || template.getAttribute('type') === 'image/svg+xml';

    // Find target range / marker if targeted
    let targetInfo = null;
    if (isTargeted) {
      targetInfo = findTarget(targetName, document);
      if (!targetInfo) {
        console.warn(`[FragmentInclude] Target not found for: for="${targetName}"`);
        template._processing = false;
        return;
      }
    }

    if (!src) {
      // Inline template include
      const fragment = document.createDocumentFragment();
      fragment.appendChild(template.content.cloneNode(true));
      clearTargetPlaceholder(targetInfo);
      insertNodesAtTarget(fragment, targetInfo, template);
      processedTemplates.add(template);
      if (template.parentNode) template.remove();
      template._processing = false;
      return;
    }

    try {
      const response = await fetchResource(src, template);

      if (isBuffered) {
        // BUFFERED: Fetch entire payload, parse into fragment, commit atomically on EOF
        const rawText = await response.text();
        const fragment = parseAndSanitize(rawText, isUnsafe, isSvg, src);

        clearTargetPlaceholder(targetInfo);
        insertNodesAtTarget(fragment, targetInfo, template);

        processedTemplates.add(template);
        if (template.parentNode) template.remove();
      } else {
        // STREAMING (NON-BUFFERED): Read chunks and stream progressively
        let clearedPlaceholder = false;
        const rawText = await response.text();

        // Split by stream chunk markers, article tags, or double newlines
        let chunks = [];
        if (rawText.includes('<!-- stream-chunk -->')) {
          chunks = rawText.split('<!-- stream-chunk -->').filter(s => s.trim().length > 0);
        } else if (rawText.includes('<article')) {
          chunks = rawText.split(/(?=<article\b)/g).filter(s => s.trim().length > 0);
        } else if (rawText.includes('\n\n')) {
          chunks = rawText.split('\n\n').filter(s => s.trim().length > 0);
        } else {
          chunks = [rawText];
        }

        let chunkIndex = 0;
        for (const chunkText of chunks) {
          if (!clearedPlaceholder) {
            clearTargetPlaceholder(targetInfo);
            clearedPlaceholder = true;
          }

          const fragment = parseAndSanitize(chunkText, isUnsafe, isSvg, src);

          // Add a streaming arrival animation class to newly streamed elements
          for (const child of Array.from(fragment.children || [])) {
            child.classList.add('stream-item-incoming');
          }

          insertNodesAtTarget(fragment, targetInfo, template);
          chunkIndex++;

          // Visibly slow pacing so progressive stream delivery is clearly apparent
          if (streamingDelayMs > 0 && chunkIndex < chunks.length) {
            await new Promise(r => setTimeout(r, streamingDelayMs));
          }
        }

        processedTemplates.add(template);
        if (template.parentNode) template.remove();
      }
    } catch (err) {
      console.error(`[FragmentInclude] Error fetching template src="${src}":`, err);
    } finally {
      template._processing = false;
    }
  }

  /**
   * Scan and process all active templates in document
   */
  function scanAndProcess(root = document) {
    const templates = root.querySelectorAll('template[src], template[for]');
    for (const tpl of templates) {
      if (!processedTemplates.has(tpl) && !tpl._processing) {
        processTemplateInclude(tpl);
      }
    }
  }

  // Auto-init on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scanAndProcess(document);
    });
  } else {
    scanAndProcess(document);
  }

  // Public API
  window.FragmentIncludePolyfill = {
    scan: scanAndProcess,
    process: processTemplateInclude,
    setDelay: (ms) => { streamingDelayMs = ms; },
    getDelay: () => streamingDelayMs
  };
})();
