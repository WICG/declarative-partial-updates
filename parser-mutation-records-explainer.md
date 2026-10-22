# Explainer: Parser-Aware `MutationObserver` Records

## Introduction

The HTML parser tracks state that never appears in the DOM:

- **Which elements are still open** on the [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements), and when each one is popped (by an explicit end tag, an implied end tag, or EOF).
- **Which parser-consumed `<template>` is active** (`<template shadowrootmode>` or `<template for>`), which redirects content into a target without inserting the `<template>` itself.
- **Which fragment context element it is parsing into** (`innerHTML`, `setHTML()`, or streaming fragment parsing).

Built-in elements like `<script>`, `<style>`, and `<object>` already rely on this state to act when the parser closes them. `MutationObserver`, however, only sees half of what the parser does: it reports an element in `addedNodes` on its start tag, without indicating whether the element is still open on the parser stack or when it closes.

When markup is primarily driven from the server (SSR, streaming HTML, or declarative updates), this parser metadata—alongside the usual `childList`/`addedNodes` records—is what provides **structural boundaries, flow control, and error control**: knowing when a streamed element or patch starts, is still in flight, finishes cleanly, or aborts mid-stream (e.g., on network truncation or a missing target). **Not exposing it pushes that weight onto the client**: applications must either move DOM construction and update orchestration into client-side JavaScript, or ship client-side workarounds to reconstruct what the parser already knows.

This explainer proposes reflecting that existing parser state for three reasons:

