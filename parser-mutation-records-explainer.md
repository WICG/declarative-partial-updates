# Explainer: Parser-Aware `MutationObserver` Records

## Introduction

The HTML parser tracks state that never appears in the DOM:

- **Which elements are still open** on the [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements), and when each one is popped (by an explicit end tag, an implied end tag, or EOF).
- **Which parser-consumed `<template>` is active** (`<template shadowrootmode>` or `<template for>`), which redirects content into a target without inserting the `<template>` itself.
- **Which fragment context element it is parsing into** (`innerHTML`, `setHTML()`, or streaming fragment parsing).

Built-in elements like `<script>`, `<style>`, and `<object>` already rely on this state to act when the parser closes them. `MutationObserver`, however, only sees half of what the parser does: it reports an element in `addedNodes` on its start tag, without indicating whether the element is still open on the parser stack or when it closes.

When markup is primarily driven from the server (SSR, streaming HTML, or declarative updates), client code needs **client-side reflection of server-driven UI** across two dimensions:
- **Hydration & subtree readiness (`parseEnd` / `isParsing`):** Knowing when a server-streamed element or island has received its closing tag so components, morphers, and animations don't act on half-streamed subtrees.
- **Flow control & error recovery (`template`):** Knowing when a server-streamed `<template for>` patch starts, updates, finishes cleanly, or aborts mid-stream (e.g., on network truncation or a missing target), along with its server metadata attributes.

**Not exposing this state pushes that weight onto the client**: applications must either move DOM construction and update orchestration into client-side JavaScript, or ship client-side workarounds to reconstruct what the parser already knows.

This explainer proposes reflecting that existing parser state for three reasons:

