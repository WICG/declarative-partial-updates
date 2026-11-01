# Explainer: Observing `<template for>` Lifecycle with `MutationObserver` (`template`)

## Introduction

When the HTML parser processes a `<template for="...">` patch (either inline via [Interleaved HTML Streaming](./patching-explainer.md) or fetched via [`<template for="..." src="...">`](./fragment-include-explainer.md)), it consumes the `<template>` element itself and streams its contents directly into the targeted range (`<?start name="...">...<?end>` or `<?marker name="...">`) without inserting the `<template>` into the DOM.

Standard `MutationObserver` records show the resulting `addedNodes` and `removedNodes` on the target container, but lose the `<template>` wrapper's lifecycle and metadata:
- **Attribution & correlation:** Separating parser-driven patch mutations from unrelated client-side DOM mutations, and reading server metadata attributes off the `<template>` (such as `for`, `src`, `data-turn`, or request IDs) across network chunks.
- **Flow control:** Knowing when a streamed patch begins clearing fallback content (`"start"`), streams incremental updates (`"update"`), and finishes (`"end"`).
- **Error recovery:** Detecting when a patch aborts (`"abort"`)—because the target marker was missing, the network stream truncated at EOF before `</template>`, or a `<template for src>` fetch failed CORS, CSP, `text/fragment` MIME, or `integrity` checks—even when zero DOM nodes were inserted.

This explainer proposes an opt-in `template: true` option on `MutationObserverInit` that attaches `templateStatus` and `templateAttributes` to the `MutationRecord`s produced by parser-consumed `<template for>` operations.

*(For batching `MutationObserver` records until an element finishes parsing, see the companion explainer: [parse-end-mutation-observer-explainer.md](./parse-end-mutation-observer-explainer.md).)*

---

## Prior Discussions

