# Explainer: Batch Delivery for `MutationObserver` (`delivery: "batch"` & `element.isStreaming`)

## Introduction

The HTML parser tracks [which elements are still open](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) and when each one closes (by an explicit end tag, an implied end tag, or EOF). Built-in elements like `<script>`, `<style>`, and `<object>` already rely on this state to act only once the parser finishes them.

`MutationObserver`, however, only sees the start tag: when markup streams across network chunks, the parser inserts an element on its opening tag and yields before its closing tag arrives, flushing half-built subtrees to observers at intermediate microtask checkpoints. By contrast, when DOM is built synchronously in JavaScript (`el.append(a); el.append(b);`), `MutationObserver` naturally batches all mutations in the task and delivers them together at the microtask checkpoint.

This explainer proposes adding a `delivery` option to `MutationObserverInit` (`MutationObserverDelivery` enum: `"stream" | "batch"`, defaulting to `"stream"`), alongside a synchronous `element.isStreaming` getter ([whatwg/html#12200](https://github.com/whatwg/html/issues/12200)). Observing a target with `delivery: "batch"` (a **batch registration**; an observer with one is called a **batch observer** below) extends `MutationObserver` batching across multi-chunk streams (`while (target.isStreaming)`):

1. **The browser already tracks this state** (the parser's stack of open elements and active streaming fragment parsers—`streamHTML*` and `<template for>` patches), so holding an observer's records while `target.isStreaming` is `true` introduces no new parser concepts or DOM tree buffering.
2. **Server-driven and streaming apps already depend on it**, reconstructing it today with sentinel nodes, inline scripts, ancestor `nextSibling` walks, regexes over raw HTML, and per-element `subtree: true` observers at measurable main-thread and wire cost (see [Existing workarounds](#existing-workarounds)).
3. **It fits the existing reactive model.** Rather than introducing a one-shot hook that tempts authors to ignore subsequent dynamic mutations ([WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)), `delivery: "batch"` is a mode of `MutationObserver` itself—delivering a single batched callback when streaming into the element finishes (or on the next microtask if `target.isStreaming` is already `false`, even with empty children), and continuing to observe future DOM changes and streams.

> [!NOTE]
> Unlike `delivery: "stream"` (today's default), **`observe(target, { delivery: "batch", ... })` can schedule a callback by itself**: each batch registration fires once, even if no mutation happens. See [§3](#3-observe-schedules-a-callback-guaranteed-firing--empty-children), and [Alternatives Considered](#alternatives-considered) for a constructor option and a dedicated method.

*(For observing parser-consumed `<template for>` lifecycle and attribution, see the companion explainer: [template-mutation-observer-explainer.md](./template-mutation-observer-explainer.md).)*

---

## Prior Discussions

- [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809), [#619](https://github.com/WICG/webcomponents/issues/619), [#550](https://github.com/WICG/webcomponents/issues/550): notifications when the HTML parser finishes parsing an element's children
- [whatwg/dom#662](https://github.com/whatwg/dom/issues/662): custom element callback/notification for "connected and parsed"
- [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116): observing parse completion when streaming into a detached document
- [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) & [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578): parser stack openness state
- [whatwg/html#12758](https://github.com/whatwg/html/pull/12758), [#12753](https://github.com/whatwg/html/pull/12753), [#12624](https://github.com/whatwg/html/pull/12624), & [#12756](https://github.com/whatwg/html/pull/12756): streaming HTML insertion (`streamHTML*`) and sanitizing while parsing

---

## Use Cases & Problem Statement

When the parser processes `<s-select><s-option>A</s-option><s-option>B</s-option></s-select>`, it inserts `<s-select>` into the DOM as soon as it reads the start tag. If the parser yields between network chunks before `</s-select>`, observers watching `<s-select>` or the document see incomplete children:

- **Evaluate content once ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)):** Elements that interpret text, configuration, or inline code (syntax highlighters, math/markdown blocks, or streamed `<script>` elements moved from a detached document) fail with syntax or parse errors when evaluated at a chunk boundary before the closing tag arrives.
- **Batch child setup and validation ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)):** Custom elements that validate, index, or slot light-DOM children (such as `<s-select>` validating `<s-option>` children or data tables indexing rows) emit false validation warnings or perform redundant $O(N^2)$ work if they run on the opening tag or on every intermediate chunk.
- **Hydrate or animate complete subtrees ([whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)):** Triggering island hydration, View Transitions, WAAPI animations, or progressive DOM morphing on an element that is still open on the parser stack acts on half-streamed markup.

`requestAnimationFrame` and `setTimeout` heuristics fail for the same reason: the parser can yield and spin the event loop in the middle of an element ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1457018630), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455818744)).

### Existing workarounds

Because element streaming/parse completion isn't exposed to `MutationObserver`, server-driven and streaming applications must reconstruct it on the client:

| Workaround | Where | What it reconstructs | Cost |
|---|---|---|---|
| **Ancestor `nextSibling` walk + a `subtree: true` `MutationObserver` per element** | [`WebReflection/html-parsed-element`](https://github.com/WebReflection/html-parsed-element/blob/main/index.js), [`svelte-retag`](https://github.com/patricknelson/svelte-retag/issues/20#issuecomment-1848262955) | End-tag completion, inferred by checking whether the element or any ancestor has a `nextSibling` | One observer per pending element, re-walking ancestors on every insertion. Reported at hundreds of milliseconds of main-thread time on medium documents; last-child elements stay "unparsed" until `DOMContentLoaded`. |
| **Regex over raw HTML chunks + `document.write()` into a detached document / `<iframe>`** | [`marko-js/writable-dom`](https://github.com/marko-js/writable-dom/blob/main/src/index.ts) | Whether an inline `<script>`/`<style>` is still open (`!(node.nextSibling \|\| /<\/\w+>$/.test(curChunk))`) | Couples DOM logic to raw chunk strings and requires an `<iframe>` fallback where detached documents strip scripts. |
| **Nested `MutationObserver`s + ancestor scans on every opening tag** | Production MPA-to-SPA streaming navigation ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1755787377), [(follow-up)](https://github.com/WICG/webcomponents/issues/809#issuecomment-2087913895), [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)) | Whether a streamed `<script>` or animated subtree is complete before moving it into the live document | **100ms+ of `MutationObserver` time on a modern laptop** (more on mobile) to reproduce in JS what the parser already tracks. |
| **Sentinel child elements** (`<the-end>`) or `onload`/`onerror` probes | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534115603), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1456790982) | End of children, signaled by a dummy last child that removes itself on connect | Extra DOM nodes and markup per instance; requires control over inner markup. |
| **Trailing inline `<script>` after each element or streamed region** | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-532525717), streaming SSR frameworks | Completion of the preceding markup | Extra wire bytes per region and requires CSP nonces/hashes or `unsafe-inline`. |
| **Deferring `customElements.define()` to `DOMContentLoaded`**, or `setTimeout`/`requestAnimationFrame` | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-737669670), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455481698), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534119444) | An approximation of "the parser is done" | Delays upgrades until the entire document finishes, or races the parser across chunks. |