1. **The browser already computes it**, so exposing it adds no new concepts to the parser.
2. **Server-driven and streaming apps already depend on it**, reconstructing it today with sentinel nodes, inline scripts, ancestor walks, regexes over raw HTML, and per-element observers at measurable main-thread and wire cost (see [Existing workarounds](#existing-workarounds)).
3. **It fits the existing reactive model.** To address the concern ([WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)) that a "parsing finished" hook might tempt authors to ignore later dynamic updates, the primary API is an opt-in (`{ parser: true }`) on `MutationObserver`—which authors already use to observe ongoing DOM changes—plus `Element.isParsing`. A custom element `parsedCallback()` is also discussed as a potentially reasonable companion ([section 4](#4-custom-elements-is-parsedcallback-ok-too)).

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

### 1. Acting on complete subtrees (`addedNodes` fires on the start tag)

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

- Reflect existing parser state (element completion, active parser-consumed `<template>`, and fragment context element) alongside `addedNodes`/`removedNodes` on `MutationRecord`.
- Eliminate the client-side workarounds above, with **zero cost when unused** and **no extra records** when elements open and close within the same chunk ([w3c/csswg-drafts#12578 (comment)](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209456796)).
- Keep records from a parser-consumed `<template>` separate from unrelated mutations ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)).
- Keep `MutationRecord` flat and preserve `MutationRecord.type` (`"attributes" | "characterData" | "childList"`).

### Non-Goals

- **Discouraging incremental rendering or dynamic mutation handling:** Elements and observers should still react to children as they arrive; parser metadata indicates whether an element or patch is still in flight.
- **Buffering parser output until an end tag**, **tracking non-element nodes**, or **replacing `PerformanceEntry` for sub-microtask RUM timing**.

---

## Proposed Approach

A single boolean option, `parser: true` in `MutationObserverInit`, opts an observer into parser-aware `MutationRecord`s, paired with a synchronous `isParsing` getter on `Element` and `ShadowRoot`:

- `element.isParsing` / `shadowRoot.isParsing`: `true` while the node is open on the parser's stack of open elements (or actively receiving a streaming fragment parse), and `false` once popped.
- **Cross-chunk parse completion (`childList` record):** When an element opens and closes in the same network chunk, its `isParsing` is already `false` when the observer sees it in `addedNodes` (zero extra records). If an element is still open when the observer flushes (`isParsing === true`), popping its end tag in a later chunk emits an empty `childList` record with `record.target` set to the closed element (`addedNodes: []`, `removedNodes: []`, `previousSibling: el.lastChild`) and `el.isParsing === false`.
- `record.templateAttributes`: `NamedNodeMap?` of attributes from the active parser-consumed `<template>` (`<template shadowrootmode>` or `<template for>`), or `null`.
- `record.templateStatus`: `"start" | "update" | "end" | "abort"`, or `null`.
- `record.parserContextElement`: The parser's fragment context element (`Element?`), or `null`.

### Example Usage

```js
const mo = new MutationObserver(records => {
  for (const r of records) {
    // 1a. Elements that opened and closed within this chunk:
    for (const node of r.addedNodes) {
      if (node instanceof Element && !node.isParsing && node.matches("article")) {
        enhanceArticle(node);
      }
    }
    // 1b. Elements that opened in an earlier chunk and closed in this chunk:
    if (
      r.type === "childList" &&
      !r.addedNodes.length &&
      !r.removedNodes.length &&
      !r.templateStatus &&
      r.target instanceof Element &&
      !r.target.isParsing &&
      r.target.matches("article")
    ) {
      enhanceArticle(r.target);
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

### 1. Element completion (`isParsing` and cross-chunk `childList` records)

When the parser pushes an `Element` onto the stack of open elements, `el.isParsing` is `true`; when the element is popped (or immediately on insertion for void and self-closing foreign elements), `el.isParsing` becomes `false`:

- **Same-chunk completion (zero extra records):** Because `MutationObserver` callbacks run at the microtask checkpoint after the parser yields, any element that opens and closes within the same chunk already has `el.isParsing === false` when the observer inspects `r.addedNodes`. No extra record is queued.
- **Cross-chunk completion (empty `childList` record on `target === closedElement`):** If a microtask checkpoint ran while `el.isParsing` was `true` (so observers saw `el` in `addedNodes` while still incomplete), then when the parser later pops `el` off the stack of open elements, it queues a `childList` record for `{ parser: true }` observers with `target: el`, `addedNodes: []`, `removedNodes: []`, `previousSibling: el.lastChild`, and `el.isParsing === false`.
- **Direct observation (`subtree: false`):** Because `record.target` is the closed element itself (`el`), an observer attached directly to a single element (`mo.observe(el, { childList: true, parser: true })`) receives the parse-completion record without needing to observe `el.parentNode`.
- **Disconnected or sanitized elements ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [whatwg/html#12756](https://github.com/whatwg/html/pull/12756)):** Elements removed from the observed tree before closing or discarded by the sanitizer do not emit a parse-completion record.

### 2. Parser-consumed `<template>` elements (`templateAttributes` & `templateStatus`)

| Phase | `<template shadowrootmode="open">` | `<template for="r">` |
|---|---|---|
| **`"start"`** | Record on the shadow host with `addedNodes: [shadowRoot]`. | Record on the patch target removing `<?start>` and fallback nodes (or empty `addedNodes`/`removedNodes` with `nextSibling: <?marker>`). |
| **`"update"`** | `childList` and `characterData` records inside `shadowRoot` (when observed). | `childList` and parser-flushed `characterData` records ([whatwg/html#12744](https://github.com/whatwg/html/issues/12744)) inside the patch. |
| **`"end"`** | Record on the shadow host when `</template>` is reached. | Record on the patch target removing `<?end>` or `<?marker>` at `</template>`. |
| **`"abort"`** | Record on the shadow host if EOF/`abort()` occurs before `</template>`, or on the fallback `<template>` insertion record if attachment failed ([whatwg/html#13075](https://github.com/whatwg/html/issues/13075)). | Record on the patch target if EOF/`abort()` occurs before `</template>` ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)) or the marker moves mid-stream ([whatwg/html#11818](https://github.com/whatwg/html/pull/11818)); or on the fallback `<template>` insertion record if the target wasn't found. |

- **Correlation identity ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** All records from a single `<template>` invocation share the **same `NamedNodeMap` instance** (`r1.templateAttributes === r2.templateAttributes`).
- **Empty patches (`<template for="r"></template>`):** Still emit both `"start"` and `"end"` records.

#### Walkthrough A: `<template for>` across two network chunks

Given `<section><?start name="r">Loading…<?end></section>`, when `main.streamAppendHTML(...)` receives chunk 1 (`<template for="r" data-turn="3"><p>H`) and chunk 2 (`i<span>!</span></p></template>`):

| # | Chunk | `type` | `target` | `removedNodes` | `addedNodes` | `isParsing` at callback | `templateAttributes` | `templateStatus` | `parserContextElement` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | `childList` | `<section>` | `[<?start>, "Loading…"]` | `[]` | `section: false` | `[for="r", data-turn="3"]` | `"start"` | `<main>` |
| 2 | 1 | `childList` | `<section>` | `[]` | `[<p>]` | `p: true` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 3 | 1 | `childList` | `<p>` | `[]` | `["H"]` | `p: true` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 4 | 2 | `characterData` | `"Hi"` | `[]` | `[]` | `p: false` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 5 | 2 | `childList` | `<p>` | `[]` | `[<span>]` | `span: false, p: false` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 6 | 2 | `childList` | `<span>` | `[]` | `["!"]` | `span: false` | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 7 | 2 | `childList` | `<p>` | `[]` | `[]` | `p: false` (`previousSibling: <span>`) | `[for="r", data-turn="3"]` | `"update"` | `<main>` |
| 8 | 2 | `childList` | `<section>` | `[<?end>]` | `[]` | `section: false` | `[for="r", data-turn="3"]` | `"end"` | `<main>` |

*(Note: In chunk 2, `<span>` opens and closes in the same chunk, so `span.isParsing` is already `false` on record #5 and no empty record is emitted for `<span>`. Because `<p>` opened in chunk 1 with `p.isParsing === true` and closed in chunk 2, record #7 emits the empty `childList` parse-completion record with `target: <p>`.)*

#### Walkthrough B: Records when `addedNodes` and `removedNodes` are empty (`<?marker>`)

When `<template for="r" data-turn="3"><p>Hi</p></template>` targets `<section><?marker name="r"></section>` in a single chunk, `<?marker>` stays in place until `</template>` removes it:

| # | `type` | `target` | `removedNodes` | `addedNodes` | `isParsing` at callback | `nextSibling` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|---|
| 1 | `childList` | `<section>` | `[]` | `[]` | `section: false` | `<?marker>` | `[for="r", data-turn="3"]` | `"start"` |
| 2 | `childList` | `<section>` | `[]` | `[<p>]` | `p: false` | `<?marker>` | `[for="r", data-turn="3"]` | `"update"` |
| 3 | `childList` | `<p>` | `[]` | `["Hi"]` | `p: false` | `null` | `[for="r", data-turn="3"]` | `"update"` |
| 4 | `childList` | `<section>` | `[<?marker>]` | `[]` | `section: false` | `null` | `[for="r", data-turn="3"]` | `"end"` |

*(Observers without `parser: true` never receive record #1 or any record where `addedNodes` and `removedNodes` are both empty.)*

### 3. Fragment parsing context (`parserContextElement`) and `Element.isParsing`

When the HTML parser runs with a fragment context element (`streamHTML*`, `setHTML`, `innerHTML`, or `<template for>` with a context element), every record it produces has `parserContextElement` set to that `Element` (and `null` for top-level document parsing).

`Element.isParsing` (and `ShadowRoot.isParsing`) is `true` while the node is on a parser's stack of open elements, or while a streaming fragment parser (`streamHTML*`) with that node as its fragment context element is active.

### 4. Custom elements: is `parsedCallback()` OK too?

The `MutationObserver` surface above is the core of this proposal. Whether custom elements should also get a lifecycle callback deserves careful consideration in light of the objections raised in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809).

**The concern: authors ignoring dynamic updates.** The central objection in #809 is that an end-tag callback invites authors to read `this.children` once in `parsedCallback()`, build their UI, and ignore subsequent mutations. Such an element works in static server-rendered markup, but fails when:
- **Created imperatively** (`document.createElement` + `append()`), where the parser isn't involved and there is no signal for when `append()` calls stop ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1757047993)).
- **Mutated after parsing**, when script, `<template for>` patches, or framework updates add or remove children.
- **Inserted in a different order**, such as connecting the element before appending its children.

Built-in elements like `<select>` work regardless of how their `<option>`s arrive or change ("If you cannot handle dynamic insertion and mutation of those insertions, how can you claim to be a proper element?", [#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1460917211), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1463846026)). We agree with this principle: elements and observers must support dynamic updates.

**Why the `MutationObserver` surface supports this principle.** An author using `MutationObserver({ childList: true, parser: true })` is already observing ongoing `childList` mutations. When markup is driven from the server, `el.isParsing`, cross-chunk `childList` completion records, `templateAttributes`, and `templateStatus` provide the missing structural boundaries, flow state, and error signals (`"abort"`) alongside `addedNodes`, so the same observer can handle both streamed server markup and later client-side mutations without pushing DOM construction and orchestration onto the client.

**Why `parsedCallback()` might be acceptable as well.** As shown in [Existing workarounds](#existing-workarounds), withholding a callback hasn't stopped custom element authors from waiting for parse completion—libraries like [`html-parsed-element`](https://github.com/WebReflection/html-parsed-element) already polyfill a method literally named `parsedCallback()` by attaching a `subtree: true` `MutationObserver` per element instance. Defining a native callback can avoid that overhead while reducing the dynamic-update footgun:

- **Fire once per connection for both parser-created and script-created elements:** If `isParsing` is `false` on connect (imperative creation, `innerHTML`, post-parse upgrade), enqueue `parsedCallback()` immediately after `connectedCallback()`. If `isParsing` is `true`, enqueue it when the parser (or streaming fragment parser) finishes the element.
- **Frame it as initial child readiness**, paired with `MutationObserver` or `slotchange` for subsequent changes:

```js
class MyWidget extends HTMLElement {
  parsedCallback() {
    this.#render();
    this.#observer ??= new MutationObserver(() => this.#render());
    this.#observer.observe(this, { childList: true, subtree: true });
  }
}
```

We welcome feedback on whether these semantics address the #809 concerns, or whether `MutationObserver` + `isParsing` should stand alone. (Separately, `shadowRootAttachedCallback(shadowRoot)` is not parser-specific: firing it for both `attachShadow()` and `<template shadowrootmode>` addresses [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) for custom elements.)

---

## Alternatives Considered

1. **A `record.parsedElements` `NodeList` on `MutationRecord`:** An earlier revision of this proposal exposed `readonly attribute NodeList parsedElements` on `MutationRecord` (with `record.target` set to `el.parentNode`), coalescing same-chunk closed elements onto the parent's `childList` record. While convenient (`for (const el of r.parsedElements)`), it requires a new `NodeList` allocation per `MutationRecord`, requires observing `el.parentNode` rather than `el` directly, and duplicates information already available via `!node.isParsing` on `addedNodes` in the 99% same-chunk case. Emitting an empty `childList` record with `target === closedElement` only when an element spans a chunk boundary avoids adding `parsedElements` to `MutationRecord` while allocating zero extra objects in the same-chunk case.
2. **Status quo (reconstruct parser state on the client):** Requires per-element observers, ancestor walks (measured at 100ms+ on complex pages), chunk regexes, or sentinel nodes/scripts, and still cannot recover detached `<template>` attributes, patch aborts, or fragment context elements.
3. **New `MutationRecord.type` values (`"parseEnd"`, `"templateStart"`, `"templateEnd"`, `"templateAbort"`):** Separated `<template>` metadata from the `childList` records carrying `addedNodes` (forcing stateful tracking in every callback) and doubled `MutationRecord` count for same-chunk element opens and closes.
4. **Exposing the detached `HTMLTemplateElement` (`record.template`):** Retains a live parser-internal element whose `.content` was bypassed; a read-only `NamedNodeMap` (`templateAttributes`) exposes its attributes without leaking the node.
5. **Multiple `MutationObserverInit` booleans and `templateAttributeFilter`:** `<template>` start tags are parsed once with 1–3 attributes (`for`, `shadowrootmode`, `data-*`), so a single `parser: true` option and `templateAttributes` cover all cases with minimal API surface.
6. **DOM Events (`parseend`, `templatestart`, `templateend`):** Per-element event dispatch during parsing repeats the performance issues of legacy `MutationEvent`.

---

## Frequently Asked Questions (Q&A)

### Q1: Does tracking element completion add overhead to the HTML parser?
No when unused, and minimal when active ([w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209456796), [whatwg/dom#662](https://github.com/whatwg/dom/issues/662)):
1. **Zero cost when `parser: true` is unused:** Queueing cross-chunk parse-completion records is gated by a per-tree flag, and `el.isParsing` checks whether the element is currently in the parser's stack of open elements (or active fragment context).
2. **Zero extra records for same-chunk elements:** Elements that open and close within the same network chunk already have `el.isParsing === false` when the observer callback runs at the microtask checkpoint, so no extra `MutationRecord` is allocated.

### Q2: Doesn't this encourage authors to ignore dynamic updates?
See [section 4](#4-custom-elements-is-parsedcallback-ok-too). On `MutationObserver`, `isParsing` and cross-chunk `childList` records are delivered to code that is *already* observing dynamic `childList` changes. When markup comes from the server, they supply the boundary metadata needed to complement `addedNodes`; when nodes are created by script, `el.isParsing` is `false` immediately in `addedNodes`.

### Q3: Why use `NamedNodeMap` for `templateAttributes` instead of `FrozenArray`?
`NamedNodeMap` provides lookup by name (`r.templateAttributes.getNamedItem("for")?.value`). Each `Attr` has `ownerElement === null`, and mutating methods throw `NoModificationAllowedError`.

### Q4: Doesn't putting a `ShadowRoot` in `addedNodes` violate the `target.childNodes` invariant?
It is only populated for `{ parser: true }` observers on `"start"` records with `shadowrootmode`. If preferred during spec review, `addedNodes` can remain `[]` and observers can read `r.target.shadowRoot`.

### Q5: Why is `record.target` on a cross-chunk parse-end record the closed element itself (`el`) rather than `el.parentNode`?
1. A `childList` record on `el` naturally means *"the child list of `el` has finished parsing"* (`r.target === el`, `!r.target.isParsing`, `r.previousSibling === el.lastChild`).
2. It works even when observing `el` directly (`mo.observe(el, { childList: true, parser: true })`) without `subtree: true` on `el.parentNode`.

### Q6: What happens with foster parenting and the adoption agency algorithm?
- **Foster parenting (`<table><div>...</div></table>`):** When `</div>` is popped across a chunk boundary, `target` is `div` (if still connected to the observed tree).
- **Adoption agency (`<b><i>Bold </b>italic</i>`):** If `<i>` or `<b>` was open across a chunk boundary, popping it at `</b>` emits its completion record; the cloned `<i>` is tracked independently until `</i>`.

### Q7: Do synchronous parsing APIs (`innerHTML`, `setHTML`) emit extra records?
No. Because synchronous parsing completes before the microtask checkpoint, every element has `el.isParsing === false` when the observer callback runs, so zero extra parse-completion records are emitted.

### Q8: Why not use DOM Events or a dedicated `PatchObserver` for `<template for>`?
Hydration, form-state preservation ([WICG/declarative-partial-updates#103](https://github.com/WICG/declarative-partial-updates/issues/103)), and progressive enhancement need the exact `removedNodes` and `addedNodes` together with `<template>` metadata.

### Q9: How does `parser: true` interact with `observe()` option validation?
`parser: true` augments `childList` (and `characterData`) records, so passing `parser: true` with `childList: false` throws a `TypeError`.

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. All state surfaced by `parser: true` originates from HTML markup parsed into a DOM subtree the caller can already observe.

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
    If an observed element is disconnected while still open on the parser stack, popping it doesn't emit a parse-completion record for observers of the outer tree.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Parser-aborted `<template>` operations are reported via `templateStatus: "abort"` rather than exceptions.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.
