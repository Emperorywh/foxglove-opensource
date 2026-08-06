# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Foxglove Studio — an open-source (MPL-2.0, open core) robotics visualization and diagnosis tool. This repo contains the web app; the desktop app and some features (Foxglove Data Platform integration, multiple layouts) live in closed-source repos. Yarn 3 workspaces monorepo (via corepack), TypeScript, React 18, MUI v5, webpack 5.

## Setup & commands

Prereqs: Node.js v16.10+, Git LFS. Setup: `git lfs pull`, `corepack enable`, `yarn install`.

```sh
yarn web:serve          # dev server (webpack-dev-server)
yarn web:build:prod     # production web build
yarn build:packages     # type-check & build all packages (tsc --build project references)
yarn storybook          # Storybook on :9009
yarn lint               # eslint --fix (uses .eslintrc.yaml; CI uses .eslintrc.ci.yaml which adds prettier)
yarn test               # jest across all projects
yarn test path/to/file.test.ts          # single test file
yarn test -t "test name"                # single test by name
yarn test:web-integration               # integration tests against a build
yarn test:web-integration:local         # integration tests against localhost:8080
```

Jest uses babel-jest (not ts-jest), so type errors won't fail tests — run `yarn build:packages` to type-check. Jest projects live in `ci/` and `packages/*/` (root `jest.config.json` aggregates them).

## Monorepo layout

- `packages/studio-base` (`@foxglove/studio-base`) — the core application; nearly all development happens here: React components, panels, players, state, i18n.
- `packages/studio-web` (`@foxglove/studio-web`) — web entry point (`main()` in `src/index.tsx`), web-specific services.
- `packages/studio` (`@foxglove/studio`) — public **extension API** type definitions (published for extension authors). Changing it is a public API change.
- `web/` — internal webpack bundling for the web app + integration tests. `benchmark/` — perf benchmarking app.
- Support packages: `@foxglove/log` (logging), `@foxglove/hooks` (React hooks), `@foxglove/den` (incubating utilities: async, math, image, urdf), `@foxglove/theme` (MUI theme), `@foxglove/mcap-support` (MCAP schema/message parsing), `@foxglove/message-path` (message path syntax like `/topic.field[0]`), `@foxglove/comlink-transfer-handlers`, `@foxglove/typescript-transformers`, `@foxglove/eslint-plugin-studio` (custom lint rules).

## Architecture

**Startup flow:** `web/src/entrypoint.tsx` → `packages/studio-web/src/index.tsx` `main()` → `WebRoot` → `StudioApp` (studio-base). `StudioApp` stacks context providers via `MultiProvider` (Problems → Toast → Logs → TimelineInteractionState → CurrentLayout → PlayerManager → Events → PanelCatalog) and renders `Workspace`, a react-mosaic layout of panels.

**Data flow (the central concept):**

1. A **data source factory** (`studio-base/src/dataSources/`, `IDataSourceFactory`) builds a **Player** from a user action (open file, connect to ws://, etc.). Factories exist for MCAP, ROS1/ROS2 bags, ULog, Rosbridge, Foxglove WebSocket, remote files.
2. A **Player** (`studio-base/src/players/types.ts`) owns playback state: subscriptions, current time, available topics/datatypes. It pushes `PlayerState` to a single listener (throttled by the listener's returned promise). Implementations: `IterablePlayer` (file-based; iterates an `IIterableSource`, often in a web worker via `WorkerIterableSource`), `RosbridgePlayer`, `FoxgloveWebSocketPlayer`, and wrappers like `TopicAliasingPlayer`.
3. **MessagePipeline** (`studio-base/src/components/MessagePipeline/`) is the bridge to React: a zustand store holding the latest `PlayerState` and frames. Panels read it via `useMessagePipeline` selectors; subscriptions flow back to the player through it. Use `MockMessagePipelineProvider` in tests/stories.
4. **Panels** (`studio-base/src/panels/` — Plot, ThreeDeeRender, Image, RawMessages, Map, etc.) are the visualizations. Each is registered in `panels/index.ts`, wrapped by the generic `components/Panel.tsx` (toolbar, error boundary); extension panels render through `PanelExtensionAdapter`. High-frequency rendering (3D, plot) bypasses React where needed.

**State:** React context (`context/` interfaces + `providers/` implementations) for app-level state; zustand stores for high-frequency data (MessagePipeline, layout). Layouts use react-mosaic; `CurrentLayoutContext` holds the panel arrangement. Heavy parsing (bag/MCAP reading) runs in web workers via comlink.

**Styling:** MUI v5 + `tss-react` (`makeStyles`). The `sx` prop, MUI `styled`, `Box`, and `@emotion/styled` are banned by lint for performance.

**i18n:** react-i18next. All user-facing strings go in `packages/studio-base/src/i18n/en/<namespace>.ts` and are accessed via `useTranslation(namespace)` + `t("camelCaseKey")`. English translations are required in every PR; non-English (zh, ja) are optional — delete stale non-English keys when changing English text. See CONTRIBUTING.md#localization.

## Enforced conventions (lint will fail otherwise)

- Every file needs the MPL license header (rule `@foxglove/license-header`):
  ```ts
  // This Source Code Form is subject to the terms of the Mozilla Public
  // License, v2.0. If a copy of the MPL was not distributed with this
  // file, You can obtain one at http://mozilla.org/MPL/2.0/
  ```
- No `null` — use `undefined` (`ReactNull` alias when React requires null).
- No property getters/setters — use functions. Use `#private` fields, not TS `private` (`@foxglove/prefer-hash-private`).
- No `Promise.race` — use `race` from `@foxglove/den/async`.
- lodash: import from `lodash-es` as namespace `_`; ramda: namespace `R` only, and built-ins (`Math.*`, `Object.*`, `Array#map` etc.) must be used instead of ramda equivalents. No `Map` type arguments from lodash/ramda (`no-map-type-argument`).
- `setTimeout`/`setInterval` require an explicit delay argument. `console` calls restricted to `warn`/`error`/`debug`/`assert`.
- No `fixme`/`todo`/`xxx` comments anywhere.
- Unused variables must be prefixed `_` (but a lone `_` is not ignored).
- Test assertions: `jest/expect-expect` recognizes `expect*` and `sendNotification.expectCalledDuringTest`.
