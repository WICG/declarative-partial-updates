# Explainer: Parse-End Delivery for `MutationObserver` (`delivery: "parse-end"`)

## Introduction

The HTML parser tracks [which elements are still open](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) and when each one closes (by an explicit end tag, an implied end tag, or EOF). Built-in elements like `<script>`, `<style>`, and `<object>` already rely on this state to act only once the parser finishes them.

`MutationObserver`, however, only sees the start tag: when markup streams across network chunks, the parser inserts an element on its opening tag and yields before its closing tag arrives, flushing half-built subtrees to observers at intermediate microtask checkpoints. By contrast, when DOM is built synchronously in JavaScript (`el.append(a); el.append(b);`), `MutationObserver` naturally batches all mutations in the task and delivers them together at the microtask checkpoint.

This explainer proposes adding a `delivery: "parse-end"` option to `MutationObserverInit` (`MutationObserverDelivery` enum, defaulting to `"default"`) that extends `MutationObserver` batching across parser chunks for a given observer:

1. **The browser already tracks this state** (the parser's stack of open elements and active `streamHTML*` context), so holding an observer's records until parse end introduces no new parser concepts or DOM tree buffering.
2. **Server-driven and streaming apps already depend on it**, reconstructing it today with sentinel nodes, inline scripts, ancestor `nextSibling` walks, regexes over raw HTML, and per-element `subtree: true` observers at measurable main-thread and wire cost (see [Existing workarounds](#existing-workarounds)).
3. **It fits the existing reactive model.** Rather than introducing a one-shot hook that tempts authors to ignore subsequent dynamic mutations ([WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809)), `delivery: "parse-end"` is an option on `MutationObserver` itself—delivering a single batched callback when parsing finishes (or on the next microtask if already parsed, even with empty children), and continuing to observe future DOM changes and `streamHTML*` streams.

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

- **Buffer `MutationRecord` delivery across parser chunks per observer (`delivery: "parse-end"`):** Hold `MutationRecord` delivery for an `(observer, target)` pair while `target` is parsing (either its end tag has never been seen, or it is currently an active `streamHTML*` target).
- **Guarantee callback delivery at parse end—or if already parsed—even with empty children:** Ensure a single observer setup handles streamed elements, empty elements (`<x-el></x-el>`), imperative/already-parsed elements, and subsequent dynamic mutations.
- Eliminate the client-side workarounds above with **zero cost when unused** and **no new properties on `MutationRecord` or `Element`**.

### Non-Goals

- **Discouraging dynamic mutation handling:** Observers remain active for ongoing DOM mutations after parse end (and automatically batch future `streamHTML*` streams into the target).
- **Holding back DOM tree mutations themselves:** Nodes and attribute changes still apply to the DOM immediately so rendering, preload scanning, and other observers are unaffected; `delivery: "parse-end"` buffers `MutationRecord` delivery (for all mutations matching that `(observer, target)` registration—both parser-driven and imperative live DOM mutations—until `target` is no longer parsing).
- **Tracking non-element nodes**, or **replacing `PerformanceEntry` for sub-microtask RUM timing**.

---

## Proposed Approach

A `delivery` option in `MutationObserverInit` (`"default" | "parse-end"`, defaulting to `"default"`) opts an observer registration into parse-end delivery when set to `"parse-end"`:

- **When a target is considered parsing:** An observed `Element` is parsing when **either** (1) its end tag has never been seen yet (it is on the HTML parser's stack of open elements), **or** (2) it is currently an active `streamHTML*` target.
- **Observer-specific buffering while parsing:** While the observed target is parsing, **all** `MutationRecord`s queued for that `(observer, target)` registration—whether from the parser or from live DOM mutations—are **buffered (held back)** until the target is no longer parsing, rather than flushing at intermediate microtask checkpoints.
- **Observer-specific firing order:** Because buffering applies only to the observer registration with `delivery: "parse-end"`, other observers (such as observers using `delivery: "default"`, or `delivery: "parse-end"` observers on child elements whose end tags arrive earlier) are not held back and may therefore fire in a different order.
- **Guaranteed flush (with empty children if applicable):** The observer is **guaranteed to fire** when parse end is reached—**or at the next microtask checkpoint if the target is already parsed** when `observe()` is called—synthesizing an empty `childList` record (`addedNodes: []`, `removedNodes: []`) if no child mutations were queued.

### Example Usage

#### 1. Custom element readiness & ongoing mutations

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

#### 2. Delegated island hydration from a document observer

```js
// Batches records per <article> until </article> (or fires on next microtask if already parsed):
const articleObserver = new MutationObserver((records) => {
  const ready = new Set(records.map((r) => r.target));
  for (const article of ready) enhanceArticle(article);
});

// Discovers <article> elements on their start tag without delaying incremental observation:
const docObserver = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node instanceof Element && node.matches("article")) {
        articleObserver.observe(node, { childList: true, delivery: "parse-end" });
      }
    }
  }
});

docObserver.observe(document, { subtree: true, childList: true });
```

### Web IDL

```webidl
enum MutationObserverDelivery { "default", "parse-end" };

partial dictionary MutationObserverInit {
  MutationObserverDelivery delivery = "default";
};
```

---

## Detailed Design

### 1. Definition of "parsing"

An observed `Element` `target` is **parsing** *(shared definition with [Hide While Loading (`:loading`)](./partial-render-blocking-explainer.md#2-the-loading-css-pseudo-class--shared-parsing-definition))* when **either**:
1. It was pushed onto the HTML parser's stack of open elements and its **end tag has never been seen** yet (void elements and self-closing foreign elements are popped immediately on insertion, so they are already parsed by the time any observer sees them), **or**
2. It is **currently the context element of an active streaming fragment parser**—either an open `streamHTML`, `streamHTMLUnsafe`, or `streamAppendHTML*` parser on `target`, or an active `<template for="...">` / `<template for="..." src="...">` patch currently streaming into a marker whose parent is `target`.

### 2. Per-observer batching & firing order

When `observer.observe(target, { childList: true, delivery: "parse-end", ... })` is called:

- **Buffering all records for `(observer, target)` while parsing:** While `target` is parsing, **all** `MutationRecord`s queued for that `(observer, target)` registration—including both parser-driven insertions and any imperative live DOM mutations (such as script `append()`, `remove()`, `setAttribute()`, or `subtree` mutations occurring while `target` is still parsing)—are buffered rather than flushed at intermediate microtask checkpoints, and delivered together once `target` is no longer parsing. (If a single `MutationObserver` observes multiple targets with `delivery: "parse-end"`, buffering is tracked per `(observer, target)` pair so a completed element flushes without waiting for an unrelated still-open element.)
- **Observer-specific firing order:** Standard `MutationObserver` delivery (`delivery: "default"`) flushes all observers at every microtask checkpoint in observer creation order. With `delivery: "parse-end"`, holding records is specific to that registration, so **other observers may fire earlier and in a different order**:
  - An observer with `delivery: "default"` (such as `docObserver` above) fires immediately at chunk 1's microtask checkpoint while a `delivery: "parse-end"` observer on an unclosed element holds its records until chunk 2.
  - Nested `delivery: "parse-end"` observers naturally flush **bottom-up** as end tags arrive: a `delivery: "parse-end"` observer registered on `<s-option>` flushes in chunk 1 as soon as `</s-option>` is seen, *before* the earlier-registered `delivery: "parse-end"` observer on its parent `<s-select>` flushes at `</s-select>` in chunk 2.

### 3. Guaranteed firing & empty children

- **At parse end:** When `target` finishes parsing (end tag popped, implied end tag, EOF reached, or active `streamHTML*` closed/aborted), all buffered records for `target` flush at the microtask checkpoint. If zero records were queued while parsing—for instance, `<my-widget></my-widget>` with empty children, or an empty `streamHTML*` write—an empty `childList` record (`target`, `addedNodes: []`, `removedNodes: []`, `previousSibling: target.lastChild`) is synthesized so the observer is **guaranteed to fire**.
- **When already parsed:** If `target` is *already* parsed when `observe(target, { childList: true, delivery: "parse-end" })` is called (e.g., post-parse custom element upgrade, `innerHTML` / `setHTML`, `document.createElement()`, or observing a node that already closed earlier in the same chunk), the observer is likewise **guaranteed to fire** at the next microtask checkpoint—delivering any synchronous mutations made later in the same task (such as `el.append(a, b)`), or an empty `childList` record (`target`, `addedNodes: []`, `removedNodes: []`, `previousSibling: target.lastChild`) if none occurred.
- **Subsequent dynamic mutations & `streamHTML*`:** After that flush, ordinary DOM mutations (`el.append(c)`) flush normally at the microtask checkpoint, while any future `el.streamHTML*()` call puts `el` back into the parsing state and buffers that stream's mutations until stream end (again firing with an empty `childList` record if the stream added no children).
- **Option validation, `takeRecords()`, & disconnection:** Passing `delivery: "parse-end"` with `childList: false` (or an unrecognized `MutationObserverDelivery` value) throws a `TypeError`. `observer.takeRecords()` synchronously drains and returns **all** queued records on `observer`, including records currently buffered for a still-parsing `delivery: "parse-end"` target (if `target` is still parsing, the observer will still fire at parse end with any subsequent mutations, or an empty `childList` record if none; if `target` was already parsed, draining clears the pending initial flush). Calling `observer.disconnect()` discards any buffered records; sanitized elements discarded by the parser never connect or fire.

### 4. Walkthrough: Batching & observer-specific ordering across two chunks

Suppose `<s-select>` and `<s-option>` each call `this.#mo.observe(this, { childList: true, delivery: "parse-end" })` in `connectedCallback()`, while `docObserver` observes `document` with `{ childList: true, subtree: true }` (`delivery: "default"`). The network delivers:
- **Chunk 1:** `<s-select><s-option>A</s-option>`
- **Chunk 2:** `<s-option>B</s-option></s-select>`

| Checkpoint | `docObserver` (`delivery: "default"`) | `<s-option>A`'s observer (`delivery: "parse-end"`) | `<s-select>`'s observer (`delivery: "parse-end"`) |
|---|---|---|---|
| **End of Chunk 1** | **Fires** (`addedNodes`: `<s-select>`, `<s-option>A`, `"A"`). | **Fires** (`addedNodes: ["A"]`) because `</s-option>` was seen in Chunk 1—even though `<s-select>`'s observer was registered earlier! | **Buffered (does not fire):** `<s-select>` has not seen `</s-select>` yet (`addedNodes: [<s-option>A]` held). |
| **End of Chunk 2** | **Fires** (`addedNodes`: `<s-option>B`, `"B"`). | *(No changes to `<s-option>A`)* | **Fires once** with **all** buffered records from both chunks (`addedNodes: [<s-option>A]` and `addedNodes: [<s-option>B]`). |

*(If the markup had instead been `<s-select></s-select>` across the two chunks with empty children, `<s-select>`'s observer would still hold at Chunk 1 and **fire at Chunk 2** with `{ type: "childList", target: <s-select>, addedNodes: [], removedNodes: [] }`.)*

### 5. Custom elements and `WICG/webcomponents#809`

The central objection in [WICG/webcomponents#809](https://github.com/WICG/webcomponents/issues/809) to a dedicated custom element `parsedCallback()` is that an end-tag callback invites authors to read `this.children` once and ignore subsequent dynamic mutations, imperative `createElement` + `append()`, or post-parse insertions ([#809 (comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1460917211), [(comment)](https://github.com/WICG/webcomponents/issues/809#issuecomment-1757047993)).

Calling `this.#mo.observe(this, { childList: true, delivery: "parse-end" })` in `connectedCallback()` satisfies that principle across every creation mode with a single callback and no extra properties on `Element`:
1. **Streamed across network chunks (`<s-select>` ... `</s-select>`):** `#mo` buffers all child insertions across chunks and fires once `</s-select>` is seen.
2. **Empty children (`<s-select></s-select>`):** Guaranteed to fire at `</s-select>` with an empty `childList` record (`addedNodes: []`, `removedNodes: []`), so initial setup still runs.
3. **Imperative `createElement` + `append()`, `innerHTML`, or late upgrade:** Because `delivery: "parse-end"` is guaranteed to fire on the next microtask when already parsed, `const s = document.createElement("s-select"); document.body.append(s); s.append(opt1, opt2);` runs `connectedCallback()` on `body.append(s)`, batches `s.append(opt1, opt2)` in the same synchronous task, and fires once at the microtask checkpoint (or fires with an empty `childList` record if no children were appended or if upgraded after parsing).
4. **Subsequent dynamic mutations & `streamHTML*`:** Later JS mutations (`s.append(opt3)`) trigger `#mo` at the microtask checkpoint, and later `s.streamHTML*()` streams automatically buffer until stream completion.

---

## Considered Extensions (Not Currently Proposed)

- **`ShadowRoot` parse-end delivery:** Extending `delivery: "parse-end"` when observing a `ShadowRoot` whose declarative `<template shadowrootmode>` has not yet closed (or that is an active `streamHTML*` target) is a natural extension under consideration, but is not part of the core proposal.
- **Custom element `parsedCallback()`:** Libraries like [`html-parsed-element`](https://github.com/WebReflection/html-parsed-element) polyfill `parsedCallback()` today using per-element `subtree: true` `MutationObserver`s. While a native `parsedCallback()` could mirror parse-end timing, `this.#mo.observe(this, { childList: true, delivery: "parse-end" })` handles both initial readiness and ongoing mutations without introducing a one-shot lifecycle footgun.

---

## Alternatives Considered

1. **Exposing synchronous `Element.isParsing` + unbatched cross-chunk completion records:** An earlier iteration exposed `el.isParsing`, flushed `addedNodes` on every intermediate chunk while `el.isParsing === true`, and emitted a trailing empty `childList` record when `</el>` finally arrived. However, that enlarged the API surface with a synchronous parser-state getter, forced every observer to manually filter out `node.isParsing` elements and maintain external state across chunks, and did not fire on already-parsed elements or single-chunk `<x-el></x-el>` elements observed in `connectedCallback()`. Per-observer `delivery: "parse-end"` buffering achieves the use cases without `Element.isParsing` or manual state tracking.
2. **A `record.parsedElements` `NodeList` on `MutationRecord`:** Required a `NodeList` allocation per `MutationRecord`, forced observing `el.parentNode` rather than `el` directly, and still delivered half-parsed child mutations across chunk boundaries.
3. **Combining parse-end delivery and `<template>` observation into a single `parser: true` option:** Streaming `<template for>` observers ([template-mutation-observer-explainer.md](./template-mutation-observer-explainer.md)) want incremental per-chunk `"start"` / `"update"` / `"end"` records (`delivery: "default"`), whereas `delivery: "parse-end"` observers want records held until the observed target finishes parsing. Keeping them separate avoids conflating opposite delivery models.
4. **DOM Events (`parseend`):** Per-element event dispatch during parsing repeats the performance issues of legacy `MutationEvent` and neither batches `MutationRecord`s nor observes subsequent dynamic mutations.
5. **Status quo (client-side reconstruction):** Requires per-element `subtree: true` observers, ancestor `nextSibling` walks, chunk regexes, or sentinel nodes/scripts, and cannot observe active `streamHTML*` boundaries.

---

## Frequently Asked Questions (Q&A)

<details>
<summary><strong>Parser overhead, firing order, empty/already-parsed targets, and HTML adoption/foster-parenting</strong></summary>

### Q1: Does `delivery: "parse-end"` add overhead to the HTML parser or delay rendering?
No. The HTML parser inserts nodes into the live DOM immediately as bytes arrive—layout, rendering, preload scanning, and other observers are never delayed. Holding records in a pending queue only occurs for observer registrations that pass `delivery: "parse-end"`, gated on state the parser already maintains (stack of open elements and active `streamHTML*` context).

### Q2: Why can observers fire in a different order when `delivery: "parse-end"` is used?
Because `delivery: "parse-end"` is observer-specific: an observer watching `<parent>` with `delivery: "parse-end"` holds its records while `<parent>` is open, whereas a `delivery: "default"` observer—or a `delivery: "parse-end"` observer on `<child>` whose `</child>` arrived in an earlier chunk—flushes at that earlier chunk's microtask checkpoint. Nested `delivery: "parse-end"` components therefore initialize bottom-up (`<s-option>` flushes before `<s-select>`).

### Q3: Why is a `delivery: "parse-end"` observer guaranteed to fire even if the target is already parsed or has empty children?
Guaranteeing a flush at parse end—or at the next microtask checkpoint if already parsed—(synthesizing an empty `childList` record when no child records were queued) ensures `<my-widget></my-widget>` observed in `connectedCallback()` and elements upgraded or observed after parsing initialize through the exact same `MutationObserver` callback as multi-chunk elements.

### Q4: What happens with foster parenting and the adoption agency algorithm?
- **Foster parenting (`<table><div>...</div></table>`):** `<div>` remains on the stack of open elements until `</div>` is seen, so a `delivery: "parse-end"` observer on `<div>` buffers until `</div>` pops it.
- **Adoption agency (`<b><i>Bold </b>italic</i>`):** Popping the original `<i>` at `</b>` ends parsing for that `<i>` instance and flushes its buffer; the reconstructed `<i>` created for `italic` is a distinct element tracked until `</i>`.

</details>

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

`delivery: "parse-end"` exposes no new user or cross-origin information: it only controls microtask delivery timing of `MutationRecord`s for a DOM element the caller can already observe, adds no new properties to `Element` or `MutationRecord`, and emits nothing for sanitizer-discarded elements.

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. `delivery: "parse-end"` only controls microtask delivery timing of `MutationRecord`s for a DOM element the caller can already observe.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes. No new properties are added to `Element` or `MutationRecord`; elements discarded by a sanitizer never connect or emit records.

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
    If a document is disconnected or its parser aborts while an observed target is still parsing, parsing ends (as at EOF/abort) and standard `MutationObserver` lifecycle rules apply; calling `observer.disconnect()` discards any buffered records.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Passing `delivery: "parse-end"` with `childList: false` (or passing an invalid `MutationObserverDelivery` enum value) throws a `TypeError`, matching existing `MutationObserver.prototype.observe()` option validation.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.

</details>
