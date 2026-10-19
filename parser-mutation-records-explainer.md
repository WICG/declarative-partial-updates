# Explainer: Parser-Aware `MutationObserver` Records

## Introduction

`MutationObserver` was designed to observe low-level DOM tree operations (node insertions, node removals, character data modifications, and attribute changes). However, when the **HTML parser** constructs or updates a DOM tree—especially across streaming network chunks, declarative partial updates (`<template for>`), declarative Shadow DOM (`<template shadowrootmode>`), or streaming fragment APIs (`element.streamHTML()`)—critical parser state is invisible in the resulting `MutationRecord`s:

1. **Element completion (`parsedElements`)**: `addedNodes` reports an element as soon as its *start tag* is parsed, when its subtree is still empty or half-streamed. No record is queued when its *end tag* is parsed.
2. **Parser-consumed `<template>` elements (`templateAttributes` & `templateStatus`)**: `<template for>` and `<template shadowrootmode>` are pushed onto the parser's stack of open elements and redirect their parsed contents into a target container without the `<template>` itself ever entering the DOM tree.
3. **Fragment parsing context (`parserContextElement`)**: When markup is parsed as a fragment (`streamHTML*`, `setHTML*`, `innerHTML`, or `<template for>` with a context element), the parser's `fragment context element` is lost once mutations land on descendant nodes.

This explainer proposes a single opt-in (`{ parser: true }` on `MutationObserverInit`) that surfaces these three pieces of parser state directly on `MutationRecord`, along with a companion `Element.parsing` property and `parseEndCallback()` custom element reaction.

---

## Prior Discussions