### Goals

- **Buffer `MutationRecord` delivery across streaming chunks (`delivery: "batch"`):** Hold an observer's records for each target observed with `delivery: "batch"` while that `target` is [streaming](#1-definition-of-streaming) (`target.isStreaming === true`).
- **Guarantee callback delivery when streaming finishes—or if already complete—even with empty children:** Ensure a single observer setup handles streamed elements, empty elements (`<x-el></x-el>`), imperative/already-parsed elements, and subsequent dynamic mutations.
- **Expose synchronous streaming state (`element.isStreaming`) with zero per-element parser traffic:** Allow synchronous code and `"stream"` observers to check whether an element is currently streaming without emitting per-element open/close operations for elements that open and close within a parser batch.
- Eliminate the client-side workarounds above with **zero cost when unused** and **no new properties on `MutationRecord`**.

### Non-Goals

- **Discouraging dynamic mutation handling:** Observers remain active for ongoing DOM mutations after initial streaming finishes (and automatically batch future streams into the target).
- **Holding back DOM tree mutations themselves:** Nodes and attribute changes still apply to the DOM immediately so rendering, preload scanning, and other observers are unaffected; a batch observer only buffers `MutationRecord` delivery (for all mutations it observes on `target`—both parser-driven and imperative—until `target.isStreaming` is `false`).
- **Tracking non-element nodes**, or **replacing `PerformanceEntry` for sub-microtask RUM timing**.

---

## Proposed Approach

