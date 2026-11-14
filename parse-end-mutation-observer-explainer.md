# Explainer: Parse-End Notification for `MutationObserver` and `element.isParsing`

## Introduction

The HTML parser tracks [which elements are still open](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) and when each one closes (by an explicit end tag, an implied end tag, or EOF). Built-in elements like `<script>`, `<style>`, and `<object>` already rely on this state to act only once the parser finishes them.

`MutationObserver`, however, only sees the start tag: when markup streams across network chunks, the parser inserts an element on its opening tag and yields before its closing tag arrives, flushing half-built subtrees to observers at intermediate microtask checkpoints. By contrast, when DOM is built synchronously in JavaScript (`el.append(a); el.append(b);`), `MutationObserver` naturally batches all mutations in the task and delivers them together at the microtask checkpoint.

This explainer proposes a synchronous `element.isParsing` getter ([whatwg/html#12200](https://github.com/whatwg/html/issues/12200)) and a way for a `MutationObserver` to learn that an observed element has finished parsing:

1. **The browser already tracks this state** (the parser's stack of open elements and active streaming fragment parsers—`streamHTML*` and `<template for>` patches), so exposing it introduces no new parser concepts or DOM tree buffering.
2. **Server-driven and streaming apps already depend on it**, reconstructing it today with sentinel nodes, inline scripts, ancestor `nextSibling` walks, regexes over raw HTML, and per-element `subtree: true` observers at measurable main-thread and wire cost (see [Existing workarounds](#existing-workarounds)).
3. **It fits the existing reactive model.** Rather than introducing a one-shot hook that tempts authors to ignore subsequent dynamic mutations ([WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)), parse end is reported through `MutationObserver` itself, which keeps observing future DOM changes and streams.

There are two candidate designs for the `MutationObserver` part, with no decision between them yet (discussion in [whatwg/html#13198](https://github.com/whatwg/html/issues/13198)). Both include `element.isParsing`.

| | [Option 1: batched delivery](#option-1) | [Option 2: parse-end record](#option-2) |
|---|---|---|
| **API** | `observer.waitForParser({ target, signal })`, next to an unchanged `observe()` | `observe(target, { childList: true, parseEnd: true })` |
| **Delivery timing** | The observer delivers nothing while a target it waits for is parsing, then delivers its whole queue in mutation order. | Unchanged from today. |
| **Parse-end signal** | The held batch. If `target` was parsing when `waitForParser()` was called, the callback is invoked at parse end even with no records. No record is synthesized. | The first callback in which `target.isParsing` is `false`. An empty `childList` record is queued when `target` finishes parsing only if no `childList` record for it is pending, so that this callback always happens. `observe()` has no side effects. |
| **`subtree: true` & several targets** | No restrictions and no new `TypeError`s. The observer is held as a whole, so elements that complete independently need separate observers. | `subtree: true` is a `TypeError`. Multiple targets and mixing `parseEnd: true` / `false` are allowed. |
| **Main advantage** | The callback never has to check `isParsing`: it does not run while a target the observer waits for is parsing. | Delivery timing, `observe()`, `takeRecords()`, and `disconnect()` all keep today's behavior. |
| **Main concern** | [Deferred microtask delivery](#scheduling-and-ordering): the observer's records are held across intermediate microtask checkpoints (including inline `<script>`s). | A [`childList` record that describes no change](#parse-end-record), plus checking `isParsing` in the callback and around `observe()`. |

See [Comparing the options](#comparison) for the full trade-offs.

*(For observing parser-consumed `<template for>` lifecycle and attribution, see the companion explainer: [template-mutation-observer-explainer.md](./template-mutation-observer-explainer.md).)*

---

## Prior Discussions

- [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809), [#619](https://github.com/WICG/webcomponents/issues/619), [#550](https://github.com/WICG/webcomponents/issues/550): notifications when the HTML parser finishes parsing an element's children
- [whatwg/dom#662](https://github.com/whatwg/dom/issues/662): custom element callback/notification for "connected and parsed"
- [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116): observing parse completion when streaming into a detached document
- [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) & [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578): parser stack openness state
- [whatwg/html#13198](https://github.com/whatwg/html/issues/13198): the proposal issue for this explainer
- [whatwg/html#12758](https://github.com/whatwg/html/pull/12758), [#12753](https://github.com/whatwg/html/pull/12753), [#12624](https://github.com/whatwg/html/pull/12624), & [#12756](https://github.com/whatwg/html/pull/12756): streaming HTML insertion (`streamHTML*`) and sanitizing while parsing

---

## Use Cases & Problem Statement

When the parser processes `<s-select><s-option>A</s-option><s-option>B</s-option></s-select>`, it inserts `<s-select>` into the DOM as soon as it reads the start tag. If the parser yields between network chunks before `</s-select>`, observers watching `<s-select>` or the document see incomplete children:

- **Evaluate content once ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)):** Elements that interpret text, configuration, or inline code (syntax highlighters, math/markdown blocks, or streamed `<script>` elements moved from a detached document) fail with syntax or parse errors when evaluated at a chunk boundary before the closing tag arrives.
- **Batch child setup and validation ([whatwg/dom#662](https://github.com/whatwg/dom/issues/662), [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)):** Custom elements that validate, index, or slot light-DOM children (such as `<s-select>` validating `<s-option>` children or data tables indexing rows) emit false validation warnings or perform redundant $O(N^2)$ work if they run on the opening tag or on every intermediate chunk.
- **Hydrate or animate complete subtrees ([whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)):** Triggering island hydration, View Transitions, WAAPI animations, or progressive DOM morphing on an element that is still open on the parser stack acts on half-streamed markup.

`requestAnimationFrame` and `setTimeout` heuristics fail for the same reason: the parser can yield and spin the event loop in the middle of an element ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1457018630), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455818744)).

### Existing workarounds

Because element parse completion isn't exposed to `MutationObserver`, server-driven and streaming applications must reconstruct it on the client:

| Workaround | Where | What it reconstructs | Cost |
|---|---|---|---|
| **Ancestor `nextSibling` walk + a `subtree: true` `MutationObserver` per element** | [`WebReflection/html-parsed-element`](https://github.com/WebReflection/html-parsed-element/blob/main/index.js), [`svelte-retag`](https://github.com/patricknelson/svelte-retag/issues/20#issuecomment-1848262955) | End-tag completion, inferred by checking whether the element or any ancestor has a `nextSibling` | One observer per pending element, re-walking ancestors on every insertion. Reported at hundreds of milliseconds of main-thread time on medium documents; last-child elements stay "unparsed" until `DOMContentLoaded`. |
| **Regex over raw HTML chunks + `document.write()` into a detached document / `<iframe>`** | [`marko-js/writable-dom`](https://github.com/marko-js/writable-dom/blob/main/src/index.ts) | Whether an inline `<script>`/`<style>` is still open (`!(node.nextSibling \|\| /<\/\w+>$/.test(curChunk))`) | Couples DOM logic to raw chunk strings and requires an `<iframe>` fallback where detached documents strip scripts. |
| **Nested `MutationObserver`s + ancestor scans on every opening tag** | Production MPA-to-SPA streaming navigation ([WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1755787377), [(follow-up)](https://github.com/WICG/webcomponents/issues/809#issuecomment-2087913895), [whatwg/dom#1116](https://github.com/whatwg/dom/issues/1116)) | Whether a streamed `<script>` or animated subtree is complete before moving it into the live document | **100ms+ of `MutationObserver` time on a modern laptop** (more on mobile) to reproduce in JS what the parser already tracks. |
| **Sentinel child elements** (`<the-end>`) or `onload`/`onerror` probes | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534115603), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1456790982) | End of children, signaled by a dummy last child that removes itself on connect | Extra DOM nodes and markup per instance; requires control over inner markup. |
| **Trailing inline `<script>` after each element or streamed region** | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-532525717), streaming SSR frameworks | Completion of the preceding markup | Extra wire bytes per region and requires CSP nonces/hashes or `unsafe-inline`. |
| **Deferring `customElements.define()` to `DOMContentLoaded`**, or `setTimeout`/`requestAnimationFrame` | [WICG/webcomponents#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-737669670), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1455481698), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-534119444) | An approximation of "the parser is done" | Delays upgrades until the entire document finishes, or races the parser across chunks. |

### Goals

- **Let a `MutationObserver` act on complete children:** Tell an observer when an observed `target` has finished [parsing](#1-definition-of-parsing), so that it can process the target's children once instead of at every chunk boundary. Option 1 holds the observer's records until then; Option 2 keeps today's delivery and queues a record at that point.
- **Cover empty elements, already-parsed elements, and later changes with the same observer:** Streamed elements, empty elements (`<x-el></x-el>`), imperative/already-parsed elements, and subsequent dynamic mutations and streams.
- **Expose synchronous parser-open state (`element.isParsing`) with zero per-element parser traffic:** Allow script and observers to check whether an element is currently parsing without emitting per-element open/close operations for elements that open and close within a parser batch.
- Eliminate the client-side workarounds above with **zero cost when unused** and **no new properties on `MutationRecord`**.

### Non-Goals

- **Discouraging dynamic mutation handling:** Observers remain active for ongoing DOM mutations after parse end, and for future streams into the target.
- **Holding back DOM tree mutations themselves:** Nodes and attribute changes still apply to the DOM immediately so rendering, preload scanning, and other observers are unaffected. Option 1 only holds `MutationRecord` delivery for an observer that called `waitForParser()`; Option 2 holds nothing.
- **Tracking non-element nodes**, or **replacing `PerformanceEntry` for sub-microtask RUM timing**.

---

<a id="1-definition-of-parsing"></a>
## `element.isParsing` (both options)

```webidl
partial interface Element {
  readonly attribute boolean isParsing;
};
```

An `Element` `target` is **parsing** (`target.isParsing === true`; *shared definition with [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) and [Hide While Loading (`hidden="while-loading"`)](./partial-render-blocking-explainer.md#2-when-is-an-element-loading)*) when **either**:
1. It was pushed onto the HTML parser's stack of open elements and its **end tag has never been seen** yet (void elements and self-closing foreign elements are popped immediately on insertion, so they are already parsed by the time any observer or script sees them), **or**
2. It is **currently the context element of an active streaming fragment parser**—either an open `streamHTML`, `streamHTMLUnsafe`, or `streamAppendHTML*` parser on `target`, or an active `<template for="...">` / `<template for="..." src="...">` patch currently streaming into a marker whose parent is `target`.

`target` **finishes parsing** (**parse end**) when `target.isParsing` goes from `true` to `false`: its end tag is popped, an end tag is implied, the parser reaches EOF or aborts, or the active stream/patch closes or aborts. A later `streamHTML*()` call or `<template for>` patch into `target` makes it parsing again, so an element can have more than one parse end.

`element.isParsing` gives synchronous inspection when script already has a reference to `element` (for example in `connectedCallback()`, an event handler, or a document-level `MutationObserver` checking whether a newly added node already closed in the current chunk). It cannot by itself tell an observer when the value later becomes `false` (see [Alternatives Considered](#alternatives-considered) #1); that is what the two options below add. It does not require per-element parser traffic in off-main-thread parsers (see [Q1](#q1)).

Only `Element` nodes can be parsing (see [Considered Extensions](#considered-extensions-not-currently-proposed) for `ShadowRoot`).

---

<a id="option-1"></a>
## Option 1: Batched delivery (`waitForParser()`)

A new method on `MutationObserver`. `observer.waitForParser({ target, signal })` asks the observer to hold delivery while `target` is parsing. `observe()` and its options are unchanged.

The main advantage of this option is that the callback never has to check `isParsing`: it does not run while a target the observer waits for is still parsing, so every time it runs, that target's children are complete. The one check left is at the call site, for elements that were already parsed (see [§1.2](#guaranteed-callback)).

- **The whole observer is held:** While any target the observer waits for is parsing, the observer delivers nothing. Its record queue stays as it is, for every node it observes, with or without `subtree: true`. When no waited target is parsing, the queue is delivered in one callback, in mutation order.
- **Standing:** A wait lasts until its `signal` is aborted or `disconnect()` is called. A later `streamHTML*()` call or `<template for>` patch into `target` holds the observer again, with no further call.
- **Several targets:** An observer can wait for several targets, one call each. It delivers only when none of them is parsing.
- **Guaranteed callback after a wait:** If `target` is parsing when `waitForParser()` is called, the callback is invoked when the wait ends, even if no record was queued. If `target` is not parsing, the call schedules nothing and guarantees nothing.
- **Other observers are unaffected**, so they can fire earlier than an observer that waits (see [§1.1](#11-holding-the-whole-observer)).

### Example usage

<a id="example-1-1"></a>
#### Example 1.1: Custom element readiness & ongoing mutations

```js
class CustomSelect extends HTMLElement {
  #mo = new MutationObserver((records) => {
    // Never runs while <custom-select> is still parsing. Runs once </custom-select>
    // is parsed, with all streamed children in one batch (or no records, if it is empty).
    // Also runs on subsequent dynamic DOM changes, and batches future streamHTML() calls.
    this.#syncOptions();
  });

  connectedCallback() {
    this.#mo.observe(this, { childList: true });
    this.#mo.waitForParser({ target: this });
    // Nothing is guaranteed for an element that is already parsed
    // (innerHTML, upgrade, createElement): handle it here.
    if (!this.isParsing) this.#syncOptions();
  }

  disconnectedCallback() {
    this.#mo.disconnect();
  }
}
```

<a id="example-1-2"></a>
#### Example 1.2: Delegated island hydration from a document observer

```js
// One observer per <article>, so that each one completes independently.
function enhanceWhenParsed(article) {
  const observer = new MutationObserver(() => enhanceArticle(article));
  observer.observe(article, { childList: true });
  observer.waitForParser({ target: article });
}

// Discovers <article> elements without delaying incremental observation:
const docObserver = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node instanceof Element && node.matches("article")) {
        if (!node.isParsing) {
          // Opened and closed in the same chunk: enhance immediately
          enhanceArticle(node);
        } else {
          // Split across chunks: wait for </article>, then keep observing
          enhanceWhenParsed(node);
        }
      }
    }
  }
});

docObserver.observe(document, { subtree: true, childList: true });
```

### Web IDL

```webidl
partial interface MutationObserver {
  undefined waitForParser(MutationObserverWaitOptions options);
};

dictionary MutationObserverWaitOptions {
  required Element target;
  AbortSignal signal;
};
```

Only `Element` nodes can be parsing, so `target` is an `Element`. It does not have to be a node the observer observes.

### 1.1 Holding the whole observer

- **One check at delivery:** [Notify mutation observers](https://dom.spec.whatwg.org/#notify-mutation-observers) skips an observer that waits for a parsing target: its record queue is not emptied and its callback is not invoked. Queuing records is unchanged. When a waited target finishes parsing and the observer no longer waits for any parsing target, the observer is scheduled for the next mutation observer microtask.
- **Everything in the queue is held:** parser insertions, script mutations (`append()`, `remove()`, `setAttribute()`), records for descendants with `subtree: true`, and records for any other node the observer observes. An observer is therefore the unit that completes together. Elements that complete independently need one observer each (as in [Example 1.2](#example-1-2)); a shared observer delivers nothing for any of its targets while one waited target is parsing.
- **Order within the observer is always mutation order**, because its one queue is held and released as a whole.
- **Order across observers changes:** observers that wait for nothing deliver at every microtask checkpoint in creation order, as today, so they fire earlier than an observer that is held:
  - `docObserver` above fires at chunk 1's microtask checkpoint, while an observer waiting for an unclosed element is held until chunk 2.
  - Nested components that each wait for themselves complete **bottom-up** as end tags arrive: `<s-option>`'s observer fires in chunk 1 as soon as `</s-option>` is seen, *before* its parent `<s-select>`'s earlier-created observer fires at `</s-select>` in chunk 2.
- **`signal`:** Aborting it removes that wait. If the observer then waits for no parsing target, its queued records are delivered at the next microtask checkpoint. Passing an already-aborted signal has no effect. A target can be waited for more than once; it holds the observer while any of those waits is not aborted.
- **Removed subtrees:** The notify step also removes the observer's transient registered observers. For a held observer that moves with the delivery, so mutations in a subtree removed while held are recorded until then, as they are until the next delivery today.

<a id="guaranteed-callback"></a>
### 1.2 The guaranteed callback

Today the callback is invoked only when the record queue is not empty. A wait adds one case.

- **At parse end:** When a target the observer was waiting for finishes parsing (end tag popped, implied end tag, EOF, parser abort, or the active stream/patch closing or aborting), and the observer no longer waits for any parsing target, the callback is invoked at the next microtask checkpoint: with the held records, or with an empty list if there are none. That covers `<my-widget></my-widget>` and an end tag that arrives in a chunk of its own.
- **No synthesized record:** The record list can be empty. `childList` records still always add or remove a node, and the assertion in [queue a tree mutation record](https://dom.spec.whatwg.org/#queue-a-tree-mutation-record) is untouched. Only observers that called `waitForParser()` can receive an empty list, and the usual loops over `records` handle it.
- **Already parsed:** If `target` is not parsing when `waitForParser()` is called (a custom element upgraded after parsing, `innerHTML` / `setHTML`, `document.createElement()`, or a node that closed earlier in the same chunk), nothing is scheduled. Like `observe()`, the call has no immediate effect. Authors check `isParsing` once at the call site (as in [Example 1.1](#example-1-1)). The wait still stands for later streams.
- **Later streams:** A later `el.streamHTML*()` call, or a `<template for>` patch into `el`, makes `el` parsing again. The observer is held until it ends, and that parse end also invokes the callback, with or without records.
- **Several targets:** The callback is invoked once, when the last waited target finishes parsing.
- **`takeRecords()`:** Drains and returns the queue as today, including held records. The callback at parse end is still guaranteed, with any later records or an empty list.
- **`disconnect()`:** Empties the queue as today and also removes the observer's waits, so nothing fires. A component that disconnects in `disconnectedCallback` calls `observe()` and `waitForParser()` again in `connectedCallback`.
- **Aborting a wait is not a parse end:** it releases queued records, but invokes nothing if there are none.
- **No validation:** There is no combination of arguments that throws, and no dependency on what the observer observes. Elements discarded by the sanitizer never connect and never fire.

### 1.3 Long-lived streams & unbounded buffering

The observer is held as long as a waited target is parsing. For a long-lived stream (such as an LLM chat response streamed into an element through `streamHTML()` for minutes), the observer holds **every** record it queues until the stream ends. That is by design, but authors should know about it:

- **Waiting is the wrong choice for progressively rendered targets.** If a component should react to content as it arrives, do not call `waitForParser()` for that target (or use `activeTemplateAttributeFilter` for `<template for>` patches; see the [template `MutationObserver` explainer](./template-mutation-observer-explainer.md)).
- **`signal` is the escape hatch.** Aborting it returns the observer to delivery at every microtask checkpoint. `takeRecords()` drains the held records at any time without ending the wait.
- **Implementations may store held records compactly** (for example by coalescing adjacent `childList` records for the same target), since only the final batch can be observed.

<a id="overlapping-registrations"></a>
<a id="scheduling-and-ordering"></a>
### 1.4 Overlapping registrations, and remaining trade-offs

#### Why the hold belongs to the observer

A mutation record is queued at most once per observer, even when it matches several of that observer's registrations ([queue a mutation record](https://dom.spec.whatwg.org/#queue-a-mutation-record)). If holding were decided per registration (as with an `observe()` option), two registrations could match the same record while disagreeing on whether to hold it. Holding the observer as a whole leaves nothing to disagree about:

```html
<div id="outer">
  <div id="inner"></div>
  <script>
    const mo = new MutationObserver(console.log);
    mo.observe(outer, { childList: true, subtree: true });
    mo.observe(inner, { childList: true });
    mo.waitForParser({ target: outer });
    inner.append("x");
  </script>
  <!-- network pause -->
</div>
```

When the script runs, `outer` is still parsing and `inner` has already closed. The record for `inner.append("x")` matches both registrations and is queued once, as today. `mo` delivers nothing across the network pause, and at `</div>` it delivers every record in mutation order, including `"x"`. Code that wants `inner`'s records at the `</script>` checkpoint uses a second observer for `inner`.

#### Remaining trade-offs of Option 1

- **Deferred microtask delivery & mid-parse script mutations:** Today, every record in a `MutationObserver`'s queue is delivered at the very next microtask checkpoint. Under Option 1, a held observer keeps its records across chunk boundaries and inline-`<script>` microtask checkpoints. If an inline `<script>` inside `<outer>` mutates the tree, an observer waiting for `outer` holds that record across any network pause until `</div>` rather than delivering it after `</script>`.
- **One observer per element that completes independently:** A shared observer cannot report a finished element while another waited element is still parsing.
- **Already-parsed targets take a second code path:** Nothing is guaranteed for them, so setup runs from the call site. `body.append(s); s.append(a, b);` runs setup in `connectedCallback` and again from the ordinary mutation callback.
- **The callback can receive an empty record list** after a wait.

[Option 2](#option-2) avoids changing microtask delivery timing, at the cost of checking `isParsing` in the callback as well as at the `observe()` call site.

<a id="option-1-scenarios"></a>
### 1.5 Scenarios & edge-case walkthroughs

The tables below show what a `MutationObserver` receives in each scenario. `[]` is a callback invoked with an empty record list.

#### 1.5.1 Multi-chunk streaming & nested bottom-up ordering

`<s-select>` and `<s-option>` each have their own observer and call `this.#mo.observe(this, { childList: true })` and `this.#mo.waitForParser({ target: this })` in `connectedCallback()`, while `docObserver` observes `document` with `{ childList: true, subtree: true }` and waits for nothing:
- **Chunk 1:** `<s-select><s-option>A</s-option>`
- **Chunk 2:** `<s-option>B</s-option></s-select>`
- **Later task:** `select.append(optC)`

| Checkpoint | `docObserver` (no wait) | `<s-option>A`'s observer (waits for itself) | `<s-select>`'s observer (waits for itself) |
|---|---|---|---|
| **End of Chunk 1** | **Fires:** `addedNodes: [<s-select>]`, `addedNodes: [<s-option>A]`, `addedNodes: ["A"]`. | **Fires:** `[addedNodes: ["A"]]` because `</s-option>` closed in Chunk 1—even though `<s-select>`'s observer was created first. | **Held:** `<s-select>` is still on the stack of open elements (`addedNodes: [<s-option>A]` stays queued). |
| **End of Chunk 2** | **Fires:** `addedNodes: [<s-option>B]`, `addedNodes: ["B"]`. | *(No changes)* | **Fires once** with all held records from both chunks: `[addedNodes: [<s-option>A], addedNodes: [<s-option>B]]`. |
| **After `select.append(optC)`** | **Fires:** `addedNodes: [<s-option>C]`. | *(No changes)* | **Fires at microtask checkpoint:** `[addedNodes: [<s-option>C]]`. |

#### 1.5.2 Empty elements, `createElement`, `innerHTML`, and late custom-element upgrades

When `<s-select>` calls `this.#mo.observe(this, { childList: true })` and `this.#mo.waitForParser({ target: this })` in `connectedCallback()`:

| Scenario | `this.isParsing` when `waitForParser()` runs | Records queued | What `<s-select>`'s observer receives |
|---|---|---|---|
| **Empty across two chunks** (`Chunk 1: <s-select>`, `Chunk 2: </s-select>`) | `true` (on stack of open elements) | None | Held at Chunk 1; **fires at end of Chunk 2** with `[]`. |
| **Empty in one chunk** (`<s-select></s-select>`) | `true` (on stack when `connectedCallback` runs; popped at `</s-select>` in same chunk) | None | **Fires at end of chunk** with `[]`. |
| **Imperative `createElement` + synchronous `append()`** (`body.append(s); s.append(optA, optB);`) | `false` (`connectedCallback` runs during `body.append(s)`) | `s.append(optA, optB)` queues `addedNodes: [optA, optB]` in the same task | Ordinary delivery: **fires at microtask checkpoint** with `[addedNodes: [optA, optB]]`. |
| **Imperative `createElement` with no children** (`body.append(s);`) | `false` | None | Nothing. The call site handles it ([Example 1.1](#example-1-1)). |
| **`el.innerHTML = "<s-select><s-option>A</s-option></s-select>"`** | `false` (custom element reactions run after the synchronous fragment parser finishes) | None after `connectedCallback()` (children were inserted before it ran) | Nothing. The call site handles it. |
| **Late `customElements.define("s-select", ...)`** after `<s-select><s-option>A</s-option></s-select>` is already in the DOM | `false` | None | Nothing. The call site handles it. |

#### 1.5.3 Delegated observation from a parent/document observer

Suppose `docObserver` (`{ childList: true, subtree: true }`, no wait) discovers `<article>` in `addedNodes` at the end of Chunk 1 and, as in [Example 1.2](#example-1-2), creates an observer that calls `observe(article, { childList: true })` and `waitForParser({ target: article })`:

| Chunk 1 & Chunk 2 markup | `article.isParsing` when `docObserver` runs at end of Chunk 1 | What the article's observer receives |
|---|---|---|
| **Chunk 1:** `<article><h1>Title</h1>`<br>**Chunk 2:** `<p>Body</p></article>` | **`true`** (`<h1>` was inserted before `observe()` was called, so it is already in `article.children`). | Held until `</article>` in Chunk 2; **fires at end of Chunk 2** with `[addedNodes: [<p>]]`. |
| **Chunk 1:** `<article><h1>Title</h1>`<br>**Chunk 2:** `</article>` *(no new children in Chunk 2)* | **`true`** | Held until `</article>` in Chunk 2; **fires at end of Chunk 2** with `[]`. |
| **Chunk 1:** `<article><h1>Title</h1></article>` *(opened and closed in Chunk 1)* | **`false`** (already parsed by the time `docObserver`'s microtask runs). | Nothing is held and nothing is guaranteed, so `docObserver` checks `!article.isParsing` and enhances `article` directly. |

#### 1.5.4 Inline `<script>` inside an open element (`document.write()`, imperative mutations, `takeRecords()`, aborting)

Suppose `<s-select>`'s observer observes it with `{ childList: true, attributes: true }` and waits for it, and the parser processes:
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
| **No-op `<script>`** | `<s-option>A`'s observer **fires** (`</s-option>` already closed). `<s-select>`'s observer **does not fire** (`<s-select>` is still on the stack of open elements). | `<s-select>`'s observer **fires once** with `[addedNodes: [<s-option>A], addedNodes: [<script>], addedNodes: [<s-option>B]]`. |
| **Imperative mutation** (`select.setAttribute("data-x", "1"); select.append(optX);`) | **Held:** Because `<s-select>` is still parsing, both parser insertions and script mutations stay queued. | **Fires once** with all held `childList` and `attributes` records in order. |
| **`document.write("<s-option>W</s-option>")`** | **Held:** Tokens written into the active parser while `<s-select>` is on the stack of open elements are held with the rest. | **Fires once** including `addedNodes: [<s-option>W]`. |
| **`const early = selectObserver.takeRecords()`** | `takeRecords()` synchronously drains and returns `[addedNodes: [<s-option>A], addedNodes: [<script>]]`. `<s-select>` is still parsing, so the observer stays held. | **Still fires at `</s-select>`** with `[addedNodes: [<s-option>B]]` (or `[]` if no further mutations occurred after `takeRecords()`). |
| **Aborting the wait's `signal`** | **Fires** with `[addedNodes: [<s-option>A], addedNodes: [<script>]]`: the observer no longer waits for anything. | **Fires** with `[addedNodes: [<s-option>B]]`, as an observer without a wait would. |

#### 1.5.5 Streaming updates after initial parse (`streamHTML*()` and `<template for>`)

Suppose `<section id="feed">` is already parsed, and `feedObserver` called `observe(feed, { childList: true, subtree: true })` and `waitForParser({ target: feed })`. `feed` was not parsing then, so nothing was held or guaranteed, but the wait stands:

| Streaming operation | While stream is open across chunks | When stream finishes |
|---|---|---|
| **`const w = feed.streamHTML()`**<br>`w.write("<p>1</p>")` → yield → `w.write("<p>2</p>")` → `w.close()` | `feed.streamHTML()` synchronously removes existing children and marks `feed` as **parsing**. Both `removedNodes: [...oldChildren]` and `addedNodes: [<p>1]` are **held** across chunks. | `w.close()` ends parsing for `feed`; `feedObserver` **fires once** with `removedNodes: [...oldChildren]` and all `addedNodes` (`<p>1`, `<p>2`, and their text). |
| **Empty `streamHTML()`** on an already-empty `feed` (`const w = feed.streamHTML(); w.close();`) | `feed` is parsing while `w` is open. | **Fires on `w.close()`** with `[]`. |
| **`<template for="feed">`** streaming across chunks into `<section id="feed"><?marker name="feed"></section>` | `feed` is the target of an active `<template for>` patch, so `feedObserver` is **held** until `</template>`. | When `</template>` is parsed (or the stream aborts at EOF), `feedObserver` **fires once** with all mutations from the patch. |

#### 1.5.6 HTML parser edge cases & aborts

Each row is about an observer that waits for the element in question.

| Edge case | Parser behavior | What the waiting observer receives |
|---|---|---|
| **Implied end tags** (`<ul><li>One<li>Two</ul>`) | Parsing the second `<li>` start tag implicitly pops the first `<li>` from the stack of open elements. | The first `<li>`'s observer fires at that chunk's microtask checkpoint, identically to an explicit `</li>`. |
| **Adoption agency algorithm** (`<x-b><x-i>Bold </x-b>italic</x-i>`) | At `</x-b>`, the original `<x-i>` and `<x-b>` are popped from the stack of open elements; a *new* `<x-i>` element is created for `italic`. | Observers waiting for the original `<x-i>` and `<x-b>` fire after `</x-b>`. The cloned `<x-i>` is a distinct `Element` instance that remains parsing until `</x-i>`. |
| **Foster parenting** (`<table><x-div><span>hi</span></x-div><tr><td>cell</td></tr></table>`) | `<x-div>` is inserted as a sibling before `<table>`, but remains on the stack of open elements until `</x-div>`. | `<x-div>`'s observer holds `<span>hi</span>` until `</x-div>`. Because `<x-div>` is inserted into `<table>.parentNode` (not `<table>`), an observer on `<table>` only sees `<tbody>`/`<tr>`, while an observer that observes and waits for `<table>.parentNode` holds both `<x-div>` and `<table>` until `<table>.parentNode` closes. |
| **Element removed mid-parse** (`Chunk 1: <x-box><p>1</p>` + `<script>box.remove()</script>`, `Chunk 2: <p>2</p></x-box>`) | The parser's stack of open elements holds a reference to `box` and continues appending `<p>2</p>` into the detached `box` until `</x-box>` pops it. | If `disconnectedCallback()` calls `this.#mo.disconnect()`, the queue and the wait are cleared and nothing fires. If the observer does *not* disconnect, `box` stays parsing until `</x-box>` pops it in Chunk 2, and the observer then fires with `[addedNodes: [<p>1], addedNodes: [<p>2]]`. |
| **Element moved mid-parse** (`newParent.append(box)` while `box` is still on the parser stack, re-running `connectedCallback`) | `box` remains on the stack of open elements until `</x-box>`. | If `disconnectedCallback` did not call `disconnect()`, the repeated `observe()` and `waitForParser()` calls in `connectedCallback` change nothing: the held records are kept, and the observer fires once `</x-box>` is parsed. |
| **Premature EOF / `window.stop()` / aborted stream** (`<x-box><p>Half...` then EOF) | At EOF or abort, the parser pops all remaining elements from the stack of open elements. | `<x-box>` stops parsing and its observer fires with the held records (`[addedNodes: [<p>]]`) at the microtask checkpoint. |

---

<a id="option-2"></a>
## Option 2: Parse-end record (`parseEnd: true`)

A `parseEnd` boolean in `MutationObserverInit`. Delivery timing is exactly today's: records are delivered at every microtask checkpoint, including at chunk boundaries. In addition, each time an element observed with `parseEnd: true` [finishes parsing](#1-definition-of-parsing) and the observer has no `childList` record pending for it, an empty `childList` record for that element is queued. Either way, the observer always gets a callback after `target.isParsing` has become `false`.

- **No timing change, no buffering:** Nothing is held, so there is no per-registration hold state, no unbounded buffering for long-lived streams, and `takeRecords()` and `disconnect()` behave as today.
- **`observe()` has no side effects:** If `target` is already parsed when `observe()` is called, no record is queued. Callers check `target.isParsing` at that point, as they would today check `childNodes`.
- **The parse-end record is about the observed target only:** `parseEnd: true` cannot be combined with `subtree: true`. A parse-end record for every descendant would require the parser to report every element it closes, which is the per-element traffic that [Q1](#q1) avoids, and would flood subtree observers. Observers that need parse end for descendants observe each one, as in [Example 2.2](#example-2-2).

### Example usage

<a id="example-2-1"></a>
#### Example 2.1: Custom element readiness & ongoing mutations

```js
class CustomSelect extends HTMLElement {
  #mo = new MutationObserver(() => {
    // Runs at every chunk, as today. The parse-end record guarantees a run
    // after </custom-select>, even if no child arrived in the last chunk
    // (or at all). Also runs on subsequent dynamic DOM changes.
    if (!this.isParsing) this.#syncOptions();
  });

  connectedCallback() {
    this.#mo.observe(this, { childList: true, parseEnd: true });
    // observe() schedules nothing: handle already-parsed elements here
    // (innerHTML, upgrade, createElement).
    if (!this.isParsing) this.#syncOptions();
  }

  disconnectedCallback() {
    this.#mo.disconnect();
  }
}
```

<a id="example-2-2"></a>
#### Example 2.2: Delegated island hydration from a document observer

```js
const articleObserver = new MutationObserver((records) => {
  for (const article of new Set(records.map((r) => r.target))) {
    // Skip per-chunk records until </article> has been parsed.
    if (!article.isParsing) enhanceArticle(article);
  }
});

const docObserver = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node instanceof Element && node.matches("article")) {
        // Opened and closed in the same chunk: enhance immediately.
        if (!node.isParsing) enhanceArticle(node);
        // Wait for </article> if still open, and observe ongoing mutations.
        articleObserver.observe(node, { childList: true, parseEnd: true });
      }
    }
  }
});

docObserver.observe(document, { subtree: true, childList: true });
```

### Web IDL

```webidl
partial dictionary MutationObserverInit {
  boolean parseEnd = false;
};
```

### 2.1 Processing model

- **Queuing:** When `target` finishes parsing, for each observer registered on `target` itself with `parseEnd: true`: if the observer's record queue contains no `childList` record whose target is `target`, queue the [parse-end record](#parse-end-record). It is delivered at the next microtask checkpoint like any other record.
- **Only when needed:** If a usual `childList` record for `target` is already pending (for example because children arrived in the same chunk as the end tag), the observer will be called anyway and nothing is added. Pending records of other types, or for other targets, do not count. Records already delivered at an earlier checkpoint, or drained by `takeRecords()`, are no longer pending, so the guarantee is the same in every case: after `target` finishes parsing, the observer's queue holds at least one `childList` record for it.
- **Later streams:** A later `el.streamHTML*()` call, or a `<template for>` patch into `el`, makes `el` parsing again. Its records are delivered per chunk as today, and another parse-end record is queued when the stream ends.
- **Option validation:** `parseEnd: true` with `subtree: true`, or with `childList: false`, throws a `TypeError`.
- **Re-observing:** Calling `observe()` again for an observed target replaces the options as today, and queues nothing.
- **Disconnection and removal:** After `observer.disconnect()` nothing is queued. An element removed from the document while still on the stack of open elements keeps its registration, so the record is still queued when the parser pops it. Elements discarded by the sanitizer never connect and never produce a record.
- **Non-element targets:** For a `Document`, `DocumentFragment`, or `ShadowRoot` target, `parseEnd: true` has no effect.

<a id="parse-end-record"></a>
### 2.2 The parse-end record

The record is `{ type: "childList", target, addedNodes: [], removedNodes: [], previousSibling: target.lastChild, nextSibling: null }`: a `childList` record that describes no change. This is the main oddity of Option 2.

- **It is a wake-up, not a description.** It exists only when no real `childList` record would trigger the callback: an empty element, or an end tag arriving in a chunk of its own. Whether it appears therefore depends on where chunk boundaries fall. (Option 1 covers the same cases by invoking the callback with an empty record list.)
- **It is a normative DOM change.** [Queue a tree mutation record](https://dom.spec.whatwg.org/#queue-a-tree-mutation-record) asserts that `addedNodes` or `removedNodes` is non-empty; that assertion would be relaxed for records delivered only to observers that opted in. Option 1 does not need this. The `"start"` record in the [template `MutationObserver` explainer](./template-mutation-observer-explainer.md) does, and both should get the same answer.
- **Callbacks should not look for it.** Since a parse end with pending records produces no parse-end record, code that needs parse end checks `target.isParsing` (as in the examples above) rather than looking for a record with two empty lists. The usual loops (`for (const r of records) handle(r.addedNodes)`) pass over it. Only observers that passed `parseEnd: true` ever see it.
- **A dedicated record type** (for example `type: "parseEnd"`) is the main alternative; see [Alternatives Considered](#alternatives-considered) #6.

### 2.3 Other costs

- **Callbacks still run at every chunk.** The observer is not shielded from half-parsed children; it has to check `isParsing` and return early. That is cheap, but it is the author's responsibility, and a component that wants the records accumulated since parsing started has to keep them itself.
- **Already-parsed targets need a second code path.** Since `observe()` schedules nothing, setup for an already-parsed element runs from the `observe()` call site (`connectedCallback` in [Example 2.1](#example-2-1)), separately from the observer callback.
- **No `subtree: true`.** Delegated patterns need one `observe()` call per element of interest.

### 2.4 Scenarios

`parseEndRecord(target, prev = target.lastChild)` denotes the [parse-end record](#parse-end-record). In each row, `target` is observed with `{ childList: true, parseEnd: true }`.

| Scenario | What the observer receives |
|---|---|
| **Multi-chunk** (`Chunk 1: <s-select><s-option>A</s-option>`, `Chunk 2: <s-option>B</s-option></s-select>`), observed in `connectedCallback()` | End of Chunk 1: `[addedNodes: [<s-option>A]]`, with `isParsing` still `true`. End of Chunk 2: `[addedNodes: [<s-option>B]]`, with `isParsing` now `false`. No parse-end record: a `childList` record was pending at `</s-select>`. |
| **Only the end tag in the last chunk** (`Chunk 1: <s-select><s-option>A</s-option>`, `Chunk 2: </s-select>`) | End of Chunk 1: `[addedNodes: [<s-option>A]]`. End of Chunk 2: `[parseEndRecord(<s-select>, <s-option>A)]`. This is the case `isParsing` alone cannot cover. |
| **Empty element** (`<s-select></s-select>`, in one chunk or two), observed in `connectedCallback()` | `[parseEndRecord(<s-select>, null)]` at the end of the chunk containing `</s-select>`. |
| **Already parsed when `observe()` runs** (`createElement`, `innerHTML`, late upgrade, or closed earlier in the same chunk) | No parse-end record. Later mutations are delivered as today. |
| **Inline `<script>` inside the open element** (`<s-select><s-option>A</s-option><script>...</script></s-select>`) | `[addedNodes: [<s-option>A], addedNodes: [<script>]]` at the `</script>` microtask checkpoint, as today, with `isParsing` still `true`. Nothing is pending at `</s-select>`, so `[parseEndRecord(<s-select>, <script>)]` at the next checkpoint. |
| **`takeRecords()` while parsing** | Returns the pending records, as today. If no further `childList` record is queued before parse end, the parse-end record is queued then. |
| **`const w = feed.streamHTML()`** on an already-parsed, observed `feed`; `w.write(...)` across tasks; `w.close()` | Records per chunk as today. `w.close()` queues `parseEndRecord(feed)` unless a `childList` record for `feed` is still pending. |
| **Implied end tags, EOF, `window.stop()`, aborted stream** | Same as an explicit end tag, for each observed element popped: a parse-end record unless a `childList` record for it is pending. |
| **Removed mid-parse** (`box.remove()` in an inline script, observer not disconnected) | Records for children the parser keeps appending to the detached `box`. When `</x-box>` pops it, `parseEndRecord(box)` unless one of those is pending. |
| **Adoption agency** (`<x-b><x-i>Bold </x-b>italic</x-i>`) | The original `<x-i>` and `<x-b>` finish parsing at `</x-b>`, each with a parse-end record unless a `childList` record for it is pending. The new `<x-i>` created for `italic` is a distinct element, with no registration unless it is observed separately. |
| **Observing `outer` (`{ childList: true, subtree: true }`) and `inner` (`{ childList: true, parseEnd: true }`) on the same observer** (compare [§1.4](#scheduling-and-ordering)) | The `"x"` record once, at the `</script>` microtask checkpoint, as today. No parse-end record: `inner` had already closed when it was observed, and `outer`'s registration cannot ask for one. |

---

<a id="comparison"></a>
## Comparing the options

| | Option 1: `waitForParser()` | Option 2: `parseEnd: true` |
|---|---|---|
| **Delivery timing** | Changed for an observer that waits: its whole queue is held across intermediate microtask checkpoints while a waited target is parsing. | Unchanged. |
| **Callbacks during parsing** | None for an observer that waits for the target; the callback never checks `isParsing`. | One per chunk, as today; the callback checks `isParsing`. |
| **Records at parse end** | Everything the observer queued while held, in mutation order, in one batch. | Only what was queued since the last checkpoint, or the parse-end record if that is nothing. |
| **`observe()`** | Unchanged. | One new option; no side effects. |
| **Already-parsed targets** | No callback is guaranteed; the caller checks `isParsing` after `waitForParser()`. | Caller checks `isParsing` after `observe()`. |
| **`subtree: true`** | Allowed. | `TypeError`. |
| **Several targets on one observer** | The observer waits for all of its waited targets, so one still-parsing target holds the records for the others. Elements that complete independently need one observer each ([§1.4](#scheduling-and-ordering)). | Multiple targets and mixing `parseEnd: true` / `false` (including with a normal `subtree: true` registration) allowed; each record is delivered once at today's timing. |
| **Empty `childList` record** | Never. After a wait, the callback can be invoked with an empty record list. | Whenever no `childList` record for the target is pending at parse end. |
| **Long-lived streams** | Holds the observer's whole queue until the stream ends; aborting `signal`, or `takeRecords()`, is the escape hatch ([§1.3](#13-long-lived-streams--unbounded-buffering)). | Nothing buffered. |
| **`takeRecords()` / `disconnect()`** | `takeRecords()` drains the held queue as today; `disconnect()` also removes the waits ([§1.2](#guaranteed-callback)). | As today. |
| **New error conditions** | None. | Two `TypeError`s (`subtree: true`, `childList: false`). |
| **Spec and implementation surface** | A list of waits per observer, one check in the notify step, scheduling at parse end, and invoking the callback with an empty list. | One conditional queuing step at parse end, one validation rule, empty fallback record. |

In short: Option 1 keeps half-parsed children out of the callback without touching `observe()`, with no new error conditions and no synthesized record. Its cost is that an observer's records are held across microtask checkpoints (including inline `<script>`s), that each independently completing element needs its own observer, and that already-parsed elements are handled at the call site. Option 2 keeps `MutationObserver`'s delivery timing completely intact, at the cost of an empty `childList` wake-up record, per-chunk callbacks that the author filters with `isParsing`, and the same call-site check.

---

<a id="custom-elements"></a>
## Custom elements and `WICG/webcomponents#809`

The central objection in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809) to a dedicated custom element `parsedCallback()` is that an end-tag callback invites authors to read `this.children` once and ignore subsequent dynamic mutations, imperative `createElement` + `append()`, or post-parse insertions ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1460917211), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1757047993)). Both options answer it by staying inside `MutationObserver`, so the same observer keeps reporting later mutations. They differ in what the callback has to check:

| Creation mode | Option 1 ([Example 1.1](#example-1-1)) | Option 2 ([Example 2.1](#example-2-1)) |
|---|---|---|
| **Streamed across network chunks** (`<s-select>` ... `</s-select>`) | `#mo` is held across chunks and fires once `</s-select>` is seen, with all child insertions. | `#mo` fires at each chunk and returns early while `isParsing`; a pending `childList` record or, failing that, the parse-end record guarantees a run after `</s-select>`. |
| **Empty children** (`<s-select></s-select>`) | Fires at `</s-select>` with an empty record list, so initial setup still runs. | The parse-end record is the only record; initial setup runs from it. |
| **Imperative `createElement` + `append()`, `innerHTML`, or late upgrade** | `isParsing` is `false` in `connectedCallback`, so nothing is guaranteed and setup runs synchronously there. `body.append(s); s.append(opt1, opt2);` runs setup in `connectedCallback` and again from the ordinary mutation callback. | The same: setup runs in `connectedCallback`, and again from the ordinary mutation callback. |
| **Subsequent dynamic mutations & streams** | Later mutations (`s.append(opt3)`) fire at the microtask checkpoint; later `s.streamHTML*()` streams or `<template for>` patches into `s` hold `#mo` until they complete. | Later mutations fire as today; later streams fire per chunk and return early, with a parse-end record when they complete. |

---

## Considered Extensions (Not Currently Proposed)

- **`ShadowRoot` targets:** Treating a `ShadowRoot` whose declarative `<template shadowrootmode>` has not yet closed (or that is an active `streamHTML*` target) as parsing, under either option, is a natural extension under consideration, but is not part of the core proposal.
- **Custom element `parsedCallback()`:** Libraries like [`html-parsed-element`](https://github.com/WebReflection/html-parsed-element) polyfill `parsedCallback()` today using per-element `subtree: true` `MutationObserver`s. While a native `parsedCallback()` could mirror parse-end timing, both options here cover initial readiness and ongoing mutations with the same observer, without introducing a one-shot lifecycle footgun.

---

## Alternatives Considered

1. **`Element.isParsing` (or `MutationRecord.closingTagParsed`, [discussed in 2023](https://github.com/WICG/webcomponents/issues/809#issuecomment-1516789211)) alone:** A boolean does not tell an observer when it later becomes `false`. If only `</element>` arrives in a later chunk, no mutation wakes the observer up ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1755889378)).
2. **A `record.parsedElements` list on `MutationRecord`:** Needs an allocation per record, forces observing the parent, and still delivers half-parsed children.
3. **One `parser: true` option shared with `<template for>` observation:** The [template records](./template-mutation-observer-explainer.md) describe a patch chunk by chunk, while the options here are about the observed target finishing.
4. **(Option 1) An `observe()` option (`settled: true` or `delivery: "parse-end"`) instead of a method:** Holding then belongs to a registration, which needs `TypeError`s for `subtree: true` and for mixing registrations on one observer ([§1.4](#overlapping-registrations)).
5. **(Option 1) A one-shot wait, or holding only the waited target's records:** The first misses later streams. The second cannot cover `subtree: true`.
6. **(Option 2) A dedicated record type (for example `type: "parseEnd"`):** Avoids a record that describes no change, at the cost of a new `MutationRecord.type` value.
7. **An `Element` method (e.g. `element.observeChildren(callback)`):** Loses one observer for many targets, `takeRecords()`, and `disconnect()`.
8. **DOM events (`parseend`):** Per-element dispatch during parsing repeats the cost of `MutationEvent`, and does not cover later mutations.
9. **Status quo:** See [Existing workarounds](#existing-workarounds).

---

## Frequently Asked Questions (Q&A)

<details>
<summary><strong>Parser overhead, firing order, and empty/already-parsed targets</strong></summary>

<a id="q1"></a>
### Q1: Does either option, or `element.isParsing`, add overhead to the HTML parser or delay rendering?
No. The HTML parser inserts nodes into the live DOM immediately as bytes arrive—layout, rendering, preload scanning, and other observers are never delayed. Option 1 leaves an observer's records in its queue while a target it waits for is parsing; Option 2 queues at most one extra record when a target observed with `parseEnd: true` finishes parsing. Both are gated on state the parser already maintains (stack of open elements and active streaming fragment parsers).

**Off-main-thread / tree-op parsers (e.g., Gecko):** An engine that separates parsing from main-thread DOM construction via queued tree operations does **not** need to emit an "end-parse" operation or flip an `isParsing` bit on every element's opening and closing tags ([w3c/csswg-drafts#12578 (comment)](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209690246)). Any element that opens and closes without an intervening parser batch flush (chunk or timer boundary), `<script>`, or custom element reaction can never be observed by script while open—by the time any `MutationObserver` or script can hold a reference to that element and read `el.isParsing`, it is already parsed (`false`, the default). The same marking tells the main thread which closing elements can have a held batch to flush (Option 1) or a parse-end record to queue (Option 2). The parser only needs to mark the $O(\text{stack depth})$ ancestor elements that are actually on the stack of open elements *at* a batch flush, `<script>`, or custom element reaction (and later emit a close op for those few nodes, which can itself be batched up to the next such boundary).

### Q2 (Option 1): Why can observers fire in a different order when an observer waits for the parser?
Because the hold is per observer: an observer waiting for `<parent>` delivers nothing while `<parent>` is open, whereas an observer that waits for nothing—or one waiting for `<child>`, whose `</child>` arrived in an earlier chunk—delivers at that earlier chunk's microtask checkpoint. Nested components that each wait for themselves therefore initialize bottom-up (`<s-option>` before `<s-select>`). Within one observer, records are always in mutation order.

### Q3 (Option 1): Why is the callback guaranteed after a wait, but not for an already-parsed target?
A wait on a parsing target is an explicit request to be told when it completes, so its end is always reported, even when no record was queued (`<my-widget></my-widget>`, or an end tag arriving in a chunk of its own). For a target that is not parsing there is nothing to wait for, and neither `observe()` nor `waitForParser()` schedules a callback by itself; the caller checks `isParsing` once at the call site.

</details>

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

`Element.prototype.isParsing` and both `MutationObserver` options expose no new user or cross-origin information: they only reflect same-origin parser-open state for a DOM element the caller can already observe (Option 1 also controls microtask delivery timing of that observer's `MutationRecord`s), and emit nothing for sanitizer-discarded elements.

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. `element.isParsing` and both options only reflect same-origin parser-open state for a DOM element the caller can already observe; Option 1 also controls microtask delivery timing of that observer's `MutationRecord`s.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes. `Element` gains one boolean and no new properties are added to `MutationRecord`; elements discarded by a sanitizer never connect or emit records.

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
    If a document is disconnected or its parser aborts while an observed target is still parsing, parsing ends (as at EOF/abort) and standard `MutationObserver` lifecycle rules apply; under Option 1, calling `observer.disconnect()` discards any buffered records.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Option 1 adds none. Option 2: passing `parseEnd: true` with `childList: false` or with `subtree: true` throws a `TypeError`, matching existing `MutationObserver.prototype.observe()` option validation.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.

</details>