- **Element parse completion & streaming state**:
  - [whatwg/dom#662](https://github.com/whatwg/dom/issues/662) — Custom element callback/promise for "connected and parsed"
  - [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809), [#619](https://github.com/WICG/webcomponents/issues/619), [#550](https://github.com/WICG/webcomponents/issues/550), & [whatwg/html#2235](https://github.com/whatwg/html/issues/2235) — Callbacks/notifications when the HTML parser finishes parsing an element's children
  - [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) & [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578) — Reflecting whether an element is open on the parser stack (`isParsingChildren` / `:parsing`)
- **Declarative partial updates & `<template for>` reflection**:
  - [whatwg/html#13008](https://github.com/whatwg/html/issues/13008) — Reflection of `<template for>` in `MutationObserver`
  - [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110) — Expose `<template for>` lifecycle events and timing
  - [WICG/declarative-partial-updates#104](https://github.com/WICG/declarative-partial-updates/issues/104) — Failure semantics when a response ends before a streamed `<template for>` patch is closed
  - [WICG/declarative-partial-updates#103](https://github.com/WICG/declarative-partial-updates/issues/103) — Preserving user-modified form/focus state when a patch replaces a containing range
  - [WICG/declarative-partial-updates#21](https://github.com/WICG/declarative-partial-updates/issues/21) & [#26](https://github.com/WICG/declarative-partial-updates/pull/26) — Reflection & timing of patch status
  - [whatwg/html#11818](https://github.com/whatwg/html/pull/11818) & [#13075](https://github.com/whatwg/html/issues/13075) — `<template for>` HTML parser specification and interaction with `shadowrootmode`
- **Streaming HTML insertion, parser text batching, & Shadow DOM observation**:
  - [whatwg/html#12758](https://github.com/whatwg/html/pull/12758), [#12753](https://github.com/whatwg/html/pull/12753), [#12624](https://github.com/whatwg/html/pull/12624), & [#12756](https://github.com/whatwg/html/pull/12756) — Streaming HTML insertion (`streamHTML*`), positional HTML insertion, direct fragment root insertion, and sanitizing while parsing
  - [whatwg/html#12744](https://github.com/whatwg/html/issues/12744) — Parser `Text` node data modification and `MutationObserver` batching
  - [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) & [#1439](https://github.com/whatwg/dom/issues/1439) — Observing shadow root attachment (especially Declarative Shadow DOM, which bypasses `Element.prototype.attachShadow()`)

---

## User-Facing Problem

### Problem 1: `addedNodes` fires on the start tag, before children are parsed

When the HTML parser parses `<article><h1>Title</h1><p>Body</p></article>`, it inserts `<article>` into its parent as soon as the `<article>` start tag token is processed. If a network chunk boundary or microtask checkpoint occurs before `</article>` arrives, a `MutationObserver` receives `<article>` in `addedNodes` while its children are incomplete or missing:

```js
// Today: broken when HTML streams across chunks
const mo = new MutationObserver(records => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node instanceof HTMLElement && node.matches("article")) {
        // BUG: <article> was just opened by the parser!
        // Its <h1> and <p> children may not have arrived from the network yet.
        enhanceArticle(node);
      }
    }
  }
});
mo.observe(document, { childList: true, subtree: true });
```

Developers today resort to fragile heuristics—checking whether `node.nextSibling` exists ([WebReflection/html-parsed-element](https://github.com/WebReflection/html-parsed-element)) or polling `requestAnimationFrame`—which fail for the last child of a container, for slow network streams ([whatwg/html#13008](https://github.com/whatwg/html/issues/13008)), and for streaming fragment APIs (`streamHTML`), while adding hundreds of milliseconds of CPU overhead on medium-sized documents ([patricknelson/svelte-retag#20](https://github.com/patricknelson/svelte-retag/issues/20#issuecomment-1848262955)).

While [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) (`Element.parsing` / `isParsingChildren`) and [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578) (`:parsing`) let code synchronously query or style an element *while* it is on the parser's stack of open elements, authors also need an asynchronous notification **when** that state transitions from `true` to `false` ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)).

### Problem 2: `<template for>` and `<template shadowrootmode>` are invisible to observers

Both declarative partial updates (`<template for="results">`, [whatwg/html#11818](https://github.com/whatwg/html/pull/11818)) and declarative Shadow DOM (`<template shadowrootmode="open">`, [whatwg/dom#831](https://github.com/whatwg/dom/issues/831)) use `<template>` tags as **parser instructions**: the parser creates the `<template>` element on its stack of open elements, redirects its parsed contents into a target (`<section>` or a new `ShadowRoot`), and discards the `<template>` when `</template>` is reached.

Because the `<template>` element is never inserted into the DOM:
- **For `<template for="results" data-turn="3">` ([whatwg/html#13008](https://github.com/whatwg/html/issues/13008), [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110))**:
  - An observer watching `<section>` sees fallback nodes removed and new nodes inserted, but has no way to know that these mutations came from `<template for="results">`, cannot read `data-turn="3"` from the `<template>`, and cannot correlate mutations belonging to the same patch across chunks.
  - When a patch targets a single-point `<?marker name="r">` or is empty (`<template for="r"></template>`), the start of the patch removes zero nodes, producing no `MutationRecord` at all.
  - When a streamed response ends at clean EOF before `</template>` arrives ([WICG/declarative-partial-updates#104](https://github.com/WICG/declarative-partial-updates/issues/104)), the parser removes the markers and reaches `document.readyState === "complete"`, making a truncated patch indistinguishable from a complete patch. Conversely, when a `<template for="missing">` fails to find its target marker, the parser falls back to inserting the inert `<template>` element with no error signal ([whatwg/html#11818](https://github.com/whatwg/html/pull/11818#issuecomment-3518721026)).
  - Frameworks that need to preserve dirty form-control values or focus when a `<template for>` replaces a range ([WICG/declarative-partial-updates#103](https://github.com/WICG/declarative-partial-updates/issues/103)) cannot distinguish a parser patch replacement (`removedNodes` on `"start"`) from ordinary imperative DOM removals.
- **For `<template shadowrootmode="open">` ([whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287))**:
  - Attaching a declarative `ShadowRoot` does not call `Element.prototype.attachShadow()` and does not queue any `MutationRecord` on the host element. Polyfills, component auto-loaders, and DevTools/hydration observers watching `document` with `subtree: true` have no way to discover declarative shadow roots as they are attached and parsed.

### Problem 3: Fragment parsing context is lost on descendant mutations

When an application streams or inserts HTML into a container via `sidebar.streamAppendHTML(response.body)`, `row.streamAfterHTML(...)`, or `el.setHTML(...)` ([whatwg/html#12758](https://github.com/whatwg/html/pull/12758), [whatwg/html#12753](https://github.com/whatwg/html/pull/12753), [whatwg/html#12624](https://github.com/whatwg/html/pull/12624)), the HTML parser runs with a `fragment context element` (`sidebar` or `row.parentNode`). However, mutations inside nested elements of that stream have `record.target` set to the immediate parent (`<p>`, `<ul>`, etc.), leaving a document-level observer with no way to attribute those mutations to the `fragment context element` being streamed.

### Goals

- Allow `MutationObserver` consumers to know when parser-inserted elements have finished parsing (`</tag>`), without doubling `MutationRecord` count when elements open and close in the same chunk, and without incurring parser-to-DOM traffic when no `parser: true` observer is active ([w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209456796)).
- Expose the attributes (`for`, `shadowrootmode`, `data-*`, etc.), correlation identity, and lifecycle (`"start"`, `"update"`, `"end"`, `"abort"`) of parser-consumed `<template>` elements on the same `MutationRecord`s that carry their DOM mutations (both `childList` and parser-batched `characterData` records, [whatwg/html#12744](https://github.com/whatwg/html/issues/12744)).
- Guarantee that records initiated by a `<template>` never coalesce with unrelated mutations or mutations from a different `<template>` ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)).
- Allow document/subtree observers to discover newly attached declarative `ShadowRoot`s ([whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287)) and know when they finish parsing.
- Expose the parser's `fragment context element` on records produced by fragment/streaming parsers.
- Keep `MutationRecord` flat and preserve `MutationRecord.type` (`"attributes" | "characterData" | "childList"`).

### Non-Goals

- **Buffering `<template for>` or `<template shadowrootmode>` mutations until `</template>`**: Streaming into the target as bytes arrive is fundamental to both features; observers must see incremental progress across chunks.
- **Tracking completion of non-element nodes (`Text`, `Comment`, `ProcessingInstruction`)**: Only `Element` nodes appear in `parsedElements`.
- **Replacing `PerformanceEntry` for sub-microtask RUM timing**: Observers can call `performance.mark()` in their callback to measure patch latency at microtask granularity ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)); if sub-microtask parser timestamps are needed in the future, a dedicated `PerformanceEntry` can be layered separately.

---

## Proposed Approach

A single boolean option, `parser: true` in `MutationObserverInit`, opts an observer into four new readonly properties on `MutationRecord`:

- `record.parsedElements`: A `NodeList` of `Element`s that finished parsing (either when popped from the stack of open elements, or immediately upon insertion for void/self-closing elements).
- `record.templateAttributes`: A `NamedNodeMap?` containing the attributes of the active parser-consumed `<template>` (`<template for>` or `<template shadowrootmode>`), or `null`.
- `record.templateStatus`: `"start" | "update" | "end" | "abort"`, or `null`.
- `record.parserContextElement`: The parser's `fragment context element` (`Element?`), or `null`.

### Example Usage

```js
const mo = new MutationObserver(records => {
  for (const r of records) {
    // 1. Act on elements only after their end tag has been parsed:
    for (const el of r.parsedElements) {
      if (el.matches("article")) enhanceArticle(el);
    }

    const attrs = r.templateAttributes;
    if (!attrs) continue;

    // 2. Discover and observe declarative Shadow DOM (<template shadowrootmode>):
    const mode = attrs.getNamedItem("shadowrootmode")?.value;
    if (mode && r.templateStatus === "start") {
      const shadowRoot = r.addedNodes[0];
      if (shadowRoot) {
        mo.observe(shadowRoot, { childList: true, subtree: true, parser: true });
      }
    }

    // 3. Track <template for> lifecycle and read custom attributes from the <template>:
    const forTarget = attrs.getNamedItem("for")?.value;
    if (forTarget) {
      const turn = attrs.getNamedItem("data-turn")?.value;
      switch (r.templateStatus) {
        case "start":  onPatchStart(r.target, forTarget, turn); break;
        case "update": if (r.type === "childList") onPatchNodes(r.addedNodes, turn); break;
        case "end":    onPatchEnd(r.target, forTarget, turn); break;
        case "abort":  onPatchAbort(r.target, forTarget, turn); break;
      }
    }
  }
});

mo.observe(document, {
  subtree: true,
  childList: true,
  characterData: true,
  parser: true,
});
```

### Web IDL

```webidl
partial dictionary MutationObserverInit {
  boolean parser = false;
};

enum TemplateStatus { "start", "update", "end", "abort" };

partial interface MutationRecord {
  [SameObject] readonly attribute NodeList parsedElements;
  readonly attribute TemplateStatus? templateStatus;
  readonly attribute NamedNodeMap? templateAttributes;
  readonly attribute Element? parserContextElement;
};
```

### 1. Element completion and coalescing (`parsedElements`)

Every parser-inserted `Element` appears in `parsedElements` once the parser finishes parsing it (when popped from the stack of open elements via an explicit end tag, an implied end tag, or parser termination, or immediately after insertion for void and self-closing foreign elements):

- **Same-chunk coalescing (zero extra records):** When an element opens *and* closes before the observer's record queue is flushed (the common case when `<p>Hello <span>world</span></p>` arrives in a single network chunk, and always the case for void/self-closing elements like `<img>`, `<br>`, `<svg/>`), the element is appended to `parsedElements` on the pending `childList` record that already holds it in `addedNodes`. Because every completed element appears in `parsedElements`, consumers that want to process parsed elements only need to iterate `r.parsedElements` without special-casing void elements.
- **Cross-chunk coalescing:** `record.target` is always the parent of the elements in `parsedElements` (just as for `addedNodes`). When an element `<article>` opens in chunk 1 (`addedNodes: [article], parsedElements: []`, with `article.parsing === true`) and closes in chunk 2, it is appended to `parsedElements` on the pending `childList` record for `article.parentNode` in chunk 2 (or a `childList` record on `article.parentNode` with `addedNodes: [], removedNodes: [], parsedElements: [article]`), coalescing with any sibling elements under the same parent that also finished parsing in that chunk.
- **Non-mixing guarantee across `<template>` boundaries ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** `parsedElements` only coalesces into a pending record that shares the exact same `(target, parserContextElement, templateAttributes, templateStatus)`. Records initiated by a `<template>` never merge with records outside that `<template>` or from a different `<template>`.
- **Elements disconnected mid-parse ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662)) or discarded by sanitizer ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)):** If a script removes an open element from the observed tree before its closing tag is parsed, or if the parser's sanitizer configuration discards an element so it never enters the target tree, popping it from the stack of open elements does not emit it in `parsedElements` for observers of that tree.

### 2. Parser-consumed `<template>` elements (`templateAttributes` & `templateStatus`)

Whenever the HTML parser processes a `<template for>` or `<template shadowrootmode>` element:

| Phase | `<template for="r">` | `<template shadowrootmode="open">` |
|---|---|---|
| **`"start"`** | Record on the patch target removing `<?start>` and fallback nodes (or empty `addedNodes`/`removedNodes` if targeting `<?marker>`, with `nextSibling: <?marker>`). | Record on the shadow host with `addedNodes: [shadowRoot]`. |
| **`"update"`** | All `childList` and parser-flushed `characterData` records ([whatwg/html#12744](https://github.com/whatwg/html/issues/12744)) performed inside the patch. | All `childList` and `characterData` records performed inside `shadowRoot` (for observers observing `shadowRoot`). |
| **`"end"`** | Record on the patch target removing `<?end>` or `<?marker>` when `</template>` is reached (plus any `parsedElements` that closed at `</template>`). | Record on the shadow host when `</template>` is reached. |
| **`"abort"`** | Record on the patch target if EOF or `writer.abort()` occurs before `</template>` ([WICG/declarative-partial-updates#104](https://github.com/WICG/declarative-partial-updates/issues/104)) or if a script displaces the target marker mid-stream ([whatwg/html#11818](https://github.com/whatwg/html/pull/11818)); or on the fallback `<template>` insertion record if the target marker was not found at `<template>` start. | Record on the shadow host if EOF or `writer.abort()` occurs before `</template>`, or on the fallback `<template>` insertion record if attaching the shadow root failed ([whatwg/html#13075](https://github.com/whatwg/html/issues/13075)). |

- **Per-attempt correlation identity ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** All `"start"`, `"update"`, and `"end"`/`"abort"` records generated by a single `<template>` invocation return the **same `NamedNodeMap` instance** (`r1.templateAttributes === r2.templateAttributes`). Observers can correlate all records of a patch attempt by object identity (`===` / `WeakMap`) even when the author did not include a unique `id` or `data-*` attribute on the `<template>`.
- **Empty patches (`<template for="r"></template>`):** Still emit both `"start"` (when `<template for="r">` is opened) and `"end"` (when `</template>` removes `<?end>` or `<?marker>`), satisfying the terminal-record requirement in [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110) even when zero replacement nodes are inserted.

#### Walkthrough A: `<template for>` across two network chunks

Given `<section><?start name="r">Loading…<?end></section>`, when `main.streamAppendHTML(...)` receives chunk 1 (`<template for="r" data-turn="3"><p>H`) followed by chunk 2 (`i<span>!</span></p></template>`):

| # | Chunk | `type` | `target` | `removedNodes` | `addedNodes` | `parsedElements` | `templateAttributes` | `templateStatus` | `parserContextElement` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | `childList` | `<section>` | `[<?start>, "Loading…"]` | `[]` | `[]` | `[for="r", data-turn="3"]` | `"start"` | `<main>` |
| 2 | 1 | `childList` | `<section>` | `[]` | `[<p>]` | `[]` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 3 | 1 | `childList` | `<p>` | `[]` | `["H"]` | `[]` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 4 | 2 | `characterData` | `"Hi"` | `[]` | `[]` | `[]` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 5 | 2 | `childList` | `<p>` | `[]` | `[<span>]` | `[<span>]` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 6 | 2 | `childList` | `<span>` | `[]` | `["!"]` | `[]` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 7 | 2 | `childList` | `<section>` | `[<?end>]` | `[]` | `[<p>]` | `[for="r", data-turn="3"]` | `"end"` | `<main>` |

#### Walkthrough B: Records when `addedNodes` and `removedNodes` are empty (e.g. `<?marker>`)

When `<template for="r" data-turn="3"><p>Hi</p></template>` targets a single `<section><?marker name="r"></section>`, no nodes are removed at `<template>` start because `<?marker>` remains in place as the insertion point until `</template>` removes it:

| # | `type` | `target` | `removedNodes` | `addedNodes` | `parsedElements` | `nextSibling` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|---|
| 1 | `childList` | `<section>` | `[]` | `[]` | `[]` | `<?marker>` | `[for="r", data-turn="3"]` | `"start"` |
| 2 | `childList` | `<section>` | `[]` | `[<p>]` | `[<p>]` | `<?marker>` | `[for="r", data-turn="3"]` | `"update"` |
| 3 | `childList` | `<p>` | `[]` | `["Hi"]` | `[]` | `null` | `[for="r", data-turn="3"]` | `"update"` |
| 4 | `childList` | `<section>` | `[<?marker>]` | `[]` | `[]` | `null` | `[for="r", data-turn="3"]` | `"end"` |

*(Observers that did not specify `parser: true` never receive record #1 or any other record whose `addedNodes` and `removedNodes` are both empty.)*

### 3. Fragment parsing context (`parserContextElement`)

When the HTML parser runs with a `fragment context element`—such as `el.streamHTML()`, `el.streamAppendHTML()`, `child.streamAfterHTML()`, `el.setHTML()`, `el.innerHTML`, or a `<template for>` with a context element—every record produced by that parser has `parserContextElement` set to that `Element`. For top-level document parsing with no fragment context element, `parserContextElement` is `null`.

### 4. Companion for Custom Elements ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662))

Because custom elements already use lifecycle callbacks rather than `MutationObserver`, the same parser hook powers `Element.parsing` (and `ShadowRoot.parsing`) plus a `parseEndCallback()` custom element reaction:

```js
class MyWidget extends HTMLElement {
  connectedCallback() {
    if (!this.parsing) this.#initialize();
  }
  parseEndCallback() {
    this.#initialize();
  }
  #initialize() {
    // Safe to inspect this.children and this.textContent
  }
}
```

---

## Alternatives Considered

### 1. New `MutationRecord.type` values (`"parseEnd"`, `"templateStart"`, `"templateEnd"`, `"templateAbort"`)

An earlier iteration expressed template boundaries and element completion as distinct `MutationRecord.type` values. This had two major drawbacks:
- **Severed connection between nodes and `<template>` metadata:** Putting `templateAttributes` on a zero-node `"templateStart"` record meant the subsequent `childList` records carrying `addedNodes` had no direct reference to the `<template>`'s attributes, forcing every observer callback to maintain a stateful `Map` across records.
- **Record bloat for `parseEnd`:** Emitting a separate `{ type: "parseEnd", target: el }` record for every closing tag doubled the number of `MutationRecord`s when parsing a document chunk. Expressing completion via `parsedElements` on `childList` records allows same-chunk opens and closes to coalesce onto existing records with zero extra allocations.

### 2. Exposing the detached `HTMLTemplateElement` on `MutationRecord`

Instead of `templateAttributes` (`NamedNodeMap`), `MutationRecord` could expose `record.template` pointing to the detached `HTMLTemplateElement` created by the parser. We rejected this because retaining a live `HTMLTemplateElement` node per template operation exposes a parser-internal element whose `.content` `DocumentFragment` was bypassed, and invites developers to mutate or insert it into the DOM. Exposing a read-only `NamedNodeMap` of its attributes provides everything the author wrote (`for`, `shadowrootmode`, `data-*`, etc.) without leaking the detached element.

### 3. Separate `MutationObserverInit` flags (`parsedElements`, `template`, `templateAttributeFilter`) and `templateFor`

We considered separate opt-in booleans for element completion vs. template metadata, plus an `attributeFilter`-style `templateAttributeFilter` list and a dedicated `record.templateFor` string. However:
- Unlike `type: "attributes"` (where `attributeFilter` prevents waking up an observer for high-frequency `style`/`class` mutations), a `<template>` start tag is parsed once and typically carries only 1–3 attributes (`for`, `shadowrootmode`, `data-*`) that are shared across all records of that `<template>`.
- Since `for` and `shadowrootmode` are themselves attributes on `<template>`, exposing all `<template>` attributes on `templateAttributes` under a single `parser: true` option eliminates three extra dictionary/interface members while unifying `<template for>` and `<template shadowrootmode>`.

### 4. Including `Text`, `Comment`, and `ProcessingInstruction` in `parsedNodes`

Comments, processing instructions, and doctypes are atomic non-element tokens in the HTML parser, and `Text` nodes already report streaming appends via `characterData` records. Including non-element nodes in `parsedNodes` added noise and required consumers to filter `node instanceof Element`, so `parsedElements` is scoped strictly to `Element`s.

### 5. Firing DOM Events (`parseend`, `templatestart`, `templateend`)

Dispatching synchronous or queued DOM events for every parsed element during HTML tree construction has the same performance hazards that led the platform to deprecate `MutationEvent` in favor of `MutationObserver`. Batching parser metadata into `MutationObserver`'s existing microtask record queue avoids per-element event dispatch overhead.

---

## Frequently Asked Questions (Q&A)

### Q1: Does popping elements from the parser stack add overhead to the HTML parser?
In browser engines ([w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209456796), [whatwg/dom#662](https://github.com/whatwg/dom/issues/662)), popping an element from the HTML parser's stack of open elements is a fast pointer pop unless the element or tree requires end-tag notification. Two design choices keep this fast:
1. **Zero cost when `parser: true` is unused:** A per-tree flag ("has `parser: true` observer") gates the check entirely, so documents without a `parser: true` observer pay zero overhead on end-tag pops.
2. **Same-chunk coalescing avoids extra record allocations:** When an element opens and closes in the same chunk (including all void elements), `parsedElements` appends onto the already-queued `childList` record for that parent rather than allocating a second `MutationRecord`.

### Q2: Why use `NodeList` (`parsedElements`) and `NamedNodeMap` (`templateAttributes`) instead of `FrozenArray`?
While the [Web Platform Design Principles (§9.4)](https://www.w3.org/TR/design-principles/#collections) generally prefer `FrozenArray` for new APIs:
- `MutationRecord.addedNodes` and `removedNodes` are already `NodeList`s on the same interface, so `NodeList` for `parsedElements` is locally consistent with `MutationRecord`.
- `NamedNodeMap` provides ergonomic lookup by attribute name (`r.templateAttributes.getNamedItem("for")?.value`) without allocating a new wrapper object per record. Each `Attr` in `templateAttributes` has `ownerElement === null` (so the parser's internal `<template>` node is never leaked), and calling mutating methods (`setNamedItem`, `removeNamedItem`) on a `MutationRecord`'s `templateAttributes` throws `NoModificationAllowedError`.

### Q3: Doesn't putting a `ShadowRoot` in `addedNodes` violate the invariant that `addedNodes` are children of `target`?
In DOM today ([whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287), [whatwg/dom#1439](https://github.com/whatwg/dom/issues/1439)), `type: "childList"` records only report mutations to `target.childNodes`, whereas a `ShadowRoot` has `parentNode === null` and `host === target`. Because `addedNodes: [shadowRoot]` is *only* populated for observers that explicitly opt into `{ parser: true }` on a record with `templateAttributes` containing `shadowrootmode` and `templateStatus === "start"`, existing observers (`parser: false`) are never affected. (If preferred during specification review, `addedNodes` on the host's `"start"` record can remain empty `[]` and observers can read `r.target.shadowRoot` directly.)

### Q4: What is `record.target` for `parsedElements`, and how does it interact with `subtree: false` vs. `subtree: true`?
`record.target` is always the `parentNode` of the elements in `record.parsedElements`, matching `record.addedNodes`:
- Every `el` in `r.parsedElements` satisfies `el.parentNode === r.target`.
- If an observer observes `<main>` with `{ childList: true, subtree: false, parser: true }`, it only receives `parsedElements` for direct children of `<main>`, matching `addedNodes`.
- If an observer observes `<main>` with `{ childList: true, subtree: true, parser: true }` and `</p></article></section>` closes across a chunk boundary, each parent whose children finished parsing queues/coalesces its own `childList` record (`target: <article>, parsedElements: [<p>]`, `target: <section>, parsedElements: [<article>]`, etc.).

### Q5: What happens when the parser reparents or clones elements (foster parenting and the adoption agency algorithm)?
- **Foster parenting (`<table><div>...</div></table>`):** The parser inserts `<div>` into `<table>`'s parent before `<table>`. When `</div>` is popped from the stack of open elements, the record's `target` is `div.parentNode` at the time it is popped (provided `div` is still connected).
- **Adoption agency algorithm (`<b><i>Bold </b>italic</i>`):** When `</b>` is parsed, the original `<i>` and `<b>` are popped from the stack of open elements and appear in `parsedElements`; the newly cloned `<i>` is pushed onto the stack and appears in `parsedElements` when `</i>` is reached.

### Q6: Do synchronous parsing APIs (`innerHTML`, `setHTML`) emit `parsedElements`?
Yes, when `innerHTML` or `setHTML` parses directly into a target element ([whatwg/html#12624](https://github.com/whatwg/html/pull/12624)) that is being observed with `{ childList: true, parser: true }`. Because synchronous parsing finishes within a single task before the microtask checkpoint, every element opens and closes in the same batch and coalesces onto the existing `childList` records with zero additional `MutationRecord`s. Detached trees (`DOMParser`, `createContextualFragment`) have no active observers during parsing.

### Q7: Why not use DOM Events (`patchstart`, `patchend`) or a dedicated `PatchObserver` for `<template for>`?
Consumers of `<template for>`—such as hydration frameworks, DOM morphing / form-state preservation ([WICG/declarative-partial-updates#103](https://github.com/WICG/declarative-partial-updates/issues/103)), and progressive enhancers—need the **exact `removedNodes` and `addedNodes`** together with the `<template>` metadata. Separate DOM events or a separate observer would split the `"start"`/`"end"` lifecycle from the node mutations and require firing events across subtrees during HTML parsing.

### Q8: How does `parser: true` interact with `MutationObserver.prototype.observe()` option validation?
Today, `observe(target, options)` throws a `TypeError` unless at least one of `childList`, `attributes`, or `characterData` is `true`. Because `parser: true` augments `childList` (and `characterData`) records rather than introducing a standalone record `type`, `parser: true` requires `childList: true` (throwing a `TypeError` if `parser: true` is passed with `childList: false`).

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   It does not expose new user or cross-origin information. All information surfaced by `parser: true` (`parsedElements`, `<template>` attributes on `templateAttributes`, `templateStatus`, and `parserContextElement`) originates from HTML markup being parsed into a DOM subtree that the caller already has a reference to observe.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes:
   - **Closed Shadow Roots (`<template shadowrootmode="closed">`):** `addedNodes` on the shadow host record only exposes the `ShadowRoot` when `shadowrootmode` is `"open"`. For `"closed"`, `addedNodes` remains empty so closed shadow roots are never leaked to observers of the outer tree.
   - **Sanitize-while-parsing ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)) & CSP nonces ([WICG/declarative-partial-updates#111](https://github.com/WICG/declarative-partial-updates/issues/111)):** When safe HTML parsing (`setHTML()`, `streamHTML()`) strips disallowed attributes or blocks a `<template>`, `templateAttributes` only reflects attributes that survived the parser's sanitizer configuration, and any `nonce` attribute on `<template>` follows standard cryptographic nonce stripping so it is not exposed in `templateAttributes`.

3. **Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?**
   No.

4. **How do the features in your specification deal with sensitive information?**
   N/A.

5. **Does data exposed by your specification carry related but distinct information that may not be obvious to users?**
   No.

6. **Do the features in your specification introduce state that persists across browsing sessions?**
   No.

7. **Do the features in your specification expose information about the underlying platform to origins?**
   No.

8. **Does this specification allow an origin to send data to the underlying platform?**
   No.

9. **Do features in this specification enable access to device sensors?**
   No.

10. **Do features in this specification enable new script execution/loading mechanisms?**
    No. `MutationObserver` callbacks continue to run at the standard microtask checkpoint, and custom element `parseEndCallback()` reactions run via the standard custom element reaction queue.

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    N/A (same-origin DOM observation only).

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Identically to normal browsing mode; no state is persisted.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    It is intended to be integrated into the WHATWG DOM and HTML Standards.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    Nothing special beyond existing `MutationObserver` behavior.

19. **What happens when a document that uses your feature gets disconnected?**
    If an observed element is disconnected from the tree while still open on the parser stack, popping it from the stack of open elements does not emit it in `parsedElements` for observers of the outer tree.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Parser-aborted `<template>` operations (such as EOF before `</template>`, missing target markers, or failed declarative shadow root attachment) are surfaced via `templateStatus: "abort"` on the `MutationRecord` rather than throwing exceptions.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.
