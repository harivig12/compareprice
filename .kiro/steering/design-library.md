---
inclusion: fileMatch
fileMatchPattern: "**/*.{html,htm,css,scss,dart,jsx,tsx,vue,svelte}"
---

# Shared design library: check it before UI work

A shared reference library lives at:

`c:\Users\vpu2\Downloads\prototype\design-library\`

(Git: its own private repo, <https://github.com/harivig12/design-library>. If the folder above doesn't exist on this machine, clone it there. Gallery: open `index.html` in a browser. Start with `guides/README.md`.)

Before designing or changing any screen, page, component, theme or flow in this project, look at the relevant part of the library first and say which references you used. Use it for inspiration and proven patterns, not as a source to copy wholesale.

## Where to look

| You are building | Read first |
|---|---|
| Any UI at all | `guides/README.md` (principles, checklist), `tokens/tokens.css` |
| Landing page / marketing site | `guides/landing-pages.md`, `patterns/drag-compare-hero.html`, `patterns/device-frames.html`, `patterns/download-trust-faq.html` |
| Dashboard / admin / data view | `guides/dashboards.md`, `patterns/calendar-strip-agenda.html` |
| Mobile app screen or flow | `guides/mobile-app-flows.md` (onboarding, sign-in, home, forms, checkout, lists/search, settings, empty/error/loading, notifications) |
| How-to / help / onboarding guide | `guides/landing-pages.md` (guide section), `patterns/guide-switch-and-steps.html`, `patterns/sticky-scroll-story.html` |
| Motion and micro-interactions | `guides/motion.md`, `patterns/motion-kit.html` |
| Cards / fintech visuals | `patterns/card-art-fan-marquee.html` |

Real-world examples with snapshots and notes are in `references/` (Colorlib templates, Eleken and Tabnav website picks, Behance and Dribbble UI/UX projects). Search `references/catalog.md` by type (SaaS, fintech, AI, portfolio, e-commerce, dashboard, mobile) to find two or three to look at.

## Rules carried by the library

- Colour is never the only signal: pair status colours with a word, glyph or label.
- Follow the device theme unless the user picks one; support light and dark.
- Respect `prefers-reduced-motion`; one easing curve (`cubic-bezier(.16,1,.3,1)`).
- Keyboard and screen-reader access on every interactive element.
- Show a mockup with options before building anything visual (see the working agreement).
- Third-party snapshots are private reference material. Don't copy their images, logos or text into shipped work.

## Keeping it useful

When a project produces a mockup or pattern worth reusing, add it to the library (see `design-library/README.md`, "Adding to the library").
