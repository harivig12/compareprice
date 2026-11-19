# prototype

| Project | What it is | Start here |
|---|---|---|
| [`compareprice/`](compareprice/) | Grocery price comparison across Indian quick-commerce sites (Instamart, BigBasket, Zepto, Blinkit, KPN Fresh, JioMart, Flipkart Minutes). Headless-Chrome engine, price history, scheduler, web UI and MCP server. Node.js >= 22.13. | [`compareprice/README.md`](compareprice/README.md) |

## Quick start

```bash
cd compareprice
npm ci
npm test                      # offline suite
node src/cli.js --help        # CLI (command name: basket)
npm run serve                 # web UI at http://localhost:7777
```

Docker: `cd compareprice && docker compose up -d --build`.

## Docs

- [`compareprice/README.md`](compareprice/README.md): usage
- [`compareprice/AGENTS.md`](compareprice/AGENTS.md): rules for contributors and coding agents
- [`compareprice/docs/ENGINE.md`](compareprice/docs/ENGINE.md): site engine and error kinds
- [`compareprice/docs/API.md`](compareprice/docs/API.md): HTTP and SSE API
- [`compareprice/docs/OPERATIONS.md`](compareprice/docs/OPERATIONS.md): running the service
- [`compareprice/CHANGELOG.md`](compareprice/CHANGELOG.md): changes
