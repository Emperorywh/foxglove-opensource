// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import ReactRefreshPlugin from "@pmmmwh/react-refresh-webpack-plugin";
import { CleanWebpackPlugin } from "clean-webpack-plugin";
import CopyPlugin from "copy-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";
import path from "path";
import { Configuration, WebpackPluginInstance } from "webpack";
import type {
  ConnectHistoryApiFallbackOptions,
  Configuration as WebpackDevServerConfiguration,
} from "webpack-dev-server";

import type { WebpackArgv } from "@foxglove/studio-base/WebpackArgv";
import { makeConfig } from "@foxglove/studio-base/webpack";
import * as palette from "@foxglove/theme/src/palette";

export interface WebpackConfiguration extends Configuration {
  devServer?: WebpackDevServerConfiguration;
}

/**
 * 告警服务同源代理(仅 yarn web:serve 开发环境)。
 *
 * 机器人告警服务不支持 CORS 且不可修改(docs/SPEC_playback_alarm_lane.md §12):
 * development 构建中渲染进程把 http://{host}:{port}/rbrainrobot/... 改写为同源路径
 * /robot-alarm-proxy/{host}/{port}/rbrainrobot/...(见 fetchRobotStatus.ts),浏览器
 * 视其为同源请求、不发 OPTIONS 预检;dev server 再按路径中的 host/port 把请求转发到
 * 真实服务——转发发生在 Node 侧,不受浏览器同源策略约束。
 *
 * host/port 来自应用设置、运行时可变,因此不能用静态 target,必须由 router 动态解析。
 */
const robotAlarmProxyPattern = /^\/robot-alarm-proxy\/([^/]+)\/(\d+)(?=\/|$)/;

/** 从代理路径中解析真实目标(http://{host}:{port});路径畸形时返回 undefined */
function robotAlarmProxyTarget(url: string | undefined): string | undefined {
  const match = robotAlarmProxyPattern.exec(url ?? "");
  return match ? `http://${match[1]}:${match[2]}` : undefined;
}

export type ConfigParams = {
  /** Directory to find `entrypoint` and `tsconfig.json`. */
  contextPath: string;
  entrypoint: string;
  outputPath: string;
  publicPath?: string;
  /** Source map (`devtool`) setting to use for production builds */
  prodSourceMap: string | false;
  /** Set the app version information */
  version: string;
  /** Needs to be overridden for react-router */
  historyApiFallback?: ConnectHistoryApiFallbackOptions;
  /** Customizations to index.html */
  indexHtmlOptions?: Partial<HtmlWebpackPlugin.Options>;
};

