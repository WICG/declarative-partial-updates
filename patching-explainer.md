# Interleaved HTML streaming (patching)

## Motivation
Streaming of HTML existed from the early days of the web, serving an important purpose for perceived performance when loading long articles etc.
However, it always had the following major constraints:
1. HTML content is streamed in DOM order.
2. After the initial parsing of the document, streaming is no longer enabled.

Use cases like updating an article without refreshing the page, or for streaming the contents of a scrollable container after it is loaded,
are accomplished today by custom JS that uses the DOM APIs, or by JS frameworks that abstract these away.

For example, React streams content out of order by injecting inline `<script>` tags that modify the already parsed DOM.

This proposal introduces partial out-of-order HTML streaming as part of the web platform.

## Declarative patching

Patches are delivered using a `<template>` element with the `contentmethod` attribute and target an existing elements in the DOM with the `contentname` attributes. These patches require no scripts to apply (are declarative) and can appear in the main response HTML to support out-of-order streaming.

Patches can be be applied later in the page lifecycle using JavaScript, see [script-initiated patching](#script-initiated-patching).

### Proposed markup

The `contentname` attribute is used to identify an element which can be patched:

```html
<section contentname=gallery>Loading...</section>
```

The content is then patches using a `<template>` element:

```html
<template contentmethod="replace-children">
  <section contentname=gallery>Actual gallery content<section>
</template>
```

The element name (`section`) needs to be repeated so that children are parsed correctly, but only the child nodes are actually replaced in this example.

There are two proposed `contentmethod` values:

- `append` inserts nodes at the end of the element, similar to `element.append(nodes)`.
- `replace-children` replaces any existing child nodes, similar to `element.replaceChildren(nodes)`.

At a low level, the only difference is that is `replace-children` removes existing nodes and then appends new nodes, while `append` only appends new nodes.

A few details about interleaved patching:
- Templates with a valid `contentmethod` are not attached to the DOM.
- If the patching element is not a direct child of `<body>`, the outlet has to have a common ancestor with the patching element's parent.
- The patch template has to be in the same tree (shadow) scope as the outlet.

See the https://github.com/whatwg/html/pull/11818 for the full processing model and details.

### Interleaved patching

An element can be patched multiple times and patches for different elements can be interleaved. This allows for updates to different parts of the document to be interleaved. For example:

```html
<div contentname=product-carousel>Loading...</div>
<div contentname=search-results>Loading...</div>
```

In this example, the search results populate in three steps while the product carousel populates in one step in between:

```html
<template contentmethod=replace-children>
  <div contentname=search-results>
    <p>first result</p>
  </div>
</template>

<template contentmethod=replace-children>
  <div contentname=product-carousel>Actual carousel content</div>
</template>

<template contentmethod=append>
  <div contentname=search-results>
    <p>second result</p>
  </div>
</template>

<template contentmethod=append>
  <div contentname=search-results>
    <p>third result</p>
  </div>
</template>
```

#### Alternatives considered

A few variations to support interleaved patching have been considered:

##### Automatic defaults

To remove children the first time an element is targeted, and to append if it is targeted again within the same parser invocation. In this alternative, the opt-in to patching would be a boolean attribute like `contentupdate` on `<template>`, and `contentmethod` is only used to override the default.

<details>
<summary>The patches use `contentupdate` instead of `contentmethod`:</summary>

```html
<template contentupdate>
  <div contentname=search-results>
  </div>
</template>

<template contentupdate>
  <div contentname=product-carousel>Actual carousel content</div>
</template>

<template contentupdate>
  <div contentname=search-results>
    <p>second result</p>
  </div>
</template>

<template contentupdate>
  <div contentname=search-results>
    <p>third result</p>
  </div>
</template>
```

</details>

(For an append-only use case, `contentmethod` would still be needed in addition to `contentupdate`.)

##### Range markers

Don't support `contentmethod=append` and instead support this use case using [markers](#streaming-to-non-element-ranges). To append, one would target two markers with no content between them originally. For multiple appends, each patch would need to insert an additional marker for the next patch to target.

<details>
<summary>The patches uses two markers to "emulate" append:</summary>

```html
<template contentmethod=replace-children>
  <div contentname=search-results>
    <p>first result</p>
    <!-- adds markers to allow for "append" -->
    <?marker name=m1?><?marker name=m2?>
  </div>
</template>

<template contentmethod=replace-children>
  <div contentname=product-carousel>Actual carousel content</div>
</template>

<template contentmethod=replace-children contentmarkerstart=m1 contentmarkerend=m2>
  <div contentname=search-results>
    <p>second result</p>
    <!-- new markers are needed for the next "append". -->
    <?marker name=m3?><?marker name=m4?>
  </div>
</template>

<template contentmethod=replace-children contentmarkerstart=m3 contentmarkerend=m4>
  <div contentname=search-results>
    <p>third result</p>
  </div>
</template>
```

</details>

##### Insertion point markers

Like above, but add support for single-marker insertion points, and `contentmethod=insert-before` to insert before such a marker. To append, one would repeatedly insert before a marker at the end of a container node.

<details>
<summary>The patches uses a single marker, prepending before it to "emulate" append:
</summary>

```html
<template contentmethod=replace-children>
  <div contentname=search-results>
    <p>first result</p>
    <?marker name=end?>
  </div>
</template>

<template contentmethod=replace-children>
  <div contentname=product-carousel>Actual carousel content</div>
</template>

<template contentmethod=insert-before contentmarker=end>
  <div contentname=search-results>
    <p>second result</p>
  </div>
</template>

<template contentmethod=insert-before contentmarker=end>
  <div contentname=search-results>
    <p>third result</p>
  </div>
</template>
```

</details>

## Script-initiated patching

`streamHTMLUnsafe()` is being pursued as a [separate proposal](https://github.com/whatwg/html/issues/2142), but will also work with patching. When `<template contentmethod>` appears in the streamed HTML, those patches can apply to descendants of element on which `streamHTMLUnsafe()` was called.

## Potential enhancement

### Avoiding overwriting with identical content

Some content might need to remain unchanged in certain conditions. For example, displaying a chat widget in all pages but the home, but not reloading it between pages.
For this, both the outlet and the patch can have a `contentrevision` attribute. If those match, the content is not applied.

### Streaming to non-element ranges

See discussion in https://github.com/WICG/declarative-partial-updates/issues/6 and https://github.com/WICG/webcomponents/issues/1116.

It has been a common request to stream not just by replacing the whole contents of an element or appending to it, but also by replacing an arbitrary range.
This is connected with other use cases for addressing arbitrary ranges in the page.
Use cases for this can be replcing some `<meta>` tags in the `<head>`, replacing multiple rows in a table, or replacing an element similar to the `replaceWith` method.

To achieve these use cases, the direction is to use addressable comments as per https://github.com/WICG/webcomponents/issues/1116, and use two comments as a "range", equivalent to an element with a `contentname` attribute.

Very initial example:

```html
<table>
  <tbody contentname=data>
    <tr><td>static data</td></tr>
    <tr><td>static data</td></tr>

    <?marker name=dyn-start?>
    <tr><td>dynamic data 1</td></tr>
    <tr><td>dynamic data 2</td></tr>
    <?marker name=dyn-end?>
  </tbody>
</table>

<!-- stuff.... -->

<!-- This would replace the children only between the dyn-start and dyn-end markers, leaving the static data alone. -->
<template contentmethod="replace-children" contentmarkerstart="dyn-start" contentmarkerend="dyn-end">
  <tbody contentname=data>    
    <tr><td>dynamic data 3
    <tr><td>dynamic data 4
    <tr><td>dynamic data 5
  </tbody>
</template>
</body>
```

### Patch contents from URL

In addition to patching from a stream or interleaved in HTML, there are use-cases for patching by fetching a URL.
This can be done with a `patchsrc` attribute.

Enabling remote fetching of patch content would act as a script in terms of CSP, with a CORS-only request, and would be sanitized with the same HTML/trusted-types restrictions as patching using script.

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1.  What information does this feature expose,
     and for what purposes?

It does not expose new information.

2.  Do features in your specification expose the minimum amount of information
     necessary to implement the intended functionality?

N/A

03.  Do the features in your specification expose personal information,
     personally-identifiable information (PII), or information derived from
     either?

No

3.  How do the features in your specification deal with sensitive information?

N/A
4.  Does data exposed by your specification carry related but distinct
     information that may not be obvious to users?

No

7.  Do the features in your specification introduce state
     that persists across browsing sessions?

No

9.  Do the features in your specification expose information about the
     underlying platform to origins?

No

11.  Does this specification allow an origin to send data to the underlying
     platform?

No

13.  Do features in this specification enable access to device sensors?

No

14.  Do features in this specification enable new script execution/loading
     mechanisms?

Yes to some extent.
Because this is a new API surface for importing HTML, this imported HTML can have
various ways to execute scripts. This is mitigated by making sure that the new API is implemented in a way that supports the sanitizer, and a new trusted-types enabler will be added for custom sanitation.
In addition, the rules of parsing this HTML are similar to the existing `setHTML` and `setHTMLUnsafe` methods, which already includes various ways of protecting against script execution, e.g. not executing a
script element that was already executed. Some of these details are discussed in https://github.com/WICG/declarative-partial-updates/issues/40.

16.  Do features in this specification allow an origin to access other devices?

No.

17.  Do features in this specification allow an origin some measure of control over
     a user agent's native UI?

No.

19.  What temporary identifiers do the features in this specification create or
     expose to the web?

N/A

20.  How does this specification distinguish between behavior in first-party and
     third-party contexts?

This would be relevant for `patchsrc`, but is out of scope for the current questionnaire.

21.  How do the features in this specification work in the context of a browser’s
     Private Browsing or Incognito mode?

N/A

22.  Does this specification have both "Security Considerations" and "Privacy
     Considerations" sections?

It is intended to be part of the HTML standard, so yes.

23.  Do features in your specification enable origins to downgrade default
     security protections?

No

24.  What happens when a document that uses your feature is kept alive in BFCache
     (instead of getting destroyed) after navigation, and potentially gets reused
     on future navigations back to the document?

Nothing in particular.

25.  What happens when a document that uses your feature gets disconnected?

Being connected/disconnected doesn't affect this feature atm.

26.  Does your spec define when and how new kinds of errors should be raised?

It will.

28.  Does your feature allow sites to learn about the user's use of assistive technology?

No

29.  What should this questionnaire have asked?

Does this feature allow new ways of changing the DOM/injecting HTML.
