# Explainer: Parser-Aware `MutationObserver` Records

## Introduction

The HTML parser keeps state that never shows up in the DOM:

- **Which elements are still open.** The parser's [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) tracks which elements it is still appending children to. It knows when each one is popped, whether by an explicit end tag, an implied end tag, or EOF.
- **Which parser-consumed `<template>` is active.** For `<template shadowrootmode>` (Declarative Shadow DOM, shipped in all engines) and `<template for>`, the parser redirects content into a target and never inserts the `<template>` itself.
- **Which fragment context element it is parsing into.** This applies to `innerHTML`, `setHTML()`, and streaming fragment parsing.

The platform already uses this state. Built-in elements such as `<script>`, `<style>`, and `<object>` run their processing when the parser pops them from the stack of open elements. When the parser yields between network chunks, though, `MutationObserver` only sees half of what happened. It reports an element in `addedNodes` as soon as the parser reads its start tag. It never says whether that element is still open or when it closes.

This explainer argues for reflecting that existing parser state to developers. There are three reasons:

1. **The browser already computes it.** The information exists in every engine's parser, and exposing it adds no new concepts to the platform.
2. **Developers already depend on it.** Libraries, frameworks, and production streaming systems rebuild it in JavaScript today with sentinel nodes, inline scripts, ancestor walks, regexes over raw HTML, and per-element observers. These workarounds cost measurable main-thread time and add bytes to the wire (see [Existing workarounds](#existing-workarounds)).
3. **It can be shaped to fit the existing reactive model.** A long-standing concern ([WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)) is that a "parsing finished" signal would lead authors to initialize once from parsed children and ignore later dynamic updates. To address it, the main proposal is an opt-in (`{ parser: true }`) on `MutationObserver`, which developers already use to react to dynamic DOM changes, plus `Element.isParsing`. A custom element `parsedCallback()` is discussed as a possibly acceptable companion (see [section 4](#4-custom-elements-is-parsedcallback-ok-too)), given that libraries already polyfill exactly that callback at significant cost.

---

## Prior Discussions

- **Element parse completion & streaming state**:
  - [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809), [#619](https://github.com/WICG/webcomponents/issues/619), [#550](https://github.com/WICG/webcomponents/issues/550): callbacks/notifications when the HTML parser finishes parsing an element's children
  - [whatwg/dom#662](https://github.com/whatwg/dom/issues/662): custom element callback/promise for "connected and parsed"
  - [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116): observing parse completion when streaming into a detached document
  - [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) & [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578): reflecting whether an element is open on the parser stack (`isParsing` / `:parsing`)
- **Parser-consumed `<template>` reflection**:
  - [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) & [#1439](https://github.com/whatwg/dom/issues/1439): observing shadow root attachment (especially Declarative Shadow DOM, which bypasses `Element.prototype.attachShadow()`)
  - [whatwg/html#13008](https://github.com/whatwg/html/issues/13008), [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110), [#104](https://github.com/WICG/declarative-partial-updates/issues/104), [#103](https://github.com/WICG/declarative-partial-updates/issues/103), [#21](https://github.com/WICG/declarative-partial-updates/issues/21) & [#26](https://github.com/WICG/declarative-partial-updates/pull/26): reflection, lifecycle, and failure semantics of `<template for>`
  - [whatwg/html#11818](https://github.com/whatwg/html/pull/11818) & [#13075](https://github.com/whatwg/html/issues/13075): `<template for>` parser specification and interaction with `shadowrootmode`
- **Streaming HTML insertion & parser text batching**:
  - [whatwg/html#12758](https://github.com/whatwg/html/pull/12758), [#12753](https://github.com/whatwg/html/pull/12753), [#12624](https://github.com/whatwg/html/pull/12624), & [#12756](https://github.com/whatwg/html/pull/12756): streaming HTML insertion (`streamHTML*`), positional insertion, direct fragment root insertion, and sanitizing while parsing
  - [whatwg/html#12744](https://github.com/whatwg/html/issues/12744): parser `Text` node data modification and `MutationObserver` batching

---

## The Problem: Parser state is real, but invisible

### `addedNodes` fires on the start tag, while the element may still be open

When the parser processes `<article><h1>Title</h1><p>Body</p></article>`, it inserts `<article>` into its parent as soon as it reads the `<article>` start tag. If a network chunk boundary falls before `</article>` and a microtask checkpoint runs, a `MutationObserver` gets `<article>` in `addedNodes` while its children are missing or incomplete:

```js
const mo = new MutationObserver(records => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node instanceof HTMLElement && node.matches("article")) {
        // <article> may still be open on the parser's stack:
        // its <h1> and <p> may not have arrived yet.
        enhanceArticle(node);
      }
    }
  }
});
mo.observe(document, { childList: true, subtree: true });
```

This isn't specific to custom elements, and it isn't about avoiding reactivity. For imperative DOM construction, `MutationObserver` already batches work: `el.append(a); el.append(b); el.append(c);` in one task produces records that are delivered after all three calls have run. The parser is the only common source of DOM mutations that can hand an observer a half-built subtree, because it yields mid-element across network chunks. Today the observer has no way to tell these cases apart. It can't know whether the element it was just handed is complete, or whether the parser will keep appending to it.

`requestAnimationFrame`, `setTimeout`, and "wait for the next mutation" heuristics all fail for the same reason: the parser can yield, render, and spin the event loop in the middle of an element ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1457018630), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455818744)).

### Existing workarounds

Because the parser state isn't exposed, developers rebuild it. These are the patterns found in the wild:

| Workaround | Where | What it reconstructs | Cost |
|---|---|---|---|
| **Ancestor `nextSibling` walk + a `subtree: true` `MutationObserver` per element** | [`WebReflection/html-parsed-element`](https://github.com/WebReflection/html-parsed-element/blob/main/index.js), used by component libraries such as [`svelte-retag`](https://github.com/patricknelson/svelte-retag/issues/20#issuecomment-1848262955) | "Has this element's end tag been parsed?", inferred as "does this element or any ancestor have a next sibling yet?" | One observer per pending element, each re-walking ancestors on every insertion beneath its parent. Reported at hundreds of milliseconds of main-thread time on medium-sized documents. An element that is the last child stays "unparsed" until `DOMContentLoaded`. |
| **Regex over the raw HTML chunk + `document.write()` into a detached document or hidden `<iframe>`** | [`marko-js/writable-dom`](https://github.com/marko-js/writable-dom/blob/main/src/index.ts) | "Is this inline `<script>`/`<style>` still open?", via `!(node.nextSibling \|\| /<\/\w+>$/.test(curChunk))` | Couples DOM logic to raw chunk text, and needs an `<iframe>` fallback where detached documents strip scripts. |
| **Nested `MutationObserver`s + ancestor scans on every opening tag** | Production MPA-to-SPA streaming navigation ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1755787377), [(follow-up)](https://github.com/WICG/webcomponents/issues/809#issuecomment-2087913895), [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)) | "Is this `<script>` complete, so moving and running it won't throw a `SyntaxError`?" and "Is this subtree complete, so its entry animation won't run on a half-empty box?" | **100ms+ of `MutationObserver` time on a modern laptop** for a complex page, and more on mobile. The authors describe having to "hackily reproduce the logic in JS" when "the browser already knows what we need". |
| **Sentinel child elements** (`<my-el>…<the-end></the-end></my-el>`) or `onload`/`onerror` probes inside the element | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534115603), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1456790982) | "The parser has reached the end of my children", signaled by a dummy node whose `connectedCallback` fires last and then removes itself | Extra markup per instance. Authors must control the markup inside the element. |
| **A trailing inline `<script>` after the element or streamed region** | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-532525717). The same shape appears in streaming SSR, where completed regions are followed by an inline script that processes the content above it. | "Everything before this script has been parsed" | An extra inline script per region, which adds wire bytes and needs CSP nonces/hashes or `unsafe-inline`. |
| **Deferring `customElements.define()` to `DOMContentLoaded`**, or `setTimeout`/`requestAnimationFrame` in `connectedCallback` | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-737669670), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455481698), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534119444) | An approximation of "the parser is done" | Waits for the entire document, or races the parser and occasionally sees partial content. |

Each of these workarounds encodes the same fact: *the parser has popped this element from its stack of open elements*. The browser already has that fact and discards it.

### The same gap applies to parser-consumed `<template>`s and fragment parsing

- **`<template shadowrootmode>` (Declarative Shadow DOM)**: Attaching a declarative `ShadowRoot` doesn't call `attachShadow()` and doesn't queue any `MutationRecord` on the host ([whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287)). Polyfills, auto-loaders, DevTools, and hydration observers watching `document` with `subtree: true` can't discover declarative shadow roots as they are attached.
- **`<template for>` ([whatwg/html#13008](https://github.com/whatwg/html/issues/13008), [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110))**: An observer sees fallback nodes removed and new nodes inserted. It can't tell that a `<template for>` caused these mutations, can't read the template's attributes, and can't correlate mutations from one patch across chunks. A truncated patch, cut off at EOF before `</template>`, looks the same as a complete one ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)). In practice, authors "guess" that a patch was applied by watching for processing instructions to be removed, which [#13008](https://github.com/whatwg/html/issues/13008) describes as "lossy and costly". One team reported building a separate document-level patch feed to recover this information ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)).
- **Fragment parsing (`streamHTML*`, `setHTML`, `innerHTML`)**: Mutations inside nested elements report their immediate parent as `record.target`. A document-level observer can't attribute them to the fragment context element being parsed into.

### Goals

- Reflect existing parser state (element completion, active parser-consumed `<template>`, and fragment context element) on the `MutationRecord`s the parser already produces.
- Remove the need for the workarounds above, with **zero cost when unused** and **no extra records** when elements open and close within the same chunk ([w3c/csswg-drafts#12578 (comment)](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209456796)).
- Fit the existing reactive model: the main surface is `MutationObserver`, which already handles imperative and dynamic changes.
- Never coalesce records from a parser-consumed `<template>` with unrelated mutations ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)).
- Keep `MutationRecord` flat and preserve `MutationRecord.type` (`"attributes" | "characterData" | "childList"`).

### Non-Goals

- **Discouraging incremental rendering.** Elements and observers should still react to children as they arrive. This proposal lets them tell "still being parsed" apart from "complete" while they do so.
- **Buffering parser output until an end tag**: Streaming into the DOM as bytes arrive is unchanged.
- **Tracking completion of non-element nodes** (`Text`, `Comment`, `ProcessingInstruction`).
- **Sub-microtask timing / RUM**: If needed, this can be layered on separately with a `PerformanceEntry`.

---

## Proposed Approach

A single boolean option, `parser: true` in `MutationObserverInit`, opts an observer into four new readonly properties on `MutationRecord`:

- `record.parsedElements`: A `NodeList` of `Element`s that finished parsing. An element finishes when it is popped from the stack of open elements, or immediately on insertion for void/self-closing elements.
- `record.templateAttributes`: A `NamedNodeMap?` containing the attributes of the active parser-consumed `<template>` (`<template shadowrootmode>` or `<template for>`), or `null`.
- `record.templateStatus`: `"start" | "update" | "end" | "abort"`, or `null`.
- `record.parserContextElement`: The parser's fragment context element (`Element?`), or `null`.

A companion `Element.isParsing` (and `ShadowRoot.isParsing`) lets code query the same state synchronously.

### Example Usage

```js
const mo = new MutationObserver(records => {
  for (const r of records) {
    // 1. Act on elements once the parser has closed them:
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

Compared with the workarounds above, this replaces per-element observers, ancestor walks, sentinel nodes, and chunk regexes with a single observer that reads state the parser already tracks.

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

partial interface Element {
  readonly attribute boolean isParsing;
};

partial interface ShadowRoot {
  readonly attribute boolean isParsing;
};
```

### 1. Element completion and coalescing (`parsedElements`)

Every parser-inserted `Element` appears in `parsedElements` once the parser finishes parsing it. That happens when the element is popped from the stack of open elements (via an explicit end tag, an implied end tag, or parser termination), or immediately after insertion for void and self-closing foreign elements:

- **Same-chunk coalescing (zero extra records):** In the common case, an element opens *and* closes before the observer's record queue is flushed. For example, `<p>Hello <span>world</span></p>` arrives in one network chunk, and void/self-closing elements like `<img>`, `<br>`, and `<svg/>` always behave this way. The element is then appended to `parsedElements` on the pending `childList` record that already holds it in `addedNodes`. Because every completed element appears in `parsedElements`, consumers that want to process parsed elements only need to iterate `r.parsedElements`, with no special case for void elements.
- **Cross-chunk coalescing:** `record.target` is always the parent of the elements in `parsedElements`, just as for `addedNodes`. Suppose `<article>` opens in chunk 1 (`addedNodes: [article], parsedElements: []`, with `article.isParsing === true`) and closes in chunk 2. In chunk 2 it is appended to `parsedElements` on the pending `childList` record for `article.parentNode`. If no such record exists, a `childList` record on `article.parentNode` is queued with `addedNodes: [], removedNodes: [], parsedElements: [article]`. Either way, it coalesces with any sibling elements under the same parent that also finished parsing in that chunk.
- **Non-mixing guarantee across `<template>` boundaries ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** `parsedElements` only coalesces into a pending record that shares the exact same `(target, parserContextElement, templateAttributes, templateStatus)`. Records from a `<template>` never merge with records from outside that `<template>` or from a different `<template>`.
- **Elements disconnected mid-parse ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662)) or discarded by the sanitizer ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)):** A script may remove an open element from the observed tree before its closing tag is parsed. The parser's sanitizer configuration may also discard an element so it never enters the target tree. In either case, popping the element from the stack of open elements doesn't emit it in `parsedElements` for observers of that tree.

### 2. Parser-consumed `<template>` elements (`templateAttributes` & `templateStatus`)

Whenever the HTML parser processes a `<template shadowrootmode>` or `<template for>` element:

| Phase | `<template shadowrootmode="open">` | `<template for="r">` |
|---|---|---|
| **`"start"`** | Record on the shadow host with `addedNodes: [shadowRoot]`. | Record on the patch target removing `<?start>` and fallback nodes. If the patch targets `<?marker>`, the record has empty `addedNodes`/`removedNodes` and `nextSibling: <?marker>`. |
| **`"update"`** | All `childList` and `characterData` records performed inside `shadowRoot` (for observers observing `shadowRoot`). | All `childList` and parser-flushed `characterData` records ([whatwg/html#12744](https://github.com/whatwg/html/issues/12744)) performed inside the patch. |
| **`"end"`** | Record on the shadow host when `</template>` is reached. | Record on the patch target removing `<?end>` or `<?marker>` when `</template>` is reached, plus any `parsedElements` that closed at `</template>`. |
| **`"abort"`** | Record on the shadow host if EOF or `writer.abort()` occurs before `</template>`. If attaching the shadow root failed ([whatwg/html#13075](https://github.com/whatwg/html/issues/13075)), it goes on the fallback `<template>` insertion record instead. | Record on the patch target if EOF or `writer.abort()` occurs before `</template>` ([WICG/declarative-partial-updates#104](https://github.com/WICG/declarative-partial-updates/issues/104)), or if a script displaces the target marker mid-stream ([whatwg/html#11818](https://github.com/whatwg/html/pull/11818)). If the target marker wasn't found at `<template>` start, it goes on the fallback `<template>` insertion record instead. |

- **Per-attempt correlation identity ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** All `"start"`, `"update"`, and `"end"`/`"abort"` records generated by a single `<template>` invocation return the **same `NamedNodeMap` instance** (`r1.templateAttributes === r2.templateAttributes`). Observers can correlate all records of one invocation by object identity (`===` / `WeakMap`), even when the author didn't put a unique `id` or `data-*` attribute on the `<template>`.
- **Empty patches (`<template for="r"></template>`):** These still emit both `"start"` (when `<template for="r">` opens) and `"end"` (when `</template>` removes `<?end>` or `<?marker>`). This gives every patch a terminal record even when it inserts no nodes.

#### Walkthrough A: `<template for>` across two network chunks

Given `<section><?start name="r">Loading…<?end></section>`, suppose `main.streamAppendHTML(...)` receives chunk 1 (`<template for="r" data-turn="3"><p>H`) followed by chunk 2 (`i<span>!</span></p></template>`):

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

When `<template for="r" data-turn="3"><p>Hi</p></template>` targets a single `<section><?marker name="r"></section>`, no nodes are removed at `<template>` start. `<?marker>` stays in place as the insertion point until `</template>` removes it:

| # | `type` | `target` | `removedNodes` | `addedNodes` | `parsedElements` | `nextSibling` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|---|
| 1 | `childList` | `<section>` | `[]` | `[]` | `[]` | `<?marker>` | `[for="r", data-turn="3"]` | `"start"` |
| 2 | `childList` | `<section>` | `[]` | `[<p>]` | `[<p>]` | `<?marker>` | `[for="r", data-turn="3"]` | `"update"` |
| 3 | `childList` | `<p>` | `[]` | `["Hi"]` | `[]` | `null` | `[for="r", data-turn="3"]` | `"update"` |
| 4 | `childList` | `<section>` | `[<?marker>]` | `[]` | `[]` | `null` | `[for="r", data-turn="3"]` | `"end"` |

*(Observers that didn't specify `parser: true` never receive record #1, or any other record whose `addedNodes` and `removedNodes` are both empty.)*

### 3. Fragment parsing context (`parserContextElement`) and `Element.isParsing`

When the HTML parser runs with a fragment context element, every record it produces has `parserContextElement` set to that `Element`. This covers `el.streamHTML()`, `el.streamAppendHTML()`, `child.streamAfterHTML()`, `el.setHTML()`, `el.innerHTML`, and `<template for>` with a context element. For top-level document parsing, which has no fragment context element, `parserContextElement` is `null`.

`Element.isParsing` (and `ShadowRoot.isParsing`) reflects whether an HTML parser is actively parsing into the node. It is `true` while the element is on a parser's stack of open elements. It is also `true` while a streaming fragment parser (`streamHTML*`) with that element as its fragment context element is alive, until the stream closes or aborts.

### 4. Custom elements: is `parsedCallback()` OK too?

The `MutationObserver` surface above is the core of this proposal. Whether custom elements should also get a lifecycle callback deserves a careful look, because this is where most of the objections in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809) were focused.

**The concern: authors ignoring dynamic updates.** The main objection in #809 is that an end-tag callback invites a specific mistake. An author reads `this.children` once in `parsedCallback()`, builds their UI from it, and never looks at children again. That element would work in a static server-rendered page, but it would break in several situations:

- **It's created imperatively.** `document.createElement("my-list")` followed by `append()` calls never involves the parser. The author can't know when the `append()` calls will stop, so there's no natural moment to "initialize from children" ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1757047993)).
- **Its children change after parsing.** Children can be added, removed, or replaced by script, by `<template for>` patches, or by a framework re-render. A parse-once element would silently ignore those changes.
- **It's inserted in a different order.** It may be inserted before its children are attached, or moved between documents.

Built-in elements meet a higher bar. A `<select>` works however its `<option>`s arrive and keeps working as they change. Custom elements are expected to meet the same bar: "If you cannot handle dynamic insertion and mutation of those insertions, how can you claim to be a proper element?" ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1460917211), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1463846026)). A related point is that end-tag hooks in built-in elements are rare, and they cost parser performance.

We agree with the principle: elements and observers should handle dynamic updates. The question is whether exposing parser completion works against that principle or supports it.

**Why the `MutationObserver` shape largely avoids this concern.** An observer using `{ childList: true, parser: true }` is already reacting to dynamic mutations. `parsedElements` only annotates records it already receives. As noted above, imperative construction already reaches observers as complete batches. `parsedElements`/`isParsing` add the one missing signal, for the one case where the parser hands over a partial subtree. That makes parser-driven and script-driven construction look *more* alike to reactive code.

**Why a `parsedCallback()` might be acceptable as well.** The evidence above suggests that custom element authors aren't deciding *whether* to wait for parse completion. They already do, and the question is how expensively. [`html-parsed-element`](https://github.com/WebReflection/html-parsed-element) is a userland polyfill of a callback literally named `parsedCallback`. It installs a `subtree: true` `MutationObserver` on the parent of every pending element and walks ancestors on each mutation. Sentinel children, trailing scripts, and deferred `define()` calls serve the same purpose. A native callback would:

- replace one observer per element instance with a check the parser already performs when popping an element, and
- give authors who already rely on this pattern a correct signal, instead of one that misfires for the last child or races the parser.

The footgun concern could be mitigated by how the callback is defined, rather than by withholding it. For example:

- **Always fire it once per connection, regardless of how the element was created.** If the element is connected while `isParsing` is `false` (imperative creation, `innerHTML`, upgrade after parsing), `parsedCallback()` is enqueued right after `connectedCallback()`. If it is connected while `isParsing` is `true`, the callback is enqueued when the parser (or the streaming fragment parser targeting it) finishes. Authors then have one place to put "children are ready" logic, and that logic runs for parser-created and script-created elements alike. Later changes still go through `MutationObserver` or `slotchange`, as they do today.
- **Document the callback as an initial-construction signal, not a substitute for observing changes.**

```js
class MyWidget extends HTMLElement {
  parsedCallback() {
    // Runs once per connection after initial children are present:
    // immediately after connectedCallback() for script-created elements,
    // or when the parser closes the element for parser-created ones.
    this.#render();
    this.#observer ??= new MutationObserver(() => this.#render());
    this.#observer.observe(this, { childList: true, subtree: true });
  }
}
```

We'd like feedback on whether a callback with these semantics addresses the concerns raised in #809, or whether the `MutationObserver` surface plus `isParsing` should stand on its own.

A related but separate reaction, `shadowRootAttachedCallback(shadowRoot)`, isn't parser-specific. It would fire for both `attachShadow()` and `<template shadowrootmode>`, and it fills the Declarative Shadow DOM observation gap in [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) for custom elements.

---

## Alternatives Considered

### 1. Status quo: keep reconstructing parser state in userland

As shown in [Existing workarounds](#existing-workarounds), this is possible but costly. Per-element observers and ancestor walks have been measured at 100ms+ of main-thread time. Sentinel nodes and trailing scripts add bytes to the wire and need CSP nonces. Heuristics misfire for the last child of a container or race the parser. The workarounds also can't recover information that never reaches the DOM, such as `<template>` attributes, patch aborts, and the fragment context element.

### 2. New `MutationRecord.type` values (`"parseEnd"`, `"templateStart"`, `"templateEnd"`, `"templateAbort"`)

An earlier iteration expressed template boundaries and element completion as distinct `MutationRecord.type` values. This had two major drawbacks:
- **It separated nodes from `<template>` metadata:** With `templateAttributes` on a zero-node `"templateStart"` record, the later `childList` records carrying `addedNodes` had no direct reference to the `<template>`'s attributes. Every observer callback would have had to maintain a stateful `Map` across records.
- **Record bloat for `parseEnd`:** Emitting a separate `{ type: "parseEnd", target: el }` record for every closing tag doubles the number of `MutationRecord`s per parsed chunk. Expressing completion via `parsedElements` on `childList` records lets same-chunk opens and closes coalesce onto existing records with no extra allocations.

### 3. Exposing the detached `HTMLTemplateElement` on `MutationRecord`

`MutationRecord` could expose `record.template`, pointing to the detached `HTMLTemplateElement` created by the parser, instead of `templateAttributes` (`NamedNodeMap`). We rejected this because it retains a live parser-internal element whose `.content` was bypassed, and it invites developers to mutate it or insert it into the DOM. A read-only `NamedNodeMap` of its attributes provides everything the author wrote without leaking the element.

### 4. Separate `MutationObserverInit` flags (`parsedElements`, `template`, `templateAttributeFilter`) and `templateFor`

We considered separate opt-in booleans for element completion and template metadata, an `attributeFilter`-style `templateAttributeFilter`, and a dedicated `record.templateFor` string. A single `parser: true` option was simpler for two reasons. First, a `<template>` start tag is parsed once and typically carries only 1–3 attributes, so filtering isn't needed the way `attributeFilter` is for high-frequency `style`/`class` changes. Second, `for` and `shadowrootmode` are themselves attributes, so `templateAttributes` covers both template kinds without extra members.

### 5. Including `Text`, `Comment`, and `ProcessingInstruction` in `parsedNodes`

Comments, processing instructions, and doctypes are atomic tokens, and `Text` nodes already report streaming appends via `characterData` records. Including non-element nodes added noise, so `parsedElements` is scoped to `Element`s.

### 6. Firing DOM Events (`parseend`, `templatestart`, `templateend`)

Dispatching events for every parsed element during tree construction has the same performance hazards that led the platform to deprecate `MutationEvent`. Batching parser state into `MutationObserver`'s existing microtask record queue avoids per-element dispatch.

---

## Frequently Asked Questions (Q&A)

### Q1: Does popping elements from the parser stack add overhead to the HTML parser?
In browser engines ([w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209456796), [whatwg/dom#662](https://github.com/whatwg/dom/issues/662)), popping an element from the stack of open elements is a fast pointer pop unless the element or tree requires end-tag notification. Two design choices keep it fast:
1. **Zero cost when `parser: true` is unused:** A per-tree flag ("has a `parser: true` observer") gates the check entirely, so documents without such an observer pay nothing on end-tag pops.
2. **Same-chunk coalescing avoids extra allocations:** When an element opens and closes in the same chunk (including all void elements), `parsedElements` appends onto the already-queued `childList` record for that parent.

The relevant comparison is the userland reconstruction this replaces, which does strictly more work: an observer callback plus ancestor walks for every insertion.

### Q2: Doesn't this encourage authors to ignore dynamic updates, or to write elements that only work with parser-created content?
This is the main concern from [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809), discussed in detail in [section 4](#4-custom-elements-is-parsedcallback-ok-too). For the `MutationObserver` surface, the answer is no. `parsedElements` annotates records that observers of dynamic changes already receive, so an author using it is already subscribed to later insertions, removals, and patches. For script-created content, `parsedElements` arrives in the same batch as `addedNodes`, because the element was never left open. Today's workarounds (per-element observers that disconnect once the element looks "parsed") are more likely to lead to parse-once behavior than a signal built into the reactive API.

### Q3: Why use `NodeList` (`parsedElements`) and `NamedNodeMap` (`templateAttributes`) instead of `FrozenArray`?
The [Web Platform Design Principles (§9.4)](https://www.w3.org/TR/design-principles/#collections) generally prefer `FrozenArray` for new APIs. We chose otherwise here for two reasons:
- `MutationRecord.addedNodes` and `removedNodes` are already `NodeList`s, so `NodeList` for `parsedElements` matches the rest of the interface.
- `NamedNodeMap` gives ergonomic lookup by attribute name (`r.templateAttributes.getNamedItem("for")?.value`). Each `Attr` in it has `ownerElement === null`, and calling mutating methods on it throws `NoModificationAllowedError`.

### Q4: Doesn't putting a `ShadowRoot` in `addedNodes` violate the invariant that `addedNodes` are children of `target`?
`addedNodes: [shadowRoot]` is only populated for observers that opt into `{ parser: true }`, on a `"start"` record whose `templateAttributes` contains `shadowrootmode`. Existing observers are unaffected. If reviewers prefer, `addedNodes` can stay `[]` on that record, and observers can read `r.target.shadowRoot` instead.

### Q5: What is `record.target` for `parsedElements`, and how does it interact with `subtree`?
`record.target` is always the `parentNode` of the elements in `record.parsedElements`, matching `addedNodes`. With `subtree: false`, an observer only receives `parsedElements` for direct children of the observed node. With `subtree: true`, suppose `</p></article></section>` closes across a chunk boundary. Each parent whose children finished parsing then queues or coalesces its own record: `target: <article>, parsedElements: [<p>]`, `target: <section>, parsedElements: [<article>]`, and so on.

### Q6: What happens with foster parenting and the adoption agency algorithm?
- **Foster parenting (`<table><div>...</div></table>`):** When `</div>` is popped, the record's `target` is `div.parentNode` at that time, provided `div` is still connected.
- **Adoption agency (`<b><i>Bold </b>italic</i>`):** When `</b>` is parsed, the original `<i>` and `<b>` are popped and appear in `parsedElements`. The cloned `<i>` appears when `</i>` is reached.

### Q7: Do synchronous parsing APIs (`innerHTML`, `setHTML`) emit `parsedElements`?
Yes, when the target is observed with `{ childList: true, parser: true }`. Synchronous parsing finishes before the microtask checkpoint, so every element opens and closes in the same batch and no additional records are created. Detached trees (`DOMParser`, `createContextualFragment`) have no active observers during parsing.

### Q8: Why not use DOM Events or a dedicated `PatchObserver` for `<template for>`?
Consumers such as hydration frameworks, form-state preservation ([WICG/declarative-partial-updates#103](https://github.com/WICG/declarative-partial-updates/issues/103)), and progressive enhancers need the exact `removedNodes` and `addedNodes` together with the `<template>` metadata. Separate events or observers would split the lifecycle from the node mutations.

### Q9: How does `parser: true` interact with `observe()` option validation?
`parser: true` augments `childList` (and `characterData`) records rather than introducing a standalone record type. It therefore requires `childList: true`, and passing it with `childList: false` throws a `TypeError`.

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   It doesn't expose new user or cross-origin information. Everything surfaced by `parser: true` (`parsedElements`, `<template>` attributes on `templateAttributes`, `templateStatus`, and `parserContextElement`) comes from HTML markup being parsed into a DOM subtree that the caller can already observe.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes:
   - **Closed shadow roots (`<template shadowrootmode="closed">`):** `addedNodes` on the shadow host record only exposes the `ShadowRoot` when `shadowrootmode` is `"open"`. For `"closed"`, `addedNodes` stays empty, so closed shadow roots never leak to observers of the outer tree.
   - **Sanitize-while-parsing ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)) & CSP nonces ([WICG/declarative-partial-updates#111](https://github.com/WICG/declarative-partial-updates/issues/111)):** `templateAttributes` only reflects attributes that survived the parser's sanitizer configuration. Any `nonce` attribute follows standard nonce hiding.

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
    No. `MutationObserver` callbacks run at the standard microtask checkpoint. Any custom element reactions (`parsedCallback()`, `shadowRootAttachedCallback()`) would run via the standard custom element reaction queue.

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
    Nothing beyond existing `MutationObserver` behavior.

19. **What happens when a document that uses your feature gets disconnected?**
    If an observed element is disconnected while still open on the parser stack, popping it doesn't emit it in `parsedElements` for observers of the outer tree.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Parser-aborted `<template>` operations (EOF before `</template>`, missing target markers, or failed declarative shadow root attachment) are reported via `templateStatus: "abort"` rather than exceptions.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.
