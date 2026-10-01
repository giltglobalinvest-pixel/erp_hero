# vendor/

Third-party files that the browser app loads from this repository instead of from a CDN.

## DOMPurify 3.4.16

`purify.min.js` is the minified browser build of [DOMPurify](https://github.com/cure53/DOMPurify), the HTML
sanitizer by Cure53. `index.html` uses it to clean rich text before it reaches the page or an editor: stored
record texts (document descriptions and notes, item texts, templates, bundles) and the text fields of AI answers.
The helpers are `sanitizeRichHtml` and `richTextToHtml` in `index.html`.

Why it is vendored:

- The server serves it from the app's own origin (`GET /vendor/purify.min.js`, `server/http/static.ts`), so the
  app does not depend on a CDN for a security function, and `sw.js` caches it for offline use like the app shell.
- The script tag pins the exact bytes with Subresource Integrity. If the file is missing, blocked or changed, the
  app fails closed: it shows an error on the login screen and does not log in.
- It is not an npm dependency. Only the browser loads it; the server stores rich text as it is and never runs it.

Nothing else in this folder is served: the licence files and this README stay in the repository only. The file
ends with a `//# sourceMappingURL=purify.min.js.map` comment from the upstream build; the map is not vendored, so
browser developer tools just show the minified code.

| | |
|---|---|
| Version | 3.4.16 |
| Source | `https://registry.npmjs.org/dompurify/-/dompurify-3.4.16.tgz`, file `package/dist/purify.min.js`, copied byte for byte |
| Tarball integrity | `sha512-sqo+pNp3qRhCIpbgRi1y8Tgk27Bo2Ry7w0dC1NBeNTdZChWjz9Xb/KOoZbRP/R6pQZ80Qw8YhXw13hWWBbMRnQ==` |
| File integrity (`purify.min.js`) | `sha384-a7SzOxErzJ3ZpQz0zJ32d67dSitNzPcbfybc/ykU9KJhMgZkwqfSxlhhdJRS+XGL` |
| Licence | Dual-licensed, Apache-2.0 or MPL-2.0: `dompurify.LICENSE` (the package's `LICENSE`, Apache-2.0) and `dompurify.LICENSE-MPL` |

`test/frontend/vendor.test.ts` checks that the file's sha384 equals the `integrity` attribute of its script tag and
the value in this README, that the file's header names the version, and that the tag is the first script after the
GitHub Pages guard.

### Updating

1. Download the new tarball from the registry: `https://registry.npmjs.org/dompurify/-/dompurify-<version>.tgz`.
2. Compare its sha512 with the registry's `dist.integrity` for that version
   (`https://registry.npmjs.org/dompurify/<version>`). Stop if they differ.
3. Copy `package/dist/purify.min.js` to `vendor/purify.min.js`, and `package/LICENSE` and `package/LICENSE-MPL` to
   `vendor/dompurify.LICENSE` and `vendor/dompurify.LICENSE-MPL`, unchanged.
4. Update the `integrity` attribute of the `vendor/purify.min.js` script tag in `index.html`
   (`sha384-` + the base64 SHA-384 of the file) and the pinned values: the table above and the version in
   `test/frontend/vendor.test.ts`.
5. Run all four gates: `npm test`, `npm run test:e2e`, `npm run typecheck` and `npm run lint`. The browser tests
   in `test/e2e/rich-text.e2e.ts` check that legitimate editor content stays byte-identical.
