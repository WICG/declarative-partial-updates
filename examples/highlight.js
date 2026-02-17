if (!("streamAppendHTMLUnsafe" in document.body)) {
  document.body.classList.add("unsupported");
  const unsupported = document.createElement("div");
  unsupported.id = "unsupported";
  unsupported.textContent = "This browser does not support declarative partial updates. Try Chrome Canary with experimental features.";
  document.body.appendChild(unsupported);
}
const style = document.createElement("style");
style.textContent = `
@import "https://dev.prismjs.com/themes/prism.css";

body {
font-size: 12px;
}

pre {
width: max-content;
position: absolute;
right: 0;
top: 0;
margin: 10px;
border: 1px solid black;
}

.unsupported {
  *:not(#unsupported) {
display: none}
}

#unsupported {
  color: red;
  font-weight: bold;
  font-size: 20px;
  text-align: center;
  display: block;
  margin: 20px;
}

`;
document.head.appendChild(style);
import("https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js").then(() => {
  document.querySelectorAll("script:not([src])").forEach((script) => {
    // Create the visible elements
    const pre = document.createElement("pre");
    const code = document.createElement("code");

    // Set the language (default to javascript)
    code.className = "language-javascript";

    // Clean up indentation and inject text
    code.textContent = script.textContent.trim();

    pre.appendChild(code);
    script.parentNode.insertBefore(pre, script.nextSibling);

    // Tell Prism to highlight the new element
    Prism.highlightElement(code);
  });
});