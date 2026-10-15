# Changelog

EditStatic is in beta. Versions below 1.0 can change how things work between releases.

## 0.2.0 (2026-10-15)

- Formatting bar on a text selection: Bold, Italic, Link, Unlink (Ctrl/Cmd+B, I, K).
  `example.com` becomes `https://example.com`; links to other sites get
  `target="_blank" rel="noopener"`.
- Unsaved edits keep their own colours and get a bright green outline, instead of
  turning red (red text vanished on red brand colours).
- The Preview toggle is now called **Original**: it shows the page before your
  unsaved changes.
- Opt-in structure editing with `<meta name="editstatic-features" content="paragraphs lists remove-empty">`:
  Enter starts a new paragraph or list item, a List button, and emptied blocks
  flagged for removal. Off by default, because the site's sync has to support them.

## 0.1.0

- First release.
