// netlify/edge-functions/proxy.ts
// 通用反向代理 - 适用于任何 HTTP/HTTPS 后端服务

import type { Context } from "netlify:edge";

// ==================== 配置区域（通过环境变量） ====================

// 目标服务器地址（必填）
const TARGET_URL = Netlify.env.get("TARGET_URL");
// 例如: http://kkk.us.kg:8096, https://api.example.com, http://192.168.1.100:3000

// 可选：允许的请求头（逗号分隔，不填则透传所有标准头）
const ALLOWED_HEADERS = Netlify.env.get("ALLOWED_HEADERS") || "";

// 可选：是否启用详细日志
const DEBUG = Netlify.env.get("PROXY_DEBUG") === "true";

// 可选：自定义响应头（JSON 格式）
const CUSTOM_HEADERS = Netlify.env.get("CUSTOM_HEADERS") || "{}";

// ==================== 默认配置 ====================

// 标准透传请求头（安全默认值）
const DEFAULT_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "accept-encoding",
  "accept-language",
  "origin",
  "cache-control",
  "x-requested-with",
  "x-api-key",
  "x-auth-token",
];

// 标准透传响应头
const DEFAULT_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "location",
];

// ==================== 工具函数 ====================

function log(...args: unknown[]) {
  if (DEBUG) {
    console.log(`[Proxy ${new Date().toISOString()}]`, ...args);
  }
}

function getAllowedRequestHeaders(): string[] {
  if (!ALLOWED_HEADERS) return DEFAULT_REQUEST_HEADERS;
  return ALLOWED_HEADERS.split(",").map(h => h.trim().toLowerCase());
}

function parseCustomHeaders(): Record<string, string> {
  try {
    return JSON.parse(CUSTOM_HEADERS);
  } catch {
    return {};
  }
}

// ==================== 主处理函数 ====================

export default async (request: Request, context: Context) => {
  // 检查必填配置
  if (!TARGET_URL) {
    return new Response(
      JSON.stringify({
        error: "Configuration Error",
        message: "TARGET_URL environment variable is not set",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // 验证目标 URL 格式
  let targetBaseUrl: URL;
  try {
    targetBaseUrl = new URL(TARGET_URL);
  } catch {
    return new Response(
      JSON.stringify({
        error: "Configuration Error",
        message: `Invalid TARGET_URL: ${TARGET_URL}`,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const url = new URL(request.url);
  
  // 构建目标 URL
  const targetUrl = new URL(url.pathname + url.search, targetBaseUrl);
  
  log(`${request.method} ${url.pathname} -> ${targetUrl.toString()}`);

  // ==================== 构建请求头 ====================
  
  const headers = new Headers();
  const allowedHeaders = getAllowedRequestHeaders();

  // 透传允许的头
  for (const header of allowedHeaders) {
    const value = request.headers.get(header);
    if (value) {
      headers.set(header, value);
    }
  }

  // 透传所有 x- 开头的自定义头（更灵活）
  request.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-") && !headers.has(key)) {
      headers.set(key, value);
    }
  });

  // 代理相关头
  headers.set("X-Forwarded-For", context.ip);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  headers.set("X-Forwarded-Host", url.host);
  headers.set("Host", targetBaseUrl.host);

  log("Request headers:", Object.fromEntries(headers.entries()));

  // ==================== 发起请求 ====================
  
  let response: Response;
  try {
    response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: headers,
      body: request.body,
      redirect: "manual", // 手动处理重定向
    });
  } catch (error) {
    log("Fetch error:", error);
    return new Response(
      JSON.stringify({
        error: "Proxy Error",
        message: "Failed to connect to target server",
        target: TARGET_URL,
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // ==================== 构建响应 ====================
  
  const responseHeaders = new Headers();

  // 透传标准响应头
  for (const header of DEFAULT_RESPONSE_HEADERS) {
    const value = response.headers.get(header);
    if (value) {
      responseHeaders.set(header, value);
    }
  }

  // 透传所有 x- 开头的自定义响应头
  response.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-") && !responseHeaders.has(key)) {
      responseHeaders.set(key, value);
    }
  });

  // 应用自定义响应头（环境变量配置）
  const customHeaders = parseCustomHeaders();
  for (const [key, value] of Object.entries(customHeaders)) {
    responseHeaders.set(key, value);
  }

  // 默认 CORS（可通过环境变量覆盖）
  if (!responseHeaders.has("Access-Control-Allow-Origin")) {
    responseHeaders.set("Access-Control-Allow-Origin", "*");
  }
  if (!responseHeaders.has("Access-Control-Allow-Methods")) {
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH");
  }
  if (!responseHeaders.has("Access-Control-Allow-Headers")) {
    responseHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, X-API-Key, X-Auth-Token");
  }

  // ==================== 处理重定向 ====================
  
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      try {
        const locUrl = new URL(location);
        // 如果重定向指向目标服务器，重写为代理地址
        if (locUrl.origin === targetBaseUrl.origin) {
          const newLoc = `${url.origin}${locUrl.pathname}${locUrl.search}`;
          responseHeaders.set("Location", newLoc);
          log("Rewrote redirect:", location, "->", newLoc);
        } else {
          responseHeaders.set("Location", location);
        }
      } catch {
        // 相对路径，直接透传
        responseHeaders.set("Location", location);
      }
    }
  }

  log("Response:", response.status, Object.fromEntries(responseHeaders.entries()));

  // 流式返回
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusStatusText,
    headers: responseHeaders,
  });
};

// ==================== 配置 ====================

export const config = {
  path: "/*",
  method: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
};