1. **The browser already computes it**, so exposing it adds no new concepts to the parser.
2. **Server-driven and streaming apps already depend on it**, reconstructing it today with sentinel nodes, inline scripts, ancestor walks, regexes over raw HTML, and per-element observers at measurable main-thread and wire cost (see [Existing workarounds](#existing-workarounds)).
3. **It fits the existing reactive model.** To address the concern ([WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)) that a "parsing finished" hook might tempt authors to ignore later dynamic updates, the primary API consists of opt-in flags (`{ parseEnd: true, template: true }`) on `MutationObserver`—which authors already use to observe ongoing DOM changes—plus `Element.isParsing`. A custom element `parsedCallback()` is also discussed as a potentially reasonable companion ([section 4](#4-custom-elements-is-parsedcallback-ok-too)).

---

## Prior Discussions

- **Element parse completion & streaming state**:
  - [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809), [#619](https://github.com/WICG/webcomponents/issues/619), [#550](https://github.com/WICG/webcomponents/issues/550): notifications when the HTML parser finishes parsing an element's children
  - [whatwg/dom#662](https://github.com/whatwg/dom/issues/662): custom element callback/promise for "connected and parsed"
  - [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116): observing parse completion when streaming into a detached document
  - [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) & [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578): reflecting whether an element is open on the parser stack (`isParsing` / `:parsing`)
- **Parser-consumed `<template>` reflection**:
  - [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) & [#1439](https://github.com/whatwg/dom/issues/1439): observing Declarative Shadow DOM attachment
  - [whatwg/html#13008](https://github.com/whatwg/html/issues/13008), [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110), [#104](https://github.com/WICG/declarative-partial-updates/issues/104), [#103](https://github.com/WICG/declarative-partial-updates/issues/103), [#21](https://github.com/WICG/declarative-partial-updates/issues/21) & [#26](https://github.com/WICG/declarative-partial-updates/pull/26): reflection, lifecycle, and failure semantics of `<template for>`
  - [whatwg/html#11818](https://github.com/whatwg/html/pull/11818) & [#13075](https://github.com/whatwg/html/issues/13075): `<template for>` parser specification and interaction with `shadowrootmode`
- **Streaming HTML insertion & parser text batching**:
  - [whatwg/html#12758](https://github.com/whatwg/html/pull/12758), [#12753](https://github.com/whatwg/html/pull/12753), [#12624](https://github.com/whatwg/html/pull/12624), & [#12756](https://github.com/whatwg/html/pull/12756): streaming HTML insertion (`streamHTML*`), positional insertion, direct fragment root insertion, and sanitizing while parsing
  - [whatwg/html#12744](https://github.com/whatwg/html/issues/12744): parser `Text` node data modification and `MutationObserver` batching

---

## Use Cases & Problem Statement

### 1. Hydration & subtree readiness (`addedNodes` fires on the start tag)

When the parser processes `<s-select><s-option>A</s-option><s-option>B</s-option></s-select>`, it inserts `<s-select>` as soon as it reads the start tag. If the parser yields between network chunks before `</s-select>`, a `MutationObserver` receives `<s-select>` in `addedNodes` while its children are still missing or incomplete:

- **Evaluate content once ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)):** Elements that interpret text, configuration, or inline code (syntax highlighters, math/markdown blocks, or streamed `<script>` elements moved from a detached document) fail with syntax or parse errors when evaluated on a chunk boundary before the closing tag arrives.
- **Batch child setup and validation ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)):** Custom elements that validate, index, or slot light-DOM children (such as `<s-select>` validating `<s-option>` children or data tables indexing rows) emit false validation warnings or perform redundant $O(N^2)$ work if they run on the opening tag or on every chunk.
- **Animate or reveal complete subtrees ([whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116), [whatwg/html#12200](https://github.com/whatwg/html/issues/12200), [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578)):** Triggering View Transitions, WAAPI animations, or progressive DOM swaps on an element that is still open on the parser stack causes half-rendered layout shifts.

When the DOM is built on the client (`el.append(a); el.append(b);`), `MutationObserver` delivers records after all synchronous calls in the task have completed. When markup is streamed from a server, the parser can yield mid-element across network chunks, handing observers a half-built subtree with no indication that more children are still being parsed into it. `requestAnimationFrame` and `setTimeout` heuristics fail for the same reason: the parser can yield and spin the event loop in the middle of an element ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1457018630), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455818744)).

### 2. Patch attribution, flow control, and error recovery (`<template for>`)

In streaming UIs that update multiple regions via `<template for>` ([whatwg/html#13008](https://github.com/whatwg/html/issues/13008), [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)), standard `MutationObserver` records show individual node insertions and removals, but lose the patch lifecycle:

- **Attribution:** Separating parser-owned patch mutations from client-side UI or framework mutations happening nearby, and reading server metadata attributes off the `<template>` (e.g., `data-turn="3"` or request IDs) to correlate chunks.
- **Flow control:** Knowing when a streamed patch starts clearing fallback content (`"start"`) and when it finishes (`"end"`) to trigger hydration, focus management, or scroll adjustments.
- **Error recovery:** Detecting when a patch fails (`"abort"`) because the target marker was missing or the network stream was truncated at EOF before `</template>` ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)), even when zero DOM nodes were mutated, so the application can surface retry or fallback UI.

### 3. Observing Declarative Shadow DOM (`<template shadowrootmode>`)

Document-wide observers need to discover shadow roots as they are attached ([whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287), [#1439](https://github.com/whatwg/dom/issues/1439)):

- **Component autoloaders:** Lazy-loading custom element definitions (e.g., Web Awesome / Shoelace autoloaders) when custom element tags appear inside open shadow trees.
- **Accessibility & DOM auditing:** Running live accessibility checks (e.g., Accented) across open shadow roots as markup streams in.
- **SSR shadow-root hydration:** Knowing when a declarative `ShadowRoot` is attached (`"start"`) and when its streamed contents finish parsing (`"end"`), or detecting when declarative shadow root attachment fails ([whatwg/html#13075](https://github.com/whatwg/html/issues/13075)).

Today, libraries monkey-patch `Element.prototype.attachShadow()` to discover shadow roots, which completely misses `<template shadowrootmode>` because the parser attaches the `ShadowRoot` without calling `attachShadow()` or queueing any `MutationRecord` on the host.

### 4. Fragment parsing context (`streamHTML*`, `setHTML`, `innerHTML`)

Descendant mutations inside a fragment parse report their immediate parent as `record.target`, losing which fragment context element is actively receiving streamed input.

### Existing workarounds

Because parser state isn't exposed, server-driven and streaming applications must shift extra work to the client to reconstruct it:

| Workaround | Where | What it reconstructs | Cost |
|---|---|---|---|
| **Ancestor `nextSibling` walk + a `subtree: true` `MutationObserver` per element** | [`WebReflection/html-parsed-element`](https://github.com/WebReflection/html-parsed-element/blob/main/index.js), [`svelte-retag`](https://github.com/patricknelson/svelte-retag/issues/20#issuecomment-1848262955) | End-tag completion, inferred by checking whether the element or any ancestor has a `nextSibling` | One observer per pending element, re-walking ancestors on every insertion. Reported at hundreds of milliseconds of main-thread time on medium documents; last-child elements stay "unparsed" until `DOMContentLoaded`. |
| **Regex over raw HTML chunks + `document.write()` into a detached document / `<iframe>`** | [`marko-js/writable-dom`](https://github.com/marko-js/writable-dom/blob/main/src/index.ts) | Whether an inline `<script>`/`<style>` is still open (`!(node.nextSibling \|\| /<\/\w+>$/.test(curChunk))`) | Couples DOM logic to raw chunk strings and requires an `<iframe>` fallback where detached documents strip scripts. |
| **Nested `MutationObserver`s + ancestor scans on every opening tag** | Production MPA-to-SPA streaming navigation ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1755787377), [(follow-up)](https://github.com/WICG/webcomponents/issues/809#issuecomment-2087913895), [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)) | Whether a streamed `<script>` or animated subtree is complete before moving it into the live document | **100ms+ of `MutationObserver` time on a modern laptop** (more on mobile) to reproduce in JS what the parser already tracks. |
| **Sentinel child elements** (`<the-end>`) or `onload`/`onerror` probes | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534115603), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1456790982) | End of children, signaled by a dummy last child that removes itself on connect | Extra DOM nodes and markup per instance; requires control over inner markup. |
| **Trailing inline `<script>` after each element or streamed region** | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-532525717), streaming SSR frameworks | Completion of the preceding markup | Extra wire bytes per region and requires CSP nonces/hashes or `unsafe-inline`. |
| **Deferring `customElements.define()` to `DOMContentLoaded`**, or `setTimeout`/`requestAnimationFrame` | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-737669670), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455481698), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534119444) | An approximation of "the parser is done" | Delays upgrades until the entire document finishes, or races the parser across chunks. |

### Goals

- **Batch `MutationRecord`s across parser chunks per observer (`parseEnd: true`):** Extend `MutationObserver`'s synchronous-task batching across network chunk boundaries while an observed target is parsing (either its end tag has not been seen yet, or it is currently an active `streamHTML*` target), guaranteeing a callback at parse end—or at the next microtask checkpoint if already parsed—even when the element has empty children.
- **Reflect parser-consumed `<template>` lifecycle (`template: true`) and fragment context:** Expose `<template for>` and `<template shadowrootmode="open">` start/update/end/abort state and attributes alongside `addedNodes`/`removedNodes` ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)).
- Eliminate the client-side workarounds above with **zero cost when unused**.
- Keep `MutationRecord` flat and preserve `MutationRecord.type` (`"attributes" | "characterData" | "childList"`).

### Non-Goals

- **Discouraging dynamic mutation handling:** Elements and observers continue to observe ongoing DOM mutations after initial parse completion (and automatically batch future `streamHTML*` streams into the same target).
- **Buffering DOM insertion itself:** The parser still inserts nodes into the live DOM immediately as bytes arrive so rendering, preload scanning, and other observers are unaffected; batching is strictly per-observer on `MutationRecord` delivery.
- **Tracking non-element nodes**, or **replacing `PerformanceEntry` for sub-microtask RUM timing**.

---

## Proposed Approach

Two boolean options in `MutationObserverInit`—`parseEnd: true` and `template: true`—opt an observer into parser-aware behavior, paired with a synchronous `isParsing` getter on `Element` and `ShadowRoot`:

- `element.isParsing` / `shadowRoot.isParsing`: `true` while the node is parsing—meaning either its end tag has not yet been seen (it is on the parser's stack of open elements) or it is currently an active `streamHTML*` target—and `false` otherwise.
- **`parseEnd: true` (observer-specific batching while parsing + guaranteed flush):**
  - For an observer registration with `parseEnd: true`, while its observed target is parsing (end tag never seen, or currently an active `streamHTML*` target), `MutationRecord`s for that observer are **batched (held back)** across chunk boundaries instead of flushing at intermediate microtask checkpoints.
  - Batching is **observer-specific**: other observers (such as observers without `parseEnd: true`, or `parseEnd: true` observers on child elements whose end tags arrive earlier) are not held back and may therefore fire in a different order.
  - The observer is **guaranteed to fire** when parse end is reached—**or at the next microtask checkpoint if the target is already parsed** when `observe()` is called—emitting an empty `childList` record (`addedNodes: []`, `removedNodes: []`) if no child mutations were queued (e.g., `<my-widget></my-widget>` with empty children, or an already-parsed element).
- **`template: true` (`record.templateAttributes` & `record.templateStatus`):**
  - `record.templateAttributes`: `TemplateAttributeMap?` (a read-only `Map`-like map of attributes from the active parser-consumed `<template>` — `<template for>` or `<template shadowrootmode="open">`), or `null`.
  - `record.templateStatus`: `"start" | "update" | "end" | "abort"`, or `null`.
- `record.parserContextElement`: The parser's fragment context element (`Element?`), or `null` (populated when `parseEnd: true` or `template: true` is set).

### Example Usage

#### 1. Component / island readiness & ongoing mutations (`parseEnd: true`)

```js
class CustomSelect extends HTMLElement {
  #mo = new MutationObserver((records) => {
    // Runs once </custom-select> is parsed (with all streamed <option>s batched),
    // OR on the next microtask if already parsed (e.g. innerHTML, upgrade, createElement),
    // even if <custom-select></custom-select> has empty children.
    // Also runs on subsequent dynamic DOM changes—and batches future streamHTML() calls!
    this.#syncOptions(records);
  });

  connectedCallback() {
    this.#mo.observe(this, { childList: true, parseEnd: true });
  }

  disconnectedCallback() {
    this.#mo.disconnect();
  }
}
```

#### 2. Document-wide `<template for>`, Declarative Shadow DOM, and island hydration

```js
// Batches records per <article> until </article> (or fires on next microtask if already parsed):
const articleObserver = new MutationObserver((records) => {
  const ready = new Set(records.map((r) => r.target));
  for (const article of ready) enhanceArticle(article);
});

const docObserver = new MutationObserver((records) => {
  for (const r of records) {
    // 1. Discover <article> elements on start tag; delegate readiness to articleObserver:
    for (const node of r.addedNodes) {
      if (node instanceof Element && node.matches("article")) {
        articleObserver.observe(node, { childList: true, parseEnd: true });
      }
    }

    const attrs = r.templateAttributes;
    if (!attrs) continue;

    // 2. Discover and observe open declarative Shadow DOM (<template shadowrootmode="open">):
    if (attrs.get("shadowrootmode") === "open" && r.templateStatus === "start") {
      const shadowRoot = r.addedNodes[0];
      if (shadowRoot) {
        docObserver.observe(shadowRoot, {
          childList: true,
          subtree: true,
          template: true,
        });
      }
    }

    // 3. Track <template for> lifecycle and read custom attributes from the <template>:
    const forTarget = attrs.get("for");
    if (forTarget) {
      const turn = attrs.get("data-turn");
      switch (r.templateStatus) {
        case "start":  onPatchStart(r.target, forTarget, turn); break;
        case "update": if (r.type === "childList") onPatchNodes(r.addedNodes, turn); break;
        case "end":    onPatchEnd(r.target, forTarget, turn); break;
        case "abort":  onPatchAbort(r.target, forTarget, turn); break;
      }
    }
  }
});

docObserver.observe(document, {
  subtree: true,
  childList: true,
  characterData: true,
  template: true,
});
```

### Web IDL

```webidl
partial dictionary MutationObserverInit {
  boolean parseEnd = false;
  boolean template = false;
};

enum TemplateStatus { "start", "update", "end", "abort" };

[Exposed=Window]
interface TemplateAttributeMap {
  readonly maplike<DOMString, DOMString>;
};

partial interface MutationRecord {
  readonly attribute TemplateStatus? templateStatus;
  readonly attribute TemplateAttributeMap? templateAttributes;
  readonly attribute Element? parserContextElement;
};

partial interface Element {
  readonly attribute boolean isParsing;
};

partial interface ShadowRoot {
  readonly attribute boolean isParsing;
};
```

### 1. Element completion & observer-specific batching (`parseEnd: true` and `isParsing`)

A target node (`Element` or `ShadowRoot`) is considered **parsing** (`isParsing === true`) when **either**:
1. It was pushed onto the HTML parser's stack of open elements and its **end tag has never been seen** yet (void and self-closing foreign elements are popped immediately on insertion, so their `isParsing` is already `false`), **or**
2. It is **currently an active `streamHTML*` target** (the fragment context element of an open streaming HTML parser).

When an observer registers `observe(target, { childList: true, parseEnd: true, ... })`:

- **Batching while parsing:** While `target` is parsing, `MutationRecord`s queued for that `(observer, target)` registration are **held in a pending batch** rather than delivered at intermediate microtask checkpoints when the parser yields between network chunks. Live DOM insertion itself is never buffered—nodes are inserted into the DOM immediately; only record delivery to that registration is held until `target` finishes parsing. (If a single `MutationObserver` observes multiple targets with `parseEnd: true`, batching is tracked per observed target so a completed element flushes without waiting for an unrelated still-open element.)
- **Observer-specific firing order:** Because batching applies only to the observer registration that opted into `parseEnd: true`, **other observers may fire in a different order** than observer creation order:
  - An observer *without* `parseEnd: true` (such as a document-level observer) fires immediately at chunk 1's microtask checkpoint while a `parseEnd: true` observer on an unclosed `<s-select>` holds its records until chunk 2.
  - Nested `parseEnd: true` observers naturally flush **bottom-up** as end tags arrive: a `parseEnd: true` observer registered on `<s-option>` flushes in chunk 1 as soon as `</s-option>` is seen, *before* the earlier-registered `parseEnd: true` observer on its parent `<s-select>` flushes at `</s-select>` in chunk 2.
- **Guaranteed firing (at parse end, or if already parsed, with empty children if applicable):**
  - **At parse end:** When `target` finishes parsing (end tag popped, EOF reached, or active `streamHTML*` closed/aborted), all batched records for `target` flush at the microtask checkpoint. If zero records were queued while parsing—for instance, an element with empty children (`<my-widget></my-widget>`) or an empty `streamHTML*` write—an empty `childList` record (`target`, `addedNodes: []`, `removedNodes: []`, `previousSibling: target.lastChild`) is synthesized so the observer is **guaranteed to fire**.
  - **When already parsed:** If `target` is *already* parsed (`isParsing === false`) when `observe(target, { childList: true, parseEnd: true })` is called (e.g., post-parse custom element upgrade, `innerHTML` / `setHTML`, `document.createElement()`, or observing a node that already closed earlier in the same chunk), the observer is likewise **guaranteed to fire** at the next microtask checkpoint—delivering any synchronous mutations made later in the same task (such as `el.append(a, b)`), or an empty `childList` record (`target`, `addedNodes: []`, `removedNodes: []`, `previousSibling: target.lastChild`) if none occurred.
  - **Subsequent dynamic mutations & `streamHTML*`:** After the initial flush, synchronous DOM mutations (`el.append(c)`) flush normally at the microtask checkpoint, while any future `el.streamHTML*()` call puts `el` back into the parsing state and batches that stream's mutations until stream end (again firing with an empty `childList` record if the stream added no children).
- **`takeRecords()` & disconnection:** `observer.takeRecords()` only drains records that are ready to flush (records held for a still-parsing `parseEnd: true` target remain batched until parse end). Calling `observer.disconnect()` discards held batches; sanitized elements discarded by the parser never connect or fire.

#### Walkthrough: Batching & observer-specific ordering across two chunks

Suppose `<s-select>` and `<s-option>` each call `this.#mo.observe(this, { childList: true, parseEnd: true })` in `connectedCallback()`, while `docObserver` observes `document` with `{ childList: true, subtree: true }` (no `parseEnd`). The network delivers:
- **Chunk 1:** `<s-select><s-option>A</s-option>`
- **Chunk 2:** `<s-option>B</s-option></s-select>`

| Checkpoint | `docObserver` (no `parseEnd`) | `<s-option>A`'s observer (`parseEnd: true`) | `<s-select>`'s observer (`parseEnd: true`) |
|---|---|---|---|
| **End of Chunk 1** | **Fires** (`addedNodes`: `<s-select>`, `<s-option>A`, `"A"`). | **Fires** (`addedNodes: ["A"]`) because `</s-option>` was seen in Chunk 1—even though `<s-select>`'s observer was registered earlier! | **Batched (does not fire):** `<s-select>` has not seen `</s-select>` yet (`addedNodes: [<s-option>A]` held). |
| **End of Chunk 2** | **Fires** (`addedNodes`: `<s-option>B`, `"B"`). | *(No changes to `<s-option>A`)* | **Fires once** with **all** batched records from both chunks (`addedNodes: [<s-option>A]` and `addedNodes: [<s-option>B]`). |

*(If the markup had instead been `<s-select></s-select>` across the two chunks with empty children, `<s-select>`'s observer would still hold at Chunk 1 and **fire at Chunk 2** with `{ type: "childList", target: <s-select>, addedNodes: [], removedNodes: [] }`.)*

### 2. Parser-consumed `<template>` elements (`template: true` — `templateAttributes` & `templateStatus`)

| Phase | `<template shadowrootmode="open">` | `<template for="r">` |
|---|---|---|
| **`"start"`** | Record on the shadow host with `addedNodes: [shadowRoot]`. | Record on the patch target removing `<?start>` and fallback nodes (or empty `addedNodes`/`removedNodes` with `nextSibling: <?marker>`). |
| **`"update"`** | `childList` and `characterData` records inside `shadowRoot` (when observed). | `childList` and parser-flushed `characterData` records ([whatwg/html#12744](https://github.com/whatwg/html/issues/12744)) inside the patch. |
| **`"end"`** | Record on the shadow host when `</template>` is reached. | Record on the patch target removing `<?end>` or `<?marker>` at `</template>`. |
| **`"abort"`** | Record on the shadow host if EOF/`abort()` occurs before `</template>`, or on the fallback `<template>` insertion record if attachment failed ([whatwg/html#13075](https://github.com/whatwg/html/issues/13075)). | Record on the patch target if EOF/`abort()` occurs before `</template>` ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)) or the marker moves mid-stream ([whatwg/html#11818](https://github.com/whatwg/html/pull/11818)); or on the fallback `<template>` insertion record if the target wasn't found. |

- **Correlation identity ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** All records from a single `<template>` invocation share the **same `TemplateAttributeMap` instance** (`r1.templateAttributes === r2.templateAttributes`).
- **Closed shadow roots excluded:** `<template shadowrootmode="closed">` never emits `"start"` / `"end"` records to outer observers.
- **Empty patches (`<template for="r"></template>`):** Still emit both `"start"` and `"end"` records.

#### Walkthrough A: `<template for>` across two network chunks (`template: true`)

Given `<section><?start name="r">Loading…<?end></section>`, when `main.streamAppendHTML(...)` receives chunk 1 (`<template for="r" data-turn="3"><p>H`) and chunk 2 (`i<span>!</span></p></template>`) under `{ childList: true, characterData: true, subtree: true, template: true }` on `<main>`:

| # | Chunk | `type` | `target` | `removedNodes` | `addedNodes` | `isParsing` at callback | `templateAttributes` | `templateStatus` | `parserContextElement` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | `childList` | `<section>` | `[<?start>, "Loading…"]` | `[]` | `section: false` | `[for="r", data-turn="3"]` | `"start"` | `<main>` |
| 2 | 1 | `childList` | `<section>` | `[]` | `[<p>]` | `p: true` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 3 | 1 | `childList` | `<p>` | `[]` | `["H"]` | `p: true` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 4 | 2 | `characterData` | `"Hi"` | `[]` | `[]` | `p: false` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 5 | 2 | `childList` | `<p>` | `[]` | `[<span>]` | `span: false, p: false` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 6 | 2 | `childList` | `<span>` | `[]` | `["!"]` | `span: false` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 7 | 2 | `childList` | `<section>` | `[<?end>]` | `[]` | `section: false` | `[for="r", data-turn="3"]` | `"end"` | `<main>` |

*(Note: Because `docObserver` on `<main>` does not set `parseEnd: true`, it receives incremental `"start"` / `"update"` / `"end"` records at each chunk boundary—whereas if an observer also observed `<p>` with `{ childList: true, parseEnd: true }`, `<p>`'s observer would hold chunk 1's `"H"` record and flush everything together at chunk 2 once `</p>` closed.)*

#### Walkthrough B: Records when `addedNodes` and `removedNodes` are empty (`<?marker>`)

When `<template for="r" data-turn="3"><p>Hi</p></template>` targets `<section><?marker name="r"></section>` in a single chunk, `<?marker>` stays in place until `</template>` removes it:

| # | `type` | `target` | `removedNodes` | `addedNodes` | `isParsing` at callback | `nextSibling` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|---|
| 1 | `childList` | `<section>` | `[]` | `[]` | `section: false` | `<?marker>` | `[for="r", data-turn="3"]` | `"start"` |
| 2 | `childList` | `<section>` | `[]` | `[<p>]` | `p: false` | `<?marker>` | `[for="r", data-turn="3"]` | `"update"` |
| 3 | `childList` | `<p>` | `[]` | `["Hi"]` | `p: false` | `null` | `[for="r", data-turn="3"]` | `"update"` |
| 4 | `childList` | `<section>` | `[<?marker>]` | `[]` | `section: false` | `null` | `[for="r", data-turn="3"]` | `"end"` |

*(Observers without `parseEnd: true` or `template: true` never receive record #1 or any record where `addedNodes` and `removedNodes` are both empty.)*

### 3. Fragment parsing context (`parserContextElement`) and `Element.isParsing`

When the HTML parser runs with a fragment context element (`streamHTML*`, `setHTML`, `innerHTML`, or `<template for>` with a context element), every record it produces has `parserContextElement` set to that `Element` (and `null` for top-level document parsing).

`Element.isParsing` (and `ShadowRoot.isParsing`) reflects the exact same condition that gates `parseEnd: true` batching: `true` while the node's end tag has not yet been seen (on a parser's stack of open elements) or while it is currently an active `streamHTML*` target, and `false` otherwise.

### 4. Custom elements: is `parsedCallback()` OK too?

The `MutationObserver` surface above is the core of this proposal. Whether custom elements should also get a lifecycle callback deserves careful consideration in light of the objections raised in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809).

**The concern: authors ignoring dynamic updates.** The central objection in #809 is that an end-tag callback invites authors to read `this.children` once in `parsedCallback()`, build their UI, and ignore subsequent mutations. Such an element works in static server-rendered markup, but fails when:
- **Created imperatively** (`document.createElement` + `append()`), where the parser isn't involved and there is no signal for when `append()` calls stop ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1757047993)).
- **Mutated after parsing**, when script, `<template for>` patches, or framework updates add or remove children.
- **Inserted in a different order**, such as connecting the element before appending its children.

Built-in elements like `<select>` work regardless of how their `<option>`s arrive or change ("If you cannot handle dynamic insertion and mutation of those insertions, how can you claim to be a proper element?", [#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1460917211), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1463846026)). We agree with this principle: elements and observers must support dynamic updates.

**Why `{ childList: true, parseEnd: true }` batching directly satisfies this principle across every creation mode.**
Calling `this.#mo.observe(this, { childList: true, parseEnd: true })` in `connectedCallback()` handles all four cases uniformly with a single callback:
1. **Streamed across network chunks (`<s-select>` ... `</s-select>`):** `this.isParsing` is `true` in `connectedCallback()`; `#mo` batches all child insertions across chunks and fires once `</s-select>` is seen.
2. **Empty children (`<s-select></s-select>`):** Guaranteed to fire at `</s-select>` with an empty `childList` record (`addedNodes: []`, `removedNodes: []`), so initial setup still runs.
3. **Imperative `createElement` + `append()`, `innerHTML`, or late upgrade (`isParsing === false`):** Because `parseEnd: true` is guaranteed to fire on the next microtask even if `this` is already parsed, `const s = document.createElement("s-select"); document.body.append(s); s.append(opt1, opt2);` runs `connectedCallback()` on `body.append(s)`, batches `s.append(opt1, opt2)` in the same synchronous task, and fires once at the microtask checkpoint (or fires with an empty `childList` record if no children were appended or if upgraded after parsing).
4. **Subsequent dynamic mutations & `streamHTML*`:** Later JS mutations (`s.append(opt3)`) trigger `#mo` at the microtask checkpoint, and later `s.streamHTML*()` streams automatically batch until stream completion.

**Why `parsedCallback()` might be acceptable as well.** As shown in [Existing workarounds](#existing-workarounds), withholding a callback hasn't stopped custom element authors from waiting for parse completion—libraries like [`html-parsed-element`](https://github.com/WebReflection/html-parsed-element) already polyfill a method literally named `parsedCallback()` by attaching a `subtree: true` `MutationObserver` per element instance. If a dedicated custom element callback is also desired, it could mirror the exact same semantics (firing after parse end when `isParsing` is `true`, or at microtask timing when already parsed), though `this.#mo.observe(this, { childList: true, parseEnd: true })` may make a separate lifecycle callback unnecessary. (Separately, `shadowRootAttachedCallback(shadowRoot)` is not parser-specific: firing it for both `attachShadow()` and `<template shadowrootmode>` addresses [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) for custom elements.)

---

## Alternatives Considered

1. **Unbatched cross-chunk completion records (flushing partial chunks + trailing empty `childList` record):** An earlier iteration flushed `addedNodes` on every intermediate chunk with `el.isParsing === true` and emitted an empty `childList` record when `</el>` finally arrived. However, that forced every observer to manually filter out `node.isParsing` elements, maintain external state across chunks, or suffer intermediate partial updates—and did not fire on already-parsed elements or single-chunk `<x-el></x-el>` elements observed in `connectedCallback()`. Batching records per `parseEnd: true` observer while parsing (and guaranteeing a flush at parse end or when already parsed) lets a single `MutationObserver` callback handle streamed, synchronous, empty, and already-parsed elements without manual state tracking.
2. **A `record.parsedElements` `NodeList` on `MutationRecord`:** Exposing `readonly attribute NodeList parsedElements` on `MutationRecord` (with `record.target` set to `el.parentNode`) required a `NodeList` allocation per `MutationRecord`, forced observing `el.parentNode` rather than `el` directly, and still delivered half-parsed child mutations across chunk boundaries.
3. **A single combined `parser: true` option instead of `parseEnd` and `template`:** Separating `parseEnd: true` (batching until parse completion) and `template: true` (streaming `<template>` start/update/end/abort metadata) is essential because streaming patch routers (`template: true`) want incremental per-chunk updates, whereas component/island observers (`parseEnd: true`) want records held until the target finishes parsing.
4. **Status quo (reconstruct parser state on the client):** Requires per-element `subtree: true` observers, ancestor `nextSibling` walks (measured at 100ms+ on complex pages), chunk regexes, or sentinel nodes/scripts, and still cannot recover detached `<template>` attributes, patch aborts, or active `streamHTML*` state.
5. **New `MutationRecord.type` values (`"parseEnd"`, `"templateStart"`, `"templateEnd"`, `"templateAbort"`):** Separated `<template>` metadata from the `childList` records carrying `addedNodes` (forcing stateful tracking in every callback).
6. **Exposing the detached `HTMLTemplateElement` (`record.template`):** Retains a live parser-internal element whose `.content` was bypassed; a read-only `TemplateAttributeMap` (`templateAttributes`) exposes its attributes without leaking the node.
7. **DOM Events (`parseend`, `templatestart`, `templateend`):** Per-element event dispatch during parsing repeats the performance issues of legacy `MutationEvent` and does not carry batched `MutationRecord`s or handle subsequent dynamic mutations.

---

## Frequently Asked Questions (Q&A)

### Q1: Does `parseEnd: true` batching add overhead to the HTML parser or delay rendering?
No:
1. **Zero parser/rendering buffering:** The HTML parser inserts nodes into the live DOM immediately as bytes arrive. Layout, rendering, preload scanning, and other observers are never delayed.
2. **Zero cost when `parseEnd: true` is unused:** Holding records in an observer's pending queue only occurs for observer registrations that pass `parseEnd: true`, gated on state the parser already maintains (stack of open elements and active `streamHTML*` context).

### Q2: Why can observers fire in a different order when `parseEnd: true` is used?
In standard DOM mutation delivery, all observers flush at every microtask checkpoint in observer creation order. Because `parseEnd: true` is **observer-specific**, an observer watching `<parent>` with `parseEnd: true` holds its records across chunk boundaries while `<parent>` is still open, whereas an observer without `parseEnd: true`—or a `parseEnd: true` observer watching a `<child>` whose `</child>` tag arrived in an earlier chunk—flushes immediately at that earlier chunk's microtask checkpoint. A beneficial side effect is that nested `parseEnd: true` components initialize **bottom-up** (`<s-option>` finishes parsing and flushes before `<s-select>`).

### Q3: Why is a `parseEnd: true` observer guaranteed to fire even if the target is already parsed or has empty children?
Without that guarantee:
- Observing `<my-widget></my-widget>` in `connectedCallback()` would never fire at `</my-widget>` because zero child nodes were inserted (`childList` saw no additions).
- Observing an element that was upgraded after parsing, created via `innerHTML` / `document.createElement()`, or discovered after closing in the same chunk would never fire if no *further* child mutations occurred.
Guaranteeing a flush at parse end—or at the next microtask checkpoint if already parsed—(synthesizing an empty `childList` record `addedNodes: [], removedNodes: []` when no child records were queued) lets authors put all initial *and* ongoing child synchronization inside a single `MutationObserver` callback without a separate initial-render codepath.

### Q4: Doesn't this encourage authors to ignore dynamic updates?
The opposite—see [section 4](#4-custom-elements-is-parsedcallback-ok-too). Because the mechanism *is* a `MutationObserver` registration (`mo.observe(el, { childList: true, parseEnd: true })`), the very same callback that runs at initial parse end stays active for all future imperative DOM mutations and automatically batches future `streamHTML*` streams into `el`.

### Q5: Why use a read-only map (`TemplateAttributeMap`) for `templateAttributes`?
`TemplateAttributeMap` (`readonly maplike<DOMString, DOMString>`) provides ergonomic lookup by name (`r.templateAttributes.get("for")`) and preserves object identity across all records emitted by the same `<template>` invocation (`r1.templateAttributes === r2.templateAttributes`) without relying on legacy `NamedNodeMap` / `Attr` objects.

### Q6: Doesn't putting a `ShadowRoot` in `addedNodes` violate the `target.childNodes` invariant?
Observing `<template shadowrootmode="open">` is an optional extension (and never operates on `shadowrootmode="closed"`). If preferred during spec review, `addedNodes` can remain `[]` and observers can read `r.target.shadowRoot`.

### Q7: What happens with foster parenting and the adoption agency algorithm?
- **Foster parenting (`<table><div>...</div></table>`):** Even when `<div>` is foster-parented outside `<table>`, `<div>` remains on the stack of open elements until `</div>` is seen, so a `parseEnd: true` observer on `<div>` batches until `</div>` pops it.
- **Adoption agency (`<b><i>Bold </b>italic</i>`):** Popping the original `<i>` at `</b>` ends parsing for that `<i>` instance and flushes its `parseEnd: true` batch; the reconstructed `<i>` created for `italic` is a distinct element tracked until `</i>`.

### Q8: Why not use DOM Events or a dedicated `PatchObserver` for `<template for>`?
Hydration, form-state preservation ([WICG/declarative-partial-updates#103](https://github.com/WICG/declarative-partial-updates/issues/103)), and progressive enhancement need the exact `removedNodes` and `addedNodes` together with `<template>` metadata.

### Q9: How do `parseEnd: true` and `template: true` interact with `observe()` option validation?
`parseEnd: true` and `template: true` augment `childList` (and `characterData` / `attributes`) delivery, so passing `template: true` or `parseEnd: true` with `childList: false` throws a `TypeError`.

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. All state surfaced by `parseEnd: true` and `template: true` originates from HTML markup parsed into a DOM subtree the caller can already observe.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes:
   - **Closed shadow roots (`<template shadowrootmode="closed">`):** `addedNodes` only exposes the `ShadowRoot` when `shadowrootmode` is `"open"`.
   - **Sanitize-while-parsing ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)) & CSP nonces ([WICG/declarative-partial-updates#111](https://github.com/WICG/declarative-partial-updates/issues/111)):** `templateAttributes` only reflects attributes that survived the sanitizer, and `nonce` attributes follow standard nonce hiding.

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
    No. `MutationObserver` callbacks run at the standard microtask checkpoint, and any custom element reactions use the standard custom element reaction queue.

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    N/A (same-origin DOM observation only).

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Identically to normal browsing mode.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    It is intended to be integrated into the WHATWG DOM and HTML Standards.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    Nothing beyond existing `MutationObserver` behavior.

19. **What happens when a document that uses your feature gets disconnected?**
    If a document is disconnected or its parser aborts while an observed target is still parsing, parsing ends (as at EOF/abort) and standard `MutationObserver` lifecycle rules apply; calling `observer.disconnect()` discards any held batches.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Parser-aborted `<template>` operations are reported via `templateStatus: "abort"` rather than exceptions.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.
