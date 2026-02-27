// 从环境变量读取目标地址，格式: http://ip:port 或 https://domain
const TARGET_URL = Netlify.env.get("TARGET_URL") || "https://google.com";

export default async (request: Request) => {
  const url = new URL(request.url);
  const targetUrl = JELLYFIN_URL + url.pathname + url.search;

  // 构建转发头
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-For", request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "");
  headers.set("X-Real-IP", request.headers.get("x-forwarded-for") || "");
  headers.set("Host", new URL(JELLYFIN_URL).host);

  try {
    // 发起请求
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
    });

    // 克隆响应头并添加 CORS
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
    newHeaders.set("Access-Control-Allow-Headers", "*");
    newHeaders.set("Access-Control-Allow-Credentials", "true");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });

  } catch (error) {
    return new Response(`Proxy Error: ${error.message}`, { status: 502 });
  }
};

export const config = {
  path: "/*",
};