- [whatwg/html#13008](https://github.com/whatwg/html/issues/13008), [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110), [#104](https://github.com/WICG/declarative-partial-updates/issues/104), [#103](https://github.com/WICG/declarative-partial-updates/issues/103), [#21](https://github.com/WICG/declarative-partial-updates/issues/21), & [#26](https://github.com/WICG/declarative-partial-updates/pull/26): reflection, lifecycle, and failure semantics of `<template for>`
- [whatwg/html#11818](https://github.com/whatwg/html/pull/11818) & [#13075](https://github.com/whatwg/html/issues/13075): `<template for>` parser specification
- [whatwg/html#12744](https://github.com/whatwg/html/issues/12744): parser `Text` node data modification and `MutationObserver` batching
- [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) & [#1439](https://github.com/whatwg/dom/issues/1439): observing Declarative Shadow DOM attachment (see [Considered Extensions](#considered-extensions-not-currently-proposed))

---

## Use Cases & Problem Statement

In streaming UIs that update one or more regions via `<template for>` or `<template for src>`, client code often needs to coordinate around patch boundaries without moving DOM rendering into JavaScript:

1. **Form-state & focus preservation ([#103](https://github.com/WICG/declarative-partial-updates/issues/103)):** Inspecting `removedNodes` on `"start"` and `addedNodes` during `"update"` / `"end"` to preserve focus, selection, or unsaved input state across declarative partial updates.
2. **Metadata-driven routing & analytics ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** Reading custom attributes placed on the `<template>` by the server (e.g., `<template for="chat" data-turn="3" data-request-id="abc">`) and correlating all multi-chunk DOM mutations belonging to that single `<template>` invocation.
3. **Failure & truncation handling ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)):** Surfacing retry UI or logging errors when a streamed `<template for>` response drops mid-stream before `</template>`, when a target marker is missing or moved mid-stream, or when an external `<template for src="...">` fetch fails.

Without native reflection on `MutationRecord`, authors must embed sentinel DOM elements or inline `<script>` tags inside every patch payload—adding wire overhead, requiring `unsafe-inline` or CSP nonces (impossible inside default-sanitized `<template for src>` fragments), and still failing to fire when a network stream truncates mid-patch or fails before parsing begins.

### Goals

- Expose `<template for>` lifecycle (`"start" | "update" | "end" | "abort"`) and attributes (`TemplateAttributeMap`) directly alongside `addedNodes` and `removedNodes` on `MutationRecord` ([WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110)).
- Keep records from a parser-consumed `<template for>` distinguishable from unrelated mutations, with **zero cost when `template: true` is unused**.
- Keep `MutationRecord` flat and preserve `MutationRecord.type` (`"attributes" | "characterData" | "childList"`).

### Non-Goals

- **Leaking live parser-internal `HTMLTemplateElement` nodes:** Attributes are exposed via a read-only map rather than retaining a detached `<template>` element.
- **Batching element children until end tags:** Handled separately by [`parseEnd: true`](./parse-end-mutation-observer-explainer.md).

---

## Proposed Approach

Passing `template: true` in `MutationObserverInit` populates two nullable fields on `MutationRecord`s generated by a `<template for>` operation (and `null` on all other records):

- **`record.templateStatus`:** `"start" | "update" | "end" | "abort"`, or `null`.
- **`record.templateAttributes`:** `TemplateAttributeMap?` (a read-only `Map`-like snapshot of the `<template>` element's attributes), or `null`. All records emitted by the same `<template>` invocation share the **same `TemplateAttributeMap` object identity** (`r1.templateAttributes === r2.templateAttributes`).

### Example Usage

```js
const observer = new MutationObserver((records) => {
  for (const r of records) {
    const attrs = r.templateAttributes;
    if (!attrs) continue;

    const targetName = attrs.get("for");
    const turn = attrs.get("data-turn");

    switch (r.templateStatus) {
      case "start":
        onPatchStart(r.target, targetName, turn, r.removedNodes);
        break;
      case "update":
        if (r.type === "childList") onPatchNodes(r.addedNodes, turn);
        break;
      case "end":
        onPatchEnd(r.target, targetName, turn);
        break;
      case "abort":
        onPatchAbort(r.target, targetName, attrs.get("src"));
        break;
    }
  }
});

observer.observe(document, {
  subtree: true,
  childList: true,
  characterData: true,
  template: true,
});
```

### Web IDL

```webidl
partial dictionary MutationObserverInit {
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
};
```

---

## Detailed Design

### Lifecycle Phases (`templateStatus`)

| Phase | When emitted | `record.target` & payload |
|---|---|---|
| **`"start"`** | When a `<template for>` resolves its target and begins applying (for `<template for src>`, once response headers pass validation and streaming begins). | `childList` record on the patch target parent: removes `<?start>` and fallback nodes, or has empty `addedNodes`/`removedNodes` with `nextSibling: <?marker>`. |
| **`"update"`** | As nodes and text stream into the patch target across one or more chunks. | Standard `childList` and parser-flushed `characterData` records ([whatwg/html#12744](https://github.com/whatwg/html/issues/12744)) inside the target subtree. |
| **`"end"`** | When the matching `</template>` (or end of a complete `<template for src>` stream) is reached. | `childList` record on the patch target parent removing `<?end>` or `<?marker>`. |
| **`"abort"`** | When a patch fails or terminates abnormally: EOF or stream abort before `</template>` ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)), marker moved/removed mid-stream ([whatwg/html#11818](https://github.com/whatwg/html/pull/11818)), missing target marker, or `<template for src>` fetch/CORS/CSP/`text/fragment`/`integrity` failure. | `childList` record on the patch target parent (or on the fallback `<template>` insertion parent if target resolution failed). |

- **Correlation identity ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** Every `"start"`, `"update"`, `"end"`, and `"abort"` record from a single `<template>` invocation shares the exact same `TemplateAttributeMap` instance (`r1.templateAttributes === r2.templateAttributes`), making `WeakMap` per-patch state trivial.
- **Empty patches (`<template for="r"></template>`):** Still emit both `"start"` and `"end"` records.
- **Option validation:** Passing `template: true` with `childList: false` throws a `TypeError`.
- **Sanitization & CSP nonces:** `templateAttributes` only exposes attributes that survived any active sanitizer ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)), and `nonce` attributes follow standard nonce-hiding rules ([WICG/declarative-partial-updates#111](https://github.com/WICG/declarative-partial-updates/issues/111)).

### Walkthrough A: `<template for>` across two network chunks

Given `<section><?start name="r">Loading…<?end></section>`, when `main.streamAppendHTML(...)` receives chunk 1 (`<template for="r" data-turn="3"><p>H`) and chunk 2 (`i<span>!</span></p></template>`) under `{ childList: true, characterData: true, subtree: true, template: true }`:

| # | Chunk | `type` | `target` | `removedNodes` | `addedNodes` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|
| 1 | 1 | `childList` | `<section>` | `[<?start>, "Loading…"]` | `[]` | `[for="r", data-turn="3"]` | `"start"` |
| 2 | 1 | `childList` | `<section>` | `[]` | `[<p>]` | `[for="r", data-turn="3"]` | `"update"` |
| 3 | 1 | `childList` | `<p>` | `[]` | `["H"]` | `[for="r", data-turn="3"]` | `"update"` |
| 4 | 2 | `characterData` | `"Hi"` | `[]` | `[]` | `[for="r", data-turn="3"]` | `"update"` |
| 5 | 2 | `childList` | `<p>` | `[]` | `[<span>]` | `[for="r", data-turn="3"]` | `"update"` |
| 6 | 2 | `childList` | `<span>` | `[]` | `["!"]` | `[for="r", data-turn="3"]` | `"update"` |
| 7 | 2 | `childList` | `<section>` | `[<?end>]` | `[]` | `[for="r", data-turn="3"]` | `"end"` |

### Walkthrough B: Single-point marker (`<?marker>`) when `addedNodes` and `removedNodes` are empty at `"start"`

When `<template for="r" data-turn="3"><p>Hi</p></template>` targets `<section><?marker name="r"></section>` in a single chunk, `<?marker>` stays in place as the insertion anchor until `</template>` removes it:

| # | `type` | `target` | `removedNodes` | `addedNodes` | `nextSibling` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|
| 1 | `childList` | `<section>` | `[]` | `[]` | `<?marker>` | `[for="r", data-turn="3"]` | `"start"` |
| 2 | `childList` | `<section>` | `[]` | `[<p>]` | `<?marker>` | `[for="r", data-turn="3"]` | `"update"` |
| 3 | `childList` | `<p>` | `[]` | `["Hi"]` | `null` | `[for="r", data-turn="3"]` | `"update"` |
| 4 | `childList` | `<section>` | `[<?marker>]` | `[]` | `null` | `[for="r", data-turn="3"]` | `"end"` |

*(Observers without `template: true` never receive record #1 or any record where `addedNodes` and `removedNodes` are both empty.)*

---

## Considered Extensions (Not Currently Proposed)

### 1. Observing Declarative Shadow DOM (`<template shadowrootmode="open">`)

Document-wide observers such as custom element autoloaders and accessibility checkers currently monkey-patch `Element.prototype.attachShadow()`, which misses parser-attached `<template shadowrootmode="open">` roots ([whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287), [#1439](https://github.com/whatwg/dom/issues/1439)). A natural extension under consideration—not part of the initial proposal—is allowing `template: true` to also emit `"start"` / `"end"` / `"abort"` records on the shadow host for `<template shadowrootmode="open">` (never `"closed"`), or addressing shadow root discovery via a dedicated non-parser-specific hook that covers both `attachShadow()` and Declarative Shadow DOM.

### 2. Fragment Parsing Context (`record.parserContextElement`)

For nested mutations inside `element.streamHTML*()`, `setHTML()`, or `innerHTML`, `record.target` is the immediate parent node rather than the root fragment context element. Exposing `readonly attribute Element? parserContextElement` on `MutationRecord` was explored alongside `template: true`, and remains a potential future addition if use cases aren't already covered by `templateAttributes` and scoping observers to the target container.

---

## Alternatives Considered

1. **New `MutationRecord.type` values (`"templateStart"`, `"templateEnd"`, `"templateAbort"`):** Separated `<template>` metadata from the `childList` records carrying `addedNodes` and `removedNodes`, forcing stateful tracking across records in every callback.
2. **Exposing the detached `HTMLTemplateElement` (`record.template`):** Retains a live parser-internal element whose `.content` was bypassed; a read-only `TemplateAttributeMap` (`templateAttributes`) exposes its attributes without leaking the node.
3. **DOM Events (`templatestart`, `templateend`, `templateabort`) or a separate `PatchObserver`:** Hydration, form-state preservation ([#103](https://github.com/WICG/declarative-partial-updates/issues/103)), and progressive enhancement need the exact `removedNodes` and `addedNodes` together with `<template>` metadata in the same microtask queue, without repeating legacy `MutationEvent` dispatch overhead.
4. **Combining `template` and `parseEnd` into a single `parser: true` option:** `<template for>` observers want incremental per-chunk `"start"` / `"update"` / `"end"` records, whereas [`parseEnd: true`](./parse-end-mutation-observer-explainer.md) batches records across chunks while an observed target is parsing. Keeping them separate avoids coupling distinct mechanisms.

---

## Frequently Asked Questions (Q&A)

### Q1: Why use a read-only map (`TemplateAttributeMap`) for `templateAttributes`?
`TemplateAttributeMap` (`readonly maplike<DOMString, DOMString>`) provides ergonomic lookup by attribute name (`r.templateAttributes.get("for")`) and preserves object identity across all records emitted by the same `<template>` invocation (`r1.templateAttributes === r2.templateAttributes`) without relying on legacy `NamedNodeMap` / `Attr` objects or retaining a detached `HTMLTemplateElement`.

### Q2: How do `template: true` and `parseEnd: true` interact if an observer sets both?
They compose cleanly: `template: true` populates `templateStatus` and `templateAttributes` on the queued records, while `parseEnd: true` holds delivery of those records for that observer until its observed target finishes parsing. Most streaming patch routers only set `template: true` so they receive `"start"` and `"update"` records incrementally per chunk.

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. All state surfaced by `template: true` originates from `<template for>` markup parsed into a DOM subtree the caller can already observe (for external `<template for src>` includes, only after standard CORS, CSP `fragment-src`/`script-src`, and `text/fragment` checks; failed fetches report `templateStatus: "abort"` without exposing cross-origin response bodies or failure details).

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes:
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
    No. `MutationObserver` callbacks run at the standard microtask checkpoint.

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
    Disconnecting the target document or container during an active `<template for>` / `<template for src>` halts the patch and surfaces `templateStatus: "abort"` per standard `MutationObserver` lifecycle rules.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Parser-aborted or fetch-aborted `<template for>` operations are reported via `templateStatus: "abort"` rather than exceptions; passing `template: true` with `childList: false` throws a `TypeError`.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.
