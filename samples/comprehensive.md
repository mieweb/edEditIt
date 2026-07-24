# edEditIt Feature Tour

A comprehensive sample exercising the Markdown features supported by the editor.

## Text formatting

Plain, **bold**, *italic*, ***bold italic***, ~~strikethrough~~, and `inline code`.

## Headings

### Level 3

#### Level 4

##### Level 5

## Lists

### Bulleted

- First item
- Second item
  - Nested item
  - Another nested item
- Third item

### Numbered

1. Step one
2. Step two
   1. Sub-step
   2. Sub-step
3. Step three

### Task list

- [x] Build the extension
- [x] Open a sample document
- [ ] Edit this task list

## Blockquotes

> Single-level quote.
>
> > Nested quote with **formatting** inside.

## Code

```typescript
interface Message {
  type: "init" | "update" | "edit" | "ready";
  text?: string;
}

function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

```json
{
  "name": "edEditIt",
  "features": ["headings", "lists", "tables", "code"],
  "wysiwyg": true
}
```

## Table

| Feature      | Status | Notes                     |
| ------------ | :----: | ------------------------- |
| Headings     |   ✅   | Levels 1–6                |
| Lists        |   ✅   | Bulleted, numbered, tasks |
| Tables       |   ✅   | With alignment            |
| Code blocks  |   ✅   | Syntax-aware              |
| Images       |   ✅   | Inline rendering          |

## Links and images

Visit the [edEditIt repository](https://github.com/mieweb/edEditIt).

![Placeholder image](https://placehold.co/400x150?text=edEditIt)

## Horizontal rule

---

## Escapes and edge cases

Literal asterisks: \*not italic\*. Ampersand: &. Emoji: 🎉

Very long line to test soft wrapping: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.

Final paragraph — the end of the tour.