A `delivery` member in `MutationObserverInit` (`"stream" | "batch"`, defaulting to `"stream"`), paired with a read-only `element.isStreaming` getter ([whatwg/html#12200](https://github.com/whatwg/html/issues/12200)). Calling `observer.observe(target, { childList: true, delivery: "batch" })` creates a **batch registration** for `target`:

- **When a target is considered streaming (`element.isStreaming`):** See [§1](#1-definition-of-streaming) (the same parser-open definition used in [Hide While Loading (`hidden="while-loading"`)](./partial-render-blocking-explainer.md#2-when-is-an-element-loading)): the element is on the parser's stack of open elements, or is the context of an active streaming fragment parser (`streamHTML*` or a `<template for>` patch). `element.isStreaming` reflects this state synchronously for code that wants to check whether an element is already complete before registering an observer (as in [Example 2](#2-delegated-island-hydration-from-a-document-observer)), and shares the same zero-overhead batch-boundary optimization for off-main-thread parsers (see [Q1](#q1-does-batch-delivery-or-elementisstreaming-add-overhead-to-the-html-parser-or-delay-rendering)).
- **Buffering is keyed on the observed target:** While an **observed** `target` is streaming (`target.isStreaming === true`), **all** of the observer's `MutationRecord`s for that `target`—from the parser or from script, and including descendant records when `subtree: true`—are **held back** until `target.isStreaming` becomes `false`. The streaming state of descendants is irrelevant.
- **Observer-specific firing order:** Buffering applies only to batch registrations, so other observers (`delivery: "stream"` observers, or batch observers on child elements whose end tags arrive earlier) are not held back and may fire in a different order. To keep each callback's timing uniform, use separate observers for `"stream"` and `"batch"` delivery rather than mixing both on one observer (as in [Example 2](#2-delegated-island-hydration-from-a-document-observer)).
- **`observe()` schedules a callback:** A batch registration is **guaranteed to fire** once: when streaming into `target` ends, **or at the next microtask checkpoint if `target.isStreaming` is already `false`** when `observe()` is called—synthesizing an empty `childList` record (`addedNodes: []`, `removedNodes: []`) if nothing was queued. This is a new side effect for `observe()` (see [§3](#3-observe-schedules-a-callback-guaranteed-firing--empty-children)).

### Example Usage

#### 1. Custom element readiness & ongoing mutations

```js
class CustomSelect extends HTMLElement {
  #mo = new MutationObserver((records) => {
    // Runs once </custom-select> is parsed (with all streamed <option>s batched),
    // OR on the next microtask if already complete (e.g. innerHTML, upgrade, createElement),
    // even if <custom-select></custom-select> has empty children.
    // Also runs on subsequent dynamic DOM changes—and batches future streamHTML() calls!
    this.#syncOptions(records);
  });

  connectedCallback() {
    this.#mo.observe(this, { childList: true, delivery: "batch" });
  }

  disconnectedCallback() {
    this.#mo.disconnect();
  }
}
```

#### 2. Delegated island hydration from a document observer

```js
// Batches records for an <article> that was still open at chunk end until </article>:
const articleObserver = new MutationObserver((records) => {
  const ready = new Set(records.map((r) => r.target));
  for (const article of ready) enhanceArticle(article);
});

// Discovers <article> elements without delaying incremental observation:
const docObserver = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node instanceof Element && node.matches("article")) {
        if (!node.isStreaming) {
          // Opened and closed in the same chunk: enhance immediately
          enhanceArticle(node);
        } else {
          // Split across chunks (or also observe for ongoing mutations): wait for </article>
          articleObserver.observe(node, { childList: true, delivery: "batch" });
        }
      }
    }
  }
});

docObserver.observe(document, { subtree: true, childList: true });
```

### Web IDL

```webidl
enum MutationObserverDelivery { "stream", "batch" };

partial dictionary MutationObserverInit {
  MutationObserverDelivery delivery = "stream";
};

partial interface Element {
  readonly attribute boolean isStreaming;
};
```

*(Within a single synchronous task, both `"stream"` and `"batch"` batch mutations at the microtask checkpoint as usual. They differ when `target.isStreaming` is `true` across tasks: `"stream"`—today's default—flushes each chunk incrementally at intermediate microtask checkpoints, whereas `"batch"` holds records until `target.isStreaming` becomes `false`.)*

---

## Detailed Design

<a id="1-definition-of-parsing"></a>
### 1. Definition of "streaming"

An `Element` `target` is **streaming** (`target.isStreaming === true`; *shared definition with [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) and [Hide While Loading (`hidden="while-loading"`)](./partial-render-blocking-explainer.md#2-when-is-an-element-loading)*) when **either**:
1. It was pushed onto the HTML parser's stack of open elements and its **end tag has never been seen** yet (void elements and self-closing foreign elements are popped immediately on insertion, so `isStreaming` is already `false` by the time any observer or script sees them), **or**
2. It is **currently the context element of an active streaming fragment parser**—either an open `streamHTML`, `streamHTMLUnsafe`, or `streamAppendHTML*` parser on `target`, or an active `<template for="...">` / `<template for="..." src="...">` patch currently streaming into a marker whose parent is `target`.

`Element.prototype.isStreaming` and `delivery: "batch"` solve complementary parts of the problem:
- **`element.isStreaming` provides synchronous inspection** when script already has a reference to `element` (for example in `connectedCallback()`, an event handler, or a document-level `"stream"` `MutationObserver` checking whether a newly added node already closed in the current chunk).
- **`delivery: "batch"` provides batched completion notification** when `element` is still open across chunks (`element.isStreaming === true`) or when the caller wants a single unified callback covering both initial completion and ongoing dynamic mutations.

Children inserted by `document.write()` from a script inside `target` (while `target` is still on the stack of open elements) are inserted by the same parser and are therefore buffered like any other child.

Only `Element` nodes have `isStreaming`. For a `Document`, `DocumentFragment`, or `ShadowRoot` target, a batch observer never buffers; it only adds the guaranteed initial callback (see [Considered Extensions](#considered-extensions-not-currently-proposed) for `ShadowRoot`).

### 2. Per-observer batching, keyed on the observed target

When `observer.observe(target, { childList: true, delivery: "batch", ... })` is called:

- **Keyed on the observed target, including with `subtree: true`:** While `target.isStreaming` is `true`, **all** of the observer's `MutationRecord`s for `target` are held, including parser insertions, script mutations (`append()`, `remove()`, `setAttribute()`), and with `subtree: true`, records for any descendant. They are delivered together once **`target.isStreaming`** becomes `false`. Descendants that close earlier do not cause an early flush. For per-descendant readiness, observe each descendant separately (as in [Example 2](#2-delegated-island-hydration-from-a-document-observer)). If one batch observer observes several targets, each target is buffered separately, so a completed element flushes without waiting for an unrelated element that is still streaming.
- **Observer-specific firing order:** `"stream"` observers flush at every microtask checkpoint in observer creation order. A batch observer holds its records, so **other observers may fire earlier and in a different order**:
  - A `"stream"` observer (such as `docObserver` above) fires immediately at chunk 1's microtask checkpoint, while a batch observer on an unclosed element holds its records until chunk 2.
  - Nested batch observers flush **bottom-up** as end tags arrive: a batch observer on `<s-option>` flushes in chunk 1 as soon as `</s-option>` is seen, *before* the earlier-created batch observer on its parent `<s-select>` flushes at `</s-select>` in chunk 2.

### 3. `observe()` schedules a callback: guaranteed firing & empty children

Today (`delivery: "stream"`), `observe()` only registers interest: the callback runs only if a mutation occurs. With `delivery: "batch"`, **`observe()` itself can cause a callback**, and the callback fires once per registration even if nothing changes. There is precedent: `IntersectionObserver.observe()` and `ResizeObserver.observe()` both deliver an initial notification without any change.

- **When streaming ends:** When `target.isStreaming` transitions from `true` to `false` (end tag popped, implied end tag, EOF, parser abort, or the active `streamHTML*` / `<template for>` stream closing or aborting), all buffered records for `target` flush at the next microtask checkpoint. If no records were queued while streaming (for example `<my-widget></my-widget>`, or an empty `streamHTML*` write), an empty `childList` record is synthesized so the observer **always fires**.
- **When already not streaming (`target.isStreaming === false`):** If `target` is *already* complete when `observe()` is called (a custom element upgraded after parsing, `innerHTML` / `setHTML`, `document.createElement()`, or a node that already closed earlier in the same chunk), `observe()` **schedules a callback for the next microtask checkpoint**. It delivers any mutations made later in the same task (such as `el.append(a, b)`), or an empty `childList` record if none occurred.
- **Re-observing (including element moves):** If `observe()` is called again for a target the observer already observes, the options are replaced as today. Re-observing with `delivery: "batch"` **does not schedule another initial callback**; switching an existing `"stream"` registration to `"batch"` does, and switching from `"batch"` to `"stream"` releases any held records at the next microtask checkpoint. This covers custom elements whose `connectedCallback` runs again after a move without an intervening `disconnect()`. After `observer.disconnect()`, a later `observe()` is a new registration and schedules a new initial callback. In the [example above](#1-custom-element-readiness--ongoing-mutations), that means a non-atomic move (`disconnectedCallback` then `connectedCallback`) runs setup again. Components that want to avoid this can implement `connectedMoveCallback` and use `moveBefore()`.
- **Trade-off vs. checking `isStreaming` / `childNodes` in `connectedCallback`:** Authors could check `if (!this.isStreaming)` in `connectedCallback` and run setup synchronously for already-parsed elements, while still needing a `MutationObserver` for streamed elements and future mutations. The guaranteed callback keeps initial setup and later updates in a single code path without branching in `connectedCallback` (see [§6](#6-custom-elements-and-wicgwebcomponents809)).
- **Subsequent dynamic mutations & streams:** After that flush, ordinary DOM mutations (`el.append(c)`) flush normally at the microtask checkpoint. A later `el.streamHTML*()` call, or a `<template for>` patch into `el`, sets `el.isStreaming` back to `true` and buffers its mutations until the stream ends (again firing with an empty `childList` record if the stream added no children).
- **Option validation, `takeRecords()`, & disconnection:** Passing `delivery: "batch"` with `childList: false` (or an unrecognized `MutationObserverDelivery` value) throws a `TypeError`. `observer.takeRecords()` synchronously drains and returns **all** queued records on `observer`, including records buffered for a target that is still streaming. If `target.isStreaming` is `true`, the observer still fires when streaming ends with any later mutations, or an empty `childList` record if there are none. If `target.isStreaming` was `false`, draining cancels the pending initial callback. Calling `observer.disconnect()` discards any buffered records. Elements discarded by the sanitizer never connect and never fire.

#### Shape of the synthesized record

The synthesized record is `{ type: "childList", target, addedNodes: [], removedNodes: [], previousSibling: target.lastChild, nextSibling: null }`, which describes no change. `"childList"` was chosen over a new record type so that the usual callback loops (`for (const r of records) handle(r.addedNodes)`) work without a special case, and existing code that switches on `record.type` sees nothing unfamiliar. The trade-off is a record that describes no change, which DOM editors may object to. A dedicated type is the main alternative. The same question applies to the `"start"` record in the [template `MutationObserver` explainer](./template-mutation-observer-explainer.md), and both should get the same answer.

### 4. Long-lived streams & unbounded buffering

Buffering lasts as long as `target.isStreaming` is `true`. For a long-lived stream (such as an LLM chat response streamed into an element through `streamHTML()` for minutes), a batch observer holds **every** record for that `target` until the stream ends. That is by design, but authors should know about it:

- **`delivery: "batch"` is the wrong choice for progressively rendered targets.** If a component should react to content as it arrives, use `delivery: "stream"` (or `activeTemplateAttributeFilter` for `<template for>` patches; see the [template `MutationObserver` explainer](./template-mutation-observer-explainer.md)).
- **`takeRecords()` is the escape hatch.** A component can drain buffered records at any time (for example from a `requestAnimationFrame` loop or a timer) without waiting for the stream to end. The guaranteed final callback still fires when the stream closes.
- **Implementations may store buffered records compactly** (for example by coalescing adjacent `childList` records for the same `target`), since only the final batch can be observed.

### 5. Scenarios & Edge-Case Walkthroughs

The tables below show what a `MutationObserver` receives in each scenario. Throughout, `emptyRecord(target, prev = target.lastChild)` denotes the synthesized record `{ type: "childList", target, addedNodes: [], removedNodes: [], previousSibling: prev, nextSibling: null }`.

#### 5.1 Multi-chunk streaming & nested bottom-up ordering

`<s-select>` and `<s-option>` each call `this.#mo.observe(this, { childList: true, delivery: "batch" })` in `connectedCallback()`, while `docObserver` observes `document` with `{ childList: true, subtree: true }` (`delivery: "stream"`):
- **Chunk 1:** `<s-select><s-option>A</s-option>`
- **Chunk 2:** `<s-option>B</s-option></s-select>`
- **Later task:** `select.append(optC)`

| Checkpoint | `docObserver` (`"stream"`) | `<s-option>A`'s observer (`"batch"`) | `<s-select>`'s observer (`"batch"`) |
|---|---|---|---|
| **End of Chunk 1** | **Fires:** `addedNodes: [<s-select>]`, `addedNodes: [<s-option>A]`, `addedNodes: ["A"]`. | **Fires:** `[addedNodes: ["A"]]` because `</s-option>` closed in Chunk 1—even though `<s-select>`'s observer was registered first. | **Held:** `<s-select>.isStreaming` is `true` (`addedNodes: [<s-option>A]` buffered). |
| **End of Chunk 2** | **Fires:** `addedNodes: [<s-option>B]`, `addedNodes: ["B"]`. | *(No changes)* | **Fires once** with all buffered records from both chunks: `[addedNodes: [<s-option>A], addedNodes: [<s-option>B]]`. |
| **After `select.append(optC)`** | **Fires:** `addedNodes: [<s-option>C]`. | *(No changes)* | **Fires at microtask checkpoint:** `[addedNodes: [<s-option>C]]`. |

#### 5.2 Empty elements, `createElement`, `innerHTML`, and late custom-element upgrades

When `<s-select>` calls `this.#mo.observe(this, { childList: true, delivery: "batch" })` in `connectedCallback()`:

| Scenario | `this.isStreaming` when `observe()` runs | Records queued before flush | What `<s-select>`'s observer receives |
|---|---|---|---|
| **Empty across two chunks** (`Chunk 1: <s-select>`, `Chunk 2: </s-select>`) | `true` (on stack of open elements) | None | Held at Chunk 1; **fires at end of Chunk 2** with `[emptyRecord(<s-select>, null)]`. |
| **Empty in one chunk** (`<s-select></s-select>`) | `true` (on stack when `connectedCallback` runs; popped at `</s-select>` in same chunk) | None | **Fires at end of chunk** with `[emptyRecord(<s-select>, null)]`. |
| **Imperative `createElement` + synchronous `append()`** (`body.append(s); s.append(optA, optB);`) | `false` (`connectedCallback` runs during `body.append(s)`) | `s.append(optA, optB)` queues `addedNodes: [optA, optB]` in the same task | **Fires once at microtask checkpoint** with `[addedNodes: [optA, optB]]` (no synthesized empty record needed because a real record was queued). |
| **Imperative `createElement` with no children** (`body.append(s);`) | `false` | None | **Fires at microtask checkpoint** with `[emptyRecord(<s-select>, null)]`. |
| **`el.innerHTML = "<s-select><s-option>A</s-option></s-select>"`** | `false` (custom element reactions run after the synchronous fragment parser finishes) | None after `connectedCallback()` (children were inserted before `connectedCallback` ran) | **Fires at microtask checkpoint** with `[emptyRecord(<s-select>, <s-option>A)]`. |
| **Late `customElements.define("s-select", ...)`** after `<s-select><s-option>A</s-option></s-select>` is already in the DOM | `false` | None | **Fires at microtask checkpoint** with `[emptyRecord(<s-select>, <s-option>A)]`. |

#### 5.3 Delegated observation from a parent/document `"stream"` observer

Suppose `docObserver` (`{ childList: true, subtree: true }`, `delivery: "stream"`) discovers `<article>` in `addedNodes` at the end of Chunk 1 and calls `articleObserver.observe(article, { childList: true, delivery: "batch" })`:

| Chunk 1 & Chunk 2 markup | `article.isStreaming` when `docObserver` runs at end of Chunk 1 | What `articleObserver` receives |
|---|---|---|
| **Chunk 1:** `<article><h1>Title</h1>`<br>**Chunk 2:** `<p>Body</p></article>` | **`true`** (`<h1>` was already inserted before `observe()` was called, so `<h1>` is already in `article.children`). | Held until `</article>` in Chunk 2; **fires at end of Chunk 2** with `[addedNodes: [<p>]]`. |
| **Chunk 1:** `<article><h1>Title</h1>`<br>**Chunk 2:** `</article>` *(no new children in Chunk 2)* | **`true`** | Held until `</article>` in Chunk 2; **fires at end of Chunk 2** with `[emptyRecord(<article>, <h1>)]`. |
| **Chunk 1:** `<article><h1>Title</h1></article>` *(opened and closed in Chunk 1)* | **`false`** (already closed by the time `docObserver`'s microtask runs). | If `articleObserver.observe()` is called anyway, it schedules a microtask immediately and **fires in the same microtask checkpoint** with `[emptyRecord(<article>, <h1>)]` (or `docObserver` can check `!article.isStreaming` to enhance `article` synchronously without registering `articleObserver`). |

#### 5.4 Inline `<script>` inside an open element (`document.write()`, imperative mutations, `takeRecords()`)

Suppose `<s-select>` is observed with `{ childList: true, attributes: true, delivery: "batch" }` and the parser processes:
```html
<s-select>
  <s-option>A</s-option>
  <script>/* runs while <s-select> is still on the stack of open elements */</script>
  <s-option>B</s-option>
</s-select>
```
When `</script>` is parsed, the parser executes the script and performs a microtask checkpoint before continuing to `<s-option>B</s-option></s-select>`:

| Action inside `<script>` | At `</script>` microtask checkpoint | At `</s-select>` microtask checkpoint |
|---|---|---|
| **No-op `<script>`** | `<s-option>A`'s observer **fires** (`</s-option>` already closed). `<s-select>`'s observer **does not fire** (`<s-select>.isStreaming` is still `true`). | `<s-select>`'s observer **fires once** with `[addedNodes: [<s-option>A], addedNodes: [<script>], addedNodes: [<s-option>B]]`. |
| **Imperative mutation** (`select.setAttribute("data-x", "1"); select.append(optX);`) | **Held:** Because `<s-select>.isStreaming` is `true`, both parser insertions and script mutations targeting `<s-select>` remain buffered. | **Fires once** with all buffered `childList` and `attributes` records in order. |
| **`document.write("<s-option>W</s-option>")`** | **Held:** Tokens written into the active parser while `<s-select>` is on the stack of open elements are buffered with the rest. | **Fires once** including `addedNodes: [<s-option>W]`. |
| **`const early = selectObserver.takeRecords()`** | `takeRecords()` synchronously drains and returns `[addedNodes: [<s-option>A], addedNodes: [<script>]]`. Because `<s-select>.isStreaming` is still `true`, the batch registration stays armed. | **Still fires at `</s-select>`** with `[addedNodes: [<s-option>B]]` (or `[emptyRecord(<s-select>)]` if no further mutations occurred after `takeRecords()`). |

#### 5.5 Streaming updates after initial parse (`streamHTML*()` and `<template for>`)

Suppose `<section id="feed">` is already parsed and observed with `feedObserver.observe(feed, { childList: true, subtree: true, delivery: "batch" })`:

| Streaming operation | While stream is open across chunks | When stream finishes |
|---|---|---|
| **`const w = feed.streamHTML()`**<br>`w.write("<p>1</p>")` → yield → `w.write("<p>2</p>")` → `w.close()` | `feed.streamHTML()` synchronously removes existing children and sets `feed.isStreaming = true`. Both `removedNodes: [...oldChildren]` and `addedNodes: [<p>1]` are **held** across chunks. | `w.close()` sets `feed.isStreaming = false`; `feedObserver` **fires once** with `removedNodes: [...oldChildren]` and all `addedNodes` (`<p>1`, `<p>2`, and their text). |
| **Empty `streamHTML()`** on an already-empty `feed` (`const w = feed.streamHTML(); w.close();`) | `feed.isStreaming` is `true` while `w` is open. | **Fires on `w.close()`** with `[emptyRecord(feed, null)]`. |
| **`<template for="feed">`** streaming across chunks into `<section id="feed"><?marker name="feed"></section>` | `feed` is the target of an active `<template for>` patch (`feed.isStreaming === true`), so records in `feed`'s buffer are **held** until `</template>`. | When `</template>` is parsed (or the stream aborts at EOF), `feedObserver` **fires once** with all mutations from the patch. |

#### 5.6 HTML parser edge cases & aborts

| Edge case | Parser behavior | What batch observer receives |
|---|---|---|
| **Implied end tags** (`<ul><li>One<li>Two</ul>`) | Parsing the second `<li>` start tag implicitly pops the first `<li>` from the stack of open elements. | Batch observer on the first `<li>` flushes at that chunk's microtask checkpoint, identically to an explicit `</li>`. |
| **Adoption agency algorithm** (`<x-b><x-i>Bold </x-b>italic</x-i>`) | At `</x-b>`, the original `<x-i>` and `<x-b>` are popped from the stack of open elements; a *new* `<x-i>` element is created for `italic`. | Observers on the original `<x-i>` and `<x-b>` flush after `</x-b>`. The cloned `<x-i>` is a distinct `Element` instance whose `isStreaming` remains `true` until `</x-i>`. |
| **Foster parenting** (`<table><x-div><span>hi</span></x-div><tr><td>cell</td></tr></table>`) | `<x-div>` is inserted as a sibling before `<table>`, but remains on the stack of open elements until `</x-div>`. | Observer on `<x-div>` holds `<span>hi</span>` until `</x-div>`. Because `<x-div>` is inserted into `<table>.parentNode` (not `<table>`), an observer on `<table>` only sees `<tbody>`/`<tr>`, while an observer on `<table>.parentNode` holds both `<x-div>` and `<table>` until `<table>.parentNode` closes. |
| **Element removed mid-parse** (`Chunk 1: <x-box><p>1</p>` + `<script>box.remove()</script>`, `Chunk 2: <p>2</p></x-box>`) | The parser's stack of open elements holds a reference to `box` and continues appending `<p>2</p>` into the detached `box` until `</x-box>` pops it. | If `disconnectedCallback()` calls `this.#mo.disconnect()`, buffered records are cleared and nothing fires. If the observer does *not* disconnect, `box.isStreaming` stays `true` until `</x-box>` pops it in Chunk 2, then flushes `[addedNodes: [<p>1], addedNodes: [<p>2]]`. |
| **Element moved mid-parse** (`newParent.append(box)` while `box` is still on the parser stack, re-running `connectedCallback`) | `box` remains on the stack of open elements until `</x-box>`. | If `disconnectedCallback` did not call `disconnect()`, calling `observe(box, { delivery: "batch" })` again in `connectedCallback` updates the existing registration in place without discarding held records or scheduling a premature flush; it flushes once `</x-box>` is parsed. |
| **Premature EOF / `window.stop()` / aborted stream** (`<x-box><p>Half...` then EOF) | At EOF or abort, the parser pops all remaining elements from the stack of open elements. | `<x-box>.isStreaming` becomes `false` and flushes all buffered records (`[addedNodes: [<p>]]`) at the microtask checkpoint. |

### 6. Custom elements and `WICG/webcomponents#809`

The central objection in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809) to a dedicated custom element `parsedCallback()` is that an end-tag callback invites authors to read `this.children` once and ignore subsequent dynamic mutations, imperative `createElement` + `append()`, or post-parse insertions ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1460917211), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1757047993)).

Calling `this.#mo.observe(this, { childList: true, delivery: "batch" })` in `connectedCallback()` satisfies that principle across every creation mode with a single callback:
1. **Streamed across network chunks (`<s-select>` ... `</s-select>`):** `#mo` buffers all child insertions across chunks and fires once `</s-select>` is seen.
2. **Empty children (`<s-select></s-select>`):** Guaranteed to fire at `</s-select>` with an empty `childList` record (`addedNodes: []`, `removedNodes: []`), so initial setup still runs.
3. **Imperative `createElement` + `append()`, `innerHTML`, or late upgrade:** Because a batch observer is guaranteed to fire on the next microtask when `target.isStreaming` is already `false`, `const s = document.createElement("s-select"); document.body.append(s); s.append(opt1, opt2);` runs `connectedCallback()` on `body.append(s)`, batches `s.append(opt1, opt2)` in the same synchronous task, and fires once at the microtask checkpoint (or fires with an empty `childList` record if no children were appended or if upgraded after parsing).
4. **Subsequent dynamic mutations & streams:** Later JS mutations (`s.append(opt3)`) trigger `#mo` at the microtask checkpoint, and later `s.streamHTML*()` streams or `<template for>` patches into `s` buffer until they complete.

---

## Considered Extensions (Not Currently Proposed)

- **`ShadowRoot` batch delivery:** Buffering a batch observer's records for a `ShadowRoot` whose declarative `<template shadowrootmode>` has not yet closed (or that is an active `streamHTML*` target) is a natural extension under consideration, but is not part of the core proposal.
- **Custom element `parsedCallback()`:** Libraries like [`html-parsed-element`](https://github.com/WebReflection/html-parsed-element) polyfill `parsedCallback()` today using per-element `subtree: true` `MutationObserver`s. While a native `parsedCallback()` could mirror batch completion timing, a batch observer handles both initial readiness and ongoing mutations without introducing a one-shot lifecycle footgun.

---

## Alternatives Considered

1. **Relying on `Element.isStreaming` (or `MutationRecord.closingTagParsed`) alone without `delivery: "batch"`:** The 2023 WCCG F2F discussed exposing a passive boolean (`MutationRecord.closingTagParsed` in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809#issuecomment-1516789211)) or `element.isStreaming` without `delivery: "batch"`. While `element.isStreaming` is useful for synchronous inspection (and is included above), a boolean *by itself* does not tell an observer when `element.isStreaming` later flips from `true` to `false`—if an element's children arrived in Chunk 1 and only `</element>` arrives in Chunk 2, no further child mutation occurs in Chunk 2 to wake up a `"stream"` `MutationObserver` ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1755889378)). Pairing `element.isStreaming` with `delivery: "batch"` provides both synchronous inspection and guaranteed completion delivery.
2. **A `record.parsedElements` `NodeList` on `MutationRecord`:** Required a `NodeList` allocation per `MutationRecord`, forced observing `el.parentNode` rather than `el` directly, and still delivered half-parsed child mutations across chunk boundaries.
3. **Combining batch delivery and `<template>` observation into a single `parser: true` option:** Streaming `<template for>` observers ([template-mutation-observer-explainer.md](./template-mutation-observer-explainer.md)) want incremental per-chunk `"start"` / `"update"` / `"end"` records (`delivery: "stream"`), whereas batch observers want records held until the observed target finishes streaming. Keeping them separate avoids conflating opposite delivery models.
4. **A constructor option (`new MutationObserver(cb, { delivery: "batch" })`):** Makes delivery a property of the whole observer, so one callback never mixes `"stream"` and `"batch"` targets, and the opt-in sits next to the callback that must handle the synthesized record. Not chosen because it buys little: per-target buffering already mixes held and flushed targets within one batch observer; `observe()` still schedules the initial callback for already-parsed targets; authors who find mixed timing confusing can use two observers; and it would add the first options dictionary to `MutationObserver`'s constructor, while every existing option lives in `MutationObserverInit`.
5. **A dedicated one-shot method (e.g. `observer.notifyWhenParsed(target)`):** `observe()` stays side-effect free; a separate call means "hold this observer's records for `target` until `target.isStreaming` is `false`, then deliver at least one record". This makes the synthesized record easy to justify ("you asked to be notified") and settles re-observing and long streams, since nothing happens unless the method is called. Not chosen because it takes two calls with ordering rules (throw if `target` isn't observed; no-op while a hold is pending; dropped by `disconnect()`), and later `streamHTML*()` streams or `<template for>` patches are not held automatically: the component owning the observer must notice them and call the method again. Kept as the main fallback if DOM editors object to `observe()` scheduling a callback.
6. **DOM Events (`parseend`):** Per-element event dispatch during parsing repeats the performance issues of legacy `MutationEvent` and neither batches `MutationRecord`s nor observes subsequent dynamic mutations.
7. **Status quo (client-side reconstruction):** Requires per-element `subtree: true` observers, ancestor `nextSibling` walks, chunk regexes, or sentinel nodes/scripts, and cannot observe active `streamHTML*` boundaries.

---

## Frequently Asked Questions (Q&A)

<details>
<summary><strong>Parser overhead, firing order, and empty/already-parsed targets</strong></summary>

### Q1: Does batch delivery or `element.isStreaming` add overhead to the HTML parser or delay rendering?
No. The HTML parser inserts nodes into the live DOM immediately as bytes arrive—layout, rendering, preload scanning, and other observers are never delayed. Holding records in a pending queue only occurs for batch observers, gated on state the parser already maintains (stack of open elements and active streaming fragment parsers).

**Off-main-thread / tree-op parsers (e.g., Gecko):** An engine that separates parsing from main-thread DOM construction via queued tree operations does **not** need to emit an "end-stream" operation or flip an `isStreaming` bit on every element's opening and closing tags ([w3c/csswg-drafts#12578 (comment)](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209690246)). Any element that opens and closes without an intervening parser batch flush (chunk or timer boundary), `<script>`, or custom element reaction can never be observed by script while open—by the time any `MutationObserver` or script can hold a reference to that element and read `el.isStreaming`, it is already `false` (the default). The parser only needs to mark the $O(\text{stack depth})$ ancestor elements that are actually on the stack of open elements *at* a batch flush, `<script>`, or custom element reaction (and later emit a close op for those few nodes, which can itself be batched up to the next such boundary).

### Q2: Why can observers fire in a different order when batch observers are used?
Because buffering is observer-specific: a batch observer watching `<parent>` holds its records while `<parent>.isStreaming` is `true`, whereas a `"stream"` observer—or a batch observer on `<child>` whose `</child>` arrived in an earlier chunk—flushes at that earlier chunk's microtask checkpoint. Nested batch components therefore initialize bottom-up (`<s-option>` flushes before `<s-select>`).

### Q3: Why is a batch observer guaranteed to fire even if the target is already parsed or has empty children?
Guaranteeing a flush when streaming ends—or at the next microtask checkpoint if `target.isStreaming` is already `false`—(synthesizing an empty `childList` record when no child records were queued) ensures `<my-widget></my-widget>` observed in `connectedCallback()` and elements upgraded or observed after parsing initialize through the exact same `MutationObserver` callback as multi-chunk elements.

</details>

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

`delivery: "batch"` and `Element.prototype.isStreaming` expose no new user or cross-origin information: they only reflect same-origin parser-open / streaming state and control microtask delivery timing of `MutationRecord`s for a DOM element the caller can already observe, and emit nothing for sanitizer-discarded elements.

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. `element.isStreaming` and `delivery: "batch"` only reflect same-origin streaming state and control microtask delivery timing of `MutationRecord`s for a DOM element the caller can already observe.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes. No new properties are added to `MutationRecord`; elements discarded by a sanitizer never connect or emit records.

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
    No. `MutationObserver` callbacks continue to run at the standard microtask checkpoint.

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
    If a document is disconnected or its parser aborts while an observed target is still streaming, streaming ends (as at EOF/abort) and standard `MutationObserver` lifecycle rules apply; calling `observer.disconnect()` discards any buffered records.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Passing `delivery: "batch"` with `childList: false` (or an invalid `MutationObserverDelivery` value) throws a `TypeError`, matching existing `MutationObserver.prototype.observe()` option validation.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.

</details>
