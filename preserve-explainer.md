# DOM preservation

(Initial draft)

## Overview
One of the features that was marked as a "future enhancement" was content preservation - preventing a partial update from overwriting existing content.
The use case for this is, e.g., being able to replace a whole range of DOM without reloading some of the iframes or videos inside of it.

A model that was proposed for this was a `preserve` attribute. 
If an element has a `preserve` attribute, and the new content contains an element with that same `preserve`, the element should be preserved rather than be overwritten, and only its attributes would be set.

## Example

```html
<main>
<?start name=page?>
Some text
<iframe src="chat.html" preserve="chat"></iframe>
</main>

<!-- after navigation... ->
<template for=page>
Some other text
<iframe src="chat.html" preserve="chat"></iframe>
</template>
```

In the above example, after the navigation, the text would read "Some other text" but the chat widget wouldn't reload, because the `preserve` attribute would make the patch skip it.

## Islands vs. morphing

The example above uses the `preserve` attribute as an ID of sorts, and the model is binary - either replace the contents or keep it the same.
This is similar to the "islands of interactivity" architecture common in some frameworks today, rather than a merge/morph/virtual-DOM architecture.

An alternative would be to reuse ID, and to have the `preserve` keyword be a boolelan/enum - a way to decide if the element is entirely skipped or if its contents/attributes get replaced by the new content.
This would allow extending this concept to being a lightweight "morph" in the future.

The advantage of going with a more island-ish architecture is that it keeps the simple and effective "overwrite by default" architecture of MPAs and creates exceptions to it, rather than tries to become a full SPA merging mechanism.

## Prior art

* [`hx-preserve` in HTMX](https://htmx.org/attributes/hx-preserve/): preserves element identity using the ID attribute as a key
* [Islands architecture in Astro](https://docs.astro.build/en/concepts/islands/): poking "holes" in the otherwise static replacement rather than a whole DOM diff
* [React Virtual DOM](https://legacy.reactjs.org/docs/faq-internals.html)
