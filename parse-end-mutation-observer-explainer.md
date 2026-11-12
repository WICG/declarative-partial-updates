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
| **API** | `observe(target, { childList: true, delivery: "parse-end" })` | `observe(target, { childList: true, parseEnd: true })` |
| **Delivery timing** | The observer's records for `target` are held while `target.isParsing` is `true` and delivered together at parse end. | Unchanged from today. |
| **Parse-end signal** | The batch itself; an empty `childList` record is synthesized only when the batch would otherwise be empty. `observe()` on an already-parsed target also schedules a callback. | The first callback in which `target.isParsing` is `false`. An empty `childList` record is queued when `target` finishes parsing only if no `childList` record for it is pending, so that this callback always happens. `observe()` has no side effects. |
| **`subtree: true`** | Allowed. | `TypeError`. |
| **Main advantage** | The author never has to check `isParsing`: the callback runs only once the target's children are complete. | Delivery timing, `observe()`, `takeRecords()`, and `disconnect()` all keep today's behavior. |
| **Main concern** | [Overlapping registrations](#overlapping-registrations) on one observer disagree about when to deliver a record. | A [`childList` record that describes no change](#parse-end-record). |

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
- **Holding back DOM tree mutations themselves:** Nodes and attribute changes still apply to the DOM immediately so rendering, preload scanning, and other observers are unaffected. Option 1 only holds `MutationRecord` delivery for the parse-end observer; Option 2 holds nothing.
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
## Option 1: Batched delivery (`delivery: "parse-end"`)

The main advantage of this option is that the author does not have to keep checking `isParsing`. The callback never runs for a target that is still parsing, so it needs no `if (target.isParsing) return;` guard at each chunk and no separate check at the `observe()` call site: every time it runs, the target's children are complete.

A `delivery` member in `MutationObserverInit` (`"normal" | "parse-end"`, defaulting to `"normal"`). Calling `observer.observe(target, { childList: true, delivery: "parse-end" })` creates a **parse-end registration** for `target` (an observer with one is called a **parse-end observer** below; other observers are **normal observers**):

- **Buffering is keyed on the observed target:** While an **observed** `target` is parsing, **all** of the observer's `MutationRecord`s for that `target`—from the parser or from script, and including descendant records when `subtree: true`—are **held back** until `target` itself is no longer parsing. The parse state of descendants is irrelevant.
- **Observer-specific firing order:** Buffering applies only to parse-end registrations, so other observers (normal observers, or parse-end observers on child elements whose end tags arrive earlier) are not held back and may fire in a different order. To keep each callback's timing uniform, use separate observers for normal and parse-end delivery rather than mixing both on one observer (as in [Example 1.2](#example-1-2)).
- **`observe()` schedules a callback:** A parse-end registration is **guaranteed to fire** once: at parse end, **or at the next microtask checkpoint if the target is already parsed** when `observe()` is called—synthesizing an empty `childList` record (`addedNodes: []`, `removedNodes: []`) if nothing was queued. This is a new side effect for `observe()` (see [§1.2](#observe-schedules-a-callback), and [Alternatives Considered](#alternatives-considered) for a constructor option and a dedicated method).

### Example usage

<a id="example-1-1"></a>
#### Example 1.1: Custom element readiness & ongoing mutations

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
    this.#mo.observe(this, { childList: true, delivery: "parse-end" });
  }

  disconnectedCallback() {
    this.#mo.disconnect();
  }
}
```

<a id="example-1-2"></a>
#### Example 1.2: Delegated island hydration from a document observer

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
        if (!node.isParsing) {
          // Opened and closed in the same chunk: enhance immediately
          enhanceArticle(node);
        } else {
          // Split across chunks (or also observe for ongoing mutations): wait for </article>
          articleObserver.observe(node, { childList: true, delivery: "parse-end" });
        }
      }
    }
  }
});

docObserver.observe(document, { subtree: true, childList: true });
```

### Web IDL

```webidl
enum MutationObserverDelivery { "normal", "parse-end" };

partial dictionary MutationObserverInit {
  MutationObserverDelivery delivery = "normal";
};
```

`"normal"` is today's delivery at every microtask checkpoint. Within a single task both values behave the same; they differ only while `target.isParsing` stays `true` across tasks.

For a `Document`, `DocumentFragment`, or `ShadowRoot` target, a parse-end observer never buffers; it only adds the guaranteed initial callback.

### 1.1 Per-observer batching, keyed on the observed target

When `observer.observe(target, { childList: true, delivery: "parse-end", ... })` is called:

- **Keyed on the observed target, including with `subtree: true`:** While `target` is parsing, **all** of the observer's `MutationRecord`s for `target` are held, including parser insertions, script mutations (`append()`, `remove()`, `setAttribute()`), and with `subtree: true`, records for any descendant. They are delivered together once **`target`** is no longer parsing. Descendants that close earlier do not cause an early flush. For per-descendant readiness, observe each descendant separately (as in [Example 1.2](#example-1-2)). If one parse-end observer observes several targets, each target is buffered separately, so a completed element flushes without waiting for an unrelated element that is still open. This is not well defined when one record matches several registrations; see [§1.4](#overlapping-registrations).
- **Observer-specific firing order:** Normal observers flush at every microtask checkpoint in observer creation order. A parse-end observer holds its records, so **other observers may fire earlier and in a different order**:
  - A normal observer (such as `docObserver` above) fires immediately at chunk 1's microtask checkpoint, while a parse-end observer on an unclosed element holds its records until chunk 2.
  - Nested parse-end observers flush **bottom-up** as end tags arrive: a parse-end observer on `<s-option>` flushes in chunk 1 as soon as `</s-option>` is seen, *before* the earlier-created parse-end observer on its parent `<s-select>` flushes at `</s-select>` in chunk 2.

<a id="observe-schedules-a-callback"></a>
### 1.2 `observe()` schedules a callback: guaranteed firing & empty children

Today, `observe()` only registers interest: the callback runs only if a mutation occurs. With `delivery: "parse-end"`, **`observe()` itself can cause a callback**, and the callback fires once per registration even if nothing changes. There is precedent: `IntersectionObserver.observe()` and `ResizeObserver.observe()` both deliver an initial notification without any change.

- **At parse end:** When `target` finishes parsing (end tag popped, implied end tag, EOF, parser abort, or the active stream/patch closing or aborting), all buffered records for `target` flush at the next microtask checkpoint. If no records were queued while parsing (for example `<my-widget></my-widget>`, or an empty `streamHTML*` write), an empty `childList` record is synthesized so the observer **always fires**.
- **When already parsed:** If `target` is *already* parsed when `observe()` is called (a custom element upgraded after parsing, `innerHTML` / `setHTML`, `document.createElement()`, or a node that already closed earlier in the same chunk), `observe()` **schedules a callback for the next microtask checkpoint**. It delivers any mutations made later in the same task (such as `el.append(a, b)`), or an empty `childList` record if none occurred.
- **Re-observing (including element moves):** If `observe()` is called again for a target the observer already observes, the options are replaced as today. Re-observing with `delivery: "parse-end"` **does not schedule another initial callback**; switching an existing normal registration to `"parse-end"` does, and switching from `"parse-end"` to `"normal"` releases any held records at the next microtask checkpoint. This covers custom elements whose `connectedCallback` runs again after a move without an intervening `disconnect()`. After `observer.disconnect()`, a later `observe()` is a new registration and schedules a new initial callback. In [Example 1.1](#example-1-1), that means a non-atomic move (`disconnectedCallback` then `connectedCallback`) runs setup again. Components that want to avoid this can implement `connectedMoveCallback` and use `moveBefore()`.
- **Trade-off vs. checking `isParsing` in `connectedCallback`:** Authors could check `if (!this.isParsing)` in `connectedCallback` and run setup synchronously for already-parsed elements, while still needing a `MutationObserver` for streamed elements and future mutations (this is what [Option 2](#option-2) asks of authors). The guaranteed callback keeps initial setup and later updates in a single code path without branching in `connectedCallback` (see [Custom elements](#custom-elements)).
- **Subsequent dynamic mutations & streams:** After that flush, ordinary DOM mutations (`el.append(c)`) flush normally at the microtask checkpoint. A later `el.streamHTML*()` call, or a `<template for>` patch into `el`, puts `el` back into the parsing state and buffers its mutations until the stream ends (again firing with an empty `childList` record if the stream added no children).
- **Option validation, `takeRecords()`, & disconnection:** Passing `delivery: "parse-end"` with `childList: false` (or an unrecognized `MutationObserverDelivery` value) throws a `TypeError`. `observer.takeRecords()` synchronously drains and returns **all** queued records on `observer`, including records buffered for a target that is still parsing. If `target` is still parsing, the observer still fires at parse end with any later mutations, or an empty `childList` record if there are none. If `target` was already parsed, draining cancels the pending initial callback. Calling `observer.disconnect()` discards any buffered records. Elements discarded by the sanitizer never connect and never fire.

#### Shape of the synthesized record

The synthesized record is `{ type: "childList", target, addedNodes: [], removedNodes: [], previousSibling: target.lastChild, nextSibling: null }`, which describes no change. `"childList"` was chosen over a new record type so that the usual callback loops (`for (const r of records) handle(r.addedNodes)`) work without a special case, and existing code that switches on `record.type` sees nothing unfamiliar. The trade-off is a record that describes no change, which DOM editors may object to. A dedicated type (for example `"parse-end"`) is the main alternative. The same question applies to the `"start"` record in the [template `MutationObserver` explainer](./template-mutation-observer-explainer.md), and both should get the same answer.

### 1.3 Long-lived streams & unbounded buffering

Buffering lasts as long as `target` is parsing. For a long-lived stream (such as an LLM chat response streamed into an element through `streamHTML()` for minutes), a parse-end observer holds **every** record for that `target` until the stream ends. That is by design, but authors should know about it:

- **Parse-end delivery is the wrong choice for progressively rendered targets.** If a component should react to content as it arrives, use a normal observer (or `activeTemplateAttributeFilter` for `<template for>` patches; see the [template `MutationObserver` explainer](./template-mutation-observer-explainer.md)).
- **`takeRecords()` is the escape hatch.** A component can drain buffered records at any time (for example from a `requestAnimationFrame` loop or a timer) without waiting for parse end. The guaranteed final callback still fires when the stream closes.
- **Implementations may store buffered records compactly** (for example by coalescing adjacent `childList` records for the same `target`), since only the final batch can be observed.

<a id="overlapping-registrations"></a>
### 1.4 Open issue: overlapping registrations on one observer

Holding is decided per registration, but a mutation record is queued once per observer, however many of that observer's registrations it matches ([queue a mutation record](https://dom.spec.whatwg.org/#queue-a-mutation-record)). When a record matches two registrations whose targets are in different parse states, the registrations disagree about when to deliver it:

```html
<div id="outer">
  <div id="inner"></div>
  <script>
    const mo = new MutationObserver(console.log);
    mo.observe(outer, { childList: true, subtree: true, delivery: "parse-end" });
    mo.observe(inner, { childList: true, delivery: "parse-end" });
    inner.append("x");
  </script>
  <!-- network pause -->
</div>
```

When the script runs, `outer` is still parsing and `inner` has already closed. The record for `inner.append("x")` matches both registrations: the one on `outer` (through `subtree: true`) says to hold it until `</div>`, which is an unbounded wait across the network pause, and the one on `inner` says to deliver it at the next microtask checkpoint, as part of the callback that `observe(inner, ...)` guarantees. No resolution keeps both promises:

| Resolution | What `mo` receives | What breaks |
|---|---|---|
| **Deliver when the first matching registration allows** | The `"x"` record after `</script>`. | The registration on `outer` no longer delivers everything under `outer` in one batch at `</div>`. If nothing else is inserted, it fires there with a synthesized empty record even though a mutation under `outer` happened and was already reported. |
| **Hold until every matching registration allows** | After `</script>`, the guaranteed callback for `inner` with a synthesized empty record; the `"x"` record only after the network pause. | The callback for `inner` reports no change while `inner` already contains `"x"`, and a registration on an element that finished parsing is delayed indefinitely by an unrelated ancestor registration. |
| **Deliver once per matching registration** | The `"x"` record twice. | The one-record-per-observer invariant; the callback cannot tell which registration a record is for. |
| **Throw from `observe()` when registrations overlap** | A `TypeError` from the second `observe()`. | Needs an ancestor/descendant walk over the observer's targets in `observe()`, and cannot catch overlap created later: `inner` moved under `outer` after both calls, or `outer.streamHTML()` starting after both calls. One of the rows above is still needed for those. |

The same conflict exists between a `"normal"` registration with `subtree: true` (for example on `document`) and a parse-end registration on a descendant, when both are on the same observer. Recommending separate observers avoids it in practice but does not define it. Separately from overlap, an observer with more than one registration can receive records out of mutation order, since a held record for one target is overtaken by later records for another.

[Option 2](#option-2) does not have this issue, because it never changes when a record is delivered.

<a id="option-1-scenarios"></a>
### 1.5 Scenarios & edge-case walkthroughs

The tables below show what a `MutationObserver` receives in each scenario. Throughout, `emptyRecord(target, prev = target.lastChild)` denotes the synthesized record `{ type: "childList", target, addedNodes: [], removedNodes: [], previousSibling: prev, nextSibling: null }`.

#### 1.5.1 Multi-chunk streaming & nested bottom-up ordering

`<s-select>` and `<s-option>` each call `this.#mo.observe(this, { childList: true, delivery: "parse-end" })` in `connectedCallback()`, while `docObserver` observes `document` with `{ childList: true, subtree: true }` (normal delivery):
- **Chunk 1:** `<s-select><s-option>A</s-option>`
- **Chunk 2:** `<s-option>B</s-option></s-select>`
- **Later task:** `select.append(optC)`

| Checkpoint | `docObserver` (normal) | `<s-option>A`'s observer (parse-end) | `<s-select>`'s observer (parse-end) |
|---|---|---|---|
| **End of Chunk 1** | **Fires:** `addedNodes: [<s-select>]`, `addedNodes: [<s-option>A]`, `addedNodes: ["A"]`. | **Fires:** `[addedNodes: ["A"]]` because `</s-option>` closed in Chunk 1—even though `<s-select>`'s observer was registered first. | **Held:** `<s-select>` is still on the stack of open elements (`addedNodes: [<s-option>A]` buffered). |
| **End of Chunk 2** | **Fires:** `addedNodes: [<s-option>B]`, `addedNodes: ["B"]`. | *(No changes)* | **Fires once** with all buffered records from both chunks: `[addedNodes: [<s-option>A], addedNodes: [<s-option>B]]`. |
| **After `select.append(optC)`** | **Fires:** `addedNodes: [<s-option>C]`. | *(No changes)* | **Fires at microtask checkpoint:** `[addedNodes: [<s-option>C]]`. |

#### 1.5.2 Empty elements, `createElement`, `innerHTML`, and late custom-element upgrades

When `<s-select>` calls `this.#mo.observe(this, { childList: true, delivery: "parse-end" })` in `connectedCallback()`:

| Scenario | State when `observe()` runs | Records queued before flush | What `<s-select>`'s observer receives |
|---|---|---|---|
| **Empty across two chunks** (`Chunk 1: <s-select>`, `Chunk 2: </s-select>`) | Parsing (on stack of open elements) | None | Held at Chunk 1; **fires at end of Chunk 2** with `[emptyRecord(<s-select>, null)]`. |
| **Empty in one chunk** (`<s-select></s-select>`) | Parsing (on stack when `connectedCallback` runs; popped at `</s-select>` in same chunk) | None | **Fires at end of chunk** with `[emptyRecord(<s-select>, null)]`. |
| **Imperative `createElement` + synchronous `append()`** (`body.append(s); s.append(optA, optB);`) | Already parsed (`connectedCallback` runs during `body.append(s)`) | `s.append(optA, optB)` queues `addedNodes: [optA, optB]` in the same task | **Fires once at microtask checkpoint** with `[addedNodes: [optA, optB]]` (no synthesized empty record needed because a real record was queued). |
| **Imperative `createElement` with no children** (`body.append(s);`) | Already parsed | None | **Fires at microtask checkpoint** with `[emptyRecord(<s-select>, null)]`. |
| **`el.innerHTML = "<s-select><s-option>A</s-option></s-select>"`** | Already parsed (custom element reactions run after the synchronous fragment parser finishes) | None after `connectedCallback()` (children were inserted before `connectedCallback` ran) | **Fires at microtask checkpoint** with `[emptyRecord(<s-select>, <s-option>A)]`. |
| **Late `customElements.define("s-select", ...)`** after `<s-select><s-option>A</s-option></s-select>` is already in the DOM | Already parsed | None | **Fires at microtask checkpoint** with `[emptyRecord(<s-select>, <s-option>A)]`. |

#### 1.5.3 Delegated observation from a parent/document normal observer

Suppose `docObserver` (`{ childList: true, subtree: true }`, normal delivery) discovers `<article>` in `addedNodes` at the end of Chunk 1 and calls `articleObserver.observe(article, { childList: true, delivery: "parse-end" })`:

| Chunk 1 & Chunk 2 markup | `article.isParsing` when `docObserver` runs at end of Chunk 1 | What `articleObserver` receives |
|---|---|---|
| **Chunk 1:** `<article><h1>Title</h1>`<br>**Chunk 2:** `<p>Body</p></article>` | **`true`** (`<h1>` was already inserted before `observe()` was called, so `<h1>` is already in `article.children`). | Held until `</article>` in Chunk 2; **fires at end of Chunk 2** with `[addedNodes: [<p>]]`. |
| **Chunk 1:** `<article><h1>Title</h1>`<br>**Chunk 2:** `</article>` *(no new children in Chunk 2)* | **`true`** | Held until `</article>` in Chunk 2; **fires at end of Chunk 2** with `[emptyRecord(<article>, <h1>)]`. |
| **Chunk 1:** `<article><h1>Title</h1></article>` *(opened and closed in Chunk 1)* | **`false`** (already parsed by the time `docObserver`'s microtask runs). | If `articleObserver.observe()` is called anyway, it schedules a microtask immediately and **fires in the same microtask checkpoint** with `[emptyRecord(<article>, <h1>)]` (or `docObserver` can check `!article.isParsing` to enhance `article` synchronously without registering `articleObserver`). |

#### 1.5.4 Inline `<script>` inside an open element (`document.write()`, imperative mutations, `takeRecords()`)

Suppose `<s-select>` is observed with `{ childList: true, attributes: true, delivery: "parse-end" }` and the parser processes:
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
| **Imperative mutation** (`select.setAttribute("data-x", "1"); select.append(optX);`) | **Held:** Because `<s-select>` is still parsing, both parser insertions and script mutations targeting `<s-select>` remain buffered. | **Fires once** with all buffered `childList` and `attributes` records in order. |
| **`document.write("<s-option>W</s-option>")`** | **Held:** Tokens written into the active parser while `<s-select>` is on the stack of open elements are buffered with the rest. | **Fires once** including `addedNodes: [<s-option>W]`. |
| **`const early = selectObserver.takeRecords()`** | `takeRecords()` synchronously drains and returns `[addedNodes: [<s-option>A], addedNodes: [<script>]]`. Because `<s-select>` is still parsing, the parse-end registration stays armed. | **Still fires at `</s-select>`** with `[addedNodes: [<s-option>B]]` (or `[emptyRecord(<s-select>)]` if no further mutations occurred after `takeRecords()`). |

#### 1.5.5 Streaming updates after initial parse (`streamHTML*()` and `<template for>`)

Suppose `<section id="feed">` is already parsed and observed with `feedObserver.observe(feed, { childList: true, subtree: true, delivery: "parse-end" })`:

| Streaming operation | While stream is open across chunks | When stream finishes |
|---|---|---|
| **`const w = feed.streamHTML()`**<br>`w.write("<p>1</p>")` → yield → `w.write("<p>2</p>")` → `w.close()` | `feed.streamHTML()` synchronously removes existing children and marks `feed` as **parsing**. Both `removedNodes: [...oldChildren]` and `addedNodes: [<p>1]` are **held** across chunks. | `w.close()` ends parsing for `feed`; `feedObserver` **fires once** with `removedNodes: [...oldChildren]` and all `addedNodes` (`<p>1`, `<p>2`, and their text). |
| **Empty `streamHTML()`** on an already-empty `feed` (`const w = feed.streamHTML(); w.close();`) | `feed` is parsing while `w` is open. | **Fires on `w.close()`** with `[emptyRecord(feed, null)]`. |
| **`<template for="feed">`** streaming across chunks into `<section id="feed"><?marker name="feed"></section>` | `feed` is the target of an active `<template for>` patch, so records in `feed`'s buffer are **held** until `</template>`. | When `</template>` is parsed (or the stream aborts at EOF), `feedObserver` **fires once** with all mutations from the patch. |

#### 1.5.6 HTML parser edge cases & aborts

| Edge case | Parser behavior | What parse-end observer receives |
|---|---|---|
| **Implied end tags** (`<ul><li>One<li>Two</ul>`) | Parsing the second `<li>` start tag implicitly pops the first `<li>` from the stack of open elements. | Parse-end observer on the first `<li>` flushes at that chunk's microtask checkpoint, identically to an explicit `</li>`. |
| **Adoption agency algorithm** (`<x-b><x-i>Bold </x-b>italic</x-i>`) | At `</x-b>`, the original `<x-i>` and `<x-b>` are popped from the stack of open elements; a *new* `<x-i>` element is created for `italic`. | Observers on the original `<x-i>` and `<x-b>` flush after `</x-b>`. The cloned `<x-i>` is a distinct `Element` instance that remains parsing until `</x-i>`. |
| **Foster parenting** (`<table><x-div><span>hi</span></x-div><tr><td>cell</td></tr></table>`) | `<x-div>` is inserted as a sibling before `<table>`, but remains on the stack of open elements until `</x-div>`. | Observer on `<x-div>` holds `<span>hi</span>` until `</x-div>`. Because `<x-div>` is inserted into `<table>.parentNode` (not `<table>`), an observer on `<table>` only sees `<tbody>`/`<tr>`, while an observer on `<table>.parentNode` holds both `<x-div>` and `<table>` until `<table>.parentNode` closes. |
| **Element removed mid-parse** (`Chunk 1: <x-box><p>1</p>` + `<script>box.remove()</script>`, `Chunk 2: <p>2</p></x-box>`) | The parser's stack of open elements holds a reference to `box` and continues appending `<p>2</p>` into the detached `box` until `</x-box>` pops it. | If `disconnectedCallback()` calls `this.#mo.disconnect()`, buffered records are cleared and nothing fires. If the observer does *not* disconnect, `box` stays parsing until `</x-box>` pops it in Chunk 2, then flushes `[addedNodes: [<p>1], addedNodes: [<p>2]]`. |
| **Element moved mid-parse** (`newParent.append(box)` while `box` is still on the parser stack, re-running `connectedCallback`) | `box` remains on the stack of open elements until `</x-box>`. | If `disconnectedCallback` did not call `disconnect()`, calling `observe(box, { delivery: "parse-end" })` again in `connectedCallback` updates the existing registration in place without discarding held records or scheduling a premature flush; it flushes once `</x-box>` is parsed. |
| **Premature EOF / `window.stop()` / aborted stream** (`<x-box><p>Half...` then EOF) | At EOF or abort, the parser pops all remaining elements from the stack of open elements. | `<x-box>` transitions out of the parsing state and flushes all buffered records (`[addedNodes: [<p>]]`) at the microtask checkpoint. |

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

- **It is a wake-up, not a description.** Like Option 1's synthesized record, it exists only when no real `childList` record would trigger the callback: an empty element, or an end tag arriving in a chunk of its own. Whether it appears therefore depends on where chunk boundaries fall.
- **It is a normative DOM change.** [Queue a tree mutation record](https://dom.spec.whatwg.org/#queue-a-tree-mutation-record) asserts that `addedNodes` or `removedNodes` is non-empty; that assertion would be relaxed for records delivered only to observers that opted in. Both options need this, as does the `"start"` record in the [template `MutationObserver` explainer](./template-mutation-observer-explainer.md), and all three should get the same answer.
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
| **The [overlapping registrations](#overlapping-registrations) example**, as `mo.observe(outer, { childList: true, subtree: true })` and `mo.observe(inner, { childList: true, parseEnd: true })` | The `"x"` record once, at the `</script>` microtask checkpoint, as today. No parse-end record: `inner` had already closed when it was observed, and `outer`'s registration cannot ask for one. |

---

<a id="comparison"></a>
## Comparing the options

| | Option 1: `delivery: "parse-end"` | Option 2: `parseEnd: true` |
|---|---|---|
| **Delivery timing** | Changed for the parse-end observer: records for a parsing target are held, possibly across many tasks. | Unchanged. |
| **Callbacks during parsing** | None for the held target. | One per chunk, as today; the callback checks `isParsing`. |
| **Records at parse end** | Everything since the target was observed, in one batch. | Only what was queued since the last checkpoint, or the parse-end record if that is nothing. |
| **`observe()`** | Can schedule a callback by itself (already-parsed targets). | No side effects. |
| **Already-parsed targets** | Same callback as streamed ones. | Caller checks `isParsing` after `observe()`. |
| **`subtree: true`** | Allowed; held on the observed target's parse state. | `TypeError`. |
| **Empty `childList` record** | Only when the batch would otherwise be empty. | Only when no `childList` record for the target is pending at parse end. More frequent than in Option 1, because earlier chunks have already been delivered. |
| **Several registrations on one observer** | [Underdefined when they overlap](#overlapping-registrations); records can be delivered out of mutation order. | Nothing new: each record is delivered once, when it would be today. |
| **Long-lived streams** | Unbounded buffering; `takeRecords()` is the escape hatch ([§1.3](#13-long-lived-streams--unbounded-buffering)). | Nothing buffered. |
| **`takeRecords()` / `disconnect()` / re-observe** | New rules for held records and the pending initial callback ([§1.2](#observe-schedules-a-callback)). | As today. |
| **Spec and implementation surface** | Per-registration hold queues, flush at parse end, guaranteed initial callback, empty record. | One conditional queuing step at parse end, one validation rule, empty record. |

In short: Option 1's main advantage is that authors never have to check `isParsing`, in the callback or around `observe()`; they get one batch through one code path. That comes at the cost of a new delivery model whose interaction with multiple registrations has no clean answer. Option 2 keeps the delivery model intact and is small to specify, at the cost of a record that describes no change, per-chunk callbacks that the author filters with `isParsing`, and an extra check for already-parsed targets.

---

<a id="custom-elements"></a>
## Custom elements and `WICG/webcomponents#809`

The central objection in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809) to a dedicated custom element `parsedCallback()` is that an end-tag callback invites authors to read `this.children` once and ignore subsequent dynamic mutations, imperative `createElement` + `append()`, or post-parse insertions ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1460917211), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1757047993)). Both options answer it by staying inside `MutationObserver`, so the same observer keeps reporting later mutations. They differ in how many code paths the component needs:

| Creation mode | Option 1 ([Example 1.1](#example-1-1)) | Option 2 ([Example 2.1](#example-2-1)) |
|---|---|---|
| **Streamed across network chunks** (`<s-select>` ... `</s-select>`) | `#mo` buffers all child insertions across chunks and fires once `</s-select>` is seen. | `#mo` fires at each chunk and returns early while `isParsing`; a pending `childList` record or, failing that, the parse-end record guarantees a run after `</s-select>`. |
| **Empty children** (`<s-select></s-select>`) | Fires at `</s-select>` with a synthesized empty `childList` record, so initial setup still runs. | The parse-end record is the only record; initial setup runs from it. |
| **Imperative `createElement` + `append()`, `innerHTML`, or late upgrade** | `observe()` schedules a callback for the next microtask. `body.append(s); s.append(opt1, opt2);` runs setup once, with both options present (or with an empty record if nothing was appended). | `isParsing` is `false` in `connectedCallback`, so setup runs synchronously there. `body.append(s); s.append(opt1, opt2);` runs setup in `connectedCallback` and again from the ordinary mutation callback. |
| **Subsequent dynamic mutations & streams** | Later mutations (`s.append(opt3)`) fire at the microtask checkpoint; later `s.streamHTML*()` streams or `<template for>` patches into `s` are buffered until they complete. | Later mutations fire as today; later streams fire per chunk and return early, with a parse-end record when they complete. |

---

## Considered Extensions (Not Currently Proposed)

- **`ShadowRoot` targets:** Treating a `ShadowRoot` whose declarative `<template shadowrootmode>` has not yet closed (or that is an active `streamHTML*` target) as parsing, under either option, is a natural extension under consideration, but is not part of the core proposal.
- **Custom element `parsedCallback()`:** Libraries like [`html-parsed-element`](https://github.com/WebReflection/html-parsed-element) polyfill `parsedCallback()` today using per-element `subtree: true` `MutationObserver`s. While a native `parsedCallback()` could mirror parse-end timing, both options here cover initial readiness and ongoing mutations with the same observer, without introducing a one-shot lifecycle footgun.

---

## Alternatives Considered

1. **Relying on `Element.isParsing` (or `MutationRecord.closingTagParsed`) alone:** The 2023 WCCG F2F discussed exposing a passive boolean (`MutationRecord.closingTagParsed` in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809#issuecomment-1516789211)). `element.isParsing` is useful for synchronous inspection (and is included above), but a boolean *by itself* does not tell an observer when it later flips from `true` to `false`: if an element's children arrived in Chunk 1 and only `</element>` arrives in Chunk 2, no further child mutation occurs in Chunk 2 to wake up a `MutationObserver` ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1755889378)). Both options close that gap: Option 1 delivers the held batch at parse end, and Option 2 queues a parse-end record.
2. **A `record.parsedElements` `NodeList` on `MutationRecord`:** Required a `NodeList` allocation per `MutationRecord`, forced observing `el.parentNode` rather than `el` directly, and still delivered half-parsed child mutations across chunk boundaries.
3. **Combining parse-end observation and `<template>` observation into a single `parser: true` option:** Streaming `<template for>` observers ([template-mutation-observer-explainer.md](./template-mutation-observer-explainer.md)) want incremental per-chunk `"start"` / `"update"` / `"end"` records about a patch, whereas the options here are about the observed target finishing parsing (and Option 1 holds records until then). Keeping them separate avoids conflating the two.
4. **(Option 1) A constructor option (`new MutationObserver(cb, { delivery: "parse-end" })`):** Makes delivery a property of the whole observer, so one callback never mixes normal and parse-end targets, and the opt-in sits next to the callback that must handle the synthesized record. Not chosen because it buys little: per-target buffering already mixes held and flushed targets within one parse-end observer; `observe()` still schedules the initial callback for already-parsed targets; authors who find mixed timing confusing can use two observers; and it would add the first options dictionary to `MutationObserver`'s constructor, while every existing option lives in `MutationObserverInit`. It also does not resolve [overlapping registrations](#overlapping-registrations), where both registrations are parse-end.
5. **(Option 1) A dedicated one-shot method (e.g. `observer.notifyWhenParsed(target)`):** `observe()` stays side-effect free; a separate call means "hold this observer's records for `target` until it finishes parsing, then deliver at least one record". This makes the synthesized record easy to justify ("you asked to be notified") and settles re-observing and long streams, since nothing happens unless the method is called. Not chosen because it takes two calls with ordering rules (throw if `target` isn't observed; no-op while a hold is pending; dropped by `disconnect()`), and later `streamHTML*()` streams or `<template for>` patches are not held automatically: the component owning the observer must notice them and call the method again. Kept as the main fallback if DOM editors object to `observe()` scheduling a callback.
6. **(Option 2) A dedicated record type (for example `type: "parseEnd"`) instead of an empty `childList` record:** Avoids a record that describes no change and leaves the [queue a tree mutation record](https://dom.spec.whatwg.org/#queue-a-tree-mutation-record) assertion alone. The cost is a new `MutationRecord.type` value, which existing callbacks that branch on `type` do not expect. Under Option 2, callbacks can ignore the record and check `isParsing`, which makes its type matter less. The same choice applies to Option 1's synthesized record and to the template explainer's `"start"` record.
7. **DOM Events (`parseend`):** Per-element event dispatch during parsing repeats the performance issues of legacy `MutationEvent` and neither batches `MutationRecord`s nor observes subsequent dynamic mutations.
8. **Status quo (client-side reconstruction):** Requires per-element `subtree: true` observers, ancestor `nextSibling` walks, chunk regexes, or sentinel nodes/scripts, and cannot observe active `streamHTML*` boundaries.

---

## Frequently Asked Questions (Q&A)

<details>
<summary><strong>Parser overhead, firing order, and empty/already-parsed targets</strong></summary>

<a id="q1"></a>
### Q1: Does either option, or `element.isParsing`, add overhead to the HTML parser or delay rendering?
No. The HTML parser inserts nodes into the live DOM immediately as bytes arrive—layout, rendering, preload scanning, and other observers are never delayed. Option 1 holds records in a pending queue only for parse-end observers; Option 2 queues at most one extra record when a target observed with `parseEnd: true` finishes parsing. Both are gated on state the parser already maintains (stack of open elements and active streaming fragment parsers).

**Off-main-thread / tree-op parsers (e.g., Gecko):** An engine that separates parsing from main-thread DOM construction via queued tree operations does **not** need to emit an "end-parse" operation or flip an `isParsing` bit on every element's opening and closing tags ([w3c/csswg-drafts#12578 (comment)](https://github.com/w3c/csswg-drafts/issues/12578#issuecomment-3209690246)). Any element that opens and closes without an intervening parser batch flush (chunk or timer boundary), `<script>`, or custom element reaction can never be observed by script while open—by the time any `MutationObserver` or script can hold a reference to that element and read `el.isParsing`, it is already parsed (`false`, the default). The same marking tells the main thread which closing elements can have a held batch to flush (Option 1) or a parse-end record to queue (Option 2). The parser only needs to mark the $O(\text{stack depth})$ ancestor elements that are actually on the stack of open elements *at* a batch flush, `<script>`, or custom element reaction (and later emit a close op for those few nodes, which can itself be batched up to the next such boundary).

### Q2 (Option 1): Why can observers fire in a different order when parse-end observers are used?
Because buffering is observer-specific: a parse-end observer watching `<parent>` holds its records while `<parent>` is open, whereas a normal observer—or a parse-end observer on `<child>` whose `</child>` arrived in an earlier chunk—flushes at that earlier chunk's microtask checkpoint. Nested parse-end components therefore initialize bottom-up (`<s-option>` flushes before `<s-select>`).

### Q3 (Option 1): Why is a parse-end observer guaranteed to fire even if the target is already parsed or has empty children?
Guaranteeing a flush at parse end—or at the next microtask checkpoint if already parsed—(synthesizing an empty `childList` record when no child records were queued) ensures `<my-widget></my-widget>` observed in `connectedCallback()` and elements upgraded or observed after parsing initialize through the exact same `MutationObserver` callback as multi-chunk elements.

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
    Option 1: passing `delivery: "parse-end"` with `childList: false` (or an invalid `MutationObserverDelivery` value) throws a `TypeError`. Option 2: passing `parseEnd: true` with `childList: false` or with `subtree: true` throws a `TypeError`. Both match existing `MutationObserver.prototype.observe()` option validation.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.

</details>