export const devServerConfig = (params: ConfigParams): WebpackConfiguration => ({
  // Use empty entry to avoid webpack default fallback to /src
  entry: {},

  // Output path must be specified here for HtmlWebpackPlugin within render config to work
  output: {
    publicPath: params.publicPath ?? "",
    path: params.outputPath,
  },

  devServer: {
    static: {
      directory: params.outputPath,
    },
    historyApiFallback: params.historyApiFallback,
    hot: true,
    // The problem and solution are described at <https://github.com/webpack/webpack-dev-server/issues/1604>.
    // When running in dev mode two errors are logged to the dev console:
    //  "Invalid Host/Origin header"
    //  "[WDS] Disconnected!"
    // Since we are only connecting to localhost, DNS rebinding attacks are not a concern during dev
    allowedHosts: "all",
    headers: {
      // Enable cross-origin isolation: https://resourcepolicy.fyi
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "credentialless",
    },

    // 告警服务代理:见上方 robotAlarmProxyPattern 注释;生产构建与桌面端不经此代理
    proxy: {
      "/robot-alarm-proxy": {
        // target 仅为路径畸形时的兜底(连接 127.0.0.1:9 被拒,按查询失败 toast);
        // 正常请求的实际目标由 router 按路径中的 host/port 动态给出
        target: "http://127.0.0.1:9",
        changeOrigin: true,
        router: (req) => robotAlarmProxyTarget(req.url) ?? "http://127.0.0.1:9",
        pathRewrite: (reqPath) => reqPath.replace(robotAlarmProxyPattern, ""),
        // 目标不可达(ECONNREFUSED/ENOTFOUND/超时等)时,http-proxy 默认只回 500 空响应,
        // 页面上只能看到 "HTTP 500",排查不出原因。这里改写为 502 + 明文原因响应体
        // (含真实目标与错误码),前端 fetchRobotStatus 会把错误响应体拼进 toast
        onError: (err, req, res) => {
          const target = robotAlarmProxyTarget(req.url) ?? "http://127.0.0.1:9";
          const code = (err as NodeJS.ErrnoException).code;
          const message = `robot-alarm-proxy: cannot reach ${target} (${code ?? err.message})`;
          console.error(`[robot-alarm-proxy] ${message}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          }
          res.end(message);
        },
      },
    },

    client: {
      overlay: {
        runtimeErrors: (error) => {
          // Suppress overlays for importScript errors from terminated webworkers.
          //
          // When a webworker is terminated, any pending `importScript` calls are cancelled by the
          // browser. These appear in the devtools network tab as "(cancelled)" and bubble up to the
          // parent page as errors which trigger `window.onerror`.
          //
          // webpack devserver attaches to the window error handler surface unhandled errors sent to
          // the page. However this kind of error is a false-positive for a worker that is
          // terminated because we do not care that its network requests were cancelled since the
          // worker itself is gone.
          //
          // Will this hide real importScript errors during development?
          // It is possible that a worker encounters this error during normal operation (if
          // importing a script does fail for a legitimate reason). In that case we expect the
          // worker logic that depended on the script to fail execution and trigger other kinds of
          // errors. The developer can still see the importScripts error in devtools console.
          if (
            error.message.startsWith(
              `Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope'`,
            )
          ) {
            return false;
          }

          return true;
        },
      },
    },
  },

  plugins: [new CleanWebpackPlugin()],
});

export const mainConfig =
  (params: ConfigParams) =>
  (env: unknown, argv: WebpackArgv): Configuration => {
    const isDev = argv.mode === "development";
    const isServe = argv.env?.WEBPACK_SERVE ?? false;

    const allowUnusedVariables = isDev;

    const plugins: WebpackPluginInstance[] = [];

    if (isServe) {
      plugins.push(new ReactRefreshPlugin());
    }

    const appWebpackConfig = makeConfig(env, argv, {
      allowUnusedVariables,
      version: params.version,
    });

    const config: Configuration = {
      name: "main",

      ...appWebpackConfig,

      target: "web",
      context: params.contextPath,
      entry: params.entrypoint,
      devtool: isDev ? "eval-cheap-module-source-map" : params.prodSourceMap,

      output: {
        publicPath: params.publicPath ?? "auto",

        // Output filenames should include content hashes in order to cache bust when new versions are available
        filename: isDev ? "[name].js" : "[name].[contenthash].js",

        path: params.outputPath,
      },

      plugins: [
        ...plugins,
        ...(appWebpackConfig.plugins ?? []),
        new CopyPlugin({
          patterns: [{ from: path.resolve(__dirname, "..", "public") }],
        }),
        new HtmlWebpackPlugin({
          templateContent: ({ htmlWebpackPlugin }) => `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="apple-mobile-web-app-capable" content="yes">
      ${htmlWebpackPlugin.options.foxgloveExtraHeadTags}
      <style type="text/css" id="loading-styles">
        body {
          margin: 0;
        }
        #root {
          height: 100vh;
          background-color: ${palette.light.background?.default};
          color: ${palette.light.text?.primary};
        }
        @media (prefers-color-scheme: dark) {
          #root {
            background-color: ${palette.dark.background?.default}};
            color: ${palette.dark.text?.primary};
          }
        }
      </style>
    </head>
    <script>
      global = globalThis;
      globalThis.FOXGLOVE_STUDIO_DEFAULT_LAYOUT = [/*FOXGLOVE_STUDIO_DEFAULT_LAYOUT_PLACEHOLDER*/][0];
    </script>
    <body>
      <div id="root"></div>
    </body>
  </html>
  `,
          foxgloveExtraHeadTags: `
            <title>睿芯行</title>
            <link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png" />
            <link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png" />
            <link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png" />
          `,
          ...params.indexHtmlOptions,
        }),
      ],
    };

    return config;
  };
