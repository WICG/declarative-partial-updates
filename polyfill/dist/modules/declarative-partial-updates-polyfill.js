(() => {
    if ('marker' in Element.prototype) {
        return;
    }
    console.log('Loading declarative partial updates polyfill...');
    function replaceRange(startNode, template) {
        const section = startNode.parentElement;
        if (!section) {
            return;
        }
        const walker = document.createTreeWalker(section, NodeFilter.SHOW_COMMENT);
        walker.currentNode = startNode;
        let endNode;
        while ((endNode = walker.nextNode())) {
            if (endNode.data.trim().startsWith('?end')) {
                break;
            }
        }
        if (endNode) {
            let current = startNode.nextSibling;
            while (current && current !== endNode) {
                const next = current.nextSibling;
                current.remove();
                current = next;
            }
            startNode.replaceWith(template.content.cloneNode(true));
            endNode.remove();
            template.remove();
        }
    }
    const processTemplate = (template) => {
        const [name, hash] = template.getAttribute('for')?.split('#') || [];
        const section = document.querySelector(`section[marker="${name}"]`);
        if (section) {
            const walker = document.createTreeWalker(section, NodeFilter.SHOW_COMMENT);
            let node;
            while ((node = walker.nextNode())) {
                const data = node.data.trim();
                if (hash) {
                    const rangeNameMatch = data.match(/^\?start\s+name=["'](.*?)["']/);
                    if (rangeNameMatch && rangeNameMatch[1] === hash) {
                        replaceRange(node, template);
                        break;
                    }
                    const markerNameMatch = data.match(/^\?marker\s+name=["'](.*?)["']/);
                    if (markerNameMatch && markerNameMatch[1] === hash) {
                        node.replaceWith(template.content.cloneNode(true));
                        template.remove();
                        break;
                    }
                }
                else {
                    if (data === '?start') {
                        replaceRange(node, template);
                        break;
                    }
                    if (data === '?marker') {
                        node.replaceWith(template.content.cloneNode(true));
                        template.remove();
                        break;
                    }
                }
            }
        }
    };
    // Handle existing templates
    document.querySelectorAll('template[for]').forEach((template) => {
        processTemplate(template);
    });
    // Listen for newly inserted templates and handle them
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLTemplateElement) {
                        processTemplate(node);
                    }
                });
            }
        });
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
})();
export {};
