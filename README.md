# html-share

Share HTML documents via GitHub Pages.

## How to share a document

1. Drop an `.html` file into the [`documents/`](documents/) folder.
2. Commit and push to `main`.
3. A GitHub Action regenerates the home page index and deploys the site.

The file becomes reachable at:

```
https://<user>.github.io/<repo>/documents/<filename>.html
```

and is automatically linked from the home page.

## Structure

| Path | Purpose |
| --- | --- |
| `index.html` | Home page; links to every document (auto-generated section between the `DOCS_LIST_*` markers) |
| `documents/` | Drop your `.html` files here |
| `scripts/build-index.mjs` | Builds the document list during deploy |
| `.github/workflows/deploy.yml` | Builds the index and deploys to GitHub Pages |

The listing is regenerated on every push — no manual editing of `index.html` needed.
